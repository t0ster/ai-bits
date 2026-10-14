- Use `langfuse --env .env.local api ...` for Langfuse CLI commands.

## Agent skills

### Issue tracker

Local markdown in `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five roles as `Status:` values. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. Before exploring domain code, read `docs/agents/domain.md`.

### Research

Save research notes in `.scratch/research/<topic>.md` (gitignored).

## Verification

- Run `uv run basedpyright`, `uv run ruff check .`, `uv run ruff format --check .`, and `uv run tach check`.
- Verify affected behavior through real CLI commands (`uv run cli/rag.py health`, `ask`, etc.).
- Agent-written tests are throwaway; remove before committing unless explicitly requested. Preserve pre-existing tests.
