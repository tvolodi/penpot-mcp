# penpot-headless

A portable MCP server for headless Penpot project/file/content management,
using Penpot's RPC API directly. No browser, no Penpot plugin session.

This package has **zero project-specific knowledge** — no hardcoded colors,
fonts, or Penpot instance URL. Every consuming project supplies its own
config and token file, so it can be installed from npm or copied as-is into
another project.

## What this does

- Team/project/file/page CRUD (`penpot_list_teams`, `penpot_create_file`, etc.)
- Shape creation — `rect`, `frame`, `text`, `circle` (ellipse), `path`, `bool` (boolean
  operations), and `image` — via `penpot_add_shapes`, with
  colors/fonts resolved either from a literal value or a
  `{ "token": "name" }` reference against your project's token file. The
  same token-or-literal pattern applies to spacing (layout gaps/padding,
  layoutItem margins/min/max sizes), corner radii (`r1`-`r4`), and shadows
  (`shadows`, either an inline `{ style, color, offsetX, offsetY, blur,
  spread, opacity }` object or `{ "token": "name" }`). Shapes may be rotated
  via an optional `rotation` field (degrees, clockwise, about the shape's
  center).
- Shape editing: `penpot_update_shapes` changes an existing shape in place
  by id — position, size, rotation, name, fill, stroke, shadows, corner
  radii, or (for text) content/font. Only the fields you pass are touched;
  everything else (children, component/variant tags, layout) is left as-is.
  `clearStroke`/`clearShadows` remove strokes/shadows entirely. Geometry
  changes automatically recompute the shape's selection box and transform,
  so a partial edit (e.g. just `width`) can't desync from the rest of the
  shape's geometry. Layout/layoutItem aren't editable this way — only
  settable at creation time via `penpot_add_shapes`.
- Shape deletion: `penpot_delete_shapes` removes one or more existing
  shapes from a page by id. Deleting a frame or group also removes its
  children, matching Penpot's own delete behavior.
- Shape grouping: `penpot_group_shapes` wraps one or more sibling shapes into
  a new group (Ctrl+G equivalent) — all shapes must share the same parent.
  The group is inserted at the topmost selected shape's z-order position and
  its bounding box is computed from the children's rotation-aware `selrect`s.
  `penpot_ungroup_shapes` dissolves a group (Ctrl+Shift+G equivalent):
  children are reparented to the group's former parent at the group's
  z-order slot, then the group is deleted.
- Shape duplication: `penpot_clone_shapes` duplicates one or more existing
  shapes (and, for frames/groups, their full descendant subtree), each with
  fresh ids — plain shape duplication, like Penpot's own Ctrl+D, not a
  component instance. Optional `dx`/`dy` offset each clone from its source
  (defaults to no offset, stacked directly on top of the original); optional
  `parentId`/`frameId` reparent every cloned root instead of leaving it
  alongside its source.
- Shape stacking order: `penpot_reorder_shapes` changes a shape's z-order
  among its siblings, matching Penpot's own "Bring to front" / "Send to
  back" / "Forward" / "Backward" UI actions. `action` is `front`/`back`
  (top/bottom of the stack), `forward`/`backward` (swap with the next/
  previous sibling — a no-op if already at that end), or `before`/`after`
  (place immediately relative to another sibling given as `targetId`).
  Only reorders among existing siblings — it doesn't reparent.
- Align & distribute: `penpot_align_shapes` lines up two or more shapes on a
  common edge or center (`left`/`right`/`top`/`bottom`/`center-h`/`center-v`),
  and `penpot_distribute_shapes` spreads three or more shapes so the gaps
  between them are equal (`horizontal`/`vertical`) — matching Penpot's own
  one-click align/distribute actions, instead of the agent computing pixel
  positions itself. Both work on each shape's visible bounding box (its
  `selrect`), so rotated shapes line up by their rendered bounds; align never
  moves the group as a whole, and distribute leaves the two outermost shapes
  fixed. Aligning or distributing a frame/group carries its whole child
  subtree along by the same offset.
- Batched edits: `penpot_batch` applies an ordered list of create/update/
  delete/reorder operations as a single `update-file` change-set — one
  `revn`/`vern` round trip no matter how many shapes are touched, instead of
  one RPC call per shape (and the races on `revn` that come with that). Each
  op takes the same fields as the matching standalone tool (`penpot_add_shapes`
  for `create`, `penpot_update_shapes` for `update`, etc.); a `create` op may
  set an explicit `id` and be referenced as a later op's `parentId`/`frameId`
  or targeted by a later `update`/`delete`/`reorder` in the same call, so a
  whole form or card grid can be built in one round trip.
- Undo point: `penpot_checkpoint` snapshots shapes and returns a `checkpointId`;
  `penpot_restore_checkpoint` undoes everything since — including a wrong
  `penpot_delete_shapes` call, which otherwise has no undo path short of
  Penpot's own UI. Supply `pageId` to scope the snapshot to a single page; omit
  `pageId` for a whole-file checkpoint that covers every page. Works by diffing
  current state against the snapshot and replaying corrective changes as a single
  `update-file` call (recreate what's missing, delete what's new, overwrite what
  changed back to its snapshotted fields), since Penpot's RPC has no "revert to
  revn X" primitive. Checkpoints live in the MCP server's memory (not the Penpot
  file, not disk) and are reusable — restore to the same point as many times as
  you like — until explicitly freed via `penpot_discard_checkpoint` or the server
  process restarts.
- Shape lookup: `penpot_get_shape` fetches a single shape by id, without
  pulling the whole page via `penpot_get_file_snapshot`. By default nests
  the shape's full descendant subtree under `shapes`; `includeDescendants`
  and `maxDepth` control how much of the subtree comes back. Always includes
  a `componentInfo` field: `linkState` (`"linked"` / `"detached"` /
  `"not-an-instance"` / `"main-component-root"`), and — for same-file linked
  instances — a `driftedFields` array listing the camelCase field names that
  differ from the main component's current definition (empty = fully in sync).
