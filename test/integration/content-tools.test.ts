/**
 * test/integration/content-tools.test.ts
 *
 * Exercises the actual MCP tool handlers (not shape-builders.ts directly) against
 * a real Penpot instance, covering the behaviors that were only verifiable by
 * live testing during development: rotation math surviving a real round-trip,
 * auto-layout attributes actually being recognized, component/instance/variant
 * wiring, and in-place shape updates. Skips itself (not fails) when Penpot
 * credentials aren't configured, so `npm test` stays green without secrets.
 */
import { describe, it, expect } from 'vitest'
import { contentTools } from '../../src/tools/content.js'
import { hasPenpotCredentials, withScratchProject, callTool, TEST_TOKENS_PATH } from './helpers/scratch-project.js'

const skip = !hasPenpotCredentials()
const d = skip ? describe.skip : describe

d('penpot_add_shapes', () => {
  it('creates a rotated rect whose selrect/points reflect the rotation, not just the raw x/y/width/height', async () => {
    await withScratchProject('add-shapes-rotation', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Rotated', x: 0, y: 0, width: 100, height: 100, rotation: 90 }],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as {
        selrect: { width: number; height: number }
        transform: { a: number; b: number }
      }
      // A 100x100 square rotated 90° still bounds to ~100x100, but the transform
      // must not be the identity matrix (regression guard against the pre-rotation-
      // support behavior where rotation was silently dropped).
      expect(shape.selrect.width).toBeCloseTo(100, 3)
      expect(shape.selrect.height).toBeCloseTo(100, 3)
      expect(shape.transform.a).not.toBeCloseTo(1, 3)
    })
  })

  it('creates a flex-layout frame that Penpot recognizes (layout attrs land on the shape as sent)', async () => {
    await withScratchProject('add-shapes-layout', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'frame',
            name: 'FlexBoard',
            x: 0,
            y: 0,
            width: 300,
            height: 100,
            layout: { type: 'flex', dir: 'column', rowGap: 12 },
          },
        ],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as {
        layout: string
        layoutFlexDir: string
        layoutGap: { rowGap: number }
      }
      expect(shape.layout).toBe('flex')
      expect(shape.layoutFlexDir).toBe('column')
      expect(shape.layoutGap.rowGap).toBe(12)
    })
  })

  it('resolves a { token: "name" } color reference against the token file', async () => {
    await withScratchProject('add-shapes-token-color', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Tokened', x: 0, y: 0, width: 10, height: 10, fillColor: { token: 'accent' }, fillOpacity: 1 }],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as { fills: Array<{ fillColor: string }> }
      expect(shape.fills[0]!.fillColor).toBe('#7AA2FF')
    })
  })
})

d('penpot_update_shapes', () => {
  it('recomputes selrect/points/transform when geometry fields change, and preserves fields it does not touch', async () => {
    await withScratchProject('update-shapes', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const updateShapes = tools.find((t) => t.name === 'penpot_update_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Original', x: 0, y: 0, width: 50, height: 50, r1: 4, r2: 4, r3: 4, r4: 4, fillColor: '#FF0000', fillOpacity: 1 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      await callTool(updateShapes, client, {
        fileId,
        pageId,
        patches: [{ shapeId, x: 200, y: 300, rotation: 45 }],
      })

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as {
        x: number
        y: number
        rotation: number
        selrect: { x: number; y: number }
        r1: number
        fills: Array<{ fillColor: string }>
      }
      expect(shape.x).toBe(200)
      expect(shape.y).toBe(300)
      expect(shape.rotation).toBe(45)
      // selrect must track the new position, not stay at the old (0,0) origin —
      // this is the exact desync mod-obj's raw `set` operation would produce.
      expect(shape.selrect.x).toBeGreaterThan(150)
      expect(shape.selrect.y).toBeGreaterThan(250)
      // Untouched fields survive the update.
      expect(shape.r1).toBe(4)
      expect(shape.fills[0]!.fillColor).toBe('#FF0000')
    })
  })

  it('preserves a frame\'s children (shapes array) and layout across an update that only renames it', async () => {
    await withScratchProject('update-shapes-frame', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const updateShapes = tools.find((t) => t.name === 'penpot_update_shapes')!

      const frameResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Board', x: 0, y: 0, width: 200, height: 200, layout: { type: 'flex', dir: 'row' } }],
      })) as { shapeIds: string[] }
      const frameId = frameResult.shapeIds[0]!

      const childResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Child', x: 10, y: 10, width: 20, height: 20, parentId: frameId, frameId }],
      })) as { shapeIds: string[] }
      const childId = childResult.shapeIds[0]!

      await callTool(updateShapes, client, {
        fileId,
        pageId,
        patches: [{ shapeId: frameId, name: 'RenamedBoard' }],
      })

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[frameId] as {
        name: string
        shapes: string[]
        layout: string
      }
      expect(shape.name).toBe('RenamedBoard')
      expect(shape.shapes).toContain(childId)
      expect(shape.layout).toBe('flex')
    })
  })
})

