# AGENTS.md

## Commits

- Monorepo: Conventional Commits with project dir as scope: `feat(nasa-rag): …`.
- One project per commit; omit scope for repo-root changes.

## Infra

- Use already-running Postgres/Redis on default ports; else `docker compose up -d`.
