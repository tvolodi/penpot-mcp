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
import { randomUUID } from 'node:crypto'
import type { PenpotRpcClient } from '../rpc-client.js'
import {
  addObj,
  addComponent,
  addPage,
  cloneComponentInstance,
  componentRootAttrs,
  frame,
  rect,
  text,
  variantContainerAttrs,
  ROOT_FRAME_ID,
  type ShapeNode,
} from '../shape-builders.js'
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

const sizingSchema = z.enum(['fill', 'auto', 'fix'])
const alignSchema = z.enum(['start', 'center', 'end', 'stretch'])
const alignContentSchema = z.enum([
  'start',
  'center',
  'end',
  'stretch',
  'space-between',
  'space-around',
  'space-evenly',
])
const paddingSchema = z.object({
  p1: z.number().min(0).optional(),
  p2: z.number().min(0).optional(),
  p3: z.number().min(0).optional(),
  p4: z.number().min(0).optional(),
})
const gridTrackSchema = z.object({
  type: z.enum(['fixed', 'percent', 'flex', 'auto']),
  value: z.number().optional(),
})

const flexLayoutSchema = z.object({
  type: z.literal('flex'),
  dir: z.enum(['row', 'row-reverse', 'column', 'column-reverse']).optional(),
  rowGap: z.number().optional(),
  columnGap: z.number().optional(),
  wrapType: z.enum(['wrap', 'nowrap']).optional(),
  paddingType: z.enum(['simple', 'multiple']).optional(),
  padding: paddingSchema.optional(),
  alignItems: alignSchema.optional(),
  alignContent: alignContentSchema.optional(),
  justifyItems: alignSchema.optional(),
  justifyContent: alignContentSchema.optional(),
})

const gridLayoutSchema = z.object({
  type: z.literal('grid'),
  dir: z.enum(['row', 'column']).optional(),
  rowGap: z.number().optional(),
  columnGap: z.number().optional(),
  paddingType: z.enum(['simple', 'multiple']).optional(),
  padding: paddingSchema.optional(),
  alignItems: alignSchema.optional(),
  alignContent: alignContentSchema.optional(),
  justifyItems: alignSchema.optional(),
  justifyContent: alignContentSchema.optional(),
  rows: z.array(gridTrackSchema).optional(),
  columns: z.array(gridTrackSchema).optional(),
})

const layoutSchema = z.discriminatedUnion('type', [flexLayoutSchema, gridLayoutSchema])

const layoutItemSchema = z.object({
  absolute: z.boolean().optional(),
  zIndex: z.number().optional(),
  horizontalSizing: sizingSchema.optional(),
  verticalSizing: sizingSchema.optional(),
  alignSelf: z.enum(['start', 'center', 'end', 'auto', 'stretch']).optional(),
  margin: z
    .object({
      m1: z.number().optional(),
      m2: z.number().optional(),
      m3: z.number().optional(),
      m4: z.number().optional(),
    })
    .optional(),
  maxWidth: z.number().optional(),
  maxHeight: z.number().optional(),
  minWidth: z.number().optional(),
  minHeight: z.number().optional(),
  row: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  rowSpan: z.number().int().positive().optional(),
  columnSpan: z.number().int().positive().optional(),
})

const baseShapeFields = {
  /** Optional caller-chosen id, so sibling shapes in the same call can reference each other as parent/frame. */
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().default(0),
  parentId: z.string().default(ROOT_FRAME_ID),
  frameId: z.string().default(ROOT_FRAME_ID),
  layoutItem: layoutItemSchema.optional(),
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
  /** Adds flex or grid auto-layout, controlling how this frame's children are positioned. */
  layout: layoutSchema.optional(),
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
        id: spec.id,
        name: spec.name,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        rotation: spec.rotation,
        parentId: spec.parentId,
        frameId: spec.frameId,
        layoutItem: spec.layoutItem,
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
        id: spec.id,
        name: spec.name,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        rotation: spec.rotation,
        parentId: spec.parentId,
        frameId: spec.frameId,
        layoutItem: spec.layoutItem,
        layout: spec.layout,
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
        id: spec.id,
        name: spec.name,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        rotation: spec.rotation,
        parentId: spec.parentId,
        frameId: spec.frameId,
        layoutItem: spec.layoutItem,
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
      'hex string or a { token: "name" } reference resolved against the project token file. Shapes may be ' +
      'rotated via the "rotation" field (degrees, clockwise, about the shape\'s center). Frames may declare ' +
      'flex or grid auto-layout via "layout"; any shape may set "layoutItem" to control its own placement ' +
      'within an auto-layout parent (sizing, alignment, margins, and, for grid parents, row/column).',
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

function makeCreateComponentInput(tokensPath: string) {
  return z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    componentName: z.string().min(1),
    /** The shape tree that becomes the component's main instance. Give shapes explicit `id`s to nest them
     * (a child's `parentId`/`frameId` referencing a sibling's `id`); exactly one shape must be the root —
     * i.e. not referenced as any sibling's `parentId`. */
    shapes: z.array(shapeSpecSchema).min(1),
    tokensPath: z.string().default(tokensPath),
  })
}

