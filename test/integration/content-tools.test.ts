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
import type { PenpotRpcClient } from '../../src/rpc-client.js'
import { hasPenpotCredentials, withScratchProject, callTool, makeClient, TEST_TOKENS_PATH } from './helpers/scratch-project.js'

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

  it('resolves a { token: "name" } radius reference against the token file\'s radii table', async () => {
    await withScratchProject('add-shapes-token-radius', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'rect',
            name: 'RoundedTokened',
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            r1: { token: 'md' },
            r2: { token: 'md' },
            r3: { token: 'md' },
            r4: { token: 'md' },
          },
        ],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as { r1: number; r2: number; r3: number; r4: number }
      expect(shape.r1).toBe(8)
      expect(shape.r2).toBe(8)
      expect(shape.r3).toBe(8)
      expect(shape.r4).toBe(8)
    })
  })

  it('resolves a { token: "name" } spacing reference for a flex layout\'s gap/padding', async () => {
    await withScratchProject('add-shapes-token-spacing', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'frame',
            name: 'SpacedBoard',
            x: 0,
            y: 0,
            width: 300,
            height: 100,
            layout: {
              type: 'flex',
              dir: 'column',
              rowGap: { token: 'md' },
              columnGap: { token: 'sm' },
              paddingType: 'multiple',
              padding: { p1: { token: 'lg' }, p2: { token: 'sm' }, p3: { token: 'sm' }, p4: { token: 'sm' } },
            },
          },
        ],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as {
        layoutGap: { rowGap: number; columnGap: number }
        layoutPadding: { p1: number; p2: number; p3: number; p4: number }
      }
      expect(shape.layoutGap.rowGap).toBe(16)
      expect(shape.layoutGap.columnGap).toBe(8)
      expect(shape.layoutPadding.p1).toBe(24)
      expect(shape.layoutPadding.p2).toBe(8)
    })
  })

  it('resolves a { token: "name" } shadow reference against the token file\'s shadows table', async () => {
    await withScratchProject('add-shapes-token-shadow', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'rect',
            name: 'ShadowedTokened',
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            shadows: [{ token: 'card' }],
          },
        ],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as {
        shadows: Array<{ style: string; offsetX: number; offsetY: number; blur: number; spread: number; color: { color: string; opacity: number } }>
      }
      expect(shape.shadows).toHaveLength(1)
      expect(shape.shadows[0]!.style).toBe('drop-shadow')
      expect(shape.shadows[0]!.offsetX).toBe(4)
      expect(shape.shadows[0]!.offsetY).toBe(4)
      expect(shape.shadows[0]!.blur).toBe(8)
      expect(shape.shadows[0]!.spread).toBe(2)
      expect(shape.shadows[0]!.color.color).toBe('#000000')
      expect(shape.shadows[0]!.color.opacity).toBeCloseTo(0.3, 5)
    })
  })

  it('accepts an inline shadow (no token) with drop-shadow and inner-shadow styles', async () => {
    await withScratchProject('add-shapes-inline-shadow', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'rect',
            name: 'InlineShadowed',
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            shadows: [
              { style: 'drop-shadow', color: '#111111', opacity: 0.5, offsetX: 1, offsetY: 1, blur: 2, spread: 0 },
              { style: 'inner-shadow', color: '#FFFFFF', opacity: 0.2, offsetX: 0, offsetY: 0, blur: 1, spread: 0 },
            ],
          },
        ],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as {
        shadows: Array<{ style: string }>
      }
      expect(shape.shadows).toHaveLength(2)
      expect(shape.shadows[0]!.style).toBe('drop-shadow')
      expect(shape.shadows[1]!.style).toBe('inner-shadow')
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

  it('applies a { token: "name" } shadow reference on update, then removes it via clearShadows', async () => {
    await withScratchProject('update-shapes-shadow-token', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const updateShapes = tools.find((t) => t.name === 'penpot_update_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'NoShadowYet', x: 0, y: 0, width: 40, height: 40 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      await callTool(updateShapes, client, {
        fileId,
        pageId,
        patches: [{ shapeId, shadows: [{ token: 'card' }] }],
      })

      let snapshot = await client.getFile(fileId)
      let shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as { shadows: Array<{ style: string }> }
      expect(shape.shadows).toHaveLength(1)
      expect(shape.shadows[0]!.style).toBe('drop-shadow')

      await callTool(updateShapes, client, {
        fileId,
        pageId,
        patches: [{ shapeId, clearShadows: true }],
      })

      snapshot = await client.getFile(fileId)
      shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as { shadows: Array<{ style: string }> }
      expect(shape.shadows).toHaveLength(0)
    })
  })

  it('resolves a { token: "name" } radius reference on update, replacing only the touched corners', async () => {
    await withScratchProject('update-shapes-radius-token', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const updateShapes = tools.find((t) => t.name === 'penpot_update_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'SquareCorners', x: 0, y: 0, width: 40, height: 40, r1: 0, r2: 0, r3: 0, r4: 0 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      await callTool(updateShapes, client, {
        fileId,
        pageId,
        patches: [{ shapeId, r1: { token: 'pill' }, r2: { token: 'pill' } }],
      })

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as { r1: number; r2: number; r3: number; r4: number }
      expect(shape.r1).toBe(999)
      expect(shape.r2).toBe(999)
      // Untouched corners keep their prior value.
      expect(shape.r3).toBe(0)
      expect(shape.r4).toBe(0)
    })
  })
})

d('penpot_delete_shapes', () => {
  it('removes a shape by id', async () => {
    await withScratchProject('delete-shapes', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const deleteShapes = tools.find((t) => t.name === 'penpot_delete_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'ToDelete', x: 0, y: 0, width: 50, height: 50 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      await callTool(deleteShapes, client, { fileId, pageId, shapeIds: [shapeId] })

      const snapshot = await client.getFile(fileId)
      expect(snapshot.data.pagesIndex[pageId]!.objects[shapeId]).toBeUndefined()
    })
  })

  it('deleting a frame also removes its children', async () => {
    await withScratchProject('delete-shapes-frame', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const deleteShapes = tools.find((t) => t.name === 'penpot_delete_shapes')!

      const frameResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Board', x: 0, y: 0, width: 200, height: 200 }],
      })) as { shapeIds: string[] }
      const frameId = frameResult.shapeIds[0]!

      const childResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Child', x: 10, y: 10, width: 20, height: 20, parentId: frameId, frameId }],
      })) as { shapeIds: string[] }
      const childId = childResult.shapeIds[0]!

      await callTool(deleteShapes, client, { fileId, pageId, shapeIds: [frameId] })

      const snapshot = await client.getFile(fileId)
      expect(snapshot.data.pagesIndex[pageId]!.objects[frameId]).toBeUndefined()
      expect(snapshot.data.pagesIndex[pageId]!.objects[childId]).toBeUndefined()
    })
  })

  it('throws when a shape id does not exist on the page', async () => {
    await withScratchProject('delete-shapes-missing', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const deleteShapes = tools.find((t) => t.name === 'penpot_delete_shapes')!

      await expect(
        callTool(deleteShapes, client, { fileId, pageId, shapeIds: ['00000000-0000-0000-0000-000000000001'] }),
      ).rejects.toThrow(/not found/)
    })
  })
})

