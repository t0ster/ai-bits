# Conversation Investigator

Ask questions about support conversations; get reports with verbatim, validated citations.
LangGraph agent with hybrid search (keyword + embeddings), a BullMQ worker, Redis, and PostgreSQL (pgvector).

## Setup

Requires uv, Python 3.12+, Redis, PostgreSQL with the `vector` extension, and an OpenAI-compatible endpoint.

Infra: PostgreSQL 17 + pgvector on 127.0.0.1:5432 (postgres/postgres) and Redis on 127.0.0.1:6379.
Use your own, then create the database: `psql postgresql://postgres:postgres@127.0.0.1:5432/postgres -f docker/postgres-init.sql`.
Or run `docker compose up -d` (runs the init script itself).

```sh
uv sync --locked
cp .env.example .env   # fill in
uv run cli setup-database
uv run cli ingest fixtures/conversations.jsonl
```

## Run

```sh
uv run python -m worker
uv run cli investigation start "Find refund complaints" --investigation-id inv-1 --request-id req-1
uv run cli investigation get inv-1
uv run cli investigation reply "September 2026" --investigation-id inv-1 --clarification-id <id> --request-id req-2
```

Ambiguous scope pauses for clarification. Commands print JSON. Request IDs must be unique.

## Demo UI

```sh
uv run --group demo uvicorn api:app --port 8000
cd demo-ui && bun install && bun run dev   # http://localhost:5173
```
