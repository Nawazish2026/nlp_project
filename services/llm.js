/**
 * LLM Service - Google Gemini Free Tier Integration
 * Translates natural language queries into SQL for the graph database.
 * Falls back to rule-based if no API key is set.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const SCHEMA_PROMPT = `You are a SQL query generator for a graph database stored in SQLite.

DATABASE SCHEMA:
Table: nodes (id TEXT PRIMARY KEY, label TEXT, properties TEXT)
Table: edges (id TEXT PRIMARY KEY, source TEXT, target TEXT, type TEXT, properties TEXT)

NODE LABELS (entity types) with their key fields stored as JSON in the "properties" column:
- sales_order (salesOrder, salesOrderType, salesOrganization, soldToParty, creationDate, totalNetAmount, transactionCurrency, overallDeliveryStatus, overallOrdReltdBillgStatus)
- sales_order_item (salesOrder, salesOrderItem, material, requestedQuantity, netAmount, materialGroup, productionPlant)
- schedule_line (salesOrder, salesOrderItem, scheduleLine, confirmedDeliveryDate)
- delivery (deliveryDocument, creationDate, overallGoodsMovementStatus, overallPickingStatus, shippingPoint)
- delivery_item (deliveryDocument, deliveryDocumentItem, material, actualDeliveryQuantity)
- invoice (billingDocument, billingDocumentType, creationDate, totalNetAmount, transactionCurrency, soldToParty, billingDocumentIsCancelled)
- invoice_item (billingDocument, billingDocumentItem, material, billingQuantity, netAmount, referenceSdDocument)
- invoice_cancellation (cancelled billing documents)
- customer (businessPartner, customer, businessPartnerFullName, businessPartnerName, industry)
- customer_address (partner addresses)
- product (product, productType, grossWeight, netWeight, productGroup, baseUnit)
- product_description (product text descriptions)
- plant (plant, plantName)
- payment (companyCode, fiscalYear, accountingDocument, amountInTransactionCurrency)
- journal_entry (journal entry items for accounts receivable)

NODE ID FORMAT: "{label}::{primary_key}" e.g. "sales_order::740506", "customer::310000108", "product::S8907367001003"
For items: "sales_order_item::740506-10", "invoice_item::90504204-10"

EDGE TYPES:
- BELONGS_TO_ORDER (item → sales_order, via salesOrder field)
- HAS_DELIVERY (→ delivery)
- REF_DELIVERY (invoice_item → delivery, via referenceSdDocument)
- HAS_INVOICE (→ invoice)
- SOLD_TO (order/invoice → customer, via soldToParty)
- HAS_PRODUCT (item → product, via material field)
- AT_PLANT / PRODUCED_AT (→ plant)
- HAS_JOURNAL (→ journal_entry)

ACCESS PROPERTIES: Use json_extract(properties, '$.fieldName') e.g. json_extract(properties, '$.totalNetAmount')

RULES:
1. Return ONLY valid SQLite. No explanation, no markdown.
2. Always query nodes and/or edges tables.
3. Filter by label for entity lookups.
4. LIMIT results to 30 unless user specifies.
5. For product+billing queries, join invoice_item nodes (which have "material" field).
6. For "trace" queries, find edges connected to the entity.
7. Use json_extract for aggregation/filtering on properties.`;

/**
 * Call Gemini API to generate SQL from natural language
 */
const generateSQL = async (userQuery) => {
    if (!GEMINI_API_KEY) return null;

    try {
        const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: SCHEMA_PROMPT },
                        { text: `User query: "${userQuery}"\n\nGenerate a single SQLite query to answer this. Return ONLY the SQL, nothing else.` }
                    ]
                }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 500
                }
            })
        });

        if (!response.ok) {
            console.error(`Gemini API error: ${response.status}`);
            return null;
        }

        const data = await response.json();
        let sql = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!sql) return null;

        // Clean up: remove markdown code fences if present
        sql = sql.replace(/```sql\s*/gi, '').replace(/```\s*/g, '').trim();
        
        // Basic safety: only allow SELECT queries
        if (!sql.toUpperCase().startsWith('SELECT')) {
            console.warn('LLM returned non-SELECT query, rejecting:', sql);
            return null;
        }

        console.log(`[LLM] Generated SQL: ${sql}`);
        return sql;
    } catch (err) {
        console.error('LLM call failed:', err.message);
        return null;
    }
};

/**
 * Generate a natural language summary of query results
 */
const generateSummary = async (userQuery, results) => {
    if (!GEMINI_API_KEY || !results || results.length === 0) return null;

    try {
        const preview = JSON.stringify(results.slice(0, 5), null, 2);
        const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `The user asked: "${userQuery}"\n\nHere are the results from the database (${results.length} rows, showing first 5):\n${preview}\n\nWrite a concise 1-2 sentence natural language answer based ONLY on this data. Do not make up information.`
                    }]
                }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 200 }
            })
        });

        if (!response.ok) return null;
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    } catch {
        return null;
    }
};

module.exports = { generateSQL, generateSummary };