d('penpot_clone_shapes', () => {
  it('duplicates a shape with a fresh id, offset by dx/dy, alongside its source by default', async () => {
    await withScratchProject('clone-shapes', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const cloneShapes = tools.find((t) => t.name === 'penpot_clone_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Original', x: 10, y: 10, width: 50, height: 50, fillColor: '#00FF00', fillOpacity: 1 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      const result = (await callTool(cloneShapes, client, {
        fileId,
        pageId,
        shapeIds: [shapeId],
        dx: 100,
        dy: 20,
      })) as { clonedRootIds: string[]; shapeIds: string[] }

      expect(result.clonedRootIds).toHaveLength(1)
      const cloneId = result.clonedRootIds[0]!
      expect(cloneId).not.toBe(shapeId)

      const snapshot = await client.getFile(fileId)
      const original = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as { x: number; y: number; parentId: string }
      const clone = snapshot.data.pagesIndex[pageId]!.objects[cloneId] as {
        x: number
        y: number
        name: string
        parentId: string
        fills: Array<{ fillColor: string }>
      }
      expect(clone.x).toBe(original.x + 100)
      expect(clone.y).toBe(original.y + 20)
      expect(clone.name).toBe('Original')
      expect(clone.parentId).toBe(original.parentId)
      expect(clone.fills[0]!.fillColor).toBe('#00FF00')
      // Original is untouched.
      expect(original.x).toBe(10)
      expect(original.y).toBe(10)
    })
  })

  it('clones a frame together with its children, reparented under an explicit parentId/frameId', async () => {
    await withScratchProject('clone-shapes-frame', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const cloneShapes = tools.find((t) => t.name === 'penpot_clone_shapes')!

      const containerResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Container', x: 0, y: 0, width: 400, height: 400 }],
      })) as { shapeIds: string[] }
      const containerId = containerResult.shapeIds[0]!

      const frameResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Board', x: 0, y: 0, width: 200, height: 200 }],
      })) as { shapeIds: string[] }
      const frameId = frameResult.shapeIds[0]!

      const childResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Child', x: 10, y: 10, width: 20, height: 20, parentId: frameId, frameId }],
      })) as { shapeIds: string[] }
      const childId = childResult.shapeIds[0]!

      const result = (await callTool(cloneShapes, client, {
        fileId,
        pageId,
        shapeIds: [frameId],
        parentId: containerId,
        frameId: containerId,
        dx: 0,
        dy: 0,
      })) as { clonedRootIds: string[]; shapeIds: string[] }

      expect(result.shapeIds).toHaveLength(2) // cloned frame + cloned child
      const cloneFrameId = result.clonedRootIds[0]!

      const snapshot = await client.getFile(fileId)
      const clonedFrame = snapshot.data.pagesIndex[pageId]!.objects[cloneFrameId] as {
        shapes: string[]
        parentId: string
        frameId: string
      }
      expect(clonedFrame.parentId).toBe(containerId)
      expect(clonedFrame.frameId).toBe(containerId)
      expect(clonedFrame.shapes).toHaveLength(1)
      const clonedChildId = clonedFrame.shapes[0]!
      expect(clonedChildId).not.toBe(childId)

      const clonedChild = snapshot.data.pagesIndex[pageId]!.objects[clonedChildId] as { parentId: string; frameId: string }
      expect(clonedChild.parentId).toBe(cloneFrameId)
      expect(clonedChild.frameId).toBe(cloneFrameId)

      // Original frame/child are untouched.
      expect(snapshot.data.pagesIndex[pageId]!.objects[frameId]).toBeDefined()
      expect(snapshot.data.pagesIndex[pageId]!.objects[childId]).toBeDefined()
    })
  })

  it('throws when a shape id does not exist on the page', async () => {
    await withScratchProject('clone-shapes-missing', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const cloneShapes = tools.find((t) => t.name === 'penpot_clone_shapes')!

      await expect(
        callTool(cloneShapes, client, { fileId, pageId, shapeIds: ['00000000-0000-0000-0000-000000000001'] }),
      ).rejects.toThrow(/not found/)
    })
  })
})

d('penpot_reorder_shapes', () => {
  async function makeThreeSiblings(client: PenpotRpcClient, fileId: string, pageId: string) {
    const tools = contentTools(TEST_TOKENS_PATH)
    const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
    const created = (await callTool(addShapes, client, {
      fileId,
      pageId,
      shapes: [
        { type: 'rect', name: 'A', x: 0, y: 0, width: 10, height: 10 },
        { type: 'rect', name: 'B', x: 20, y: 0, width: 10, height: 10 },
        { type: 'rect', name: 'C', x: 40, y: 0, width: 10, height: 10 },
      ],
    })) as { shapeIds: string[] }
    return created.shapeIds as [string, string, string]
  }

  it('"front" moves a root-level shape to the end of the page\'s top-level order', async () => {
    await withScratchProject('reorder-front', async ({ client, fileId, pageId }) => {
      const [a, b, c] = await makeThreeSiblings(client, fileId, pageId)
      const tools = contentTools(TEST_TOKENS_PATH)
      const reorderShapes = tools.find((t) => t.name === 'penpot_reorder_shapes')!

      const result = (await callTool(reorderShapes, client, {
        fileId,
        pageId,
        shapeId: a,
        action: 'front',
      })) as { order: string[] }

      expect(result.order.indexOf(a)).toBe(result.order.length - 1)

      const snapshot = await client.getFile(fileId)
      const root = snapshot.data.pagesIndex[pageId]!.objects['00000000-0000-0000-0000-000000000000'] as {
        shapes: string[]
      }
      const ia = root.shapes.indexOf(a)
      const ib = root.shapes.indexOf(b)
      const ic = root.shapes.indexOf(c)
      expect(ia).toBeGreaterThan(ib)
      expect(ia).toBeGreaterThan(ic)
    })
  })

  it('"back" moves a shape to the start of its parent frame\'s child order', async () => {
    await withScratchProject('reorder-back', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const reorderShapes = tools.find((t) => t.name === 'penpot_reorder_shapes')!

      const frameResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Board', x: 0, y: 0, width: 200, height: 200 }],
      })) as { shapeIds: string[] }
      const frameId = frameResult.shapeIds[0]!

      const childrenResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'X', x: 10, y: 10, width: 10, height: 10, parentId: frameId, frameId },
          { type: 'rect', name: 'Y', x: 30, y: 10, width: 10, height: 10, parentId: frameId, frameId },
        ],
      })) as { shapeIds: string[] }
      const [x, y] = childrenResult.shapeIds as [string, string]

      await callTool(reorderShapes, client, { fileId, pageId, shapeId: y, action: 'back' })

      const snapshot = await client.getFile(fileId)
      const frame = snapshot.data.pagesIndex[pageId]!.objects[frameId] as { shapes: string[] }
      expect(frame.shapes).toEqual([y, x])
    })
  })

  it('"forward" and "backward" swap with the adjacent sibling', async () => {
    await withScratchProject('reorder-forward-backward', async ({ client, fileId, pageId }) => {
      const [a, b, c] = await makeThreeSiblings(client, fileId, pageId)
      const tools = contentTools(TEST_TOKENS_PATH)
      const reorderShapes = tools.find((t) => t.name === 'penpot_reorder_shapes')!

      await callTool(reorderShapes, client, { fileId, pageId, shapeId: a, action: 'forward' })

      let snapshot = await client.getFile(fileId)
      let root = snapshot.data.pagesIndex[pageId]!.objects['00000000-0000-0000-0000-000000000000'] as {
        shapes: string[]
      }
      expect(root.shapes.indexOf(a)).toBeGreaterThan(root.shapes.indexOf(b))

      await callTool(reorderShapes, client, { fileId, pageId, shapeId: a, action: 'backward' })

      snapshot = await client.getFile(fileId)
      root = snapshot.data.pagesIndex[pageId]!.objects['00000000-0000-0000-0000-000000000000'] as { shapes: string[] }
      expect(root.shapes.indexOf(a)).toBeLessThan(root.shapes.indexOf(b))
      expect(root.shapes).toContain(c)
    })
  })

  it('"before"/"after" place a shape relative to an explicit targetId', async () => {
    await withScratchProject('reorder-before-after', async ({ client, fileId, pageId }) => {
      const [a, b, c] = await makeThreeSiblings(client, fileId, pageId)
      const tools = contentTools(TEST_TOKENS_PATH)
      const reorderShapes = tools.find((t) => t.name === 'penpot_reorder_shapes')!

      await callTool(reorderShapes, client, { fileId, pageId, shapeId: c, action: 'before', targetId: a })

      const snapshot = await client.getFile(fileId)
      const root = snapshot.data.pagesIndex[pageId]!.objects['00000000-0000-0000-0000-000000000000'] as {
        shapes: string[]
      }
      expect(root.shapes.indexOf(c)).toBe(root.shapes.indexOf(a) - 1)
      expect(root.shapes).toContain(b)
    })
  })

  it('throws when action is "before"/"after" without targetId', async () => {
    await withScratchProject('reorder-missing-target', async ({ client, fileId, pageId }) => {
      const [a] = await makeThreeSiblings(client, fileId, pageId)
      const tools = contentTools(TEST_TOKENS_PATH)
      const reorderShapes = tools.find((t) => t.name === 'penpot_reorder_shapes')!

      await expect(
        callTool(reorderShapes, client, { fileId, pageId, shapeId: a, action: 'before' }),
      ).rejects.toThrow(/targetId/)
    })
  })

  it('throws when the shape id does not exist on the page', async () => {
    await withScratchProject('reorder-missing-shape', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const reorderShapes = tools.find((t) => t.name === 'penpot_reorder_shapes')!

      await expect(
        callTool(reorderShapes, client, {
          fileId,
          pageId,
          shapeId: '00000000-0000-0000-0000-000000000001',
          action: 'front',
        }),
      ).rejects.toThrow(/not found/)
    })
  })
})

