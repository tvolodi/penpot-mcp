# Development workflow

Every new feature or nontrivial change follows these steps, in order. Don't
skip a step or collapse them — each one has caught real problems in this
project before.

1. **Requirements** — before writing code, state what the feature must do
   and how it will be verified, in a sentence or two. For anything touching
   Penpot's RPC/wire schema (new shape types, new fields, new change ops),
   check the actual Penpot source (`shape.cljc`, the RPC method schemas) or
   the plugin API rather than guessing field names/casing. If the user's
   ask is ambiguous or has more than one reasonable approach, ask before
   building.
2. **Code** — implement the feature. Follow the conventions already in
   `shape-builders.ts`/`src/tools/*.ts`: camelCase in the tool's input
   schema, translated to Penpot's kebab-case wire format at the boundary.
3. **Tests** — add coverage in the matching suite (see "Testing" in
   README.md):
   - **Unit** (`test/unit/`) for pure logic — geometry/matrix math, request
     shaping, camelCase-in/kebab-case-out normalization, anything that
     doesn't need a live Penpot instance. Runs in CI on every push/PR.
   - **Integration** (`test/integration/`) for anything that exercises a
     real MCP tool handler against Penpot's RPC API. These create their own
     scratch project and clean up in a `finally` block (see
     `test/integration/helpers/scratch-project.ts`). Local/manual only,
     never CI — Penpot accepting a change over RPC is not proof Penpot's
     editor renders it correctly, so a schema-only unit test is not a
     substitute for a live integration test when wire format is involved.
4. **Run the tests and fix failures before considering the feature done.**
   `npm test` (unit) and, when the change touches Penpot's wire schema or a
   tool handler, `npm run test:integration` too (requires `PENPOT_BASE_URL`/
   `PENPOT_ACCESS_TOKEN` in `.env` — skips itself otherwise). `npm run
   typecheck` should also pass. Don't report a feature complete with known
   failing tests or type errors.
5. **Record what shipped.** This project tracks features as a checklist in
   the README's "Possible future additions" section: mark the item `[x]`
   and add a `(Done — ...)` note summarizing what was built, any wire-format
   gotchas hit along the way (see existing entries for the level of detail —
   e.g. `penpot_reorder_shapes`, `penpot_checkpoint`), and any deliberate
   deviation from the original plan. If the change reveals a real constraint
   rather than a gap to fix later, add it to "Known limitations" instead.
   If it's a new tool, also add it to the relevant reference section
   earlier in the README (tool list, schema tables, etc.) so the README
   stays the single source of truth for what the server can do.

## Notes specific to this repo

- No network/Penpot account should ever be required for `npm test` to pass.
  If a test needs either, it belongs in the integration suite, not unit.
- Prefer verifying live against Penpot before trusting that a schema change
  is correct — this codebase has hit more than one case where a malli
  validation error or silent misrender only showed up under live testing
  (documented in README.md's "Known limitations" / changelog entries).