- Shape search: `penpot_find_shapes` searches every shape on a page against
  one or more predicates — `type`, `name` (exact match), `nameContains`
  (case-insensitive substring), `textContains` (case-insensitive substring
  against a text shape's rendered characters), `isComponentInstance`, and/or
  `isRoot` — all given filters must match (AND). Omit every filter to list
  the whole page. Returns each match's id/type/name/position/size plus
  `linkState` and (for linked same-file instances) `driftedFields`; use
  `penpot_get_shape` on a match's id for the full subtree and detailed
  `componentInfo`, optionally capped via `limit`.
- Text measurement: `penpot_measure_text` computes the real rendered
  width/height of a string for a given font (family/size/weight), without
  creating or touching any shape — removing the guesswork around `width`/
  `height` when calling `penpot_add_shapes`/`penpot_update_shapes` for text.
  Tries Google Fonts first (by family name, no API key needed); if the family
  isn't there, searches all Penpot teams accessible to the configured token
  for a matching custom/team font, so fonts uploaded directly to your Penpot
  instance are also measurable. Measures real glyph advance widths (plus
  kerning) so the numbers match what Penpot renders. Splits on explicit `\n`;
  pass `maxWidth` to also get word-wrapped line breaks for a fixed-width box.
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
  instance between variants. `penpot_add_variant` adds a new variant to
  an already-existing variant group container: accepts the same shape specs
  as one entry in `penpot_create_variant_group`'s `variants` array and the
  `containerId` returned by that tool (or found via `penpot_find_shapes`),
  then appends the new variant's main instance to the container's `shapes`
  array and registers a new component — all in a single `update-file` call.
- `penpot_list_components` enumerates a file's existing components (from its
  `data.components` map), instead of requiring the caller to have created
  them itself in the same session or parse `penpot_get_file_snapshot`'s
  output by hand. Each entry includes the `componentId` (usable with
  `penpot_add_component_instance`), `name`, `mainInstanceId`/
  `mainInstancePage`, and — for variant components — `variantId`/
  `variantProperties`.
- Media upload: `penpot_upload_media` uploads an image or other asset to a Penpot
  file and returns the media object metadata (`id`, `width`, `height`, `mtype`).
  Accepts a local file path (`filePath`), a remote URL (`url` — Penpot's server
  fetches it directly), or base64-encoded bytes (`dataBase64` + `mtype`). The
  returned `id` is used as `mediaId` when creating an `image` shape.
- Comments: `penpot_list_comment_threads` lists all threads for a file;
  `penpot_get_comments` fetches replies inside a thread;
  `penpot_create_comment_thread` pins a new thread to a canvas position
  (x/y, optional `frameId`); `penpot_create_comment` adds a reply;
  `penpot_update_comment` edits a comment's text;
  `penpot_resolve_comment_thread` marks a thread resolved or reopens it;
  `penpot_delete_comment` removes a single reply;
  `penpot_delete_comment_thread` removes a whole thread.
- Version history: `penpot_list_file_snapshots` lists all named snapshots for a
  file; `penpot_create_file_snapshot` saves the current state as a named version
  (equivalent to "Save version" in the Penpot UI, with an optional `label`);
  `penpot_restore_file_snapshot` rolls the live file back to a snapshot (Penpot
  automatically saves a system backup before restoring, so restores are themselves
  undoable); `penpot_rename_file_snapshot` / `penpot_delete_file_snapshot` manage
  user-created versions; `penpot_lock_file_snapshot` / `penpot_unlock_file_snapshot`
  protect a version from accidental deletion; `penpot_get_file_snapshot_data` returns
  the full file content at a snapshot for read-only inspection.
- Reading a file's current shape tree via `penpot_get_file_snapshot`.
- Rendering shapes or pages to PNG/SVG/PDF via `penpot_export_shape` (single shape) and
  `penpot_export_batch` (multiple shapes in one call, returned in the same order, across any
  number of pages — use the `shapes` array for multi-page exports; the `shapeIds` shorthand
  is still available when all shapes share the same page) — requires
  `PENPOT_LOGIN_EMAIL`/`PENPOT_LOGIN_PASSWORD`, `PENPOT_OIDC_USERNAME`/`PENPOT_OIDC_PASSWORD`,
  or `PENPOT_AUTH_TOKEN_COOKIE`, see below — no browser tab
  or Penpot plugin session needed on your end.

## Render/export capability