d('penpot_create_component / penpot_add_component_instance', () => {
  it('registers a component and places an instance linked back via shape-ref', async () => {
    await withScratchProject('components', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const createComponent = tools.find((t) => t.name === 'penpot_create_component')!
      const addInstance = tools.find((t) => t.name === 'penpot_add_component_instance')!

      const created = (await callTool(createComponent, client, {
        fileId,
        pageId,
        componentName: 'Button',
        shapes: [{ type: 'rect', name: 'ButtonMain', x: 0, y: 0, width: 120, height: 40, fillColor: '#3366FF', fillOpacity: 1 }],
      })) as { componentId: string; mainInstanceId: string }

      const instance = (await callTool(addInstance, client, {
        fileId,
        pageId,
        componentId: created.componentId,
        x: 300,
        y: 0,
      })) as { instanceRootId: string }

      const snapshot = await client.getFile(fileId)
      const mainShape = snapshot.data.pagesIndex[pageId]!.objects[created.mainInstanceId] as {
        componentRoot: boolean
        mainInstance: boolean
      }
      const instanceShape = snapshot.data.pagesIndex[pageId]!.objects[instance.instanceRootId] as {
        shapeRef: string
        componentId: string
        x: number
      }
      expect(mainShape.componentRoot).toBe(true)
      expect(mainShape.mainInstance).toBe(true)
      expect(instanceShape.shapeRef).toBe(created.mainInstanceId)
      expect(instanceShape.componentId).toBe(created.componentId)
      expect(instanceShape.x).toBe(300)
      expect(snapshot.data.components?.[created.componentId]).toBeDefined()
    })
  })
})

d('penpot_create_variant_group', () => {
  it('groups two components under one container whose variant-id equals its own shape id', async () => {
    await withScratchProject('variants', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const createVariantGroup = tools.find((t) => t.name === 'penpot_create_variant_group')!

      const result = (await callTool(createVariantGroup, client, {
        fileId,
        pageId,
        groupName: 'Button',
        x: 0,
        y: 0,
        width: 400,
        height: 100,
        variants: [
          {
            name: 'Primary',
            properties: [{ name: 'Type', value: 'Primary' }],
            shapes: [{ type: 'rect', name: 'Button', x: 0, y: 0, width: 120, height: 40, fillColor: '#3366FF', fillOpacity: 1 }],
          },
          {
            name: 'Secondary',
            properties: [{ name: 'Type', value: 'Secondary' }],
            shapes: [{ type: 'rect', name: 'Button', x: 200, y: 0, width: 120, height: 40, fillColor: '#888888', fillOpacity: 1 }],
          },
        ],
      })) as { variantId: string; containerId: string; variants: Array<{ componentId: string }> }

      // Regression test for the bug caught by diffing against Penpot's own
      // createVariantFromComponents plugin API: variant-id must equal the
      // container's own shape id, or the editor's Variants.properties/
      // variantComponents() silently come back empty.
      expect(result.variantId).toBe(result.containerId)

      const snapshot = await client.getFile(fileId)
      const container = snapshot.data.pagesIndex[pageId]!.objects[result.containerId] as {
        isVariantContainer: boolean
        variantId: string
        shapes: string[]
      }
      expect(container.isVariantContainer).toBe(true)
      expect(container.variantId).toBe(result.containerId)
      expect(container.shapes).toHaveLength(2)
      expect(result.variants).toHaveLength(2)
      expect(snapshot.data.components?.[result.variants[0]!.componentId]?.variantId).toBe(result.containerId)
    })
  })
})
