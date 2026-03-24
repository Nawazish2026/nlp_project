const { runQuery } = require('../config/database');

const getGraph = async (limit = 300) => {
    const nodes = await runQuery('SELECT * FROM nodes LIMIT ?', [limit]);
    if (nodes.length === 0) return { nodes: [], edges: [] };

    const ids = nodes.map(n => `'${n.id.replace(/'/g, "''")}'`).join(',');
    const edges = await runQuery(
        `SELECT * FROM edges WHERE source IN (${ids}) AND target IN (${ids})`
    );

    console.log(`[/graph] Returning ${nodes.length} nodes, ${edges.length} edges`);
    return formatCyto(nodes, edges);
};

const formatCyto = (nodes, edges) => {
    const cyNodes = nodes.map(n => {
        let props = {};
        try { props = JSON.parse(n.properties); } catch {}
        return { data: { id: n.id, label: n.label, ...props } };
    });
    const cyEdges = edges.map(e => {
        let props = {};
        try { props = JSON.parse(e.properties); } catch {}
        return { data: { id: e.id, source: e.source, target: e.target, label: e.type, ...props } };
    });
    return { nodes: cyNodes, edges: cyEdges };
};

module.exports = { getGraph, formatCyto };
