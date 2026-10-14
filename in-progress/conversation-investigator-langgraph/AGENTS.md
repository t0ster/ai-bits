## Agent skills

### Issue tracker

Local markdown in `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five roles as `Status:` values. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. Before exploring domain code, read `docs/agents/domain.md`.

### Research

Save research notes in `.scratch/research/<topic>.md` (gitignored).

### Package boundaries

Packages are deep modules: see [packages/README.md](./packages/README.md) before adding or importing one.

### Scope boundaries

Before proposing or implementing, read the relevant topic in `.out-of-scope/`.
These record agreed exclusions and rationale; explicit user requests can reopen them.

## Verification

Use uv. For small code changes, run type checking, lint, and import-boundary checks:

```sh
uv run basedpyright
uv run ruff check .
uv run tach check
```

Before committing code changes, run `uv run ruff format --check .`.
Batch end-to-end verification; run it before committing or after a large chunk
of work. Verify affected behavior with real CLI commands in Herdr against local
Redis, PostgreSQL, and the configured model endpoint. Run the worker in one pane
and client commands in another. Use the Herdr CLI even when this agent runs
outside Herdr.

Programmatic tests are throwaway; remove any created for verification afterward.
