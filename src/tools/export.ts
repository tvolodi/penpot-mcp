/**
 * tools/export.ts
 *
 * MCP tool for rendering a Penpot shape/page to an image. Unlike every
 * other tool in this package, this does not go through PenpotRpcClient —
 * Penpot's render pipeline is a separate subsystem (the exporter
 * microservice) with its own cookie-based auth. See exporter-client.ts.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PenpotExporterClient, PenpotExporterError } from '../exporter-client.js'

const exportShapeInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  shapeId: z.string().min(1),
  format: z.enum(['png', 'svg']).default('png'),
  scale: z.number().positive().default(1),
  name: z.string().min(1).default('export'),
})

export function registerExportTool(server: McpServer, exporter: PenpotExporterClient): void {
  server.registerTool(
    'penpot_export_shape',
    {
      description:
        'Render a shape (or an entire page, by passing the root frame) from a Penpot file to a PNG or SVG ' +
        'image, using Penpot\'s own server-side exporter. Requires either ' +
        'PENPOT_LOGIN_EMAIL/PENPOT_LOGIN_PASSWORD (password-based login) or ' +
        'PENPOT_AUTH_TOKEN_COOKIE (a pre-obtained auth-token cookie, e.g. from completing an SSO/OIDC login in a browser) ' +
        'to be configured, separately from PENPOT_ACCESS_TOKEN.',
      inputSchema: exportShapeInput.shape,
    },
    async (input: unknown) => {
      try {
        const { fileId, pageId, shapeId, format, scale, name } = exportShapeInput.parse(input ?? {})
        const result = await exporter.exportShape(fileId, pageId, shapeId, format, scale, name)
        return {
          content: [
            {
              type: 'image' as const,
              data: result.data.toString('base64'),
              mimeType: result.mimeType,
            },
          ],
        }
      } catch (err) {
        const message =
          err instanceof PenpotExporterError
            ? `${err.message}: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`
            : err instanceof Error
              ? err.message
              : 'Unknown error'
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        }
      }
    },
  )
}
