/* ── Entity color palette ─────────────────────────────────── */
const COLORS = {
    sales_order:          '#3b82f6',
    sales_order_item:     '#6366f1',
    schedule_line:        '#818cf8',
    delivery:             '#10b981',
    delivery_item:        '#34d399',
    invoice:              '#f59e0b',
    invoice_item:         '#fbbf24',
    invoice_cancellation: '#ef4444',
    customer:             '#ec4899',
    customer_address:     '#f472b6',
    customer_company:     '#db2777',
    customer_sales_area:  '#be185d',
    product:              '#8b5cf6',
    product_description:  '#a78bfa',
    product_plant:        '#7c3aed',
    product_storage:      '#6d28d9',
    plant:                '#14b8a6',
    payment:              '#22c55e',
    journal_entry:        '#06b6d4',
};
const getColor = (label) => COLORS[label] || '#64748b';

/* ── Cytoscape init ───────────────────────────────────────── */
let cy = cytoscape({
    container: document.getElementById('cy'),
    style: [
        {
            selector: 'node',
            style: {
                'label': 'data(label)',
                'background-color': (el) => getColor(el.data('label')),
                'color': '#e2e8f0',
                'text-valign': 'bottom',
                'text-halign': 'center',
                'font-size': '8px',
                'width': '28px',
                'height': '28px',
                'border-width': 2,
                'border-color': 'rgba(255,255,255,0.15)',
                'text-outline-width': 1,
                'text-outline-color': '#000',
                'text-margin-y': 4,
                'transition-property': 'background-color, border-color, width, height',
                'transition-duration': '0.2s',
            }
        },
        {
            selector: 'edge',
            style: {
                'width': 1,
                'line-color': '#334155',
                'target-arrow-color': '#334155',
                'target-arrow-shape': 'triangle',
                'curve-style': 'bezier',
                'arrow-scale': 0.6,
                'opacity': 0.6,
            }
        },
        {
            selector: ':selected',
            style: { 'border-color': '#f59e0b', 'border-width': 3, 'width': '36px', 'height': '36px' }
        },
        {
            selector: '.highlighted',
            style: { 'border-color': '#22d3ee', 'border-width': 3, 'width': '34px', 'height': '34px', 'z-index': 10 }
        },
        {
            selector: '.highlighted-edge',
            style: { 'line-color': '#22d3ee', 'target-arrow-color': '#22d3ee', 'width': 2, 'opacity': 1 }
        }
    ],
    layout: { name: 'cose', padding: 50, nodeRepulsion: 12000, animate: false },
    wheelSensitivity: 0.3,
});

/* ── State ────────────────────────────────────────────────── */
let selectedNodeId = null;

/* ── Inspector ────────────────────────────────────────────── */
const inspector = document.getElementById('inspector-content');
const expandBtn = document.getElementById('btn-expand');

cy.on('tap', 'node', function(evt) {
    const d = evt.target.data();
    selectedNodeId = d.id;
    expandBtn.classList.remove('hidden');

    let html = `<div style="margin-bottom:8px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${getColor(d.label)};margin-right:6px"></span>
        <strong style="color:${getColor(d.label)}">${d.label}</strong>
        </div>`;
    for (const [k, v] of Object.entries(d)) {
        if (k === 'id' || k === 'label') continue;
        html += `<div class="prop-row"><span class="prop-key">${k}</span><span class="prop-val">${v}</span></div>`;
    }
    const connectedEdges = cy.getElementById(d.id).connectedEdges();
    html += `<div style="margin-top:8px;color:#64748b">Connections: ${connectedEdges.length}</div>`;
    inspector.innerHTML = html;
});

cy.on('tap', function(evt) {
    if (evt.target === cy) {
        selectedNodeId = null;
        expandBtn.classList.add('hidden');
        inspector.innerHTML = 'Click a node in the graph to inspect.';
    }
});

/* ── Node expansion ───────────────────────────────────────── */
expandBtn.addEventListener('click', async () => {
    if (!selectedNodeId) return;
    try {
        const res = await fetch(`/api/node/${encodeURIComponent(selectedNodeId)}`);
        const data = await res.json();
        if (data.neighbours) {
            const existingIds = new Set(cy.nodes().map(n => n.id()));
            for (const n of data.neighbours) {
                if (!existingIds.has(n.id)) {
                    let props = {};
                    try { props = JSON.parse(n.properties); } catch {}
                    cy.add({ data: { id: n.id, label: n.label, ...props } });
                }
            }
            for (const e of data.edges) {
                const edgeExists = cy.getElementById(e.id).length > 0;
                if (!edgeExists && cy.getElementById(e.source).length > 0 && cy.getElementById(e.target).length > 0) {
                    let props = {};
                    try { props = JSON.parse(e.properties); } catch {}
                    cy.add({ data: { id: e.id, source: e.source, target: e.target, label: e.type, ...props } });
                }
            }
            cy.layout({ name: 'cose', padding: 50, nodeRepulsion: 12000, animate: true, animationDuration: 500 }).run();
            updateStats();
        }
    } catch(e) { console.error('Expand error:', e); }
});