`penpot_export_shape` renders a single shape (or an entire page, by passing its
root frame's id) to PNG, SVG, or PDF, using Penpot's own server-side exporter —
the same headless-Chromium-backed service Penpot's self-hosted stack
already runs (the `penpotapp/exporter` container). `penpot_export_batch`
accepts either a `shapeIds` array (all shapes on the same `pageId`) or a `shapes`
array where each entry can specify its own `pageId`, `format`, `scale`, and `name`
— enabling whole-file exports across multiple pages in a single API call. All
formats (PNG/SVG/PDF) are supported. No browser automation
happens in this package; it's two HTTP calls (auth, then export) against
your Penpot instance.

This needs a **second, separate auth mode** from the rest of this package:
Penpot's export pipeline (`POST /api/export`) is a distinct microservice
from the `/api/rpc/command/*` surface everything else here uses, and it
authenticates purely via a session cookie — a personal access token in an
`Authorization` header is never read on this path (confirmed by reading
Penpot's exporter source: its `wrap-auth` looks for a literal `auth-token`
cookie and nothing else), independently of `PENPOT_ACCESS_TOKEN`.

Three ways to supply this cookie — configure exactly one:

**Option A — password login** (`PENPOT_LOGIN_EMAIL` + `PENPOT_LOGIN_PASSWORD`):
The server logs in with email/password to obtain the `auth-token` cookie and
caches it for the process lifetime, re-logging-in automatically on expiry.
Best for instances that expose password login. `PENPOT_ACCESS_TOKEN` and
these credentials must belong to **the same Penpot account** (or at least
accounts with access to the same team); mismatched accounts cause a silent
10-second render timeout because the exporter can't distinguish "access
denied" from "shape not visible."

**Option B — headless OIDC/SSO login** (`PENPOT_OIDC_USERNAME` + `PENPOT_OIDC_PASSWORD`):
The server drives the OIDC redirect flow over plain HTTP: it follows
Penpot's OAuth endpoint redirect chain to the identity provider's login page,
parses the HTML login form, submits the credentials, and captures the
resulting `auth-token` cookie — no browser or external tooling needed.
Re-logs in automatically on expiry. Works for form-based IdPs that render a
standard HTML login form (Keycloak, Authentik, Dex, and similar). Does **not**
work for JavaScript-driven login pages (Google, Microsoft, Okta hosted login)
because their login UIs are SPA shells with no server-rendered form.

Set `PENPOT_OIDC_PROVIDER` to the OAuth provider name configured on your
Penpot instance (default: `"oidc"`). Most self-hosted setups use this
default; check your Penpot server flags if login doesn't start.

**Option C — pre-obtained SSO/OIDC cookie** (`PENPOT_AUTH_TOKEN_COOKIE`):
Paste the raw value of the `auth-token` cookie from a browser session in
which you already completed the OIDC/SSO login. The server uses it as-is
and emits a clear error if it expires (since it has no credentials to
re-login with). Works for instances where password login is disabled and
the IdP uses a JavaScript-driven login page (where Option B can't reach).
To obtain the cookie value:
1. Open your Penpot instance in a browser and complete the SSO/OIDC login.
2. Open DevTools → Application → Cookies → your Penpot domain.
3. Copy the value of the `auth-token` cookie (not the whole `Cookie:` header
   — just the token value after `auth-token=`).
4. Set `PENPOT_AUTH_TOKEN_COOKIE` to that value.

If none of the options is configured, `penpot_export_shape` is not registered and
every other tool works exactly as before.

## Setup

1. Generate a Penpot access token: your Penpot instance → Account settings
   → Access tokens. (Self-hosted instances: this section is hidden unless
   the backend/frontend are started with `PENPOT_FLAGS` including
   `enable-access-tokens`.)
2. Create a token file for your project (see `design-tokens/*.tokens.json`
   in the consuming repo for an example — or write your own matching the
   schema below).
3. If you want `penpot_export_shape`, also configure one of:
   - **Password login:** set `PENPOT_LOGIN_EMAIL`/`PENPOT_LOGIN_PASSWORD` to the
     **same account** the access token above belongs to.
   - **Headless OIDC login:** set `PENPOT_OIDC_USERNAME`/`PENPOT_OIDC_PASSWORD` to
     your IdP credentials. Works for form-based IdPs (Keycloak, Authentik, Dex).
     Set `PENPOT_OIDC_PROVIDER` if your provider name differs from the default `"oidc"`.
   - **SSO/OIDC cookie:** set `PENPOT_AUTH_TOKEN_COOKIE` to the raw `auth-token`
     cookie value from a browser session in which you completed the SSO login
     (see "Render/export capability" above). Use this for JavaScript-driven IdP
     login pages where headless OIDC can't reach.

   Skip this step entirely if you don't need rendering.
4. *(Optional)* To persist checkpoints across server restarts, set `PENPOT_CHECKPOINTS_PATH`
   to a local directory path. When set, each `penpot_checkpoint` call writes a JSON file
   to that directory; on startup the server reloads any files already there, so a
   checkpoint survives the MCP server being restarted mid-way through a long edit.
   The directory is created automatically. Without this setting, checkpoints live only
   in process memory (the previous behaviour).
5. Register this server in your MCP client config, e.g. (password-login variant):
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

   Or, for an SSO/OIDC-only instance with a form-based IdP (headless OIDC login):
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
           "PENPOT_OIDC_USERNAME": "your-idp-username-or-email",
           "PENPOT_OIDC_PASSWORD": "your-idp-password"
         }
       }
     }
   }
   ```

   Or, for an SSO/OIDC-only instance with a JavaScript-driven IdP login page:
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
           "PENPOT_AUTH_TOKEN_COOKIE": "the-auth-token-cookie-value-from-your-browser"
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
  },
  "spacing": {
    "sm": 8,
    "md": 16,
    "lg": 24
  },
  "radii": {
    "sm": 4,
    "md": 8,
    "pill": 999
  },
  "shadows": {
    "card": {
      "style": "drop-shadow",
      "color": "#000000",
      "opacity": 0.3,
      "offsetX": 4,
      "offsetY": 4,
      "blur": 8,
      "spread": 2
    }
  }
}
```

All four token tables are optional except `colors`. Any color-typed field
in `penpot_add_shapes`/`penpot_update_shapes` accepts either a literal hex
string or `{ "token": "accent" }`, resolved against this file at call time.
The same applies to:

- **Numeric fields** (layout gaps/padding, layoutItem margins/min/max
  sizes, and corner radii `r1`-`r4`) — either a literal number or
  `{ "token": "sm" }`, resolved against `spacing` (gaps/padding/margins) or
  `radii` (corner radii).
- **`shadows`** on a shape — an array where each entry is either an inline
  `{ style, color, opacity, offsetX, offsetY, blur, spread }` object (color
  itself may also be a `{ "token": "name" }` reference) or
  `{ "token": "card" }`, resolved against `shadows`. `style` is
  `"drop-shadow"` (default) or `"inner-shadow"`.

## Testing

Two suites, split because they need very different things:

- **Unit** (`npm test`) — pure functions in `shape-builders.ts` (rotation
  matrix math, layout attribute mapping, the camelCase-in/kebab-case-out
  shape extraction `penpot_update_shapes` relies on) and `font-metrics.ts`
  (line-splitting/word-wrap logic, measured against a hand-built fake font
  so no network call is needed). No network, no Penpot account, runs
  anywhere. This is the suite CI runs on every push/PR.
