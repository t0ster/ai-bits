# Issue tracker: Local Markdown

Issues and specs live in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- Spec: `.scratch/<feature-slug>/spec.md`.
- Tickets: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,
  numbered from `01`, one file per ticket.
- Triage state: `Status:` near the top; use `triage-labels.md`.
- Append conversation under `## Comments`.

## Publish and fetch

To publish, create the appropriate file and parent directories.
To fetch, read the referenced ticket path.

## Wayfinding operations

- Map: `.scratch/<effort>/map.md`, containing Notes,
  Decisions-so-far, and Fog.
- Child: `.scratch/<effort>/issues/NN-<slug>.md`.
  Put the question in the body; record
  `Type: research|prototype|grilling|task`.
- Wayfinding uses its own lifecycle: open → claimed → resolved.
- Dependencies: `Blocked by: NN, NN`.
  Unblocked means all listed tickets are resolved.
- Frontier: open, unblocked, unclaimed tickets; lowest number first.
- Claim: save `Status: claimed` before starting.
- Resolve: append `## Answer`, set `Status: resolved`,
  and add a gist plus ticket link to the map's Decisions-so-far.