function makeCreateComponent(
  defaultTokensPath: string,
): ToolDefinition<z.infer<ReturnType<typeof makeCreateComponentInput>>> {
  return {
    name: 'penpot_create_component',
    description:
      'Register a new shape tree as a Penpot component (its "main instance"). Accepts the same shape specs as ' +
      'penpot_add_shapes (rect/frame/text, with layout/rotation/etc.); give each shape an explicit "id" so ' +
      'children can nest under a sibling via matching "parentId"/"frameId". The one shape not parented to a ' +
      'sibling in this call becomes the component root. Returns the componentId, usable with ' +
      'penpot_add_component_instance to place copies elsewhere.',
    inputSchema: makeCreateComponentInput(defaultTokensPath),
    handler: async (client, { fileId, pageId, componentName, shapes, tokensPath }) => {
      const tokens = await loadTokenFile(tokensPath)
      const file = await client.getFile(fileId)

      const specsWithIds = shapes.map((spec) => ({ ...spec, id: spec.id ?? randomUUID() }))
      const idsInBatch = new Set(specsWithIds.map((s) => s.id))
      const rootCandidates = specsWithIds.filter((s) => !idsInBatch.has(s.parentId))
      const rootCandidate = rootCandidates[0]
      if (rootCandidates.length !== 1 || !rootCandidate) {
        throw new Error(
          `penpot_create_component: expected exactly one root shape (not parented to a sibling in this call), ` +
            `found ${rootCandidates.length}`,
        )
      }
      const rootId = rootCandidate.id!

      const objs = specsWithIds.map((spec) => buildShapeObject(spec, tokens))
      for (const obj of objs) {
        if (obj.id === rootId) Object.assign(obj, componentRootAttrs(randomUUID(), fileId))
      }
      const componentId = (objs.find((o) => o.id === rootId)!['component-id']) as string

      const addObjChanges = objs.map((obj) => addObj(pageId, obj))
      const registerChange = addComponent(componentId, componentName, rootId, pageId)

      const result = await client.updateFile(fileId, file.revn, file.vern, [...addObjChanges, registerChange])
      return { componentId, mainInstanceId: rootId, shapeIds: objs.map((o) => o.id as string), revn: result.revn }
    },
  }
}

const variantPropertySchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
})

function makeCreateVariantGroupInput(tokensPath: string) {
  return z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    groupName: z.string().min(1),
    /** Position/size of the container frame that physically groups every variant's main instance. */
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    /** Optional auto-layout on the container, e.g. a row layout to lay variants out side by side. */
    layout: layoutSchema.optional(),
    variants: z
      .array(
        z.object({
          /** Display label for this variant, e.g. "Primary" (shown in Penpot's swap UI). */
          name: z.string().min(1),
          /** Structured property/value pairs distinguishing this variant, e.g. [{ name: "Type", value: "Primary" }]. */
          properties: z.array(variantPropertySchema).min(1),
          /** This variant's shape tree — same rules as penpot_create_component's `shapes` (explicit `id`s to
           * nest; the one shape not parented to a sibling becomes this variant's main-instance root). Root
           * shapes' parentId/frameId are ignored and forced to the new container. */
          shapes: z.array(shapeSpecSchema).min(1),
        }),
      )
      .min(2),
    tokensPath: z.string().default(tokensPath),
  })
}

