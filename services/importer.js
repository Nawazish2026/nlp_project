const admZip = require('adm-zip');
const fs = require('fs');
const { execute, runQuery } = require('../config/database');
const path = require('path');

const parseJSONL = (str) => {
    return str.split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
};

/* ── Entity name normalisation ────────────────────────────── */
const ENTITY_NORM = {
    sales_order_headers:                     'sales_order',
    sales_order_items:                       'sales_order_item',
    sales_order_schedule_lines:              'schedule_line',
    outbound_delivery_headers:               'delivery',
    outbound_delivery_items:                 'delivery_item',
    billing_document_headers:                'invoice',
    billing_document_items:                  'invoice_item',
    billing_document_cancellations:          'invoice_cancellation',
    business_partners:                       'customer',
    business_partner_addresses:              'customer_address',
    customer_company_assignments:            'customer_company',
    customer_sales_area_assignments:         'customer_sales_area',
    products:                                'product',
    product_descriptions:                    'product_description',
    product_plants:                          'product_plant',
    product_storage_locations:               'product_storage',
    plants:                                  'plant',
    payments_accounts_receivable:            'payment',
    journal_entry_items_accounts_receivable: 'journal_entry',
};
const norm = (raw) => ENTITY_NORM[raw] || raw;

/* ── camelCase field → target entity + edge type ──────────── */
const REL_MAP = {
    // Sales order references
    salesOrder:           { target: 'sales_order',     type: 'BELONGS_TO_ORDER' },
    salesDocument:        { target: 'sales_order',     type: 'BELONGS_TO_ORDER' },
    // Delivery references
    deliveryDocument:     { target: 'delivery',        type: 'HAS_DELIVERY' },
    referenceSdDocument:  { target: 'delivery',        type: 'REF_DELIVERY' },
    // Billing / Invoice references
    billingDocument:      { target: 'invoice',         type: 'HAS_INVOICE' },
    cancelledBillingDocument: { target: 'invoice',     type: 'CANCELS_INVOICE' },
    accountingDocument:   { target: 'journal_entry',   type: 'HAS_JOURNAL' },
    // Customer / Partner references
    soldToParty:          { target: 'customer',        type: 'SOLD_TO' },
    shipToParty:          { target: 'customer',        type: 'SHIPPED_TO' },
    payerParty:           { target: 'customer',        type: 'PAID_BY' },
    billToParty:          { target: 'customer',        type: 'BILLED_TO' },
    customer:             { target: 'customer',        type: 'HAS_CUSTOMER' },
    businessPartner:      { target: 'customer',        type: 'HAS_PARTNER' },
    // Product / Material references
    product:              { target: 'product',         type: 'HAS_PRODUCT' },
    material:             { target: 'product',         type: 'HAS_PRODUCT' },
    // Plant references
    plant:                { target: 'plant',           type: 'AT_PLANT' },
    productionPlant:      { target: 'plant',           type: 'PRODUCED_AT' },
    shippingPoint:        { target: 'plant',           type: 'SHIPS_FROM' },
};

/* ── Primary key field per raw entity ─────────────────────── */
const PK_MAP = {
    sales_order_headers:                     'salesOrder',
    sales_order_items:                       'salesOrder',  // composite, use salesOrder
    sales_order_schedule_lines:              'salesOrder',
    outbound_delivery_headers:               'deliveryDocument',
    outbound_delivery_items:                 'deliveryDocument',
    billing_document_headers:                'billingDocument',
    billing_document_items:                  'billingDocument',
    billing_document_cancellations:          'billingDocument',
    business_partners:                       'businessPartner',
    business_partner_addresses:              'businessPartner',
    customer_company_assignments:            'customer',
    customer_sales_area_assignments:         'customer',
    products:                                'product',
    product_descriptions:                    'product',
    product_plants:                          'product',
    product_storage_locations:               'product',
    plants:                                  'plant',
    payments_accounts_receivable:            'accountingDocument',
    journal_entry_items_accounts_receivable: 'accountingDocument',
};

