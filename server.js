require('dotenv').config();
const express = require('express');
const path = require('path');
const { initDb, runQuery } = require('./config/database');
const { inferGraph } = require('./services/importer');
const { getGraph } = require('./services/graph');
const { processQuery } = require('./services/nlp');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── Load data ────────────────────────────────────────────── */
app.post('/api/load-data', async (req, res) => {
    try {
        const zipPath = path.resolve(__dirname, 'sap-order-to-cash-dataset.zip');
        const result = await inferGraph(zipPath);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/* ── Full graph ───────────────────────────────────────────── */
app.get('/api/graph', async (req, res) => {
    try {
        const data = await getGraph(300);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── Single node + neighbours ─────────────────────────────── */
app.get('/api/node/:id', async (req, res) => {
    try {
        const nodeId = decodeURIComponent(req.params.id);
        const rows = await runQuery('SELECT * FROM nodes WHERE id = ?', [nodeId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

        const node = rows[0];
        node.properties = JSON.parse(node.properties);

        // Get neighbours (for expansion)
        const edges = await runQuery(
            'SELECT * FROM edges WHERE source = ? OR target = ?', [nodeId, nodeId]
        );
        const neighbourIds = [...new Set(edges.flatMap(e => [e.source, e.target]).filter(id => id !== nodeId))];
        let neighbours = [];
        if (neighbourIds.length > 0) {
            const q = neighbourIds.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
            neighbours = await runQuery(`SELECT * FROM nodes WHERE id IN (${q}) LIMIT 30`);
        }

        res.json({ node, edges, neighbours });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── Chat query ───────────────────────────────────────────── */
app.post('/api/chat', async (req, res) => {
    try {
        const result = await processQuery(req.body.query || '');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── Query (alias for /chat) ──────────────────────────────── */
app.post('/api/query', async (req, res) => {
    try {
        const result = await processQuery(req.body.query || '');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── Start ────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
initDb().then(async () => {
    const nc = await runQuery('SELECT count(*) as c FROM nodes');
    const ec = await runQuery('SELECT count(*) as c FROM edges');
    const hasKey = !!process.env.GEMINI_API_KEY;
    console.log(`\n  DB state : ${nc[0].c} nodes, ${ec[0].c} edges`);
    console.log(`  LLM mode : ${hasKey ? 'Gemini (active)' : 'Rule-based fallback (set GEMINI_API_KEY for LLM)'}`);
    app.listen(PORT, () => console.log(`  Server   → http://localhost:${PORT}\n`));
}).catch(err => console.error('DB init failed:', err));