d('penpot_align_shapes', () => {
  it('aligns shapes to a common left edge, moving only along x and never moving the leftmost', async () => {
    await withScratchProject('align-left', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const alignShapes = tools.find((t) => t.name === 'penpot_align_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'A', x: 10, y: 0, width: 30, height: 20 },
          { type: 'rect', name: 'B', x: 50, y: 100, width: 20, height: 20 },
          { type: 'rect', name: 'C', x: 30, y: 200, width: 60, height: 20 },
        ],
      })) as { shapeIds: string[] }
      const [a, b, c] = created.shapeIds as [string, string, string]

      await callTool(alignShapes, client, { fileId, pageId, shapeIds: [a, b, c], edge: 'left' })

      const snapshot = await client.getFile(fileId)
      const objs = snapshot.data.pagesIndex[pageId]!.objects as Record<string, { x: number; y: number }>
      // Every left edge snaps to the leftmost (A at x=10); y is untouched.
      expect(objs[a]!.x).toBe(10)
      expect(objs[b]!.x).toBe(10)
      expect(objs[c]!.x).toBe(10)
      expect(objs[b]!.y).toBe(100)
      expect(objs[c]!.y).toBe(200)
    })
  })

  it('centers shapes horizontally on the group mid-x', async () => {
    await withScratchProject('align-center-h', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const alignShapes = tools.find((t) => t.name === 'penpot_align_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'A', x: 0, y: 0, width: 20, height: 20 },
          { type: 'rect', name: 'B', x: 80, y: 50, width: 20, height: 20 },
        ],
      })) as { shapeIds: string[] }
      const [a, b] = created.shapeIds as [string, string]

      await callTool(alignShapes, client, { fileId, pageId, shapeIds: [a, b], edge: 'center-h' })

      const snapshot = await client.getFile(fileId)
      const objs = snapshot.data.pagesIndex[pageId]!.objects as Record<string, { x: number; width: number }>
      // Group x extent [0,100] → mid-x 50; both 20-wide boxes center at x=40.
      expect(objs[a]!.x).toBe(40)
      expect(objs[b]!.x).toBe(40)
    })
  })

  it('moves a frame together with its child when the frame is aligned', async () => {
    await withScratchProject('align-frame-children', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const alignShapes = tools.find((t) => t.name === 'penpot_align_shapes')!

      // A plain rect on the left, and a frame (with a child) further right.
      const anchor = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Anchor', x: 0, y: 0, width: 20, height: 20 }],
      })) as { shapeIds: string[] }
      const anchorId = anchor.shapeIds[0]!

      const frameResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Board', x: 100, y: 0, width: 60, height: 60 }],
      })) as { shapeIds: string[] }
      const frameId = frameResult.shapeIds[0]!

      const childResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Child', x: 110, y: 10, width: 20, height: 20, parentId: frameId, frameId }],
      })) as { shapeIds: string[] }
      const childId = childResult.shapeIds[0]!

      await callTool(alignShapes, client, { fileId, pageId, shapeIds: [anchorId, frameId], edge: 'left' })

      const snapshot = await client.getFile(fileId)
      const objs = snapshot.data.pagesIndex[pageId]!.objects as Record<string, { x: number }>
      // Frame's left edge snaps from 100 to 0 (dx = -100); its child must follow by the same delta.
      expect(objs[frameId]!.x).toBe(0)
      expect(objs[childId]!.x).toBe(10) // 110 - 100
    })
  })

  it('throws when a shape id does not exist on the page', async () => {
    await withScratchProject('align-missing', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const alignShapes = tools.find((t) => t.name === 'penpot_align_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'A', x: 0, y: 0, width: 10, height: 10 }],
      })) as { shapeIds: string[] }

      await expect(
        callTool(alignShapes, client, {
          fileId,
          pageId,
          shapeIds: [created.shapeIds[0]!, '00000000-0000-0000-0000-000000000001'],
          edge: 'left',
        }),
      ).rejects.toThrow(/not found/)
    })
  })
})

d('penpot_distribute_shapes', () => {
  it('equalizes horizontal gaps, leaving the two endpoints put', async () => {
    await withScratchProject('distribute-horizontal', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const distributeShapes = tools.find((t) => t.name === 'penpot_distribute_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'L', x: 0, y: 0, width: 10, height: 10 },
          { type: 'rect', name: 'M', x: 20, y: 0, width: 10, height: 10 },
          { type: 'rect', name: 'R', x: 100, y: 0, width: 10, height: 10 },
        ],
      })) as { shapeIds: string[] }
      const [l, m, r] = created.shapeIds as [string, string, string]

      await callTool(distributeShapes, client, { fileId, pageId, shapeIds: [l, m, r], axis: 'horizontal' })

      const snapshot = await client.getFile(fileId)
      const objs = snapshot.data.pagesIndex[pageId]!.objects as Record<string, { x: number }>
      // Span 0..110, total width 30, free 80 over 2 gaps → gap 40; middle x1 = 0 + 10 + 40 = 50.
      expect(objs[l]!.x).toBe(0)
      expect(objs[r]!.x).toBe(100)
      expect(objs[m]!.x).toBe(50)
    })
  })

  it('throws with fewer than 3 shapes (schema rejects it)', async () => {
    await withScratchProject('distribute-too-few', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const distributeShapes = tools.find((t) => t.name === 'penpot_distribute_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'A', x: 0, y: 0, width: 10, height: 10 },
          { type: 'rect', name: 'B', x: 40, y: 0, width: 10, height: 10 },
        ],
      })) as { shapeIds: string[] }

      // The .min(3) schema rejects at parse time, which callTool does synchronously
      // (before any promise) — so this is a synchronous throw, not a rejected promise.
      expect(() =>
        callTool(distributeShapes, client, { fileId, pageId, shapeIds: created.shapeIds, axis: 'horizontal' }),
      ).toThrow(/>=3/)
    })
  })
})

