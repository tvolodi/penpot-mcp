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
  format: z.enum(['png', 'svg', 'pdf']).default('png'),
  scale: z.number().positive().default(1),
  name: z.string().min(1).default('export'),
})

const exportBatchInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  shapeIds: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'IDs of the shapes to export. Pass the page root frame ID to export the whole page. ' +
        'All shapes must belong to the same page.',
    ),
  format: z.enum(['png', 'svg', 'pdf']).default('png'),
  scale: z.number().positive().default(1),
})

export function registerExportTool(server: McpServer, exporter: PenpotExporterClient): void {
  server.registerTool(
    'penpot_export_shape',
    {
      description:
        'Render a shape (or an entire page, by passing the root frame) from a Penpot file to a PNG, SVG, or PDF ' +
        'using Penpot\'s own server-side exporter. Requires either ' +
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

  server.registerTool(
    'penpot_export_batch',
    {
      description:
        'Export multiple shapes from a Penpot page in a single call, returning one image per shape ' +
        'in the same order as the input shapeIds. Supports PNG, SVG, and PDF formats. ' +
        'Requires the same exporter credentials as penpot_export_shape ' +
        '(PENPOT_LOGIN_EMAIL/PENPOT_LOGIN_PASSWORD or PENPOT_AUTH_TOKEN_COOKIE).',
      inputSchema: exportBatchInput.shape,
    },
    async (input: unknown) => {
      try {
        const { fileId, pageId, shapeIds, format, scale } = exportBatchInput.parse(input ?? {})
        const specs = shapeIds.map((shapeId, i) => ({
          shapeId,
          pageId,
          format,
          scale,
          name: `export-${i + 1}`,
        }))
        const results = await exporter.exportShapesBatch(fileId, specs)
        return {
          content: results.map((result) => ({
            type: 'image' as const,
            data: result.data.toString('base64'),
            mimeType: result.mimeType,
          })),
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
