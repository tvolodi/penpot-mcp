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

Also out of scope: rotated shapes (only `rotation: 0` is supported —
`selrect`/`points`/`transform` are computed as identity-matrix math, which
only holds for unrotated shapes), and components/variants/auto-layout.

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
- Unrotated shapes only.
- No component, variant, or auto-layout tool support — only `rect`, `frame`,
  `text`.