d('penpot_batch', () => {
  it('creates a frame and a child referencing its caller-chosen id, in one update-file round trip', async () => {
    await withScratchProject('batch-create-nested', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const batch = tools.find((t) => t.name === 'penpot_batch')!

      const frameId = '093cb14b-286f-4218-b6a3-edaa49cb8283'
      const result = (await callTool(batch, client, {
        fileId,
        pageId,
        ops: [
          { op: 'create', shape: { type: 'frame', id: frameId, name: 'Board', x: 0, y: 0, width: 200, height: 200 } },
          {
            op: 'create',
            shape: { type: 'rect', name: 'Child', x: 10, y: 10, width: 20, height: 20, parentId: frameId, frameId },
          },
        ],
      })) as { results: Array<{ op: string; shapeId: string }>; revn: number }

      expect(result.results).toHaveLength(2)
      expect(result.results[0]!.shapeId).toBe(frameId)
      const childId = result.results[1]!.shapeId

      const snapshot = await client.getFile(fileId)
      const frame = snapshot.data.pagesIndex[pageId]!.objects[frameId] as { shapes: string[] }
      const child = snapshot.data.pagesIndex[pageId]!.objects[childId] as { parentId: string; frameId: string }
      expect(frame.shapes).toContain(childId)
      expect(child.parentId).toBe(frameId)
      expect(child.frameId).toBe(frameId)
    })
  })

  it('applies create/update/delete/reorder ops in order, each seeing earlier ops in the same batch', async () => {
    await withScratchProject('batch-mixed-ops', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const batch = tools.find((t) => t.name === 'penpot_batch')!

      const existing = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Existing', x: 0, y: 0, width: 10, height: 10 }],
      })) as { shapeIds: string[] }
      const existingId = existing.shapeIds[0]!

      const result = (await callTool(batch, client, {
        fileId,
        pageId,
        ops: [
          { op: 'create', shape: { type: 'rect', name: 'New', x: 50, y: 50, width: 10, height: 10 } },
          { op: 'update', patch: { shapeId: existingId, x: 99, name: 'Renamed' } },
          { op: 'delete', shapeId: existingId },
        ],
      })) as { results: Array<{ op: string; shapeId: string }>; revn: number }

      // The delete op targets the shape the update op just touched, in the same batch —
      // this only works if penpot_batch tracks its own in-memory shadow of `objects`
      // rather than only trusting the get-file snapshot taken before the batch started.
      expect(result.results.map((r) => r.op)).toEqual(['create', 'update', 'delete'])

      const newShapeId = result.results[0]!.shapeId
      const snapshot = await client.getFile(fileId)
      expect(snapshot.data.pagesIndex[pageId]!.objects[newShapeId]).toBeDefined()
      expect(snapshot.data.pagesIndex[pageId]!.objects[existingId]).toBeUndefined()
    })
  })

  it('reorders a shape created earlier in the same batch', async () => {
    await withScratchProject('batch-reorder-same-batch', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const batch = tools.find((t) => t.name === 'penpot_batch')!

      const existing = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'A', x: 0, y: 0, width: 10, height: 10 }],
      })) as { shapeIds: string[] }
      const a = existing.shapeIds[0]!

      const newId = 'a1128e9a-b6b2-41de-ba14-34c8028d6099'
      const result = (await callTool(batch, client, {
        fileId,
        pageId,
        ops: [
          { op: 'create', shape: { type: 'rect', id: newId, name: 'B', x: 20, y: 0, width: 10, height: 10 } },
          { op: 'reorder', shapeId: newId, action: 'before', targetId: a },
        ],
      })) as { results: Array<{ op: string; shapeId: string; order?: string[] }> }

      const reorderResult = result.results[1]!
      expect(reorderResult.order!.indexOf(newId)).toBe(reorderResult.order!.indexOf(a) - 1)

      const snapshot = await client.getFile(fileId)
      const root = snapshot.data.pagesIndex[pageId]!.objects['00000000-0000-0000-0000-000000000000'] as {
        shapes: string[]
      }
      expect(root.shapes.indexOf(newId)).toBe(root.shapes.indexOf(a) - 1)
    })
  })

  it('throws referencing the op index when a later op targets a shape id not found', async () => {
    await withScratchProject('batch-missing-shape', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const batch = tools.find((t) => t.name === 'penpot_batch')!

      await expect(
        callTool(batch, client, {
          fileId,
          pageId,
          ops: [{ op: 'update', patch: { shapeId: '00000000-0000-0000-0000-000000000001', name: 'X' } }],
        }),
      ).rejects.toThrow(/op 0 \(update\).*not found/)
    })
  })
})

d('penpot_checkpoint / penpot_restore_checkpoint / penpot_discard_checkpoint', () => {
  it('restores a deleted shape back to the page', async () => {
    await withScratchProject('checkpoint-restore-delete', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const deleteShapes = tools.find((t) => t.name === 'penpot_delete_shapes')!
      const checkpoint = tools.find((t) => t.name === 'penpot_checkpoint')!
      const restore = tools.find((t) => t.name === 'penpot_restore_checkpoint')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Survivor', x: 5, y: 5, width: 20, height: 20, fillColor: '#FF00FF', fillOpacity: 1 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      const cp = (await callTool(checkpoint, client, { fileId, pageId })) as { checkpointId: string }

      await callTool(deleteShapes, client, { fileId, pageId, shapeIds: [shapeId] })
      let snapshot = await client.getFile(fileId)
      expect(snapshot.data.pagesIndex[pageId]!.objects[shapeId]).toBeUndefined()

      await callTool(restore, client, { checkpointId: cp.checkpointId })

      snapshot = await client.getFile(fileId)
      const restored = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as {
        name: string
        x: number
        fills: Array<{ fillColor: string }>
      }
      expect(restored).toBeDefined()
      expect(restored.name).toBe('Survivor')
      expect(restored.x).toBe(5)
      expect(restored.fills[0]!.fillColor).toBe('#FF00FF')

      // The restored shape must also be back in its parent's (the root frame's) shapes
      // order, not just present as a dangling object — otherwise Penpot's editor
      // wouldn't actually render it.
      const root = snapshot.data.pagesIndex[pageId]!.objects['00000000-0000-0000-0000-000000000000'] as {
        shapes: string[]
      }
      expect(root.shapes).toContain(shapeId)
    })
  })

  it('reverts an in-place update back to its snapshotted fields', async () => {
    await withScratchProject('checkpoint-restore-update', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const updateShapes = tools.find((t) => t.name === 'penpot_update_shapes')!
      const checkpoint = tools.find((t) => t.name === 'penpot_checkpoint')!
      const restore = tools.find((t) => t.name === 'penpot_restore_checkpoint')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Original', x: 0, y: 0, width: 10, height: 10 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      const cp = (await callTool(checkpoint, client, { fileId, pageId })) as { checkpointId: string }

      await callTool(updateShapes, client, { fileId, pageId, patches: [{ shapeId, x: 500, name: 'Moved' }] })

      await callTool(restore, client, { checkpointId: cp.checkpointId })

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as { x: number; name: string }
      expect(shape.x).toBe(0)
      expect(shape.name).toBe('Original')
    })
  })

  it('removes a shape created after the checkpoint', async () => {
    await withScratchProject('checkpoint-restore-create', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const checkpoint = tools.find((t) => t.name === 'penpot_checkpoint')!
      const restore = tools.find((t) => t.name === 'penpot_restore_checkpoint')!

      const cp = (await callTool(checkpoint, client, { fileId, pageId })) as { checkpointId: string }

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Unwanted', x: 0, y: 0, width: 10, height: 10 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      const result = (await callTool(restore, client, { checkpointId: cp.checkpointId })) as {
        deletedShapeCount: number
      }
      expect(result.deletedShapeCount).toBe(1)

      const snapshot = await client.getFile(fileId)
      expect(snapshot.data.pagesIndex[pageId]!.objects[shapeId]).toBeUndefined()
    })
  })

  it('is reusable: the same checkpoint can be restored to more than once', async () => {
    await withScratchProject('checkpoint-reusable', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const deleteShapes = tools.find((t) => t.name === 'penpot_delete_shapes')!
      const checkpoint = tools.find((t) => t.name === 'penpot_checkpoint')!
      const restore = tools.find((t) => t.name === 'penpot_restore_checkpoint')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'A', x: 0, y: 0, width: 10, height: 10 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      const cp = (await callTool(checkpoint, client, { fileId, pageId })) as { checkpointId: string }

      await callTool(deleteShapes, client, { fileId, pageId, shapeIds: [shapeId] })
      await callTool(restore, client, { checkpointId: cp.checkpointId })
      await callTool(deleteShapes, client, { fileId, pageId, shapeIds: [shapeId] })
      await callTool(restore, client, { checkpointId: cp.checkpointId })

      const snapshot = await client.getFile(fileId)
      expect(snapshot.data.pagesIndex[pageId]!.objects[shapeId]).toBeDefined()
    })
  })

  it('penpot_discard_checkpoint makes a later restore throw', async () => {
    await withScratchProject('checkpoint-discard', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const checkpoint = tools.find((t) => t.name === 'penpot_checkpoint')!
      const restore = tools.find((t) => t.name === 'penpot_restore_checkpoint')!
      const discard = tools.find((t) => t.name === 'penpot_discard_checkpoint')!

      const cp = (await callTool(checkpoint, client, { fileId, pageId })) as { checkpointId: string }

      const discardResult = (await callTool(discard, client, { checkpointId: cp.checkpointId })) as {
        discarded: boolean
      }
      expect(discardResult.discarded).toBe(true)

      await expect(callTool(restore, client, { checkpointId: cp.checkpointId })).rejects.toThrow(/no checkpoint/)
    })
  })

  it('throws when restoring an unknown checkpoint id', async () => {
    const tools = contentTools(TEST_TOKENS_PATH)
    const restore = tools.find((t) => t.name === 'penpot_restore_checkpoint')!
    await expect(
      callTool(restore, makeClient(), { checkpointId: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toThrow(/no checkpoint/)
  })
})

d('penpot_get_shape', () => {
  it('returns a single shape without descendants when includeDescendants is false', async () => {
    await withScratchProject('get-shape-flat', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const getShape = tools.find((t) => t.name === 'penpot_get_shape')!

      const frameResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Board', x: 0, y: 0, width: 200, height: 200 }],
      })) as { shapeIds: string[] }
      const frameId = frameResult.shapeIds[0]!

      const childResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Child', x: 10, y: 10, width: 20, height: 20, parentId: frameId, frameId }],
      })) as { shapeIds: string[] }
      const childId = childResult.shapeIds[0]!

      const result = (await callTool(getShape, client, {
        fileId,
        pageId,
        shapeId: frameId,
        includeDescendants: false,
      })) as { id: string; name: string; shapes: string[] }

      expect(result.id).toBe(frameId)
      expect(result.name).toBe('Board')
      expect(result.shapes).toEqual([childId])
    })
  })

  it('nests descendant shapes under "shapes" by default', async () => {
    await withScratchProject('get-shape-nested', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const getShape = tools.find((t) => t.name === 'penpot_get_shape')!

      const frameResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Board', x: 0, y: 0, width: 200, height: 200 }],
      })) as { shapeIds: string[] }
      const frameId = frameResult.shapeIds[0]!

      const childResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Child', x: 10, y: 10, width: 20, height: 20, parentId: frameId, frameId }],
      })) as { shapeIds: string[] }
      const childId = childResult.shapeIds[0]!

      const result = (await callTool(getShape, client, {
        fileId,
        pageId,
        shapeId: frameId,
      })) as { id: string; shapes: Array<{ id: string; name: string }> }

      expect(result.id).toBe(frameId)
      expect(result.shapes).toHaveLength(1)
      expect(result.shapes[0]!.id).toBe(childId)
      expect(result.shapes[0]!.name).toBe('Child')
    })
  })

  it('throws when the shape id does not exist on the page', async () => {
    await withScratchProject('get-shape-missing', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const getShape = tools.find((t) => t.name === 'penpot_get_shape')!

      await expect(
        callTool(getShape, client, { fileId, pageId, shapeId: '00000000-0000-0000-0000-000000000001' }),
      ).rejects.toThrow(/not found/)
    })
  })
})

