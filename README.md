# penpot-headless

A portable MCP server for headless Penpot project/file/content management,
using Penpot's RPC API directly. No browser, no Penpot plugin session.

This package has **zero project-specific knowledge** — no hardcoded colors,
fonts, or Penpot instance URL. Every consuming project supplies its own
config and token file, so this directory can be copied as-is into another
project.

## What this does

- Team/project/file/page CRUD (`penpot_list_teams`, `penpot_create_file`, etc.)
- Shape creation — `rect`, `frame`, `text` — via `penpot_add_shapes`, with
  colors/fonts resolved either from a literal value or a
  `{ "token": "name" }` reference against your project's token file.
- Reading a file's current shape tree via `penpot_get_file_snapshot`.

## What this does NOT do

**There is no server-side render/export-to-image capability.** Penpot's RPC
API has no endpoint that renders a shape, page, or file to PNG/SVG — the
`create-file-thumbnail`/`create-file-object-thumbnail` methods take a
client-*uploaded* image (thumbnail caching), not the reverse, and
`export-binfile` is a binary `.penpot` backup format, not an image. This was
confirmed by reading Penpot's full RPC method list, not assumed.

If you need a rendered image of a design (e.g. for visual QA), that
currently requires a live browser tab with a Penpot file open and the
official Penpot MCP plugin running (`export_shape` tool) — a separate,
non-portable capability tied to an interactive session. This package does
not attempt to work around that; it's a real property of Penpot's
architecture today.

Also out of scope: rotated shapes (only `rotation: 0` is supported —
`selrect`/`points`/`transform` are computed as identity-matrix math, which
only holds for unrotated shapes), and components/variants/auto-layout.

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Generate a Penpot access token: your Penpot instance → Account settings
   → Access tokens.
3. Create a token file for your project (see `design-tokens/*.tokens.json`
   in the consuming repo for an example — or write your own matching the
   schema below).
4. Register this server in your MCP client config, e.g.:
   ```json
   {
     "mcpServers": {
       "penpot-headless": {
         "command": "npx",
         "args": ["tsx", "/path/to/mcp-servers/penpot-headless/src/server.ts"],
         "env": {
           "PENPOT_BASE_URL": "https://your-penpot-instance.example.com",
           "PENPOT_ACCESS_TOKEN": "your-token-here",
           "PENPOT_TOKENS_PATH": "/path/to/your-project/design-tokens/tokens.json"
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

This directory has its own `package.json`/`tsconfig.json` and depends only
on `@modelcontextprotocol/sdk` and `zod` — no framework dependencies. Copy
the whole `penpot-headless/` directory into the new project, run
`npm install`, write a token file for that project, and register the server
with a `PENPOT_TOKENS_PATH` pointing at it.

## Known limitations

- No render/export capability (see above).
- Unrotated shapes only.
- No component, variant, or auto-layout tool support — only `rect`, `frame`,
  `text`.
