const { runQuery } = require('../config/database');
const { formatCyto } = require('./graph');
const { generateSQL, generateSummary } = require('./llm');

const GUARDRAIL = "This system only answers questions related to the provided dataset.";

/* ── Synonym → normalised label ───────────────────────────── */
const SYNONYMS = {
    product:    'product',    products:   'product',    material:  'product',
    order:      'sales_order', orders:    'sales_order', 'sales order': 'sales_order',
    customer:   'customer',   customers:  'customer',   partner:   'customer',
    delivery:   'delivery',   deliveries: 'delivery',   shipment:  'delivery',
    invoice:    'invoice',    invoices:   'invoice',     bill:      'invoice',    billing: 'invoice',
    payment:    'payment',    payments:   'payment',
    plant:      'plant',      plants:     'plant',
    journal:    'journal_entry',
    schedule:   'schedule_line',
    item:       'sales_order_item',
};

/* ── Relevance keywords (guardrail whitelist) ─────────────── */
const RELEVANT = [
    'order','sales','item','delivery','billing','invoice','bill','customer',
    'partner','product','material','plant','payment','journal','schedule',
    'address','storage','cancel','receivable','trace','lifecycle','top',
    'broken','flow','dataset','cash','ship','document','header','show',
    'list','find','get','search','all','total','count','which','how',
    'many','highest','lowest','most','least','average','between','connected',
    'linked','related','associated','number',
];

/* ── Main processor ───────────────────────────────────────── */
const processQuery = async (queryText) => {
    const qt = queryText.toLowerCase().trim();

    // Guardrail
    if (!RELEVANT.some(k => qt.includes(k))) {
        return { response: GUARDRAIL, type: 'text' };
    }

    try {
        // ═══════════════════════════════════════════════════
        // PATH 1: LLM-powered SQL generation (if API key set)
        // ═══════════════════════════════════════════════════
        const llmSQL = await generateSQL(queryText);
        if (llmSQL) {
            try {
                const rawResults = await runQuery(llmSQL);
                
                if (rawResults.length === 0) {
                    return { response: `Query executed but returned no results.`, type: 'text' };
                }

                // Check if results are nodes (have id, label, properties columns)
                const isNodeResult = rawResults[0].id && rawResults[0].label && rawResults[0].properties;
                
                let nodes = [];
                let edges = [];
                let responseText = '';

                if (isNodeResult) {
                    nodes = rawResults;
                    const ids = nodes.map(n => `'${n.id.replace(/'/g, "''")}'`).join(',');
                    edges = await runQuery(`SELECT * FROM edges WHERE source IN (${ids}) OR target IN (${ids})`);
                    
                    // Pull neighbour nodes
                    const have = new Set(nodes.map(n => n.id));
                    const missing = [...new Set(edges.flatMap(e => [e.source, e.target]).filter(x => !have.has(x)))];
                    if (missing.length > 0) {
                        const mq = missing.map(m => `'${m.replace(/'/g, "''")}'`).join(',');
                        const extra = await runQuery(`SELECT * FROM nodes WHERE id IN (${mq}) LIMIT 40`);
                        nodes = [...nodes, ...extra];
                    }
                }

                // Generate NL summary via LLM
                const summary = await generateSummary(queryText, rawResults);
                responseText = summary || `Found ${rawResults.length} results.`;

                if (nodes.length > 0) {
                    return { response: responseText, type: 'graph', data: formatCyto(nodes, edges) };
                } else {
                    // Tabular results (aggregation queries etc.)
                    return { 
                        response: responseText, 
                        type: 'table', 
                        data: rawResults 
                    };
                }
            } catch (sqlErr) {
                console.error('[LLM SQL Error]', sqlErr.message, 'SQL was:', llmSQL);
                // Fall through to rule-based
            }
        }

        // ═══════════════════════════════════════════════════
        // PATH 2: Rule-based fallback
        // ═══════════════════════════════════════════════════
        return await ruleBasedQuery(qt, queryText);

    } catch (err) {
        console.error('NLP error:', err);
        return { response: 'Query error: ' + err.message, type: 'text' };
    }
};

