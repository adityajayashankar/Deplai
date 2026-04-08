# KG agent

This folder contains only the Knowledge-Graph (KG) agent components so you can move them into another project.

## Included

- `main.py` - interactive CLI entry point.
- `pipeline/` - LangGraph agent, tools, Neo4j connector, HITL policy.
- `pipeline/graphrag/` - GraphRAG retriever, schema, qdrant connector, embeddings, indexer.
- `scripts/kg/` - KG load scripts for Neo4j.
- `scripts/maintenance/graphrag_embed_index_qdrant_cpu.py` - embedding + Qdrant upsert.
- `scripts/maintenance/validate_kg.py` - KG validation checks.
- `vuln-graph-backend/server.js` - optional Node API over Neo4j.
- `.env.example` - KG-agent-only env template (no secrets).
- `.env.template` - alternate template name for tooling that expects this convention.

## Quick start

1. Create env and install deps:

```powershell
cd "KG agent"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.template .env
```

2. Run the agent:

```powershell
python main.py
```

## Notes

- Keep your real API keys in `KG agent/.env` only.
- If Neo4j is unavailable, some tools fall back to local JSON files (if present).
- For vector retrieval, set `GRAPHRAG_USE_VECTOR=1` and configure Qdrant vars.
