# AGENTS.md

## Agent skills

### Issue tracker

Local markdown in `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five roles as `Status:` values. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. Before exploring domain code, read `docs/agents/domain.md`.

### Research

Save research notes in `.scratch/research/<topic>.md` (gitignored).

## Verify

1. `bun run typecheck`, `bun run check`, `bun run test` (needs Postgres and migrated `chat_test`).
2. Before E2E, check frontend `http://localhost:4417` and backend `http://localhost:4100`. Start missing services with `bun run dev` and `bun run dev:backend`, wait for readiness, and check both again. Verify with agent-browser:
   - stream a reply
   - reload and confirm the reply is still there
   - force a failure and retry it (`CHAT_VERIFICATION_STREAM_ERROR_RATE`, see README)

   Wait for hydration before clicking.

No frontend tests; verify frontend behavior only through browser automation.

Agent-written automated tests are throwaway verification; remove them before committing unless the user explicitly requested tests and their boundaries, granularity, and coverage were discussed. Preserve pre-existing tests unless removal is requested.

The verification gate does not require a build.
