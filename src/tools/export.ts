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
import { PenpotExporterClient, PenpotExporterError, type BatchExportSpec } from '../exporter-client.js'

const exportShapeInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  shapeId: z.string().min(1),
  format: z.enum(['png', 'svg', 'pdf']).default('png'),
  scale: z.number().positive().default(1),
  name: z.string().min(1).default('export'),
})

/** Per-shape entry for the multi-page shapes array. */
const exportBatchItemSchema = z.object({
  shapeId: z.string().min(1),
  pageId: z.string().min(1).optional().describe(
    'Page this shape lives on. Overrides the top-level pageId. Required if no top-level pageId is set.',
  ),
  format: z.enum(['png', 'svg', 'pdf']).optional().describe('Export format for this shape. Overrides the top-level format.'),
  scale: z.number().positive().optional().describe('Scale for this shape. Overrides the top-level scale.'),
  name: z.string().min(1).optional().describe('Base filename for this shape\'s export.'),
})

/**
 * Raw ZodObject used for MCP tool registration (inputSchema).
 * Cross-field refinements are kept in exportBatchInput below.
 */
export const exportBatchBaseSchema = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1).optional().describe(
    'Default page ID. Required when using shapeIds; used as fallback for any shapes entry that omits its own pageId.',
  ),
  shapeIds: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'IDs of shapes to export, all on the same pageId. ' +
        'Mutually exclusive with shapes. Requires a top-level pageId.',
    ),
  shapes: z
    .array(exportBatchItemSchema)
    .min(1)
    .optional()
    .describe(
      'Per-shape export specs. Use this instead of shapeIds when shapes span multiple pages ' +
        'or need different formats/scales. Each entry must have a pageId or a top-level pageId must be supplied.',
    ),
  format: z.enum(['png', 'svg', 'pdf']).default('png').describe('Default export format.'),
  scale: z.number().positive().default(1).describe('Default export scale.'),
})

/** Full schema with cross-field validation, used inside the tool handler. */
export const exportBatchInput = exportBatchBaseSchema
  .refine(
    (data) => data.shapeIds !== undefined || data.shapes !== undefined,
    { message: 'Either shapeIds or shapes must be provided.' },
  )
  .refine(
    (data) => !(data.shapeIds !== undefined && data.shapes !== undefined),
    { message: 'Provide either shapeIds or shapes, not both.' },
  )
  .refine(
    (data) => data.shapeIds === undefined || data.pageId !== undefined,
    { message: 'pageId is required when using shapeIds.' },
  )
  .refine(
    (data) =>
      data.shapes === undefined ||
      data.shapes.every((s) => s.pageId !== undefined || data.pageId !== undefined),
    { message: 'Each shape in the shapes array must have a pageId, or supply a top-level pageId as default.' },
  )

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
        'Export multiple shapes from a Penpot file in a single call, returning one image per shape ' +
        'in the same order as the input. Supports PNG, SVG, and PDF formats. ' +
        'Use shapeIds (with a top-level pageId) for shapes on a single page, or the shapes array ' +
        'to export shapes from different pages — each entry can specify its own pageId, format, and scale. ' +
        'Requires the same exporter credentials as penpot_export_shape ' +
        '(PENPOT_LOGIN_EMAIL/PENPOT_LOGIN_PASSWORD or PENPOT_AUTH_TOKEN_COOKIE).',
      inputSchema: exportBatchBaseSchema.shape,
    },
    async (input: unknown) => {
      try {
        const { fileId, pageId, shapeIds, shapes, format, scale } = exportBatchInput.parse(input ?? {})

        let specs: BatchExportSpec[]
        if (shapeIds !== undefined) {
          specs = shapeIds.map((shapeId, i) => ({
            shapeId,
            pageId: pageId!,
            format,
            scale,
            name: `export-${i + 1}`,
          }))
        } else {
          specs = shapes!.map((s, i) => ({
            shapeId: s.shapeId,
            pageId: s.pageId ?? pageId!,
            format: s.format ?? format,
            scale: s.scale ?? scale,
            name: s.name ?? `export-${i + 1}`,
          }))
        }

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
