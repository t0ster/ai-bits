# nasa-rag

Retrieval-augmented question answering over NASA e-books, with cited answers and Ragas/Langfuse evals.

## Setup

Requires Python 3.14, [uv](https://docs.astral.sh/uv/), and PostgreSQL with pgvector.

Infra: PostgreSQL 17 + pgvector on 127.0.0.1:5432 (postgres/postgres).
Use your own, then create the database: `psql postgresql://postgres:postgres@127.0.0.1:5432/postgres -f docker/postgres-init.sql`.
Or run `docker compose up -d` (runs the init script itself).

```sh
cp .env.local.example .env.local   # fill in keys
uv sync
```

## Usage

```sh
uv run cli/download_nasa_books.py               # PDFs/EPUBs into data/nasa/
uv run cli/rag.py ingest-nasa                  # index them
uv run cli/rag.py ask "How did the X-15 handle reentry heating?"
uv run cli/ragas_evals.py --dataset nasa-rag-reference-v1 --description "Baseline"
```

Run `--help` on any command for options.

Generate a synthetic Ragas dataset from indexed chunks:

```sh
uv run cli/ragas_generate.py --size 5 --chunk-limit 20 --output datasets/generated.json
```