- **Integration** (`npm run test:integration`) — exercises the actual MCP
  tool handlers against a real Penpot instance via `PENPOT_BASE_URL`/
  `PENPOT_ACCESS_TOKEN` (reads `.env`, same as the server itself). Each
  test creates its own scratch project and deletes it in a `finally` block,
  even on failure — see `test/integration/helpers/scratch-project.ts`.
  Skips itself (doesn't fail) if credentials aren't configured. **Local/
  manual only — deliberately not run in CI**, since it mutates a real
  Penpot account and CI credentials for that are out of scope for this
  project. Run it yourself before trusting a change to Penpot's wire
  schema (rotation, layout, components, variants). `font-metrics.test.ts`
  also lives in this suite despite not needing Penpot credentials — it
  makes a real call to the public Google Fonts CDN, which the unit suite's
  "no network" rule excludes; it skips itself if that network call fails
  rather than needing `PENPOT_ACCESS_TOKEN`.

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
`@modelcontextprotocol/sdk`, `zod`, and `opentype.js` (used by
`penpot_measure_text` to parse real font files) — no framework
dependencies. Copy the whole `penpot-headless/` directory into the new
project, run `npm install`, write a token file for that project, and
register the server with a `PENPOT_TOKENS_PATH` pointing at it.

## Known limitations

- `penpot_measure_text` doesn't apply ligature substitution (e.g. rendering
  "fi" as one glyph) — it sums individual glyph advances (with real GPOS
  kerning) instead of using opentype.js's built-in shaping, because that
  shaping path throws on GSUB tables present in most current-generation
  Google Fonts, including Inter and Roboto (see `measureLineWidth` in
  `font-metrics.ts`). This is a deliberate tradeoff, not an open gap: the
  width difference from skipping ligatures is a few percent at most for
  typical UI text, next to a hard crash on most real-world fonts if the
  built-in shaping were used instead.
- `penpot_measure_text` matches Penpot custom/team fonts by family name
  (case-insensitive) and weight. If a font variant exists in multiple styles
  (normal/italic) for the same weight, the "normal" style is preferred; if
  your use-case requires a specific non-normal style for measurement, this
  is not yet controllable via the tool's input parameters.

## Possible future additions

Ideas for further reducing agent friction, roughly in priority order:

- [x] `penpot_update_shapes` — edit an existing shape's geometry/fill/stroke/
      text in place. (Done — see above.)
- [x] `penpot_delete_shapes` — wraps `del-obj`. (Done — see above.)
- [x] `penpot_get_shape` — look up one shape (or a small subtree) by id,
      instead of pulling the whole page via `penpot_get_file_snapshot` and
      parsing a potentially large JSON blob client-side to find it. (Done —
      see above.)
- [x] `penpot_measure_text` — text `width`/`height` in `penpot_add_shapes`
      are just numbers the caller has to guess; Penpot only knows real
      rendered bounds after layout. (Done — see above. Measures against a
      real fetched Google Font via opentype.js rather than an approximation;
      see the "Text measurement" note below and `font-metrics.ts` for why it
      sums per-glyph advances instead of using opentype.js's built-in
      `getAdvanceWidth`.)
- [x] `penpot_clone_shapes` — plain-shape duplication (not the
      component-instance path already covered by
      `penpot_add_component_instance`). (Done — see above.)
- [x] `penpot_reorder_shapes` — bring-to-front/send-to-back/forward/backward/
      before/after, by id. (Done — see above. Note: does *not* wrap
      `reorder-children` as originally planned — that RPC change type was
      never actually verified live. Instead it round-trips the parent shape
      through `add-obj` with a recomputed `shapes` array, the same mechanism
      `penpot_update_shapes` already uses; `reorder-children` may still work
      but wasn't worth the extra risk once the `add-obj` approach was
      confirmed live. One live-only pitfall found along the way: fields like
      `transformInverse`/`hideFillOnExport` on the object returned by
      `get-file` are real required fields, not stale camelCase duplicates —
      they must be renamed to their kebab-case form when round-tripped, not
      dropped, or `update-file` rejects the change with a malli validation
      error on `transform-inverse`.)
- [x] `penpot_list_components` — enumerate a file's existing components,
      instead of requiring the caller to have created them itself in the
      same session or parse the snapshot's `components` map by hand. (Done —
      see above.)
