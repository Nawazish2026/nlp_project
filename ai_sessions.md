# AI Session Log

## Prompt 1
**Goal:** Build a "Graph-Based Data Modeling and Query System"
**Constraints:** No auth, minimal dependencies, free-tier friendly, no hallucination.
**Details:** Parse `./sap-order-to-cash-dataset.zip` into a graph (nodes+edges) stored in SQLite. Create APIs, cytoscape graph visualization, natural language chat query with guardrails. Everything should be completed in one pass.

## Iteration 1 — Initial Scaffold
**Action:** Created full-stack system with Node.js + Express + SQLite + Cytoscape.js.
**Issue:** Importer only looked for `.csv` files, but dataset contains `.jsonl` (JSON Lines) in nested directories.
**Result:** App ran but graph was empty (0 nodes, 0 edges).

## Iteration 2 — Diagnosed Data Format
**Action:** Created diagnostic script (`inspect.js`) to dump ZIP contents and DB state.
**Finding:** Dataset has 19 entity directories, each containing `.jsonl` part files. Not CSV at all.
**Key entities found:** sales_order_headers, outbound_delivery_headers, billing_document_headers, business_partners, products, payments_accounts_receivable, etc.

## Iteration 3 — JSONL Parser + Entity Normalization
**Action:** Rewrote `services/importer.js` to:
- Parse `.jsonl` files (one JSON object per line)
- Group files by parent directory (= entity type)
- Normalize entity names (e.g., `sales_order_headers` → `sales_order`)
- Build edges using SAP domain field mapping (SoldToParty → customer, DeliveryDocument → delivery, etc.)
- Log all detected entities and final counts

**Action:** Rewrote `services/nlp.js` with synonym mapping and intent detection.
**Result:** Data loading works. Queries return actual nodes and edges.

## Iteration 4 — LLM Integration + UI Polish
**Action:** After reviewing full task spec (Dodge AI assignment), identified requirement for LLM-powered NL→SQL translation.
**Changes:**
1. Created `services/llm.js` — Google Gemini free-tier integration with schema-aware prompting
2. Updated `services/nlp.js` — LLM-first path with rule-based fallback
3. Updated `server.js` — Added `/api/node/:id` with neighbour expansion
4. Updated frontend — Node expansion, result highlighting (cyan glow), table rendering for aggregation queries, toolbar, animated layout, Inter font
5. Updated `README.md` — Architecture diagram, DB rationale, graph modeling, NL→query approach, guardrails

**Architecture decisions:**
- Dual-path NLP: LLM generates SQL dynamically when API key is present; rule-based fallback ensures system works without any external API
- Schema prompt engineering: Full database schema with all 19 entity labels, edge types, and field names sent to Gemini
- Safety: Only SELECT queries accepted from LLM; all answers grounded in actual DB results
- Node expansion: Click-to-expand graph exploration via `/api/node/:id` endpoint
