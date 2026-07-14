# penpot-headless

A portable MCP server for headless Penpot project/file/content management,
using Penpot's RPC API directly. No browser, no Penpot plugin session.

This package has **zero project-specific knowledge** — no hardcoded colors,
fonts, or Penpot instance URL. Every consuming project supplies its own
config and token file, so it can be installed from npm or copied as-is into
another project.

## What this does

- Team/project/file/page CRUD (`penpot_list_teams`, `penpot_create_file`, etc.)
- Shape creation — `rect`, `frame`, `text` — via `penpot_add_shapes`, with
  colors/fonts resolved either from a literal value or a
  `{ "token": "name" }` reference against your project's token file.
  Shapes may be rotated via an optional `rotation` field (degrees,
  clockwise, about the shape's center).
- Shape editing: `penpot_update_shapes` changes an existing shape in place
  by id — position, size, rotation, name, fill, stroke, corner radii, or
  (for text) content/font. Only the fields you pass are touched; everything
  else (children, component/variant tags, layout) is left as-is. Geometry
  changes automatically recompute the shape's selection box and transform,
  so a partial edit (e.g. just `width`) can't desync from the rest of the
  shape's geometry. Layout/layoutItem aren't editable this way — only
  settable at creation time via `penpot_add_shapes`.
- Auto-layout: a `frame` may declare flex or grid layout via an optional
  `layout` field (direction, gap, padding, alignment; grid also takes
  row/column track definitions). Any shape may set `layoutItem` to control
  its own placement within an auto-layout parent (sizing, alignment,
  margins, min/max size, and — for grid parents — row/column/span).
- Components: `penpot_create_component` registers a shape tree (same specs
  as `penpot_add_shapes`) as a component's main instance; give shapes
  explicit `id`s to nest them, and the one shape not parented to a sibling
  becomes the root. `penpot_add_component_instance` then places a full
  copy of that tree elsewhere on a page, linked back to the main instance
  via Penpot's `shape-ref` so it's recognized as a proper component copy —
  reusable any number of times.
- Variants: `penpot_create_variant_group` groups two or more components
  (built the same way as `penpot_create_component`, one per variant) into a
  single container tagged with shared property axes (e.g. a "Button" with
  Type=Primary/Secondary). This wires up Penpot's actual variant-swap
  system — confirmed live via the Penpot plugin API, including
  `instance.switchVariant(pos, value)` correctly swapping a placed
  instance between variants.
- Reading a file's current shape tree via `penpot_get_file_snapshot`.
- Rendering a shape or page to PNG/SVG via `penpot_export_shape` (requires
  `PENPOT_LOGIN_EMAIL`/`PENPOT_LOGIN_PASSWORD`, see below) — no browser tab
  or Penpot plugin session needed on your end.

## Render/export capability

`penpot_export_shape` renders a shape (or an entire page, by passing its
root frame's id) to PNG or SVG, using Penpot's own server-side exporter —
the same headless-Chromium-backed service Penpot's self-hosted stack
already runs (the `penpotapp/exporter` container). No browser automation
happens in this package; it's two HTTP calls (login, then export) against
your Penpot instance.

This needs a **second, separate auth mode** from the rest of this package:
Penpot's export pipeline (`POST /api/export`) is a distinct microservice
from the `/api/rpc/command/*` surface everything else here uses, and it
authenticates purely via a session cookie — a personal access token in an
`Authorization` header is never read on this path (confirmed by reading
Penpot's exporter source: its `wrap-auth` looks for a literal `auth-token`
cookie and nothing else). So this tool logs in with
`PENPOT_LOGIN_EMAIL`/`PENPOT_LOGIN_PASSWORD` to obtain that cookie,
independently of `PENPOT_ACCESS_TOKEN`.

**Important:** `PENPOT_ACCESS_TOKEN` and `PENPOT_LOGIN_EMAIL`/
`PENPOT_LOGIN_PASSWORD` must belong to **the same Penpot account** (or at
least accounts with access to the same team). If they're different
accounts, `penpot_export_shape` will time out — the export session can't
see a file it has no permission to open, and Penpot's exporter doesn't
distinguish "shape not visible" from "access denied," so the failure surfaces
as a generic 10-second render timeout.

If your Penpot instance doesn't expose password login (e.g. SSO-only
instances), or you'd rather not configure these credentials, simply omit
`PENPOT_LOGIN_EMAIL`/`PENPOT_LOGIN_PASSWORD` — the export tool won't be
registered, and every other tool works exactly as before.

## Setup

1. Generate a Penpot access token: your Penpot instance → Account settings
   → Access tokens. (Self-hosted instances: this section is hidden unless
   the backend/frontend are started with `PENPOT_FLAGS` including
   `enable-access-tokens`.)
2. Create a token file for your project (see `design-tokens/*.tokens.json`
   in the consuming repo for an example — or write your own matching the
   schema below).
3. If you want `penpot_export_shape`, also set `PENPOT_LOGIN_EMAIL`/
   `PENPOT_LOGIN_PASSWORD` to the **same account** the access token above
   belongs to (see "Render/export capability" above for why). Skip this if
   you don't need rendering.
4. Register this server in your MCP client config, e.g.:
   ```json
   {
     "mcpServers": {
       "penpot-headless": {
         "command": "npx",
         "args": ["-y", "@ai-dala/penpot-headless"],
         "env": {
           "PENPOT_BASE_URL": "https://your-penpot-instance.example.com",
           "PENPOT_ACCESS_TOKEN": "your-token-here",
           "PENPOT_TOKENS_PATH": "/path/to/your-project/design-tokens/tokens.json",
           "PENPOT_LOGIN_EMAIL": "same-account-as-the-token-above@example.com",
           "PENPOT_LOGIN_PASSWORD": "that-account's-password"
         }
       }
     }
   }
   ```

   Or, if working from a local clone instead of the published package:
   ```json
   {
     "mcpServers": {
       "penpot-headless": {
         "command": "npx",
         "args": ["tsx", "/path/to/penpot-mcp/src/server.ts"],
         "env": {
           "PENPOT_BASE_URL": "https://your-penpot-instance.example.com",
           "PENPOT_ACCESS_TOKEN": "your-token-here",
           "PENPOT_TOKENS_PATH": "/path/to/your-project/design-tokens/tokens.json",
           "PENPOT_LOGIN_EMAIL": "same-account-as-the-token-above@example.com",
           "PENPOT_LOGIN_PASSWORD": "that-account's-password"
         }
       }
     }
   }
   ```

## Token file schema

```json
{
  "colors": {
    "accent": "#7AA2FF",
    "bg-surface": "#111726"
  },
  "fonts": {
    "sans": { "family": "Inter", "weights": ["400", "500", "600"] }
  }
}
```

Any color-typed field in `penpot_add_shapes` accepts either a literal hex
string or `{ "token": "accent" }`, resolved against this file at call time.

## Testing

Two suites, split because they need very different things:

- **Unit** (`npm test`) — pure functions in `shape-builders.ts` (rotation
  matrix math, layout attribute mapping, the camelCase-in/kebab-case-out
  shape extraction `penpot_update_shapes` relies on). No network, no Penpot
  account, runs anywhere. This is the suite CI runs on every push/PR.
- **Integration** (`npm run test:integration`) — exercises the actual MCP
  tool handlers against a real Penpot instance via `PENPOT_BASE_URL`/
  `PENPOT_ACCESS_TOKEN` (reads `.env`, same as the server itself). Each
  test creates its own scratch project and deletes it in a `finally` block,
  even on failure — see `test/integration/helpers/scratch-project.ts`.
  Skips itself (doesn't fail) if credentials aren't configured. **Local/
  manual only — deliberately not run in CI**, since it mutates a real
  Penpot account and CI credentials for that are out of scope for this
  project. Run it yourself before trusting a change to Penpot's wire
  schema (rotation, layout, components, variants).

This split matters because Penpot's RPC schema accepting a change is not
the same as Penpot's editor correctly rendering or recognizing it — the
variant-id bug documented in `shape-builders.ts` (`variantContainerAttrs`)
was only caught by live testing, not by the schema validating successfully.
`npm run test:all` runs both.

## Copying to another project

This package is published to npm as `@ai-dala/penpot-headless`, so most
consuming projects can just reference it via `npx` (see above) without a
local copy.

If you'd rather vendor it, this directory has its own
`package.json`/`tsconfig.json` and depends only on
`@modelcontextprotocol/sdk` and `zod` — no framework dependencies. Copy the
whole `penpot-headless/` directory into the new project, run `npm install`,
write a token file for that project, and register the server with a
`PENPOT_TOKENS_PATH` pointing at it.

## Known limitations

- `penpot_export_shape` requires password-login credentials for the same
  account as the access token — see "Render/export capability" above.
  Instances that are SSO/OIDC-only (no password login) can't use it.
- `penpot_create_variant_group` only builds new variant groups from scratch;
  there's no tool to add a variant to an already-existing component/group,
  since that requires reparenting an existing shape into the group's
  container, and this package's `mov-objects` RPC calls were found not to
  actually move shapes (accepted, but silently a no-op) — see the note on
  `variantContainerAttrs` in `shape-builders.ts`.
- `penpot_update_shapes` can't change layout/layoutItem, and only supports
  rect/frame/text (not path/group/circle/svg-raw/image/bool).

## Possible future additions

Ideas for further reducing agent friction, roughly in priority order:

- [x] `penpot_update_shapes` — edit an existing shape's geometry/fill/stroke/
      text in place. (Done — see above.)
- [ ] `penpot_delete_shapes` — wraps `del-obj`; currently the only way to
      remove a shape is not to create it in the first place.
- [ ] `penpot_get_shape` — look up one shape (or a small subtree) by id,
      instead of pulling the whole page via `penpot_get_file_snapshot` and
      parsing a potentially large JSON blob client-side to find it.
- [ ] `penpot_measure_text` — text `width`/`height` in `penpot_add_shapes`
      are just numbers the caller has to guess; Penpot only knows real
      rendered bounds after layout. A dry-run measurement (or an
      "auto-size" flag) would remove a lot of trial-and-error resizing.
- [ ] `penpot_clone_shapes` — plain-shape duplication (not the
      component-instance path already covered by
      `penpot_add_component_instance`).
- [ ] `penpot_reorder_shapes` — wraps `reorder-children` (seen in the malli
      schema dump during the variants investigation); z-order is currently
      fixed at creation order with no bring-to-front/send-to-back.
- [ ] `penpot_list_components` — enumerate a file's existing components,
      instead of requiring the caller to have created them itself in the
      same session or parse the snapshot's `components` map by hand.
- [ ] `penpot_find_shapes` — predicate/name-based search over a page
      (mirrors the plugin API's `findShapes`), instead of the caller
      walking the tree itself for "every text shape" or "the shape named X."
