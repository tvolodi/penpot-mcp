/**
 * Unit tests for penpot_group_shapes and penpot_ungroup_shapes.
 *
 * These tests exercise the pure logic of grouping/ungrouping: bounding-box
 * computation, z-order insertion/replacement, reparenting, and error paths.
 * No network calls are made — the PenpotRpcClient is fully mocked.
 */

import { describe, it, expect, vi } from 'vitest'
import { contentTools } from '../../src/tools/content.js'
import { ROOT_FRAME_ID } from '../../src/shape-builders.js'
import type { PenpotRpcClient } from '../../src/rpc-client.js'
import type { ZodType } from 'zod'

// ── helpers ─────────────────────────────────────────────────────────────────

type AnyTool = {
  name: string
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: ZodType<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (client: PenpotRpcClient, input: any) => Promise<unknown>
}

const TOOLS = contentTools('/dev/null') as unknown as AnyTool[]

function getTool(name: string): AnyTool {
  const t = TOOLS.find((t) => t.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return t
}

/** Minimal shape node as returned by get-file (camelCase). */
function makeShape(
  id: string,
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
  parentId: string,
  frameId: string,
  shapes: string[] = [],
): Record<string, unknown> {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    rotation: 0,
    parentId,
    frameId,
    'parent-id': parentId,
    'frame-id': frameId,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    hideFillOnExport: false,
    'hide-fill-on-export': false,
    selrect: { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h },
    shapes,
    fills: [],
    strokes: [],
    shadows: [],
  }
}

/** Build a mock root frame with the given child ids in its shapes array. */
function makeRootFrame(childIds: string[]): Record<string, unknown> {
  return makeShape(ROOT_FRAME_ID, 'frame', 0, 0, 1920, 1080, ROOT_FRAME_ID, ROOT_FRAME_ID, childIds)
}

/**
 * Build a minimal mock PenpotRpcClient whose getFile returns a page
 * containing `objects`, and whose updateFile resolves to `{ revn: 1 }`.
 * Both methods are vi.fn() spies so tests can assert the calls.
 */
function makeClient(pageId: string, objects: Record<string, Record<string, unknown>>): PenpotRpcClient {
  return {
    getFile: vi.fn().mockResolvedValue({
      id: 'file1',
      revn: 0,
      vern: 0,
      data: {
        pages: [pageId],
        pagesIndex: {
          [pageId]: { name: 'Page 1', objects },
        },
      },
    }),
    updateFile: vi.fn().mockResolvedValue({ revn: 1 }),
  } as unknown as PenpotRpcClient
}

// ── penpot_group_shapes ──────────────────────────────────────────────────────