function makeCreateVariantGroup(
  defaultTokensPath: string,
): ToolDefinition<z.infer<ReturnType<typeof makeCreateVariantGroupInput>>> {
  return {
    name: 'penpot_create_variant_group',
    description:
      'Create a Penpot variant group: a container frame physically grouping two or more component main ' +
      'instances that share property axes (e.g. a "Button" with Type=Primary/Secondary variants), enabling ' +
      "Penpot's variant swap UI/switchVariant on instances of these components. Each entry in \"variants\" " +
      'accepts the same shape specs as penpot_create_component. Returns one componentId per variant, usable ' +
      'with penpot_add_component_instance.',
    inputSchema: makeCreateVariantGroupInput(defaultTokensPath),
    handler: async (client, { fileId, pageId, groupName, x, y, width, height, layout, variants, tokensPath }) => {
      const tokens = await loadTokenFile(tokensPath)
      const file = await client.getFile(fileId)

      const containerId = randomUUID()
      // Verified live against Penpot's official `createVariantFromComponents` plugin API: the group's
      // `variant-id` is the CONTAINER's own shape id, not an independently generated id — a hand-built
      // group using a separate variant-id round-trips through the RPC schema without error, but the
      // editor's Variants.properties/variantComponents() then silently come back empty (the swap UI
      // wouldn't work). Reusing containerId here is what makes the group actually recognized.
      const variantId = containerId

      const allObjs: Record<string, unknown>[] = []
      const registerChanges: ReturnType<typeof addComponent>[] = []
      const resultVariants: Array<{ componentId: string; mainInstanceId: string; shapeIds: string[] }> = []

      for (const variant of variants) {
        const specsWithIds = variant.shapes.map((spec) => ({ ...spec, id: spec.id ?? randomUUID() }))
        const idsInBatch = new Set(specsWithIds.map((s) => s.id))
        const rootCandidates = specsWithIds.filter((s) => !idsInBatch.has(s.parentId))
        const rootCandidate = rootCandidates[0]
        if (rootCandidates.length !== 1 || !rootCandidate) {
          throw new Error(
            `penpot_create_variant_group: variant "${variant.name}" expected exactly one root shape ` +
              `(not parented to a sibling within its own shapes list), found ${rootCandidates.length}`,
          )
        }
        const rootId = rootCandidate.id!

        // Force the root's parent/frame to the new container, regardless of what the caller passed —
        // every variant's main instance must be a direct child of the container (verified live: setting
        // this at add-obj time works; reparenting an existing shape into it via mov-objects does not).
        const specsForContainer = specsWithIds.map((spec) =>
          spec.id === rootId ? { ...spec, parentId: containerId, frameId: containerId } : spec,
        )

        const componentId = randomUUID()
        const objs = specsForContainer.map((spec) => buildShapeObject(spec, tokens))
        for (const obj of objs) {
          if (obj.id === rootId) {
            Object.assign(obj, componentRootAttrs(componentId, fileId, { variantId, name: variant.name }))
          }
        }
        allObjs.push(...objs)
        registerChanges.push(
          addComponent(componentId, groupName, rootId, pageId, '', { variantId, properties: variant.properties }),
        )
        resultVariants.push({ componentId, mainInstanceId: rootId, shapeIds: objs.map((o) => o.id as string) })
      }

      const containerObj = frame({
        id: containerId,
        name: groupName,
        x,
        y,
        width,
        height,
        parentId: ROOT_FRAME_ID,
        frameId: ROOT_FRAME_ID,
        layout,
        fills: [],
      })
      Object.assign(containerObj, variantContainerAttrs(variantId), {
        shapes: resultVariants.map((v) => v.mainInstanceId),
      })

      const addObjChanges = [addObj(pageId, containerObj), ...allObjs.map((obj) => addObj(pageId, obj))]
      const result = await client.updateFile(fileId, file.revn, file.vern, [...addObjChanges, ...registerChanges])

      return { variantId, containerId, variants: resultVariants, revn: result.revn }
    },
  }
}

function makeAddComponentInstanceInput() {
  return z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    componentId: z.string().min(1),
    /** Where to place the instance's root shape (its main instance's top-left corner is translated here). */
    x: z.number(),
    y: z.number(),
    parentId: z.string().default(ROOT_FRAME_ID),
    frameId: z.string().default(ROOT_FRAME_ID),
  })
}

function makeAddComponentInstance(): ToolDefinition<z.infer<ReturnType<typeof makeAddComponentInstanceInput>>> {
  return {
    name: 'penpot_add_component_instance',
    description:
      'Place a copy (instance) of an existing component, created via penpot_create_component, at a new position ' +
      'on a page. Clones the component\'s full main-instance shape tree with fresh ids, linked back to the main ' +
      'via shape-ref so Penpot recognizes it as a component copy.',
    inputSchema: makeAddComponentInstanceInput(),
    handler: async (client, { fileId, pageId, componentId, x, y, parentId, frameId }) => {
      const file = await client.getFile(fileId)
      const component = file.data.components?.[componentId]
      if (!component) {
        throw new Error(`penpot_add_component_instance: no component ${componentId} found in file ${fileId}`)
      }
      const mainPage = file.data.pagesIndex[component.mainInstancePage]
      if (!mainPage) {
        throw new Error(
          `penpot_add_component_instance: component ${componentId}'s main-instance page ${component.mainInstancePage} not found`,
        )
      }
      const mainRoot = mainPage.objects[component.mainInstanceId] as ShapeNode | undefined
      if (!mainRoot) {
        throw new Error(
          `penpot_add_component_instance: component ${componentId}'s main-instance shape ${component.mainInstanceId} not found`,
        )
      }

      const dx = x - (mainRoot.x as number)
      const dy = y - (mainRoot.y as number)
      const changes = cloneComponentInstance({
        pageId,
        objects: mainPage.objects as Record<string, ShapeNode>,
        mainRootId: component.mainInstanceId,
        componentId,
        componentFileId: fileId,
        parentId,
        frameId,
        dx,
        dy,
      })

      const result = await client.updateFile(fileId, file.revn, file.vern, changes)
      const instanceRoot = changes[0]
      if (!instanceRoot) throw new Error('penpot_add_component_instance: clone produced no shapes')
      return { instanceRootId: instanceRoot.id, shapeIds: changes.map((c) => c.id), revn: result.revn }
    },
  }
}

export function contentTools(defaultTokensPath: string) {
  return [
    createPage,
    makeAddShapes(defaultTokensPath),
    makeLoadTokenConfig(defaultTokensPath),
    makeCreateComponent(defaultTokensPath),
    makeAddComponentInstance(),
    makeCreateVariantGroup(defaultTokensPath),
  ]
}