d('penpot_find_shapes', () => {
  it('filters by type', async () => {
    await withScratchProject('find-shapes-type', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const findShapesTool = tools.find((t) => t.name === 'penpot_find_shapes')!

      await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'RectOne', x: 0, y: 0, width: 20, height: 20 },
          { type: 'text', name: 'TextOne', x: 0, y: 0, width: 20, height: 20, characters: 'hello' },
        ],
      })

      const result = (await callTool(findShapesTool, client, {
        fileId,
        pageId,
        type: 'text',
      })) as { shapes: Array<{ name: string; type: string }>; count: number }

      expect(result.count).toBe(1)
      expect(result.shapes[0]!.name).toBe('TextOne')
      expect(result.shapes[0]!.type).toBe('text')
    })
  })

  it('filters by nameContains (case-insensitive substring)', async () => {
    await withScratchProject('find-shapes-name', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const findShapesTool = tools.find((t) => t.name === 'penpot_find_shapes')!

      await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'Primary Button', x: 0, y: 0, width: 20, height: 20 },
          { type: 'rect', name: 'Secondary Button', x: 0, y: 0, width: 20, height: 20 },
          { type: 'rect', name: 'Icon', x: 0, y: 0, width: 20, height: 20 },
        ],
      })

      const result = (await callTool(findShapesTool, client, {
        fileId,
        pageId,
        nameContains: 'button',
      })) as { shapes: Array<{ name: string }>; count: number }

      expect(result.count).toBe(2)
      expect(result.shapes.map((s) => s.name).sort()).toEqual(['Primary Button', 'Secondary Button'])
    })
  })

  it('filters by textContains against rendered text-shape characters', async () => {
    await withScratchProject('find-shapes-text', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const findShapesTool = tools.find((t) => t.name === 'penpot_find_shapes')!

      await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'text', name: 'Label1', x: 0, y: 0, width: 100, height: 20, characters: 'Welcome aboard' },
          { type: 'text', name: 'Label2', x: 0, y: 0, width: 100, height: 20, characters: 'Goodbye' },
        ],
      })

      const result = (await callTool(findShapesTool, client, {
        fileId,
        pageId,
        textContains: 'welcome',
      })) as { shapes: Array<{ name: string }>; count: number }

      expect(result.count).toBe(1)
      expect(result.shapes[0]!.name).toBe('Label1')
    })
  })
})