describe('penpot_group_shapes', () => {
  const tool = getTool('penpot_group_shapes')
  const PAGE = 'page1'

  it('creates a group wrapping two shapes with the correct bounding box', async () => {
    // shape-a: (10,10) 100×50  → selrect x1=10 y1=10 x2=110 y2=60
    // shape-b: (20,20)  80×40  → selrect x1=20 y1=20 x2=100 y2=60
    // Union bounding box: x1=10, y1=10, x2=110, y2=60 → w=100, h=50
    const shapeA = makeShape('shape-a', 'rect', 10, 10, 100, 50, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const shapeB = makeShape('shape-b', 'rect', 20, 20, 80, 40, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const rootFrame = makeRootFrame(['shape-a', 'shape-b', 'shape-c'])
    const shapeC = makeShape('shape-c', 'rect', 200, 200, 50, 50, ROOT_FRAME_ID, ROOT_FRAME_ID)

    const objects = {
      [ROOT_FRAME_ID]: rootFrame,
      'shape-a': shapeA,
      'shape-b': shapeB,
      'shape-c': shapeC,
    }

    const client = makeClient(PAGE, objects)
    const result = await tool.handler(client, {
      fileId: 'file1',
      pageId: PAGE,
      shapeIds: ['shape-a', 'shape-b'],
      name: 'MyGroup',
      groupId: 'group-1',
    })

    expect(result).toMatchObject({ groupId: 'group-1', parentId: ROOT_FRAME_ID, revn: 1 })
    expect((result as { childIds: string[] }).childIds).toEqual(['shape-a', 'shape-b'])

    // Check updateFile was called with the right changes
    expect(client.updateFile).toHaveBeenCalledOnce()
    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]!

    // 1st change: add-obj for the group itself
    const groupChange = changes[0]
    expect(groupChange.type).toBe('add-obj')
    expect(groupChange.id).toBe('group-1')
    expect(groupChange.obj.type).toBe('group')
    expect(groupChange.obj.name).toBe('MyGroup')
    expect(groupChange.obj.x).toBeCloseTo(10)
    expect(groupChange.obj.y).toBeCloseTo(10)
    expect(groupChange.obj.width).toBeCloseTo(100)
    expect(groupChange.obj.height).toBeCloseTo(50)
    expect(groupChange.obj.shapes).toEqual(['shape-a', 'shape-b'])
    expect(groupChange.obj['parent-id']).toBe(ROOT_FRAME_ID)
    expect(groupChange.obj['frame-id']).toBe(ROOT_FRAME_ID)

    // 2nd change: reparent shape-a to the group
    const reparentA = changes[1]
    expect(reparentA.type).toBe('add-obj')
    expect(reparentA.id).toBe('shape-a')
    expect(reparentA.obj['parent-id']).toBe('group-1')
    // No stale camelCase duplicates
    expect(reparentA.obj.parentId).toBeUndefined()
    expect(reparentA.obj.transformInverse).toBeUndefined()

    // 3rd change: reparent shape-b to the group
    const reparentB = changes[2]
    expect(reparentB.type).toBe('add-obj')
    expect(reparentB.id).toBe('shape-b')
    expect(reparentB.obj['parent-id']).toBe('group-1')

    // 4th change: update the root frame's shapes list
    const parentUpdate = changes[3]
    expect(parentUpdate.type).toBe('add-obj')
    expect(parentUpdate.id).toBe(ROOT_FRAME_ID)
    // group-1 at index 0 (where shape-a was), shape-c remains
    expect(parentUpdate.obj.shapes).toEqual(['group-1', 'shape-c'])
  })

  it('preserves existing z-order of children within the group', async () => {
    // Parent has shapes in order: [c, a, b]. Grouping [a, b] → group gets [a, b] (their parent order).
    const shapeA = makeShape('shape-a', 'rect', 10, 10, 100, 50, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const shapeB = makeShape('shape-b', 'rect', 20, 20, 80, 40, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const shapeC = makeShape('shape-c', 'rect', 5, 5, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const rootFrame = makeRootFrame(['shape-c', 'shape-a', 'shape-b'])

    const objects = { [ROOT_FRAME_ID]: rootFrame, 'shape-a': shapeA, 'shape-b': shapeB, 'shape-c': shapeC }
    const client = makeClient(PAGE, objects)

    await tool.handler(client, {
      fileId: 'file1',
      pageId: PAGE,
      shapeIds: ['shape-a', 'shape-b'],
      name: 'Group',
      groupId: 'grp',
    })

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]!
    const groupChange = changes[0]
    // Children in the group follow parent's order (c, a, b) filtered to [a, b]
    expect(groupChange.obj.shapes).toEqual(['shape-a', 'shape-b'])

    const parentUpdate = changes[changes.length - 1]
    // Group inserted at index 1 (where shape-a was in [c, a, b]); shape-b removed → ['shape-c', 'grp']
    expect(parentUpdate.obj.shapes).toEqual(['shape-c', 'grp'])
  })

  it('inserts the group at the z-position of the first (lowest-index) selected shape', async () => {
    // Parent: [x, a, y, b, z]. Grouping [b, a] → group at index 1 (shape-a's position).
    const shapes: Record<string, Record<string, unknown>> = {}
    for (const id of ['shape-x', 'shape-a', 'shape-y', 'shape-b', 'shape-z']) {
      shapes[id] = makeShape(id, 'rect', 0, 0, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID)
    }
    shapes[ROOT_FRAME_ID] = makeRootFrame(['shape-x', 'shape-a', 'shape-y', 'shape-b', 'shape-z'])

    const client = makeClient(PAGE, shapes)
    await tool.handler(client, {
      fileId: 'file1',
      pageId: PAGE,
      shapeIds: ['shape-b', 'shape-a'],
      name: 'G',
      groupId: 'grp',
    })

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]!
    const parentUpdate = changes[changes.length - 1]
    // shape-a is at index 1 in original list — that's where the group goes.
    expect(parentUpdate.obj.shapes).toEqual(['shape-x', 'grp', 'shape-y', 'shape-z'])
  })

  it('computes bounding box from selrect when available', async () => {
    // shape-a rotated: its selrect is 40×80 starting at (5, 5)
    const shapeA: Record<string, unknown> = {
      ...makeShape('shape-a', 'rect', 20, 20, 40, 80, ROOT_FRAME_ID, ROOT_FRAME_ID),
      selrect: { x: 5, y: 5, width: 40, height: 80, x1: 5, y1: 5, x2: 45, y2: 85 },
    }
    const shapeB = makeShape('shape-b', 'rect', 50, 10, 30, 20, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const root = makeRootFrame(['shape-a', 'shape-b'])
    const objects = { [ROOT_FRAME_ID]: root, 'shape-a': shapeA, 'shape-b': shapeB }

    const client = makeClient(PAGE, objects)
    await tool.handler(client, { fileId: 'file1', pageId: PAGE, shapeIds: ['shape-a', 'shape-b'], name: 'G', groupId: 'grp' })

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]!
    const groupChange = changes[0]
    // Union: x1=min(5,50)=5, y1=min(5,10)=5, x2=max(45,80)=80, y2=max(85,30)=85 → w=75, h=80
    expect(groupChange.obj.x).toBeCloseTo(5)
    expect(groupChange.obj.y).toBeCloseTo(5)
    expect(groupChange.obj.width).toBeCloseTo(75)
    expect(groupChange.obj.height).toBeCloseTo(80)
  })

  it('generates a random UUID for groupId when not supplied', async () => {
    const shapeA = makeShape('shape-a', 'rect', 0, 0, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const root = makeRootFrame(['shape-a'])
    const client = makeClient(PAGE, { [ROOT_FRAME_ID]: root, 'shape-a': shapeA })

    const result = await tool.handler(client, { fileId: 'file1', pageId: PAGE, shapeIds: ['shape-a'], name: 'G' })
    const { groupId } = result as { groupId: string }
    expect(groupId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('throws if a shape is not found on the page', async () => {
    const shapeA = makeShape('shape-a', 'rect', 0, 0, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const root = makeRootFrame(['shape-a'])
    const client = makeClient(PAGE, { [ROOT_FRAME_ID]: root, 'shape-a': shapeA })

    await expect(
      tool.handler(client, { fileId: 'file1', pageId: PAGE, shapeIds: ['shape-a', 'missing'], name: 'G' }),
    ).rejects.toThrow('missing')
  })

  it('throws if shapes have different parents', async () => {
    // shape-b lives inside a sub-frame, not in the root
    const shapeA = makeShape('shape-a', 'rect', 0, 0, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const subFrame = makeShape('sub-frame', 'frame', 100, 100, 200, 200, ROOT_FRAME_ID, ROOT_FRAME_ID, ['shape-b'])
    const shapeB = makeShape('shape-b', 'rect', 110, 110, 50, 50, 'sub-frame', 'sub-frame')
    const root = makeRootFrame(['shape-a', 'sub-frame'])
    const objects = { [ROOT_FRAME_ID]: root, 'shape-a': shapeA, 'sub-frame': subFrame, 'shape-b': shapeB }

    const client = makeClient(PAGE, objects)
    await expect(
      tool.handler(client, { fileId: 'file1', pageId: PAGE, shapeIds: ['shape-a', 'shape-b'], name: 'G' }),
    ).rejects.toThrow(/same parent/)
  })

  it('throws if the page is not found', async () => {
    const client = makeClient(PAGE, {})
    await expect(
      tool.handler(client, { fileId: 'file1', pageId: 'nonexistent', shapeIds: ['x'], name: 'G' }),
    ).rejects.toThrow('nonexistent')
  })
})

// ── penpot_ungroup_shapes ────────────────────────────────────────────────────

describe('penpot_ungroup_shapes', () => {
  const tool = getTool('penpot_ungroup_shapes')
  const PAGE = 'page1'

  it('dissolves a group and reparents its children to the group\'s parent', async () => {
    // Root: [grp, shape-c]. grp contains [shape-a, shape-b].
    const shapeA = makeShape('shape-a', 'rect', 10, 10, 100, 50, 'grp', ROOT_FRAME_ID)
    const shapeB = makeShape('shape-b', 'rect', 20, 20, 80, 40, 'grp', ROOT_FRAME_ID)
    const grp = makeShape('grp', 'group', 10, 10, 100, 50, ROOT_FRAME_ID, ROOT_FRAME_ID, ['shape-a', 'shape-b'])
    const shapeC = makeShape('shape-c', 'rect', 200, 200, 50, 50, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const root = makeRootFrame(['grp', 'shape-c'])

    const objects = { [ROOT_FRAME_ID]: root, grp, 'shape-a': shapeA, 'shape-b': shapeB, 'shape-c': shapeC }
    const client = makeClient(PAGE, objects)

    const result = await tool.handler(client, { fileId: 'file1', pageId: PAGE, groupId: 'grp' })

    expect(result).toMatchObject({ ungroupedShapeIds: ['shape-a', 'shape-b'], parentId: ROOT_FRAME_ID, revn: 1 })

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]!

    // 1st & 2nd changes: reparent shape-a and shape-b to root frame
    const reparentA = changes[0]
    expect(reparentA.type).toBe('add-obj')
    expect(reparentA.id).toBe('shape-a')
    expect(reparentA.obj['parent-id']).toBe(ROOT_FRAME_ID)
    expect(reparentA.obj['frame-id']).toBe(ROOT_FRAME_ID)
    expect(reparentA.obj.parentId).toBeUndefined()
    expect(reparentA.obj.transformInverse).toBeUndefined()

    const reparentB = changes[1]
    expect(reparentB.type).toBe('add-obj')
    expect(reparentB.id).toBe('shape-b')
    expect(reparentB.obj['parent-id']).toBe(ROOT_FRAME_ID)

    // 3rd change: update root frame's shapes — grp replaced by [shape-a, shape-b]
    const parentUpdate = changes[2]
    expect(parentUpdate.type).toBe('add-obj')
    expect(parentUpdate.id).toBe(ROOT_FRAME_ID)
    expect(parentUpdate.obj.shapes).toEqual(['shape-a', 'shape-b', 'shape-c'])

    // 4th change: delete the group
    const deleteChange = changes[3]
    expect(deleteChange.type).toBe('del-obj')
    expect(deleteChange.id).toBe('grp')
  })

  it('places ungrouped children at the group\'s original z-order position', async () => {
    // Root: [x, grp, z]. grp contains [a, b]. After ungroup: [x, a, b, z].
    const shapeX = makeShape('shape-x', 'rect', 0, 0, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const shapeZ = makeShape('shape-z', 'rect', 0, 0, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const shapeA = makeShape('shape-a', 'rect', 0, 0, 10, 10, 'grp', ROOT_FRAME_ID)
    const shapeB = makeShape('shape-b', 'rect', 0, 0, 10, 10, 'grp', ROOT_FRAME_ID)
    const grp = makeShape('grp', 'group', 0, 0, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID, ['shape-a', 'shape-b'])
    const root = makeRootFrame(['shape-x', 'grp', 'shape-z'])
    const objects = { [ROOT_FRAME_ID]: root, grp, 'shape-x': shapeX, 'shape-z': shapeZ, 'shape-a': shapeA, 'shape-b': shapeB }

    const client = makeClient(PAGE, objects)
    await tool.handler(client, { fileId: 'file1', pageId: PAGE, groupId: 'grp' })

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]!
    const parentUpdate = changes.find((c: { type: string; id: string }) => c.type === 'add-obj' && c.id === ROOT_FRAME_ID)
    expect(parentUpdate.obj.shapes).toEqual(['shape-x', 'shape-a', 'shape-b', 'shape-z'])
  })

  it('throws if the shape is not a group', async () => {
    const shapeA = makeShape('shape-a', 'rect', 0, 0, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID)
    const root = makeRootFrame(['shape-a'])
    const client = makeClient(PAGE, { [ROOT_FRAME_ID]: root, 'shape-a': shapeA })

    await expect(
      tool.handler(client, { fileId: 'file1', pageId: PAGE, groupId: 'shape-a' }),
    ).rejects.toThrow(/not a group/)
  })

  it('throws if the group is not found on the page', async () => {
    const root = makeRootFrame([])
    const client = makeClient(PAGE, { [ROOT_FRAME_ID]: root })

    await expect(
      tool.handler(client, { fileId: 'file1', pageId: PAGE, groupId: 'missing-grp' }),
    ).rejects.toThrow('missing-grp')
  })

  it('throws if the page is not found', async () => {
    const client = makeClient(PAGE, {})
    await expect(
      tool.handler(client, { fileId: 'file1', pageId: 'bad-page', groupId: 'grp' }),
    ).rejects.toThrow('bad-page')
  })

  it('handles a group with no children gracefully', async () => {
    const grp = makeShape('grp', 'group', 0, 0, 10, 10, ROOT_FRAME_ID, ROOT_FRAME_ID, [])
    const root = makeRootFrame(['grp'])
    const client = makeClient(PAGE, { [ROOT_FRAME_ID]: root, grp })

    const result = await tool.handler(client, { fileId: 'file1', pageId: PAGE, groupId: 'grp' })
    expect((result as { ungroupedShapeIds: string[] }).ungroupedShapeIds).toEqual([])

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]!
    const parentUpdate = changes.find((c: { type: string; id: string }) => c.type === 'add-obj' && c.id === ROOT_FRAME_ID)
    expect(parentUpdate.obj.shapes).toEqual([])

    const deleteChange = changes[changes.length - 1]
    expect(deleteChange.type).toBe('del-obj')
    expect(deleteChange.id).toBe('grp')
  })
})

// ── tool registration ────────────────────────────────────────────────────────

describe('group/ungroup tool registration', () => {
  it('both tools are registered in contentTools', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toContain('penpot_group_shapes')
    expect(names).toContain('penpot_ungroup_shapes')
  })

  it('penpot_group_shapes has a non-empty description', () => {
    expect(getTool('penpot_group_shapes').description.trim().length).toBeGreaterThan(0)
  })

  it('penpot_ungroup_shapes has a non-empty description', () => {
    expect(getTool('penpot_ungroup_shapes').description.trim().length).toBeGreaterThan(0)
  })

  it('penpot_group_shapes schema validates minimal valid input', () => {
    const schema = getTool('penpot_group_shapes').inputSchema
    expect(() =>
      schema.parse({ fileId: 'f', pageId: 'p', shapeIds: ['shape-a'] }),
    ).not.toThrow()
  })

  it('penpot_group_shapes schema rejects empty shapeIds', () => {
    const schema = getTool('penpot_group_shapes').inputSchema
    expect(() =>
      schema.parse({ fileId: 'f', pageId: 'p', shapeIds: [] }),
    ).toThrow()
  })

  it('penpot_ungroup_shapes schema validates minimal valid input', () => {
    const schema = getTool('penpot_ungroup_shapes').inputSchema
    expect(() =>
      schema.parse({ fileId: 'f', pageId: 'p', groupId: 'grp-id' }),
    ).not.toThrow()
  })
})