/* ── Rule-based fallback ──────────────────────────────────── */
const ruleBasedQuery = async (qt, queryText) => {
    let nodes = [];
    let edges = [];
    let responseText = '';

    const id = (qt.match(/\b\d{4,}\b/) || [])[0];
    const label = resolveLabel(qt);

    // Top products by billing
    if ((qt.includes('top') || qt.includes('highest') || qt.includes('most')) && 
        (qt.includes('product') || qt.includes('bill'))) {
        nodes = await runQuery(`SELECT * FROM nodes WHERE label='invoice_item' LIMIT 20`);
        if (nodes.length === 0) nodes = await runQuery(`SELECT * FROM nodes WHERE label='invoice' LIMIT 20`);
        responseText = `Showing ${nodes.length} billing items linked to products.`;
    }
    // Trace / lifecycle
    else if (qt.includes('trace') || qt.includes('lifecycle') || qt.includes('full flow')) {
        let seeds;
        if (id) {
            seeds = await runQuery(`SELECT * FROM nodes WHERE label='sales_order' AND (id LIKE ? OR properties LIKE ?)`, [`%${id}%`, `%${id}%`]);
        } else {
            seeds = await runQuery(`SELECT * FROM nodes WHERE label='sales_order' LIMIT 3`);
        }
        if (seeds.length > 0) {
            const seedIds = seeds.map(n => `'${n.id}'`).join(',');
            edges = await runQuery(`SELECT * FROM edges WHERE source IN (${seedIds})`);
            const tgtIds = [...new Set(edges.map(e => e.target))].map(t => `'${t}'`).join(',');
            const related = tgtIds ? await runQuery(`SELECT * FROM nodes WHERE id IN (${tgtIds})`) : [];
            if (related.length > 0) {
                const hop2Ids = related.map(n => `'${n.id}'`).join(',');
                const hop2e = await runQuery(`SELECT * FROM edges WHERE source IN (${hop2Ids}) LIMIT 50`);
                const hop2t = [...new Set(hop2e.map(e => e.target))].filter(t => !seeds.find(s=>s.id===t) && !related.find(r=>r.id===t)).map(t=>`'${t}'`).join(',');
                const hop2n = hop2t ? await runQuery(`SELECT * FROM nodes WHERE id IN (${hop2t}) LIMIT 20`) : [];
                edges = [...edges, ...hop2e];
                nodes = [...seeds, ...related, ...hop2n];
            } else { nodes = seeds; }
        }
        responseText = `Order lifecycle trace: ${nodes.length} nodes, ${edges.length} edges.`;
    }
    // Broken flows
    else if (qt.includes('broken') || (qt.includes('deliver') && qt.includes('not'))) {
        nodes = await runQuery(`SELECT * FROM nodes WHERE label='delivery' AND id NOT IN (SELECT e.source FROM edges e WHERE e.type='HAS_INVOICE') LIMIT 20`);
        responseText = `Broken flows: ${nodes.length} deliveries without invoices.`;
    }
    // Entity + optional ID
    else if (label) {
        if (id) {
            nodes = await runQuery(`SELECT * FROM nodes WHERE label=? AND (id LIKE ? OR properties LIKE ?) LIMIT 20`, [label, `%${id}%`, `%${id}%`]);
            if (nodes.length === 0) nodes = await runQuery(`SELECT * FROM nodes WHERE id LIKE ? OR properties LIKE ? LIMIT 20`, [`%${id}%`, `%${id}%`]);
            responseText = `Results for ${label} #${id}: ${nodes.length} nodes.`;
        } else {
            nodes = await runQuery(`SELECT * FROM nodes WHERE label=? LIMIT 15`, [label]);
            responseText = `Showing ${nodes.length} ${label} nodes.`;
        }
    }
    // Fuzzy fallback
    else {
        const kw = id || qt.split(' ').filter(w => w.length > 3)[0] || 'order';
        nodes = await runQuery(`SELECT * FROM nodes WHERE id LIKE ? OR properties LIKE ? OR label LIKE ? LIMIT 20`, [`%${kw}%`, `%${kw}%`, `%${kw}%`]);
        responseText = `Search "${kw}": ${nodes.length} nodes.`;
    }

    if (nodes.length === 0) return { response: responseText + ' No data found.', type: 'text' };

    // Fetch edges
    const ids = nodes.map(n => `'${n.id}'`).join(',');
    if (edges.length === 0) {
        edges = await runQuery(`SELECT * FROM edges WHERE source IN (${ids}) OR target IN (${ids})`);
    }
    const have = new Set(nodes.map(n => n.id));
    const missing = [...new Set(edges.flatMap(e => [e.source, e.target]).filter(x => !have.has(x)))];
    if (missing.length > 0) {
        const mq = missing.map(m => `'${m}'`).join(',');
        nodes = [...nodes, ...await runQuery(`SELECT * FROM nodes WHERE id IN (${mq}) LIMIT 40`)];
    }

    return { response: responseText, type: 'graph', data: formatCyto(nodes, edges) };
};

const resolveLabel = (qt) => {
    for (const [syn, label] of Object.entries(SYNONYMS)) {
        if (qt.includes(syn)) return label;
    }
    return null;
};

module.exports = { processQuery };