d('opacity, hidden, blocked, blendMode fields', () => {
  it('creates a shape with opacity and verifies round-trip via get-file', async () => {
    await withScratchProject('add-shapes-opacity', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'SemiTransparent', x: 0, y: 0, width: 100, height: 100, opacity: 0.5 }],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as { opacity: number }
      expect(shape.opacity).toBe(0.5)
    })
  })

  it('creates a shape with hidden flag and verifies round-trip via get-file', async () => {
    await withScratchProject('add-shapes-hidden', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'circle', name: 'HiddenCircle', x: 0, y: 0, width: 50, height: 50, hidden: true }],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as { hidden: boolean }
      expect(shape.hidden).toBe(true)
    })
  })

  it('creates a shape with blocked flag and verifies round-trip via get-file', async () => {
    await withScratchProject('add-shapes-blocked', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'BlockedFrame', x: 0, y: 0, width: 200, height: 200, blocked: true }],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as { blocked: boolean }
      expect(shape.blocked).toBe(true)
    })
  })

  it('creates a shape with blendMode and verifies round-trip via get-file', async () => {
    await withScratchProject('add-shapes-blendMode', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'BlendedRect', x: 0, y: 0, width: 100, height: 100, blendMode: 'multiply' }],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as Record<string, unknown>
      expect(shape['blend-mode']).toBe('multiply')
    })
  })

  it('updates a shape\'s opacity via penpot_update_shapes and verifies the new value persists', async () => {
    await withScratchProject('update-shapes-opacity', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const updateShapes = tools.find((t) => t.name === 'penpot_update_shapes')!

      // Create initial shape
      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'TestRect', x: 0, y: 0, width: 100, height: 100, opacity: 1.0 }],
      })) as { shapeIds: string[] }

      const shapeId = result.shapeIds[0]!

      // Update opacity
      await callTool(updateShapes, client, {
        fileId,
        pageId,
        patches: [{ shapeId, opacity: 0.25 }],
      })

      // Verify
      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as { opacity: number }
      expect(shape.opacity).toBe(0.25)
    })
  })

  it('updates a shape\'s blendMode via penpot_update_shapes and verifies persistence', async () => {
    await withScratchProject('update-shapes-blendMode', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const updateShapes = tools.find((t) => t.name === 'penpot_update_shapes')!

      // Create initial shape
      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'circle', name: 'TestCircle', x: 0, y: 0, width: 50, height: 50, blendMode: 'normal' }],
      })) as { shapeIds: string[] }

      const shapeId = result.shapeIds[0]!

      // Update blendMode
      await callTool(updateShapes, client, {
        fileId,
        pageId,
        patches: [{ shapeId, blendMode: 'screen' }],
      })

      // Verify
      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as Record<string, unknown>
      expect(shape['blend-mode']).toBe('screen')
    })
  })

  it('creates a shape with all four fields (opacity, hidden, blocked, blendMode)', async () => {
    await withScratchProject('add-shapes-all-flags', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'rect',
            name: 'AllFlags',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            opacity: 0.75,
            hidden: false,
            blocked: true,
            blendMode: 'overlay',
          },
        ],
      })) as { shapeIds: string[] }

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[result.shapeIds[0]!] as Record<string, unknown>
      expect(shape.opacity).toBe(0.75)
      expect(shape.hidden).toBe(false)
      expect(shape.blocked).toBe(true)
      expect(shape['blend-mode']).toBe('overlay')
    })
  })

  it('filters by isRoot', async () => {
    await withScratchProject('find-shapes-root', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const findShapesTool = tools.find((t) => t.name === 'penpot_find_shapes')!

      const frameResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Board', x: 0, y: 0, width: 200, height: 200 }],
      })) as { shapeIds: string[] }
      const frameId = frameResult.shapeIds[0]!

      await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'Child', x: 10, y: 10, width: 20, height: 20, parentId: frameId, frameId },
        ],
      })

      const result = (await callTool(findShapesTool, client, {
        fileId,
        pageId,
        isRoot: true,
      })) as { shapes: Array<{ name: string }>; count: number }

      expect(result.shapes.map((s) => s.name)).toEqual(['Board'])
    })
  })

  it('combines multiple filters with AND semantics and respects limit', async () => {
    await withScratchProject('find-shapes-combo', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const findShapesTool = tools.find((t) => t.name === 'penpot_find_shapes')!

      await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'Button Red', x: 0, y: 0, width: 20, height: 20 },
          { type: 'rect', name: 'Button Blue', x: 0, y: 0, width: 20, height: 20 },
          { type: 'text', name: 'Button Label', x: 0, y: 0, width: 20, height: 20, characters: 'Go' },
        ],
      })

      const result = (await callTool(findShapesTool, client, {
        fileId,
        pageId,
        type: 'rect',
        nameContains: 'button',
        limit: 1,
      })) as { shapes: Array<{ name: string }>; count: number }

      expect(result.count).toBe(1)
      expect(result.shapes[0]!.name.startsWith('Button')).toBe(true)
    })
  })

  it('throws when the page id does not exist', async () => {
    await withScratchProject('find-shapes-missing-page', async ({ client, fileId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const findShapesTool = tools.find((t) => t.name === 'penpot_find_shapes')!

      await expect(
        callTool(findShapesTool, client, { fileId, pageId: '00000000-0000-0000-0000-000000000001' }),
      ).rejects.toThrow(/not found/)
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

d('penpot_list_components', () => {
  it('lists a component created via penpot_create_component', async () => {
    await withScratchProject('list-components', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const createComponent = tools.find((t) => t.name === 'penpot_create_component')!
      const listComponentsTool = tools.find((t) => t.name === 'penpot_list_components')!

      const created = (await callTool(createComponent, client, {
        fileId,
        pageId,
        componentName: 'Button',
        shapes: [{ type: 'rect', name: 'ButtonMain', x: 0, y: 0, width: 120, height: 40, fillColor: '#3366FF', fillOpacity: 1 }],
      })) as { componentId: string; mainInstanceId: string }

      const result = (await callTool(listComponentsTool, client, { fileId })) as {
        components: Array<{
          componentId: string
          name: string
          mainInstanceId: string
          mainInstancePage: string
          variantId?: string
        }>
      }

      const entry = result.components.find((c) => c.componentId === created.componentId)
      expect(entry).toBeDefined()
      expect(entry?.name).toBe('Button')
      expect(entry?.mainInstanceId).toBe(created.mainInstanceId)
      expect(entry?.mainInstancePage).toBe(pageId)
      expect(entry?.variantId).toBeUndefined()
    })
  })

  it('returns an empty list for a file with no components', async () => {
    await withScratchProject('list-components-empty', async ({ client, fileId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const listComponentsTool = tools.find((t) => t.name === 'penpot_list_components')!

      const result = (await callTool(listComponentsTool, client, { fileId })) as { components: unknown[] }
      expect(result.components).toEqual([])
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

d('penpot_add_variant', () => {
  it('appends a new variant to an existing variant group and registers a new component', async () => {
    await withScratchProject('add-variant', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const createVariantGroup = tools.find((t) => t.name === 'penpot_create_variant_group')!
      const addVariant = tools.find((t) => t.name === 'penpot_add_variant')!

      // Build a variant group with one variant first.
      const created = (await callTool(createVariantGroup, client, {
        fileId,
        pageId,
        groupName: 'Tag',
        x: 0,
        y: 0,
        width: 300,
        height: 60,
        variants: [
          {
            name: 'Default',
            properties: [{ name: 'Style', value: 'Default' }],
            shapes: [{ type: 'rect', name: 'Tag', x: 0, y: 0, width: 80, height: 24, fillColor: '#AAAAAA', fillOpacity: 1 }],
          },
        ],
      })) as { containerId: string; variantId: string; variants: Array<{ componentId: string; mainInstanceId: string }> }

      expect(created.variants).toHaveLength(1)

      // Now append a second variant.
      const addResult = (await callTool(addVariant, client, {
        fileId,
        pageId,
        containerId: created.containerId,
        groupName: 'Tag',
        variant: {
          name: 'Active',
          properties: [{ name: 'Style', value: 'Active' }],
          shapes: [{ type: 'rect', name: 'Tag', x: 100, y: 0, width: 80, height: 24, fillColor: '#3366FF', fillOpacity: 1 }],
        },
      })) as { componentId: string; mainInstanceId: string; revn: number }

      expect(typeof addResult.componentId).toBe('string')
      expect(typeof addResult.mainInstanceId).toBe('string')

      const snapshot = await client.getFile(fileId)
      // Container now has 2 variant roots.
      const container = snapshot.data.pagesIndex[pageId]!.objects[created.containerId] as {
        shapes: string[]
        isVariantContainer: boolean
        variantId: string
      }
      expect(container.shapes).toHaveLength(2)
      expect(container.isVariantContainer).toBe(true)
      expect(container.variantId).toBe(created.containerId)

      // New component is registered in data.components.
      expect(snapshot.data.components?.[addResult.componentId]).toBeDefined()
      expect(snapshot.data.components?.[addResult.componentId]?.variantId).toBe(created.containerId)

      // New main instance shape exists on the page.
      const newInstance = snapshot.data.pagesIndex[pageId]!.objects[addResult.mainInstanceId] as {
        componentRoot: boolean
        name: string
      }
      expect(newInstance).toBeDefined()
      expect(newInstance.componentRoot).toBe(true)
    })
  })
})

d('penpot_group_shapes / penpot_ungroup_shapes', () => {
  it('wraps sibling shapes in a new group at the correct z-position', async () => {
    await withScratchProject('group-shapes', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const groupShapes = tools.find((t) => t.name === 'penpot_group_shapes')!

      // Create three shapes; we will group the first two.
      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'A', x: 10, y: 10, width: 40, height: 40 },
          { type: 'rect', name: 'B', x: 60, y: 10, width: 40, height: 40 },
          { type: 'rect', name: 'C', x: 110, y: 10, width: 40, height: 40 },
        ],
      })) as { shapeIds: string[] }
      const [a, b, c] = created.shapeIds as [string, string, string]

      const result = (await callTool(groupShapes, client, {
        fileId,
        pageId,
        shapeIds: [a, b],
      })) as { groupId: string }

      expect(typeof result.groupId).toBe('string')

      const snapshot = await client.getFile(fileId)
      const group = snapshot.data.pagesIndex[pageId]!.objects[result.groupId] as {
        type: string
        shapes: string[]
        parentId: string
        x: number
        y: number
        width: number
        height: number
      }
      expect(group.type).toBe('group')
      // Both shapes are children of the new group.
      expect(group.shapes).toContain(a)
      expect(group.shapes).toContain(b)
      // C is still at the root level, not inside the group.
      const cShape = snapshot.data.pagesIndex[pageId]!.objects[c] as { parentId: string }
      expect(cShape.parentId).not.toBe(result.groupId)
      // Bounding box spans both A (10..50) and B (60..100) → x=10, width=90
      expect(group.x).toBeCloseTo(10, 0)
      expect(group.y).toBeCloseTo(10, 0)
      expect(group.width).toBeCloseTo(90, 0)
      expect(group.height).toBeCloseTo(40, 0)
    })
  })

  it('dissolves a group: children are reparented to the group\'s former parent', async () => {
    await withScratchProject('ungroup-shapes', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const groupShapes = tools.find((t) => t.name === 'penpot_group_shapes')!
      const ungroupShapes = tools.find((t) => t.name === 'penpot_ungroup_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'X', x: 0, y: 0, width: 30, height: 30 },
          { type: 'rect', name: 'Y', x: 40, y: 0, width: 30, height: 30 },
        ],
      })) as { shapeIds: string[] }
      const [x, y] = created.shapeIds as [string, string]

      const grouped = (await callTool(groupShapes, client, {
        fileId,
        pageId,
        shapeIds: [x, y],
      })) as { groupId: string }

      // Verify group exists before ungrouping.
      let snapshot = await client.getFile(fileId)
      expect(snapshot.data.pagesIndex[pageId]!.objects[grouped.groupId]).toBeDefined()

      await callTool(ungroupShapes, client, {
        fileId,
        pageId,
        groupId: grouped.groupId,
      })

      snapshot = await client.getFile(fileId)
      // Group is gone.
      expect(snapshot.data.pagesIndex[pageId]!.objects[grouped.groupId]).toBeUndefined()
      // Former children are back at the root level (their original grandparent).
      const root = snapshot.data.pagesIndex[pageId]!.objects['00000000-0000-0000-0000-000000000000'] as {
        shapes: string[]
      }
      expect(root.shapes).toContain(x)
      expect(root.shapes).toContain(y)
      const xShape = snapshot.data.pagesIndex[pageId]!.objects[x] as { parentId: string }
      expect(xShape.parentId).toBe('00000000-0000-0000-0000-000000000000')
    })
  })

  it('throws when shapes have different parents', async () => {
    await withScratchProject('group-shapes-diff-parents', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const groupShapes = tools.find((t) => t.name === 'penpot_group_shapes')!

      const frameResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'frame', name: 'Board', x: 0, y: 0, width: 200, height: 200 }],
      })) as { shapeIds: string[] }
      const frameId = frameResult.shapeIds[0]!

      const shapeResult = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          { type: 'rect', name: 'RootShape', x: 300, y: 0, width: 30, height: 30 },
          { type: 'rect', name: 'ChildShape', x: 10, y: 10, width: 20, height: 20, parentId: frameId, frameId },
        ],
      })) as { shapeIds: string[] }
      const [rootShape, childShape] = shapeResult.shapeIds as [string, string]

      await expect(
        callTool(groupShapes, client, {
          fileId,
          pageId,
          shapeIds: [rootShape, childShape],
        }),
      ).rejects.toThrow(/same parent/)
    })
  })
})

