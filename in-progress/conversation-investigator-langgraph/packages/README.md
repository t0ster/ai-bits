# packages/

Each package is a deep module: a lot of behaviour behind a small interface.
`uv run tach check` enforces the rules below.

```
packages/<name>/
  __init__.py         optional; re-exports a few public symbols only
  <use_case>.py       entry points, e.g. start_investigation.py, jobs.py
  lib/                implementation (or lib.py for small packages)
  tach.domain.toml    public interface: symbols other code may import
```

## Rules

1. **Interface only.** Code outside a package may import only the symbols listed
   in that package's `tach.domain.toml` `expose` list. Everything else is private.
2. **Intra-package freedom.** A package's own files import each other freely.
3. **Explicit dependencies.** Importing another package must be allowed in
   `tach.toml`, by `depends_on` or by layers.

Keep `__init__.py` re-exports to a few symbols; never re-export a whole subtree.
Prefer adding a small entry-point file over growing `__init__.py`.

## Adding a package

Create `packages/<name>/` with entry-point files, `lib/`, and a
`tach.domain.toml` listing its public symbols. Run `uv run tach check`.
