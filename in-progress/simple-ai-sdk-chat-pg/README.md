# simple-ai-sdk-chat-pg

Vercel AI SDK v7 chat with durable Postgres threads, retry, model tools, and a slash command.

- `frontend/`: TanStack Start + React 19, `@ai-sdk/react`, Tailwind 4, and the shadcn `ai-elements` components. It proxies `/api/threads/*` to the backend. An encrypted `user-id` session cookie holds the anonymous visitor ID and the selected thread.
- `backend/`: Bun + h3, AI SDK `streamText` on the OpenAI Responses API, Drizzle + `pg`, neverthrow, and a citty CLI.
  - Each turn is claimed in Postgres. A heartbeat keeps the turn alive; turns with a stale heartbeat are marked failed and can be retried.
  - Generation runs to completion even if the client disconnects.
- `shared/`: wire types, the model tool and command schemas, and typed error keys (`i18n.ts`).


## Setup

Infra: PostgreSQL 17 on 127.0.0.1:5432 (postgres/postgres).
Use your own, then create the databases: `psql postgresql://postgres:postgres@127.0.0.1:5432/postgres -f docker/postgres-init.sql`.
Or run `docker compose up -d` (runs the init script itself).

```sh
bun install
cp backend/.env.example backend/.env    # set OPENAI_API_KEY (and OPENAI_BASE_URL if needed)
cp backend/.env.test.example backend/.env.test
cp frontend/.env.example frontend/.env  # set SESSION_SECRET (32+ chars)
bun run --cwd backend db:migrate
bun run --cwd backend db:migrate:test
```

Database URLs:

- dev: `postgres://postgres:postgres@127.0.0.1:5432/chat` (`backend/.env`)
- test: `postgres://postgres:postgres@127.0.0.1:5432/chat_test` (`backend/.env.test`)

The test database name must contain `test`. Tests truncate it.

## Run

```sh
bun run dev:backend   # http://localhost:4100
bun run dev           # http://localhost:4417
```

Or run the backend in Docker. The container migrates the dev database on start and reads `backend/.env`:

```sh
docker compose --profile backend up --build
```

Try `/help`, "What time is it in Tokyo?", or "Roll 3 six-sided dice."

## Verify

```sh
bun run typecheck
bun run check
bun run test          # backend integration tests; fake OpenAI server, real Postgres
```

To exercise retry end to end, start the backend with `CHAT_VERIFICATION_STREAM_ERROR_RATE=1`, send a message, restart the backend at `0`, and press "Try again".

## Telemetry

- OpenTelemetry spans print to stdout through `ConsoleSpanExporter`.
  - Each request gets an HTTP span. Each turn gets a `chat.turn` span.
  - AI SDK spans and Postgres spans are included.
- When `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, spans are also sent to Langfuse. User and thread IDs propagate as Langfuse user and session IDs.

## Backend CLI

```sh
bun run --cwd backend cli thread --help
```