d('rich text paragraphs', () => {
  it('creates a text shape with multiple paragraphs and verifies the wire format round-trips', async () => {
    await withScratchProject('rich-text-paragraphs', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'text',
            name: 'RichText',
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            paragraphs: [
              {
                textAlign: 'center',
                fontFamily: 'sourcesanspro',
                fontSize: '18',
                fontWeight: '700',
                ranges: [{ characters: 'Heading' }],
              },
              {
                textAlign: 'left',
                fontFamily: 'sourcesanspro',
                fontSize: '14',
                fontWeight: '400',
                ranges: [
                  { characters: 'Normal ' },
                  { characters: 'bold', fontWeight: '700' },
                ],
              },
            ],
          },
        ],
      })) as { shapeIds: string[] }

      const shapeId = result.shapeIds[0]!
      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as {
        type: string
        content: {
          type: string
          children: Array<{
            type: string
            children: Array<{ type: string; children?: Array<{ text: string }> }>
          }>
        }
      }

      expect(shape.type).toBe('text')
      // Two paragraph nodes inside root.
      const root = shape.content
      expect(root.type).toBe('root')
      const paragraphs = root.children[0]?.children ?? []
      expect(paragraphs.length).toBe(2)
      // Second paragraph has two leaf nodes (ranges).
      const secondParagraph = paragraphs[1]!
      expect(secondParagraph.children).toBeDefined()
      expect(secondParagraph.children!.length).toBe(2)
    })
  })

  it('preserves a rich-text shape\'s paragraphs when updating only geometry via penpot_update_shapes', async () => {
    await withScratchProject('rich-text-update-preserves', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const updateShapes = tools.find((t) => t.name === 'penpot_update_shapes')!

      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'text',
            name: 'TwoPara',
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            paragraphs: [
              { textAlign: 'left', ranges: [{ characters: 'First paragraph' }] },
              { textAlign: 'right', ranges: [{ characters: 'Second paragraph' }] },
            ],
          },
        ],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      // Update only x position — rich text content must survive.
      await callTool(updateShapes, client, {
        fileId,
        pageId,
        patches: [{ shapeId, x: 100 }],
      })

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as {
        x: number
        content: { children: Array<{ children: Array<{ children: Array<unknown> }> }> }
      }
      expect(shape.x).toBe(100)
      // Both paragraphs are still there.
      const paragraphs = shape.content.children[0]?.children ?? []
      expect(paragraphs.length).toBe(2)
    })
  })
})