- [x] `penpot_find_shapes` — predicate/name-based search over a page
      (mirrors the plugin API's `findShapes`), instead of the caller
      walking the tree itself for "every text shape" or "the shape named X."
      (Done — see above.)
- [x] `penpot_batch` — apply an ordered list of create/update/delete/reorder
      ops as a single `update-file` change-set. (Done — see above. Ops are
      applied against an in-memory shadow of the page's shapes, mutated as
      each op is processed, so a later op sees the effect of every earlier
      op in the same call — mirroring how `update-file` applies its
      `changes` array sequentially server-side. This is also what lets a
      `create` op's caller-chosen `id` be referenced by a later op's
      `parentId`/`frameId`, or be the target of a later `update`/`delete`/
      `reorder`, without an extra RPC round trip in between.)
- [x] `penpot_checkpoint` / `penpot_restore_checkpoint` /
      `penpot_discard_checkpoint` — snapshot shapes before a risky multi-step
      edit, and restore them after. (Done — see above. Penpot's RPC has no
      "revert to revn X" primitive, so restore works by diffing current state
      against the snapshot and replaying corrective `add-obj`/`del-obj` changes
      as a single `update-file` call, reusing the same camelCase-in/kebab-case-out
      normalization already verified live for `penpot_update_shapes`/
      `penpot_reorder_shapes` — see `restoreShapeAsAddObj` in `shape-builders.ts`.
      Snapshots are held in the MCP server's own memory, not written to the Penpot
      file or disk, so a checkpoint doesn't survive a server restart.
      `penpot_checkpoint` now accepts an optional `pageId`: supply it to scope the
      snapshot to a single page; omit it for a whole-file checkpoint that covers
      every page. Restore applies all pages' corrective changes in one `update-file`
      call, so a multi-step edit that touched multiple pages is fully undone in a
      single round trip.)
- [x] `penpot_align_shapes` / `penpot_distribute_shapes` — the one-click
      align-left/center/distribute-evenly actions Penpot's own UI has, that
      this package doesn't. Without them, an agent has to compute pixel
      positions itself from `penpot_get_shape` results — exactly the kind
      of arithmetic LLMs get wrong. (Done — see above. Both operate on each
      shape's `selrect` (its rotation-aware visible bounding box), so rotated
      shapes line up by what's rendered; align never moves the group as a
      whole (its reference line comes from the shapes' own extent) and
      distribute leaves the two endpoints fixed. Aligning/distributing a
      frame or group moves its whole descendant subtree by the same delta —
      a container's children have absolute positions, so shifting only the
      container's own x/y would leave them behind. Reuses the same
      camelCase-in/kebab-case-out `add-obj` update path already verified live
      for `penpot_update_shapes`, applied as a single `update-file`
      change-set.)
- [x] Token file support for spacing/radii/shadows, not just `colors` and
      `fonts`. (Done — see above/Token file schema. Added a `shadows` wire
      field to `rect`/`frame`/`text` that didn't exist at all before this —
      verified live against a real instance's `add-obj`/`get-file`: the
      field is `shadows` (array, back-to-front like `fills`/`strokes`),
      `style` is `"drop-shadow"` | `"inner-shadow"` (not `shadowType` as the
      Penpot plugin API's `Shadow` type would suggest), offsets are
      kebab-case `offset-x`/`offset-y` on write and camelCase `offsetX`/
      `offsetY` on read back, and `color` is a nested `{ color, opacity }`
      object rather than flattened `shadow-color`/`shadow-opacity` keys —
      see the comment on `Shadow` in `shape-builders.ts`. Every numeric
      field that previously took a raw number (layout `rowGap`/`columnGap`/
      `padding`, `layoutItem` margins/min/max sizes, corner radii `r1`-`r4`)
      now accepts a `{ token: "name" }` reference resolved against the token
      file's new `spacing`/`radii` tables, resolved in `content.ts` before
      reaching `shape-builders.ts` — which stays token-agnostic by design,
      same seam `resolveColor` already used for fills/strokes.)
- [x] Path/ellipse shapes and boolean ops (union/subtract/intersect) in
      `penpot_add_shapes`. (Done — `circle` is an ellipse bounded by x/y/width/height;
      `path` accepts an array of `{ command, params }` segments and derives its bounding
      box automatically from tight cubic-Bézier extrema; `bool` wraps children shapes
      (added with `parentId` = the bool's id, same pattern as frames) with a `boolType`
      of `union`, `difference`, `intersection`, or `exclusion` — the visual result path
      is computed by Penpot's editor when the file is opened, since the boolean geometry
      engine lives in Penpot's browser-side WASM module rather than on the server.)
- [x] Widen `penpot_update_shapes` to cover path/group/circle/svg-raw/image/bool
      (and any other shape type). (Done — `circle` and `bool` round-trip through their
      dedicated builders (preserving `bool-type` and `shapes`); `path` rebuilds geometry
      from the existing path content unless a new `content` array is supplied in the patch
      (x/y/width/height are always derived from content and cannot be set independently);
      `group` rebuilds geometry and `shapes` without touching children; image/svg-raw and
      any other type get a generic geometry-only rebuild, with all type-specific fields
      carried forward from `existing` via the `{ ...existing, ...obj }` merge. Also added
      `layout` (frame shapes only) and `layoutItem` (any shape) to the patch schema so
      auto-layout can be set or replaced after creation — same schema as `penpot_add_shapes`.
      A new `boolType` patch field replaces a bool's operation type in place. `computeShapeGeometry`
      and `group` are now exported from `shape-builders.ts` and `expandTranslateChanges` in
      `content.ts` now correctly handles groups and paths in align/distribute subtrees.)
- [x] Penpot team/custom font lookup for `penpot_measure_text` — if the
      requested font family is not found on Google Fonts, all Penpot teams
      accessible to the configured access token are searched for a matching
      custom/team font variant (`get-font-variants` → `download-font`). The
      "normal" style is preferred when multiple variants exist for the same
      family+weight; if none match anywhere, a combined error message names
      both sources. (Done — see `font-metrics.ts`:`fetchPenpotFontBytes`;
      `PenpotFontClient` interface keeps the module decoupled from
      `rpc-client.ts` so unit tests can supply a plain mock.)
- [x] Add a variant to an already-existing component/group.
      `penpot_add_variant` appends a new variant to an existing variant group
      container by re-adding the container frame via `add-obj` with the new
      variant's root id appended to its `shapes` array (the same
      delete-and-recreate-through-`add-obj` trick used by
      `penpot_reorder_shapes`, avoiding the `mov-objects` silent-no-op
      pitfall noted below). The new component is registered in the same
      `update-file` call.
- [x] `penpot_list_pages` / `penpot_rename_page` / `penpot_delete_page` —
      `penpot_create_page` exists and now so does the rest of the page CRUD:
      `penpot_list_pages` returns every page's id and name (in order) without
      pulling the full shape tree; `penpot_rename_page` renames a page in place;
      `penpot_delete_page` removes it (guards against deleting the last page of
      a file). Both mutations go through `update-file` with `rename-page` /
      `del-page` change types, the same single-round-trip path every other
      content tool uses.
- [x] SSO/OIDC-only instance support for `penpot_export_shape` via
      `PENPOT_AUTH_TOKEN_COOKIE`. (Done — in addition to the existing
      `PENPOT_LOGIN_EMAIL`/`PENPOT_LOGIN_PASSWORD` password-login path,
      you can now set `PENPOT_AUTH_TOKEN_COOKIE` to a raw `auth-token`
      cookie value obtained by completing the OIDC/SSO flow in a real
      browser. The profile-id is fetched via `get-profile` on first use;
      if the cookie expires a clear error message explains how to renew
      it. `PENPOT_LOGIN_EMAIL`/`PENPOT_LOGIN_PASSWORD` takes precedence
      when both are set. Fully headless OIDC automation — driving the
      redirect flow without a browser — is still not implemented, as
      the cookie-passthrough approach covers the SSO gap without adding
      a Playwright dependency.)
- [x] Unit coverage for `rpc-client.ts`, `transit.ts`, and
      `tools/project-files.ts` — currently zero unit tests, only reachable
      via the integration suite that's excluded from CI. Mocking `fetch`
      for status-code branching (204, 401/403 retry, non-2xx →
      `PenpotRpcError`) would catch regressions in CI instead of only on a
      manual integration run.
- [x] Gradient and image fills — `Fill`/`Stroke` in `shape-builders.ts`
      only carry a flat `color`/`opacity`; Penpot supports linear/radial
      gradient fills and image fills, neither reachable from any tool
      today. Likely the highest-value gap, since most real designs use at
      least one gradient or image fill somewhere. (Done — `fills` array on
      every non-text shape (`rect`, `frame`, `circle`, `path`, `bool`) in
      `penpot_add_shapes`/`penpot_update_shapes`/`penpot_batch` accepts
      entries of `type` `"solid"`, `"linear-gradient"`, `"radial-gradient"`,
      or `"image"`. Gradient stops may use `{ token: "name" }` references
      against the token file's `colors` table. Image fills reference an
      already-uploaded Penpot media object by `mediaId` UUID — the caller
      must upload the image to Penpot first (via the Penpot UI or a
      separate tool). When `fills` is provided it overrides the legacy
      `fillColor`/`fillOpacity` shorthand entirely; backward compatibility
      is preserved for all existing callers using `fillColor`/`fillOpacity`.
      The `Fill` type in `shape-builders.ts` is now a union of `SolidFill`,
      `GradientFill`, and `ImageFill`; `extractEditableFields` round-trips
      all three types from `get-file`'s camelCase response back to the
      kebab-case form `add-obj` expects.)
- [x] Image shapes / asset upload — there's no `image` shape builder and
      no upload-media RPC call anywhere; `image`/`svg-raw` shapes are only
      handled via a generic geometry-only fallback in
      `penpot_update_shapes`. Blocks any workflow that needs to bring in
      photos, icons, or existing SVG art. (Done — `penpot_upload_media`
      uploads a media asset to a Penpot file and returns `{ id, name,
      width, height, mtype }`. Three source modes: `filePath` (the MCP
      server reads a local file and POSTs it as multipart), `url` (Penpot's
      server fetches the image directly — nothing passes through the MCP
      server, uses `create-file-media-object-from-url`), or `dataBase64`
      (base64-encoded bytes, requires `mtype`). The returned `id` is then
      passed as `mediaId` when calling `penpot_add_shapes` with
      `type: "image"`; `mediaWidth`/`mediaHeight`/`mtype` come from the
      same response. The `image` shape builder sets `type: "image"` with a
      `metadata: { id, width, height, mtype }` block (Penpot's wire format,
      verified from `schema:image-attrs` in `shape.cljc`) plus the standard
      geometry and selrect/transform fields. `penpot_update_shapes` now
      handles image shapes with a dedicated case (instead of the previous
      generic fallback) and accepts `mediaId`/`mediaWidth`/`mediaHeight`/
      `mtype` patch fields to swap the displayed image in place. MIME type
      is auto-detected from file extension for `filePath` uploads
      (`.png`→`image/png`, `.jpg`/`.jpeg`→`image/jpeg`, `.svg`→
      `image/svg+xml`, `.webp`, `.gif`, `.avif`).)
- [x] Opacity/hidden/locked/blend-mode flags (Done — all four fields now available in shape builders and `penpot_update_shapes` schema: opacity (0-1 numeric), hidden (boolean), blocked (boolean), blendMode (string). Extraction via `extractEditableFields` converts wire-format "blend-mode" to camelCase "blendMode" for consistent builder interface. Unit and integration tests verify round-trip through Penpot's RPC API.)
- [x] Rich per-range text formatting — `text()` in `shape-builders.ts`
      always emits a single paragraph with one style run; no per-
      character-range styling, text-align, line-height, letter-spacing,
      or text-decoration. (Done — `penpot_add_shapes` and
      `penpot_update_shapes` both accept a `paragraphs` array on text
      shapes. Each paragraph sets `textAlign` plus typography defaults
      (`fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `lineHeight`,
      `letterSpacing`, `textDecoration`, `textTransform`, `fills`/`fillColor`);
      its `ranges` array holds one or more text runs that may individually
      override any of those fields. Multiple paragraphs produce separate
      paragraph nodes (line-break boundaries). `growType`
      (`"auto-width"` | `"auto-height"` | `"fixed"`) and `verticalAlign`
      (`"top"` | `"center"` | `"bottom"`) are also now settable on text
      shapes. The legacy `characters`/`fontFamily`/`fontSize`/`fontWeight`/
      `fillColor` shorthand is fully preserved for callers that don't need
      per-range control. `extractEditableFields` now returns a full
      `paragraphs` array for text shapes so a geometry-only update patch
      (`x`/`y`/`width`/`height` only) no longer collapses a rich-text shape
      back to single-paragraph. Verified field names against Penpot's
      `common/src/app/common/types/text.cljc` `text-node-attrs` /
      `paragraph-attrs` / `root-attrs`.)
- [x] Group/ungroup as first-class tools — `group()` already exists as an
      internal builder, but nothing exposes grouping existing shapes or
      ungrouping a group via an MCP tool. (Done — `penpot_group_shapes` takes
      a `shapeIds` array of sibling shapes (all must share the same parent)
      and wraps them in a new group at the topmost selected shape's z-order
      position; the group's bounding box is the union of the children's
      `selrect`s (rotation-aware bounds). `penpot_ungroup_shapes` takes a
      `groupId` and dissolves it: each child is reparented to the group's
      former parent at the group's z-order position (preserving relative
      child order) and the group shape is deleted. Both are implemented as
      single `update-file` change-sets — group creation sends `add-obj` for
      the new group, one `add-obj` per child (to update `parent-id`) and an
      `add-obj` for the updated parent's `shapes` array; ungroup does the
      same in reverse then appends a `del-obj`. Requires siblings only —
      shapes with different parents must be moved to a common parent first.)
- [x] Resize constraints — Penpot's `constraints-h`/`constraints-v`
      (how a shape behaves when its parent resizes) are never set or
      exposed in `EditableShapeFields` or the update patch schema.
      (Done — `constraintsH` (`left`/`right`/`leftright`/`center`/`scale`) and
      `constraintsV` (`top`/`bottom`/`topbottom`/`center`/`scale`) are now
      accepted by every shape builder (`rect`, `frame`, `text`, `circle`,
      `path`, `bool`, `group`, `image`), emitted as `constraints-h`/
      `constraints-v` in the wire format. Both fields are settable at creation
      time via `penpot_add_shapes` and patchable via `penpot_update_shapes`/
      `penpot_batch`; `extractEditableFields` reads them back from `get-file`'s
      camelCase response so a partial update patch preserves the existing
      constraints when neither field is included in the patch.)
- [x] Batch/whole-page export — `penpot_export_shape` takes exactly one
      `shapeId` per call, with no multi-shape or multi-page batch export,
      and only `png`/`svg` (no PDF). (Done — `penpot_export_batch` accepts
      either a `shapeIds` array (same `pageId`, any mix of `format`/`scale`)
      or a `shapes` array where each entry may carry its own `pageId`, `format`,
      `scale`, and `name` — enabling whole-file exports across multiple pages in
      a single `POST /api/export` call. Parsing each result's `~:uri`/
      `~:mtype`/`~:filename` via `matchAll` on the transit+json response; asset
      downloads are parallelised. Both tools also accept `pdf` as a format value.
      Multi-page export was previously gated on the MCP schema, not the
      exporter-client, which already sent per-spec `pageId`s.)
- [x] Shared-library components — `penpot_list_components` and
      `penpot_add_component_instance` only look at the current file's own
      `components` map; there's no support for pulling components from a
      separate connected shared-library file. (Done — `penpot_list_components`
      now accepts `includeLibraries: true`, which calls `get-file-libraries` to
      enumerate all linked library files (direct and transitive) and then calls
      `get-file` on each to read its `components` map; each library component
      entry carries a `libraryFileId` and `libraryFileName` field in the
      response. `penpot_add_component_instance` now accepts an optional
      `libraryFileId`; when supplied, the component's main-instance tree is
      looked up in that library file instead of the current file, and the
      cloned instance's root `component-file` field is set to the library
      file's id (matching what Penpot's own editor writes for cross-file
      component instances). Note: `get-file-libraries` returns file metadata
      only — it does not include shape/component data — so a separate
      `get-file` call per library is necessary to enumerate components; this
      is the same two-step pattern Penpot's own frontend uses.)
- [x] Comments API — `penpot_list_comment_threads` lists all threads for a file;
      `penpot_get_comments` fetches the replies inside a thread;
      `penpot_create_comment_thread` pins a new thread to a canvas position
      (x/y + optional `frameId`); `penpot_create_comment` adds a reply;
      `penpot_update_comment` edits an existing comment's text;
      `penpot_resolve_comment_thread` marks a thread resolved or reopens it;
      `penpot_delete_comment` removes a single reply; and
      `penpot_delete_comment_thread` removes a whole thread and all its replies.
      All eight tools go through `PenpotRpcClient` methods that send
      kebab-case JSON params to the `get-comment-threads` /
      `create-comment-thread` / `update-comment-thread` / `delete-comment` /
      etc. RPC endpoints (same call pattern as every other tool). Wire format
      verified against Penpot's frontend source (`data/comments.cljs`):
      `position` is a nested `{ x, y }` JSON object; `frame-id` is optional
      on creation (omit to place on the page root); `is-resolved` controls
      thread resolution state.
- [x] Text search-and-replace across a file — `penpot_replace_text` finds
      every text shape on a page whose runs contain a literal search string and
      rewrites all occurrences in a single `update-file` call. Matching is
      case-insensitive by default (`caseSensitive: true` to override); an
      optional `limit` caps the number of shapes touched; empty `replacement`
      deletes matches. Replacement is per text-run (leaf node): a search string
      that spans two adjacent runs within a paragraph is not matched — this
      covers the common case where all text is in a single run per paragraph.
      (Done — regex metacharacters in the search string are escaped so `.` /
      `*` / `(` etc. are always matched literally, not as pattern operators.)
- [x] Cross-page/whole-file undo — `penpot_checkpoint` now accepts an optional
      `pageId`; omit it to snapshot every page in the file in one call.
      `penpot_restore_checkpoint` restores all snapshotted pages in a single
      `update-file` call. Checkpoints still live in server memory and don't
      survive a restart; persistence across restarts is still not implemented
      (callers needing that should snapshot via `penpot_get_file_snapshot`
      themselves). (Done — `Checkpoint` in `checkpoints.ts` now holds a
      `pages` map (pageId → objects) instead of a single `pageId`/`objects`
      pair; the restore loop iterates every entry and accumulates all changes
      before sending one `update-file` call — the same single-round-trip
      pattern used by `penpot_batch`.)
- [x] Fully headless OIDC/SSO login — drive the redirect flow without a
      browser, instead of requiring `PENPOT_AUTH_TOKEN_COOKIE` to be
      obtained manually beforehand. (Done — `PENPOT_OIDC_USERNAME` +
      `PENPOT_OIDC_PASSWORD` trigger a new `'oidc'` auth mode in the
      exporter client. The server follows Penpot's `/api/auth/oauth/{provider}`
      redirect chain to the identity provider's login page via plain HTTP
      (Node.js `http`/`https` modules, no browser dependency), parses the
      HTML login form heuristically to identify username/email and password
      fields (including hidden CSRF/state fields, which are preserved and
      re-submitted verbatim), and captures the resulting `auth-token`
      cookie. Multi-step flows — where the IdP shows username on page 1
      and password on page 2 (Authentik-style) — are handled by a
      MAX_FORM_STEPS loop that re-parses and re-submits until the cookie
      appears. 307/308 redirects preserve POST method+body; 301/302/303
      switch to GET per RFC 7231. The cookie jar correctly captures
      Penpot's own state/CSRF cookies set on the initial redirect so they
      are forwarded to the IdP's callback. Re-logs in automatically on
      401/403 (same as password mode). `PENPOT_OIDC_PROVIDER` controls
      the provider name (default `"oidc"`). Does not work for
      JavaScript-driven IdP login pages — use `PENPOT_AUTH_TOKEN_COOKIE`
      for those. Unit-tested via injected mock fetcher; integration test
      requires a live OIDC provider and is not in CI.)
- [x] Checkpoint persistence across server restarts — checkpoints
      (`penpot_checkpoint`/`penpot_restore_checkpoint`) currently live only
      in the MCP server's own memory and are lost on restart. Persisting
      them to disk (or letting the caller supply a checkpoint id to
      save/load) would let a long-running multi-step edit survive a server
      restart mid-way through. (Done — set `PENPOT_CHECKPOINTS_PATH` to a
      local directory; the server writes each checkpoint as `<uuid>.json`
      into that directory and reloads all files from it at startup.
      `initCheckpointStore(dir)` is called once in `server.ts` main;
      `saveCheckpoint` is now async and awaits the `writeFile` so the
      caller knows immediately if the write failed; `deleteCheckpoint` is
      also async and removes the corresponding file from disk. No change
      to the in-memory behaviour when the env var is unset.)
- [x] Single-call multi-page batch export — `penpot_export_batch` exports
      multiple shapes on one page in a single call; exporting across pages
      still requires one call per `pageId`. Worth revisiting if batch
      export becomes a bottleneck for whole-file exports. (Done — `penpot_export_batch`
      now accepts either `shapeIds` (single-page shorthand, backward-compatible) or a
      `shapes` array where each entry carries its own `pageId`, `format`, `scale`, and
      optional `name`. The exporter-client already sent per-spec `pageId`s in a single
      `POST /api/export`; the only change was widening the MCP tool's Zod schema to
      expose this capability. Cross-field validation (at least one of `shapeIds`/`shapes`;
      not both; `pageId` required for `shapeIds`; every `shapes` entry has a `pageId`
      either per-entry or via the top-level default) is done with `.refine()` on a
      separate `exportBatchInput` schema while `exportBatchBaseSchema` (the raw
      `ZodObject`) is passed to the MCP SDK's `inputSchema` to preserve `.shape`.)
- [x] Stale-write detection via `revn` — every write tool
      (`penpot_update_shapes`/`penpot_batch`/`penpot_restore_checkpoint`/etc.)
      currently sends `update-file` blind, without checking the file's
      current `revn` (revision number) first. If a human has the file open
      in the Penpot editor and edits concurrently with an agent session,
      whichever write lands second silently overwrites the other with no
      error. Penpot's own `update-file` RPC takes a `revn` and is expected
      to reject a change-set built against a stale one; today nothing here
      reads or checks it beforehand. Fix is to fetch current `revn` before
      writing and surface a clear "file changed underneath you, re-fetch
      and retry" error on rejection, rather than actually merging concurrent
      edits (which would need Penpot's own operational-transform logic).
      (Done — `PenpotStaleWriteError` is thrown by `updateFile` in
      `rpc-client.ts` whenever the `update-file` response includes a
      non-empty `lagged` array, meaning Penpot applied change-sets from
      another session before ours. Penpot's collaborative engine still
      applies our write on top, so the write succeeds at the HTTP level,
      but the error surfaces the concurrent-edit situation with a clear
      message that names the new `revn` and tells the caller to re-fetch
      via `penpot_get_file_snapshot` before making further edits. Applies
      to all write tools automatically — `penpot_add_shapes`,
      `penpot_update_shapes`, `penpot_delete_shapes`, `penpot_batch`,
      `penpot_restore_checkpoint`, `penpot_group_shapes`,
      `penpot_ungroup_shapes`, `penpot_clone_shapes`, `penpot_reorder_shapes`,
      `penpot_align_shapes`, `penpot_distribute_shapes`, page CRUD, etc. —
      since they all go through `updateFile`. `PenpotStaleWriteError`
      carries `laggedCount` (number of concurrent change-sets) and `result`
      (the full `update-file` response, including the new `revn`) so
      callers that need the new revision can read it from the error rather
      than requiring an additional round trip.)
- [x] Version history / branching support — `penpot_list_file_snapshots` lists all named
      snapshots for a file (both user-created versions and system auto-backups);
      `penpot_create_file_snapshot` saves the current state as a named version (optional
      `label`; Penpot generates a timestamp label when omitted);
      `penpot_restore_file_snapshot` rolls the live file back to any listed snapshot
      (Penpot automatically creates a system backup of the current state before applying
      the restore, so a restore is itself undoable by restoring the most-recent system
      entry); `penpot_rename_file_snapshot` renames a user-created snapshot;
      `penpot_delete_file_snapshot` removes one; `penpot_lock_file_snapshot` /
      `penpot_unlock_file_snapshot` pin/unpin a snapshot against accidental deletion
      (only the snapshot's creator can lock/unlock, and only user-created snapshots
      support locking — system backups expire automatically). `penpot_get_file_snapshot_data`
      returns the full file content at a specific snapshot for read-only inspection or
      comparison without touching the live file. Wire format verified against
      `backend/src/app/rpc/commands/files_snapshot.clj` and
      `backend/src/app/features/file_snapshots.clj`.
- [x] Component-instance drift/override visibility — Penpot's composition
      model is tokens → elements → components (with variants) → screens
      built from component instances, and today the tools that read shape
      state (`penpot_get_shape`, `penpot_find_shapes`) don't surface where a
      shape sits in that hierarchy. A component instance's `shape-ref` link
      to its main component (and whether it has drifted — fields overridden
      since being placed, or fully detached) is invisible: an agent editing
      an instance via `penpot_update_shapes` can't currently tell "this edit
      creates a per-instance override" from "this edit changes a raw shape,"
      which matters for keeping instances honestly in sync with their
      component rather than silently diverging the way ad-hoc UI edits can.
      Scope: extend `penpot_get_shape`/`penpot_find_shapes` to report
      link state (`linked` / `detached` / not-an-instance) and, when linked,
      which fields differ from the main component's current definition —
      read-only visibility first; explicit detach/relink tools and
      discovery-first tool guidance (checking `penpot_list_components`
      before creating shapes that duplicate an existing component) are
      possible natural follow-ons once drift is at least visible.
      (Done — both `penpot_get_shape` and `penpot_find_shapes` now include
      component link state in their output. `penpot_get_shape` adds a
      top-level `componentInfo` field with `linkState` (`"linked"` /
      `"detached"` / `"not-an-instance"` / `"main-component-root"`), the
      `componentId` and `componentFileId` when present, `mainInstanceId` /
      `mainInstancePage` for same-file linked instances, and a `driftedFields`
      array (camelCase field names) listing which visual properties on this
      instance differ from the main component's current definition — empty
      array means fully in sync. `penpot_find_shapes` adds `linkState` and
      `componentId` to each match entry, plus `driftedFields` for same-file
      linked instances. Drift is compared over: `name`, `fills`, `strokes`,
      `shadows`, `opacity`, `hidden`, `blendMode`, `width`, `height`,
      `constraintsH`, `constraintsV`, and `content` (text shapes); position
      `x`/`y` is excluded since every placed instance lives at a different
      canvas location by design. Library components (`componentFile` ≠ current
      file) report `linkState: "linked"` but `driftedFields` is omitted since
      the library file's pages would require an extra RPC call — use
      `penpot_get_shape` on a library instance root, then follow its
      `mainInstanceId`/`mainInstancePage` manually if cross-file drift is
      needed.)

