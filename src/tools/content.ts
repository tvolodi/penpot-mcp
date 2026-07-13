/**
 * tools/content.ts
 *
 * MCP tools for creating pages and shapes in a Penpot file, headlessly.
 * This is the generalized, token-aware replacement for the one-off
 * `demo-form-screen` proof-of-concept script: no shape geometry or
 * color values are baked in here — every color accepts either a literal
 * hex string or a `{ token: "name" }` reference resolved against the
 * project's token file (see tools/tokens.ts).
 */

import { z } from 'zod'
import type { PenpotRpcClient } from '../rpc-client.js'
import { addObj, addPage, frame, rect, text, ROOT_FRAME_ID } from '../shape-builders.js'
import { colorValueSchema, loadTokenFile, resolveColor, type TokenFile } from './tokens.js'
import type { ToolDefinition } from './project-files.js'

const strokeSchema = z.object({
  color: colorValueSchema,
  opacity: z.number().min(0).max(1).default(1),
  width: z.number().min(0).default(1),
  style: z.enum(['solid', 'dotted', 'dashed', 'mixed']).default('solid'),
  alignment: z.enum(['inner', 'outer', 'center']).default('inner'),
})

const cornerRadiiSchema = z.object({
  r1: z.number().min(0).optional(),
  r2: z.number().min(0).optional(),
  r3: z.number().min(0).optional(),
  r4: z.number().min(0).optional(),
})

const baseShapeFields = {
  name: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  parentId: z.string().default(ROOT_FRAME_ID),
  frameId: z.string().default(ROOT_FRAME_ID),
}

const rectShapeSchema = z.object({
  type: z.literal('rect'),
  ...baseShapeFields,
  fillColor: colorValueSchema.optional(),
  fillOpacity: z.number().min(0).max(1).default(1),
  stroke: strokeSchema.optional(),
  ...cornerRadiiSchema.shape,
})

const frameShapeSchema = z.object({
  type: z.literal('frame'),
  ...baseShapeFields,
  fillColor: colorValueSchema.optional(),
  fillOpacity: z.number().min(0).max(1).default(1),
  stroke: strokeSchema.optional(),
  ...cornerRadiiSchema.shape,
})

const textShapeSchema = z.object({
  type: z.literal('text'),
  ...baseShapeFields,
  characters: z.string(),
  fontFamily: z.string().optional(),
  fontSize: z.string().optional(),
  fontWeight: z.string().optional(),
  fillColor: colorValueSchema.optional(),
})

const shapeSpecSchema = z.discriminatedUnion('type', [rectShapeSchema, frameShapeSchema, textShapeSchema])
export type ShapeSpec = z.infer<typeof shapeSpecSchema>

function resolveStroke(spec: z.infer<typeof strokeSchema> | undefined, tokens: TokenFile) {
  if (!spec) return undefined
  return [
    {
      'stroke-color': resolveColor(spec.color, tokens),
      'stroke-opacity': spec.opacity,
      'stroke-width': spec.width,
      'stroke-style': spec.style,
      'stroke-alignment': spec.alignment,
    },
  ]
}

function buildShapeObject(spec: ShapeSpec, tokens: TokenFile): Record<string, unknown> {
  switch (spec.type) {
    case 'rect':
      return rect({
        name: spec.name,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        parentId: spec.parentId,
        frameId: spec.frameId,
        fills: spec.fillColor
          ? [{ 'fill-color': resolveColor(spec.fillColor, tokens), 'fill-opacity': spec.fillOpacity }]
          : undefined,
        strokes: resolveStroke(spec.stroke, tokens),
        r1: spec.r1,
        r2: spec.r2,
        r3: spec.r3,
        r4: spec.r4,
      })
    case 'frame':
      return frame({
        name: spec.name,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        parentId: spec.parentId,
        frameId: spec.frameId,
        fills: spec.fillColor
          ? [{ 'fill-color': resolveColor(spec.fillColor, tokens), 'fill-opacity': spec.fillOpacity }]
          : undefined,
        strokes: resolveStroke(spec.stroke, tokens),
        r1: spec.r1,
        r2: spec.r2,
        r3: spec.r3,
        r4: spec.r4,
      })
    case 'text':
      return text({
        name: spec.name,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        parentId: spec.parentId,
        frameId: spec.frameId,
        characters: spec.characters,
        fontFamily: spec.fontFamily,
        fontSize: spec.fontSize,
        fontWeight: spec.fontWeight,
        fillColor: spec.fillColor ? resolveColor(spec.fillColor, tokens) : undefined,
      })
  }
}

const createPageInput = z.object({
  fileId: z.string().min(1),
  name: z.string().min(1),
})

const createPage: ToolDefinition<z.infer<typeof createPageInput>> = {
  name: 'penpot_create_page',
  description: 'Create a new, empty page in a Penpot file.',
  inputSchema: createPageInput,
  handler: async (client, { fileId, name }) => {
    const file = await client.getFile(fileId)
    const pageChange = addPage(name)
    const result = await client.updateFile(fileId, file.revn, file.vern, [pageChange])
    return { pageId: pageChange.id, pageName: name, revn: result.revn }
  },
}

function makeAddShapesInput(tokensPath: string) {
  return z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    shapes: z.array(shapeSpecSchema).min(1),
    tokensPath: z.string().default(tokensPath),
  })
}

function makeAddShapes(defaultTokensPath: string): ToolDefinition<z.infer<ReturnType<typeof makeAddShapesInput>>> {
  return {
    name: 'penpot_add_shapes',
    description:
      'Add one or more shapes (rect, frame, text) to a page in a Penpot file. Colors accept either a literal ' +
      'hex string or a { token: "name" } reference resolved against the project token file. Only unrotated ' +
      'shapes are supported.',
    inputSchema: makeAddShapesInput(defaultTokensPath),
    handler: async (client, { fileId, pageId, shapes, tokensPath }) => {
      const tokens = await loadTokenFile(tokensPath)
      const file = await client.getFile(fileId)
      const changes = shapes.map((spec) => {
        const obj = buildShapeObject(spec, tokens)
        return addObj(pageId, obj)
      })
      const result = await client.updateFile(fileId, file.revn, file.vern, changes)
      return { shapeIds: changes.map((c) => c.id), revn: result.revn }
    },
  }
}

const loadTokenConfigInput = z.object({ tokensPath: z.string() })

function makeLoadTokenConfig(defaultTokensPath: string): ToolDefinition<z.infer<typeof loadTokenConfigInput>> {
  return {
    name: 'penpot_load_token_config',
    description: 'Read and validate the project design-token file, returning the resolved color/font table.',
    inputSchema: loadTokenConfigInput.extend({ tokensPath: z.string().default(defaultTokensPath) }),
    handler: async (_client, { tokensPath }) => loadTokenFile(tokensPath),
  }
}

export function contentTools(defaultTokensPath: string) {
  return [createPage, makeAddShapes(defaultTokensPath), makeLoadTokenConfig(defaultTokensPath)]
}
