# Domain Docs

## Layout and reading rules

Single-context repo:
- `GLOSSARY.md` at the root.
- ADRs in `docs/adr/`.

Before exploring domain code, read the glossary and ADRs relevant
to the area being changed.

If these files do not exist, proceed silently.
Domain-modeling creates them lazily as terms and decisions resolve.

## Vocabulary

Use glossary terms in issue titles, proposals, hypotheses, and
test names. Avoid synonyms the glossary rejects.

For missing concepts, reconsider invented language or note a gap
for domain-modeling.

## ADR conflicts

Explicitly surface contradictions with existing ADRs, identifying
the ADR and explaining why reopening the decision is warranted.
