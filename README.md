# SAP Order-to-Cash: Graph-Based Data Modeling and Query System

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (Vanilla JS)                │
│  ┌───────────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Cytoscape.js  │  │   Chat   │  │  Node Inspector  │  │
│  │  Graph View   │  │  Panel   │  │  + Expansion     │  │
│  └──────┬────────┘  └────┬─────┘  └────────┬─────────┘  │
│─────────┼───────────────┼──────────────────┼────────────│
│         │  REST API     │                  │             │
│  ┌──────┴───────────────┴──────────────────┴─────────┐  │
│  │              Express.js Server                     │  │
│  │  /api/graph  /api/chat  /api/node/:id  /api/query  │  │
│  └──────────────────┬────────────────────────────────┘  │
│                     │                                    │
│  ┌──────────────────┴────────────────────────────────┐  │
│  │              NLP Query Engine                      │  │
│  │  ┌─────────────────┐  ┌─────────────────────────┐ │  │
│  │  │  Gemini LLM     │  │  Rule-Based Fallback    │ │  │
│  │  │  NL → SQL       │  │  Synonyms + Intents     │ │  │
│  │  │  + NL Summary   │  │  + Fuzzy Search         │ │  │
│  │  └────────┬────────┘  └────────────┬────────────┘ │  │
│  │           │  fallback              │               │  │
│  │           └────────────┬───────────┘               │  │
│  └────────────────────────┼──────────────────────────┘  │
│                           │                              │
│  ┌────────────────────────┴──────────────────────────┐  │
│  │              SQLite (graph.db)                     │  │
│  │   nodes(id, label, properties)                     │  │
│  │   edges(id, source, target, type, properties)      │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Database Choice: SQLite

SQLite was chosen for:
- **Zero configuration**: No separate DB server needed
- **Free-tier friendly**: Single file, portable, no hosting costs
- **Sufficient for graph modeling**: With nodes/edges tables and JSON property storage, SQLite effectively models a property graph
- **json_extract() support**: Enables querying into JSON properties for dynamic schema

### Schema
```sql
CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, properties TEXT);
CREATE TABLE edges (id TEXT PRIMARY KEY, source TEXT, target TEXT, type TEXT, properties TEXT);
```

Node IDs follow the format `{entity_type}::{primary_key}` (e.g., `sales_order::740506`).

## Graph Modeling

### Entity Normalization
Raw JSONL directory names are normalized to clear business entities:

| Raw Entity | Normalized Label |
|---|---|
| sales_order_headers | `sales_order` |
| sales_order_items | `sales_order_item` |
| outbound_delivery_headers | `delivery` |
| billing_document_headers | `invoice` |
| business_partners | `customer` |
| products | `product` |
| payments_accounts_receivable | `payment` |
| plants | `plant` |

### Relationship Inference
Edges are built by detecting SAP standard field names and mapping them to target entities:

| Field Name | Edge Type | Target Entity |
|---|---|---|
| SalesOrder, SalesDocument | BELONGS_TO_ORDER | sales_order |
| DeliveryDocument | HAS_DELIVERY | delivery |
| BillingDocument | HAS_INVOICE | invoice |
| SoldToParty, Customer | SOLD_TO / HAS_CUSTOMER | customer |
| Product, Material | HAS_PRODUCT | product |
| Plant | AT_PLANT | plant |

## Natural Language → Query Approach

### Dual-Path Architecture:

**Path 1 — LLM (Google Gemini Free Tier)**
1. User query is sent to Gemini with a detailed schema prompt describing all tables, labels, edge types, and field names
2. Gemini generates a SQLite SELECT query
3. Query is executed against the graph database
4. Results are sent back to Gemini for natural language summarization
5. Both the summary and graph visualization are returned

**Path 2 — Rule-Based Fallback** (when no API key or LLM fails)
1. Intent detection: classifies query as TOP_PRODUCTS_BILLING, TRACE_LIFECYCLE, BROKEN_FLOW, or ENTITY_LOOKUP
2. Synonym resolution: maps user terms to entity labels (e.g., "customer" → `customer`, "order" → `sales_order`)
3. ID extraction: detects numeric IDs (4+ digits) for specific lookups
4. Multi-hop traversal: for lifecycle traces, follows edges 2 hops deep
5. Fuzzy fallback: LIKE search on properties, IDs, and labels

### LLM Prompt Engineering
The schema prompt includes:
- Full table definitions with column types
- All 19 node labels with their key fields
- All edge types with source/target descriptions
- Node ID format conventions
- Safety rules (SELECT only, LIMIT enforcement)

## Guardrails

The system enforces strict relevance checking:
1. **Keyword whitelist**: Query must contain at least one domain-relevant term (order, product, delivery, billing, customer, etc.)
2. **Off-topic rejection**: Returns exactly: `"This system only answers questions related to the provided dataset."`
3. **SQL safety**: LLM-generated queries are validated to be SELECT-only before execution
4. **No hallucination**: All answers are backed by actual database results. The LLM summarizes data, never invents it.

## Setup Steps

### Prerequisites
- Node.js 18+
- (Optional) Google Gemini API key for LLM-powered queries

### Installation
```bash
npm install
```

### Configuration (Optional — for LLM mode)
```bash
export GEMINI_API_KEY=your_key_here
```
Get a free key at: https://ai.google.dev

### Running
```bash
npm run dev
```

### Usage
1. Open http://localhost:3000
2. Click **"⚡ Load Dataset"** to ingest the ZIP and build the graph
3. Query via the chat panel
4. Click nodes to inspect properties
5. Click **"⊕ Expand"** on a selected node to load its neighbours

### Example Queries
- `Which products are associated with the highest number of billing documents?`
- `Trace the full flow of sales order 740506`
- `Show all deliveries that were not billed`
- `Show customers`
- `How many payments are there?`

## Tech Stack
| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Database | SQLite3 |
| LLM | Google Gemini 2.0 Flash (free tier) |
| Graph Viz | Cytoscape.js |
| Frontend | Vanilla HTML/CSS/JS |