const inferGraph = async (zipPath) => {
    if (!fs.existsSync(zipPath))
        return { success: false, message: `ZIP not found at ${zipPath}` };

    try {
        const zip = new admZip(zipPath);
        const entries = zip.getEntries();

        await execute('DELETE FROM nodes');
        await execute('DELETE FROM edges');

        // 1. Group JSONL files by entity directory
        const bucket = {};
        for (const e of entries) {
            if (e.isDirectory || !e.entryName.endsWith('.jsonl')) continue;
            const parts = e.entryName.split('/').filter(Boolean);
            const rawEntity = parts.length >= 2 ? parts[1] : parts[0];
            if (!bucket[rawEntity]) bucket[rawEntity] = [];
            bucket[rawEntity].push(e);
        }

        console.log('\n═══ DETECTED ENTITIES ═══');
        Object.keys(bucket).forEach(k => console.log(`  ${k} → ${norm(k)}`));

        // 2. Parse + insert nodes
        const datasets = {};
        let totalNodes = 0;

        for (const [rawEntity, files] of Object.entries(bucket)) {
            let rows = [];
            for (const f of files) rows.push(...parseJSONL(f.getData().toString('utf8')));
            datasets[rawEntity] = rows;
            if (rows.length === 0) continue;

            const pk = PK_MAP[rawEntity] || Object.keys(rows[0])[0];
            const cap = rawEntity.startsWith('product_storage') || rawEntity.startsWith('product_plant') ? 150 : 500;
            const limited = rows.slice(0, cap);

            for (let i = 0; i < limited.length; i++) {
                const row = limited[i];
                const idVal = row[pk] ?? `${i}`;
                // For items (composite keys), include item number
                let nodeId;
                if (rawEntity === 'sales_order_items') {
                    nodeId = `sales_order_item::${row.salesOrder}-${row.salesOrderItem}`;
                } else if (rawEntity === 'outbound_delivery_items') {
                    nodeId = `delivery_item::${row.deliveryDocument}-${row.deliveryDocumentItem}`;
                } else if (rawEntity === 'billing_document_items') {
                    nodeId = `invoice_item::${row.billingDocument}-${row.billingDocumentItem}`;
                } else {
                    nodeId = `${norm(rawEntity)}::${idVal}`;
                }

                await execute(
                    'INSERT OR IGNORE INTO nodes (id, label, properties) VALUES (?,?,?)',
                    [nodeId, norm(rawEntity), JSON.stringify(row)]
                );
                totalNodes++;
            }
        }

        // 3. Build edges from field values matching REL_MAP
        let totalEdges = 0;
        for (const [rawEntity, rows] of Object.entries(datasets)) {
            const pk = PK_MAP[rawEntity] || Object.keys(rows[0])[0];
            const cap = rawEntity.startsWith('product_storage') || rawEntity.startsWith('product_plant') ? 150 : 500;
            const limited = rows.slice(0, cap);
            const normalLabel = norm(rawEntity);

            for (let i = 0; i < limited.length; i++) {
                const row = limited[i];

                // Build source ID (same logic as node creation)
                let srcId;
                if (rawEntity === 'sales_order_items') {
                    srcId = `sales_order_item::${row.salesOrder}-${row.salesOrderItem}`;
                } else if (rawEntity === 'outbound_delivery_items') {
                    srcId = `delivery_item::${row.deliveryDocument}-${row.deliveryDocumentItem}`;
                } else if (rawEntity === 'billing_document_items') {
                    srcId = `invoice_item::${row.billingDocument}-${row.billingDocumentItem}`;
                } else {
                    srcId = `${normalLabel}::${row[pk] ?? i}`;
                }

                for (const [field, val] of Object.entries(row)) {
                    // Skip PK field, empty values, objects
                    if (field === pk) continue;
                    if (!val || (typeof val === 'object') || String(val).trim() === '') continue;

                    const rel = REL_MAP[field];
                    if (!rel) continue;

                    // Don't create self-referencing edges to same entity type
                    if (rel.target === normalLabel) continue;

                    const tgtId = `${rel.target}::${val}`;
                    const edgeId = `e::${srcId}→${field}→${val}`;

                    await execute(
                        'INSERT OR IGNORE INTO edges (id, source, target, type, properties) VALUES (?,?,?,?,?)',
                        [edgeId, srcId, tgtId, rel.type, JSON.stringify({ field })]
                    );
                    totalEdges++;
                }
            }
        }

        // 4. Summary
        const dbNodes = await runQuery('SELECT count(*) as c FROM nodes');
        const dbEdges = await runQuery('SELECT count(*) as c FROM edges');
        const sample  = await runQuery('SELECT * FROM nodes LIMIT 1');
        const edgeSample = await runQuery('SELECT * FROM edges LIMIT 3');

        console.log(`\n═══ IMPORT COMPLETE ═══`);
        console.log(`  Nodes: ${dbNodes[0].c}`);
        console.log(`  Edges: ${dbEdges[0].c}`);
        console.log(`  Sample node:`, sample[0]?.id, sample[0]?.label);
        console.log(`  Sample edges:`, edgeSample.map(e => `${e.source} -[${e.type}]-> ${e.target}`).join('\n    '));

        return {
            success: true,
            message: `Graph built: ${dbNodes[0].c} nodes, ${dbEdges[0].c} edges across ${Object.keys(bucket).length} entities.`
        };
    } catch (err) {
        console.error('Import error:', err);
        return { success: false, message: err.message };
    }
};

module.exports = { inferGraph };