/* ── Graph render ─────────────────────────────────────────── */
const renderGraph = (data) => {
    cy.elements().remove();
    if (data.nodes) cy.add(data.nodes);
    if (data.edges) cy.add(data.edges);
    cy.layout({ name: 'cose', padding: 50, nodeRepulsion: 12000, animate: true, animationDuration: 600 }).run();
    updateStats();
};

const highlightNodes = (nodeIds) => {
    cy.elements().removeClass('highlighted highlighted-edge');
    if (!nodeIds || nodeIds.length === 0) return;
    const idSet = new Set(nodeIds);
    cy.nodes().forEach(n => {
        if (idSet.has(n.id())) n.addClass('highlighted');
    });
    cy.edges().forEach(e => {
        if (idSet.has(e.source().id()) || idSet.has(e.target().id())) e.addClass('highlighted-edge');
    });
};

const updateStats = () => {
    document.getElementById('graph-stats').textContent =
        `${cy.nodes().length} nodes · ${cy.edges().length} edges`;
};

/* ── Load initial graph ───────────────────────────────────── */
const loadInitialGraph = async () => {
    try {
        const res = await fetch('/api/graph');
        const data = await res.json();
        if (data.nodes && data.nodes.length > 0) {
            renderGraph(data);
            document.getElementById('status-badge').textContent = `${data.nodes.length} nodes`;
            document.getElementById('status-badge').classList.add('loaded');
        }
    } catch (e) { console.error(e); }
};

/* ── Load Dataset button ──────────────────────────────────── */
document.getElementById('btn-load-data').addEventListener('click', async () => {
    const loading = document.getElementById('loading');
    loading.classList.remove('hidden');
    try {
        const response = await fetch('/api/load-data', { method: 'POST' });
        const res = await response.json();
        if (res.success) {
            await loadInitialGraph();
            addChatMsg('bot', '✅ ' + res.message);
        } else {
            addChatMsg('bot', '❌ ' + res.message);
        }
    } catch(e) {
        addChatMsg('bot', 'Network error loading dataset.');
    }
    loading.classList.add('hidden');
});

/* ── Toolbar ──────────────────────────────────────────────── */
document.getElementById('btn-fit').addEventListener('click', () => cy.fit(50));
document.getElementById('btn-reset').addEventListener('click', () => {
    cy.elements().removeClass('highlighted highlighted-edge');
    cy.fit(50);
});

/* ── Chat ─────────────────────────────────────────────────── */
const addChatMsg = (sender, text, tableData) => {
    const hist = document.getElementById('chat-history');
    const d = document.createElement('div');
    d.className = `msg ${sender}`;
    d.textContent = text;

    // Render table for tabular results
    if (tableData && tableData.length > 0) {
        const tableDiv = document.createElement('div');
        tableDiv.className = 'table-result';
        const keys = Object.keys(tableData[0]);
        let html = '<table><tr>' + keys.map(k => `<th>${k}</th>`).join('') + '</tr>';
        for (const row of tableData.slice(0, 10)) {
            html += '<tr>' + keys.map(k => `<td>${row[k] ?? ''}</td>`).join('') + '</tr>';
        }
        html += '</table>';
        if (tableData.length > 10) html += `<div style="color:#64748b;margin-top:4px">...and ${tableData.length - 10} more rows</div>`;
        tableDiv.innerHTML = html;
        d.appendChild(tableDiv);
    }

    hist.appendChild(d);
    hist.scrollTop = hist.scrollHeight;
};

const sendQuery = async () => {
    const input = document.getElementById('chat-input-field');
    const query = input.value.trim();
    if (!query) return;

    addChatMsg('user', query);
    input.value = '';

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });
        const data = await res.json();

        if (data.type === 'graph' && data.data) {
            addChatMsg('bot', data.response);
            renderGraph(data.data);
            // Highlight the result nodes
            const resultIds = data.data.nodes.map(n => n.data.id);
            setTimeout(() => highlightNodes(resultIds), 700);
        } else if (data.type === 'table' && data.data) {
            addChatMsg('bot', data.response, data.data);
        } else {
            addChatMsg('bot', data.response);
        }
    } catch(e) {
        addChatMsg('bot', 'Error contacting query engine.');
    }
};

document.getElementById('btn-send').addEventListener('click', sendQuery);
document.getElementById('chat-input-field').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendQuery();
});

/* ── Init ─────────────────────────────────────────────────── */
loadInitialGraph();
