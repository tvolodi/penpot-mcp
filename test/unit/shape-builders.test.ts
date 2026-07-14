import { describe, it, expect } from 'vitest'
import {
  rect,
  frame,
  text,
  addObj,
  addComponent,
  componentRootAttrs,
  variantContainerAttrs,
  extractEditableFields,
  cloneComponentInstance,
  ROOT_FRAME_ID,
  type ShapeNode,
} from '../../src/shape-builders.js'

describe('rect', () => {
  it('produces an axis-aligned selrect/points/identity transform when unrotated', () => {
    const obj = rect({ name: 'R', x: 10, y: 20, width: 100, height: 50, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.selrect).toEqual({ x: 10, y: 20, width: 100, height: 50, x1: 10, y1: 20, x2: 110, y2: 70 })
    expect(obj.points).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 70 },
      { x: 10, y: 70 },
    ])
    expect(obj.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    expect(obj['transform-inverse']).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    expect(obj.rotation).toBe(0)
  })

  it('rotates points about the shape center and keeps selrect as their bounding box', () => {
    // A 100x100 square at the origin, rotated 90°, should have its bounding box
    // stay square (100x100) even though selrect's own x/y shift due to fp rounding
    // being clamped at 0 — verified against a live instance during development
    // (see shape-builders.ts's rotation-support header comment).
    const obj = rect({ name: 'R', x: 0, y: 0, width: 100, height: 100, rotation: 90, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    const selrect = obj.selrect as { width: number; height: number }
    expect(selrect.width).toBeCloseTo(100, 6)
    expect(selrect.height).toBeCloseTo(100, 6)

    const points = obj.points as Array<{ x: number; y: number }>
    // Rotating a square 90° about its own center maps the point set onto itself
    // (just reordered) — every point should still be one of the four original corners.
    const expectedCorners = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]
    for (const p of points) {
      const match = expectedCorners.some((c) => Math.abs(c.x - p.x) < 1e-6 && Math.abs(c.y - p.y) < 1e-6)
      expect(match).toBe(true)
    }
  })

  it('transform and transform-inverse are true inverses of each other', () => {
    const obj = rect({ name: 'R', x: 5, y: 5, width: 40, height: 20, rotation: 37, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    const t = obj.transform as { a: number; b: number; c: number; d: number; e: number; f: number }
    const inv = obj['transform-inverse'] as typeof t

    // Applying t then inv to an arbitrary point should return the original point
    // (matrix form: x' = a*x + c*y + e; y' = b*x + d*y + f — Penpot's convention).
    const apply = (m: typeof t, p: { x: number; y: number }) => ({
      x: m.a * p.x + m.c * p.y + m.e,
      y: m.b * p.x + m.d * p.y + m.f,
    })
    const original = { x: 17, y: -3 }
    const roundTripped = apply(inv, apply(t, original))
    expect(roundTripped.x).toBeCloseTo(original.x, 6)
    expect(roundTripped.y).toBeCloseTo(original.y, 6)
  })

  it('defaults fills/strokes/corner-radii and honors an explicit id', () => {
    const obj = rect({ id: 'my-id', name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.id).toBe('my-id')
    expect(obj.fills).toEqual([])
    expect(obj.strokes).toEqual([])
    expect(obj.r1).toBe(0)
    expect(obj.r2).toBe(0)
    expect(obj.r3).toBe(0)
    expect(obj.r4).toBe(0)
  })
})

describe('frame', () => {
  it('defaults to a white fill, an empty shapes array, and hide-fill-on-export: false', () => {
    const obj = frame({ name: 'F', x: 0, y: 0, width: 100, height: 100, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.fills).toEqual([{ 'fill-color': '#FFFFFF', 'fill-opacity': 1 }])
    expect(obj.shapes).toEqual([])
    expect(obj['hide-fill-on-export']).toBe(false)
  })

  it('emits flex layout attrs with the documented defaults when fields are omitted', () => {
    const obj = frame({
      name: 'F',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      layout: { type: 'flex' },
    })
    expect(obj.layout).toBe('flex')
    expect(obj['layout-flex-dir']).toBe('row')
    expect(obj['layout-wrap-type']).toBe('nowrap')
    expect(obj['layout-align-items']).toBe('start')
    expect(obj['layout-justify-content']).toBe('start')
    expect(obj['layout-gap']).toEqual({ 'row-gap': 0, 'column-gap': 0 })
    expect(obj['layout-padding-type']).toBe('simple')
    expect(obj['layout-padding']).toEqual({ p1: 0, p2: 0, p3: 0, p4: 0 })
  })

  it('emits grid layout attrs with a default single flex track when rows/columns are omitted', () => {
    const obj = frame({
      name: 'F',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      layout: { type: 'grid' },
    })
    expect(obj.layout).toBe('grid')
    expect(obj['layout-grid-dir']).toBe('row')
    expect(obj['layout-grid-rows']).toEqual([{ type: 'flex', value: 1 }])
    expect(obj['layout-grid-columns']).toEqual([{ type: 'flex', value: 1 }])
  })

  it('omits layout attrs entirely when no layout is given', () => {
    const obj = frame({ name: 'F', x: 0, y: 0, width: 100, height: 100, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.layout).toBeUndefined()
    expect(obj['layout-flex-dir']).toBeUndefined()
  })
})

describe('layoutItem attrs (via rect)', () => {
  it('only emits fields that were actually set on the layoutItem', () => {
    const obj = rect({
      name: 'R',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      layoutItem: { horizontalSizing: 'fill', row: 2, column: 1 },
    })
    expect(obj['layout-item-h-sizing']).toBe('fill')
    expect(obj['layout-item-row']).toBe(2)
    expect(obj['layout-item-column']).toBe(1)
    expect(obj['layout-item-v-sizing']).toBeUndefined()
    expect(obj['layout-item-align-self']).toBeUndefined()
  })

  it('fills in all four margin sides with 0 when only one is given', () => {
    const obj = rect({
      name: 'R',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      layoutItem: { margin: { m1: 8 } },
    })
    expect(obj['layout-item-margin']).toEqual({ m1: 8, m2: 0, m3: 0, m4: 0 })
  })
})

describe('text', () => {
  it('builds a single-paragraph content tree from characters/font fields', () => {
    const obj = text({
      name: 'T',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      characters: 'hello',
      fontFamily: 'Inter',
      fontSize: '16',
      fontWeight: '700',
    })
    expect(obj['grow-type']).toBe('auto-width')
    const content = obj.content as {
      children: Array<{ children: Array<{ 'font-family': string; 'font-size': string; children: Array<{ text: string }> }> }>
    }
    const paragraph = content.children[0]!.children[0]!
    expect(paragraph['font-family']).toBe('Inter')
    expect(paragraph['font-size']).toBe('16')
    expect(paragraph.children[0]!.text).toBe('hello')
  })

  it('defaults font fields and fill color when omitted', () => {
    const obj = text({ name: 'T', x: 0, y: 0, width: 100, height: 20, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, characters: 'x' })
    expect(obj.fills).toEqual([{ 'fill-color': '#000000', 'fill-opacity': 1 }])
  })
})

describe('extractEditableFields', () => {
  it('reads camelCase fill/stroke arrays back into the kebab-case shape the builders expect', () => {
    const shape: ShapeNode = {
      id: 'x',
      type: 'rect',
      name: 'R',
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      rotation: 5,
      fills: [{ fillColor: '#FF0000', fillOpacity: 0.5 }],
      strokes: [{ strokeColor: '#000000', strokeOpacity: 1, strokeWidth: 2, strokeStyle: 'dashed', strokeAlignment: 'outer' }],
      r1: 1,
      r2: 2,
      r3: 3,
      r4: 4,
    }
    const fields = extractEditableFields(shape)
    expect(fields.fills).toEqual([{ 'fill-color': '#FF0000', 'fill-opacity': 0.5 }])
    expect(fields.strokes).toEqual([
      { 'stroke-color': '#000000', 'stroke-opacity': 1, 'stroke-width': 2, 'stroke-style': 'dashed', 'stroke-alignment': 'outer' },
    ])
    expect(fields.name).toBe('R')
    expect(fields.x).toBe(1)
    expect(fields.rotation).toBe(5)
  })

  it('returns undefined fills/strokes (not empty arrays) when the shape has none, so a caller can distinguish "no change" from "clear"', () => {
    const shape: ShapeNode = { id: 'x', type: 'rect', name: 'R', x: 0, y: 0, width: 1, height: 1, rotation: 0, fills: [], strokes: [] }
    const fields = extractEditableFields(shape)
    expect(fields.fills).toBeUndefined()
    expect(fields.strokes).toBeUndefined()
  })

  it('extracts text content from the first paragraph/leaf, matching what text() produces', () => {
    const built = text({ name: 'T', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, characters: 'abc', fontSize: '22' })
    // Simulate get-file's camelCase round-trip of the content tree (font-family -> fontFamily etc.)
    const asShapeNode: ShapeNode = {
      ...built,
      id: built.id as string,
      type: 'text',
      content: {
        children: [
          {
            children: [
              {
                fontFamily: 'Inter',
                fontSize: '22',
                fontWeight: '400',
                children: [{ text: 'abc' }],
              },
            ],
          },
        ],
      },
    }
    const fields = extractEditableFields(asShapeNode)
    expect(fields.characters).toBe('abc')
    expect(fields.fontSize).toBe('22')
  })
})

describe('componentRootAttrs', () => {
  it('tags component-id/component-file/component-root/main-instance without variant fields by default', () => {
    const attrs = componentRootAttrs('comp-1', 'file-1')
    expect(attrs).toEqual({
      'component-id': 'comp-1',
      'component-file': 'file-1',
      'component-root': true,
      'main-instance': true,
    })
  })

  it('adds variant-id/variant-name when a variant is given', () => {
    const attrs = componentRootAttrs('comp-1', 'file-1', { variantId: 'v-1', name: 'Primary' })
    expect(attrs['variant-id']).toBe('v-1')
    expect(attrs['variant-name']).toBe('Primary')
  })
})

describe('addComponent', () => {
  it('omits variant-id/variant-properties when no variant is given', () => {
    const change = addComponent('comp-1', 'Button', 'main-1', 'page-1')
    expect(change['variant-id']).toBeUndefined()
    expect(change['variant-properties']).toBeUndefined()
  })

  it('includes variant-id/variant-properties when given', () => {
    const change = addComponent('comp-1', 'Button', 'main-1', 'page-1', '', {
      variantId: 'v-1',
      properties: [{ name: 'Type', value: 'Primary' }],
    })
    expect(change['variant-id']).toBe('v-1')
    expect(change['variant-properties']).toEqual([{ name: 'Type', value: 'Primary' }])
  })
})

describe('variantContainerAttrs', () => {
  it('sets is-variant-container and echoes the given id as variant-id', () => {
    // Regression test for a real bug caught during development: the group's
    // variant-id must equal the CONTAINER's own shape id (not an independently
    // generated id), or Penpot's editor can't resolve Variants.properties /
    // variantComponents() even though the RPC schema accepts either. Callers
    // (content.ts) are responsible for passing containerId here — this test
    // just locks the function's own pass-through contract.
    const attrs = variantContainerAttrs('container-123')
    expect(attrs).toEqual({ 'is-variant-container': true, 'variant-id': 'container-123' })
  })
})

describe('addObj', () => {
  it('derives page-id/frame-id/parent-id from the wrapped object', () => {
    const obj = rect({ id: 'shape-1', name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: 'parent-1', frameId: 'frame-1' })
    const change = addObj('page-1', obj)
    expect(change).toMatchObject({
      type: 'add-obj',
      id: 'shape-1',
      'page-id': 'page-1',
      'frame-id': 'frame-1',
      'parent-id': 'parent-1',
    })
  })
})

describe('cloneComponentInstance', () => {
  const rootId = 'main-root'
  const childId = 'main-child'
  const objects: Record<string, ShapeNode> = {
    [rootId]: {
      id: rootId,
      type: 'frame',
      name: 'MainFrame',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      selrect: { x: 0, y: 0, width: 200, height: 100, x1: 0, y1: 0, x2: 200, y2: 100 },
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 100 },
        { x: 0, y: 100 },
      ],
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      shapes: [childId],
    },
    [childId]: {
      id: childId,
      type: 'rect',
      name: 'Child',
      x: 16,
      y: 16,
      width: 50,
      height: 50,
      selrect: { x: 16, y: 16, width: 50, height: 50, x1: 16, y1: 16, x2: 66, y2: 66 },
      points: [
        { x: 16, y: 16 },
        { x: 66, y: 16 },
        { x: 66, y: 66 },
        { x: 16, y: 66 },
      ],
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    },
  }

  it('returns changes in parent-before-child order', () => {
    // Regression test: an earlier implementation recursed into children before
    // pushing the parent's own add-obj change, so changes[0] was the CHILD, not
    // the root — callers that read changes[0].id as "the instance root" (like
    // penpot_add_component_instance) got the wrong id. Caught only by inspecting
    // actual output order, not by the RPC accepting the batch (Penpot doesn't
    // require parent-before-child ordering within one update-file call).
    const changes = cloneComponentInstance({
      pageId: 'page-1',
      objects,
      mainRootId: rootId,
      componentId: 'comp-1',
      componentFileId: 'file-1',
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      dx: 0,
      dy: 0,
    })
    expect(changes).toHaveLength(2)
    expect(changes[0]!.obj.type).toBe('frame')
    expect(changes[1]!.obj.type).toBe('rect')
  })

  it('only tags the root with component-id/component-file; descendants get shape-ref only', () => {
    const changes = cloneComponentInstance({
      pageId: 'page-1',
      objects,
      mainRootId: rootId,
      componentId: 'comp-1',
      componentFileId: 'file-1',
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      dx: 100,
      dy: 200,
    })
    const [rootChange, childChange] = changes
    expect(rootChange!.obj['component-id']).toBe('comp-1')
    expect(rootChange!.obj['component-file']).toBe('file-1')
    expect(rootChange!.obj['shape-ref']).toBe(rootId)

    expect(childChange!.obj['component-id']).toBeUndefined()
    expect(childChange!.obj['shape-ref']).toBe(childId)
  })

  it("points the cloned child's frame-id at the cloned ROOT's new id, not the caller's frameId param", () => {
    // Regression test: a frame's children must have frame-id pointing at the
    // frame itself, not at whatever frame contains the frame. An earlier
    // implementation propagated the top-level `frameId` param to every
    // descendant regardless of nesting depth.
    const changes = cloneComponentInstance({
      pageId: 'page-1',
      objects,
      mainRootId: rootId,
      componentId: 'comp-1',
      componentFileId: 'file-1',
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      dx: 0,
      dy: 0,
    })
    const [rootChange, childChange] = changes
    const newRootId = rootChange!.id
    expect(childChange!.obj['frame-id']).toBe(newRootId)
    expect(childChange!.obj['parent-id']).toBe(newRootId)
  })

  it('offsets every node (root and descendants) by the same (dx, dy), preserving relative position', () => {
    const changes = cloneComponentInstance({
      pageId: 'page-1',
      objects,
      mainRootId: rootId,
      componentId: 'comp-1',
      componentFileId: 'file-1',
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      dx: 300,
      dy: 50,
    })
    const [rootChange, childChange] = changes
    expect(rootChange!.obj.x).toBe(300)
    expect(rootChange!.obj.y).toBe(50)
    expect(childChange!.obj.x).toBe(316) // 16 + 300
    expect(childChange!.obj.y).toBe(66) // 16 + 50
  })

  it('assigns fresh, distinct ids to every cloned node', () => {
    const changes = cloneComponentInstance({
      pageId: 'page-1',
      objects,
      mainRootId: rootId,
      componentId: 'comp-1',
      componentFileId: 'file-1',
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      dx: 0,
      dy: 0,
    })
    const ids = changes.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(rootId)
    expect(ids).not.toContain(childId)
  })
})