d('gradient fills', () => {
  it('creates a rect with a linear gradient fill and reads it back from get-file', async () => {
    await withScratchProject('gradient-linear', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'rect',
            name: 'GradRect',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            fills: [
              {
                type: 'linear-gradient',
                startX: 0,
                startY: 0,
                endX: 1,
                endY: 0,
                opacity: 1,
                stops: [
                  { color: '#FF0000', opacity: 1, offset: 0 },
                  { color: '#0000FF', opacity: 1, offset: 1 },
                ],
              },
            ],
          },
        ],
      })) as { shapeIds: string[] }

      const shapeId = result.shapeIds[0]!
      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as {
        fills: Array<{ fillColorGradient?: { type: string; stops: Array<{ color: string }> } }>
      }

      expect(shape.fills).toHaveLength(1)
      // Penpot stores gradients as `fillColorGradient` on the fill object (camelCase from get-file).
      const gradient = shape.fills[0]!.fillColorGradient
      expect(gradient).toBeDefined()
      expect(gradient!.type).toBe('linear')
      expect(gradient!.stops).toHaveLength(2)
    })
  })

  it('creates a rect with a radial gradient fill and reads it back from get-file', async () => {
    await withScratchProject('gradient-radial', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'circle',
            name: 'RadialCircle',
            x: 0,
            y: 0,
            width: 80,
            height: 80,
            fills: [
              {
                type: 'radial-gradient',
                startX: 0.5,
                startY: 0.5,
                endX: 1,
                endY: 0.5,
                opacity: 1,
                stops: [
                  { color: '#FFFFFF', opacity: 1, offset: 0 },
                  { color: '#000000', opacity: 0, offset: 1 },
                ],
              },
            ],
          },
        ],
      })) as { shapeIds: string[] }

      const shapeId = result.shapeIds[0]!
      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as {
        fills: Array<{ fillColorGradient?: { type: string } }>
      }

      expect(shape.fills).toHaveLength(1)
      const gradient = shape.fills[0]!.fillColorGradient
      expect(gradient).toBeDefined()
      expect(gradient!.type).toBe('radial')
    })
  })

  it('round-trips a gradient fill through penpot_update_shapes', async () => {
    await withScratchProject('gradient-update', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!
      const updateShapes = tools.find((t) => t.name === 'penpot_update_shapes')!

      // Create with a solid fill, then replace with a gradient.
      const created = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [{ type: 'rect', name: 'Flat', x: 0, y: 0, width: 50, height: 50, fillColor: '#FF0000', fillOpacity: 1 }],
      })) as { shapeIds: string[] }
      const shapeId = created.shapeIds[0]!

      await callTool(updateShapes, client, {
        fileId,
        pageId,
        patches: [
          {
            shapeId,
            fills: [
              {
                type: 'linear-gradient',
                startX: 0,
                startY: 0,
                endX: 1,
                endY: 1,
                opacity: 1,
                stops: [
                  { color: '#00FF00', opacity: 1, offset: 0 },
                  { color: '#0000FF', opacity: 1, offset: 1 },
                ],
              },
            ],
          },
        ],
      })

      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as {
        fills: Array<{ fillColorGradient?: { type: string; stops: Array<unknown> } }>
      }
      const gradient = shape.fills[0]!.fillColorGradient
      expect(gradient).toBeDefined()
      expect(gradient!.type).toBe('linear')
      expect(gradient!.stops).toHaveLength(2)
    })
  })
})

d('penpot_create_page / penpot_list_pages / penpot_rename_page / penpot_delete_page', () => {
  it('creates a new page and it appears in list_pages', async () => {
    await withScratchProject('page-crud-create', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const createPage = tools.find((t) => t.name === 'penpot_create_page')!
      const listPages = tools.find((t) => t.name === 'penpot_list_pages')!

      const before = (await callTool(listPages, client, { fileId })) as { pages: Array<{ id: string; name: string }> }
      const beforeCount = before.pages.length

      const created = (await callTool(createPage, client, { fileId, name: 'Flows' })) as {
        pageId: string
        pageName: string
        revn: number
      }
      expect(created.pageName).toBe('Flows')
      expect(typeof created.pageId).toBe('string')

      const after = (await callTool(listPages, client, { fileId })) as { pages: Array<{ id: string; name: string }> }
      expect(after.pages.length).toBe(beforeCount + 1)
      const newPage = after.pages.find((p) => p.id === created.pageId)
      expect(newPage).toBeDefined()
      expect(newPage!.name).toBe('Flows')
    })
  })

  it('renames an existing page and the new name appears in list_pages', async () => {
    await withScratchProject('page-crud-rename', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const renamePage = tools.find((t) => t.name === 'penpot_rename_page')!
      const listPages = tools.find((t) => t.name === 'penpot_list_pages')!

      const result = (await callTool(renamePage, client, { fileId, pageId, name: 'Renamed' })) as {
        pageId: string
        name: string
        revn: number
      }
      expect(result.name).toBe('Renamed')
      expect(result.pageId).toBe(pageId)

      const list = (await callTool(listPages, client, { fileId })) as { pages: Array<{ id: string; name: string }> }
      const page = list.pages.find((p) => p.id === pageId)
      expect(page).toBeDefined()
      expect(page!.name).toBe('Renamed')
    })
  })

  it('deletes a page and it no longer appears in list_pages', async () => {
    await withScratchProject('page-crud-delete', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const createPage = tools.find((t) => t.name === 'penpot_create_page')!
      const deletePage = tools.find((t) => t.name === 'penpot_delete_page')!
      const listPages = tools.find((t) => t.name === 'penpot_list_pages')!

      // Create a second page so we can safely delete it (can't delete the only page).
      const extra = (await callTool(createPage, client, { fileId, name: 'Extra' })) as { pageId: string }

      const before = (await callTool(listPages, client, { fileId })) as { pages: Array<{ id: string }> }
      const beforeCount = before.pages.length

      await callTool(deletePage, client, { fileId, pageId: extra.pageId })

      const after = (await callTool(listPages, client, { fileId })) as { pages: Array<{ id: string }> }
      expect(after.pages.length).toBe(beforeCount - 1)
      expect(after.pages.find((p) => p.id === extra.pageId)).toBeUndefined()
    })
  })

  it('list_pages returns pages in order, matching data.pages array', async () => {
    await withScratchProject('page-crud-order', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const createPage = tools.find((t) => t.name === 'penpot_create_page')!
      const listPages = tools.find((t) => t.name === 'penpot_list_pages')!

      await callTool(createPage, client, { fileId, name: 'Alpha' })
      await callTool(createPage, client, { fileId, name: 'Beta' })
      await callTool(createPage, client, { fileId, name: 'Gamma' })

      const list = (await callTool(listPages, client, { fileId })) as { pages: Array<{ id: string; name: string }> }
      const names = list.pages.map((p) => p.name)
      // The three new pages must appear at the end, in creation order.
      expect(names.slice(-3)).toEqual(['Alpha', 'Beta', 'Gamma'])
    })
  })
})

d('penpot_upload_media', () => {
  // Uses the dataBase64 source with a minimal 1×1 white PNG so no external
  // URL or local file path is needed — the MCP server sends the decoded bytes
  // directly to Penpot's create-file-media-object RPC.
  const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQ' +
    'AABjkB6QAAAABJRU5ErkJggg=='

  it('uploads base64 image bytes and returns a media object with id/width/height/mtype', async () => {
    await withScratchProject('upload-media-base64', async ({ client, fileId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const uploadMedia = tools.find((t) => t.name === 'penpot_upload_media')!

      const result = (await callTool(uploadMedia, client, {
        fileId,
        name: 'test-pixel',
        dataBase64: TINY_PNG_BASE64,
        mtype: 'image/png',
      })) as { id: string; width: number; height: number; mtype: string; name: string }

      expect(typeof result.id).toBe('string')
      expect(result.id.length).toBeGreaterThan(0)
      expect(result.width).toBe(1)
      expect(result.height).toBe(1)
      expect(result.mtype).toBe('image/png')
    })
  })

  it('uses the returned mediaId to create an image shape on a page', async () => {
    await withScratchProject('upload-media-then-shape', async ({ client, fileId, pageId }) => {
      const tools = contentTools(TEST_TOKENS_PATH)
      const uploadMedia = tools.find((t) => t.name === 'penpot_upload_media')!
      const addShapes = tools.find((t) => t.name === 'penpot_add_shapes')!

      const media = (await callTool(uploadMedia, client, {
        fileId,
        name: 'pixel',
        dataBase64: TINY_PNG_BASE64,
        mtype: 'image/png',
      })) as { id: string; width: number; height: number; mtype: string }

      const result = (await callTool(addShapes, client, {
        fileId,
        pageId,
        shapes: [
          {
            type: 'image',
            name: 'PixelImg',
            x: 0,
            y: 0,
            width: 50,
            height: 50,
            mediaId: media.id,
            mediaWidth: media.width,
            mediaHeight: media.height,
            mtype: media.mtype,
          },
        ],
      })) as { shapeIds: string[] }

      const shapeId = result.shapeIds[0]!
      const snapshot = await client.getFile(fileId)
      const shape = snapshot.data.pagesIndex[pageId]!.objects[shapeId] as {
        type: string
        metadata: { id: string; width: number; height: number }
      }
      expect(shape.type).toBe('image')
      expect(shape.metadata.id).toBe(media.id)
      expect(shape.metadata.width).toBe(1)
      expect(shape.metadata.height).toBe(1)
    })
  })
})
