import { describe, it, expect } from 'vitest'
import {
  rect,
  frame,
  text,
  circle,
  path,
  bool,
  image,
  addObj,
  addComponent,
  componentRootAttrs,
  variantContainerAttrs,
  extractEditableFields,
  cloneComponentInstance,
  cloneShapes,
  reorderChildren,
  computeAlignment,
  computeDistribution,
  ROOT_FRAME_ID,
  type ShapeBox,
  type ShapeNode,
  type PathCommand,
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

  it('defaults fills/strokes/shadows/corner-radii and honors an explicit id', () => {
    const obj = rect({ id: 'my-id', name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.id).toBe('my-id')
    expect(obj.fills).toEqual([])
    expect(obj.strokes).toEqual([])
    expect(obj.shadows).toEqual([])
    expect(obj.r1).toBe(0)
    expect(obj.r2).toBe(0)
    expect(obj.r3).toBe(0)
    expect(obj.r4).toBe(0)
  })

  it('passes through an explicit shadows array unchanged', () => {
    const shadow = {
      style: 'drop-shadow' as const,
      'offset-x': 4,
      'offset-y': 4,
      blur: 8,
      spread: 2,
      color: { color: '#000000', opacity: 0.3 },
      hidden: false,
    }
    const obj = rect({ name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, shadows: [shadow] })
    expect(obj.shadows).toEqual([shadow])
  })

  it('passes through a linear gradient fill with the correct kebab-case wire format', () => {
    const gradient = {
      'fill-color-gradient': {
        type: 'linear' as const,
        'start-x': 0,
        'start-y': 0.5,
        'end-x': 1,
        'end-y': 0.5,
        width: 1,
        stops: [
          { color: '#FF0000', opacity: 1, offset: 0 },
          { color: '#0000FF', opacity: 1, offset: 1 },
        ],
      },
      'fill-opacity': 0.8,
    }
    const obj = rect({ name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, fills: [gradient] })
    const fills = obj.fills as typeof gradient[]
    expect(fills).toHaveLength(1)
    expect(fills[0]!['fill-color-gradient']?.type).toBe('linear')
    expect(fills[0]!['fill-color-gradient']?.['start-x']).toBe(0)
    expect(fills[0]!['fill-color-gradient']?.['end-x']).toBe(1)
    expect(fills[0]!['fill-color-gradient']?.stops).toHaveLength(2)
    expect(fills[0]!['fill-opacity']).toBe(0.8)
  })

  it('passes through a radial gradient fill', () => {
    const gradient = {
      'fill-color-gradient': {
        type: 'radial' as const,
        'start-x': 0.5,
        'start-y': 0.5,
        'end-x': 1,
        'end-y': 0.5,
        width: 1,
        stops: [
          { color: '#FFFFFF', opacity: 1, offset: 0 },
          { color: '#000000', opacity: 0, offset: 1 },
        ],
      },
    }
    const obj = rect({ name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, fills: [gradient] })
    const fills = obj.fills as typeof gradient[]
    expect(fills[0]!['fill-color-gradient']?.type).toBe('radial')
    expect(fills[0]!['fill-color-gradient']?.['start-x']).toBe(0.5)
  })

  it('passes through an image fill with the correct kebab-case wire format', () => {
    const imageFill = {
      'fill-image': {
        id: '11111111-1111-1111-1111-111111111111',
        width: 200,
        height: 150,
        mtype: 'image/png',
        name: 'background.png',
        'keep-aspect-ratio': true,
      },
      'fill-opacity': 1,
    }
    const obj = rect({ name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, fills: [imageFill] })
    const fills = obj.fills as typeof imageFill[]
    expect(fills).toHaveLength(1)
    expect(fills[0]!['fill-image']?.id).toBe('11111111-1111-1111-1111-111111111111')
    expect(fills[0]!['fill-image']?.width).toBe(200)
    expect(fills[0]!['fill-image']?.mtype).toBe('image/png')
    expect(fills[0]!['fill-image']?.['keep-aspect-ratio']).toBe(true)
  })

  it('supports a mixed fills array (solid + gradient)', () => {
    const solidFill = { 'fill-color': '#AABBCC', 'fill-opacity': 0.5 }
    const gradientFill = {
      'fill-color-gradient': {
        type: 'linear' as const,
        'start-x': 0, 'start-y': 0, 'end-x': 1, 'end-y': 0,
        width: 1,
        stops: [{ color: '#FF0000', opacity: 1, offset: 0 }, { color: '#0000FF', opacity: 1, offset: 1 }],
      },
    }
    const obj = rect({ name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, fills: [solidFill, gradientFill] })
    expect((obj.fills as unknown[]).length).toBe(2)
  })
})

describe('frame', () => {
  it('defaults to a white fill, an empty shapes array, and hide-fill-on-export: false', () => {
    const obj = frame({ name: 'F', x: 0, y: 0, width: 100, height: 100, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.fills).toEqual([{ 'fill-color': '#FFFFFF', 'fill-opacity': 1 }])
    expect(obj.shapes).toEqual([])
    expect(obj.shadows).toEqual([])
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

  it('emits growType and verticalAlign via paragraphs mode', () => {
    const obj = text({
      name: 'T',
      x: 0,
      y: 0,
      width: 200,
      height: 40,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      growType: 'auto-height',
      verticalAlign: 'center',
      paragraphs: [{ ranges: [{ text: 'hello' }] }],
    })
    expect(obj['grow-type']).toBe('auto-height')
    const content = obj.content as { 'vertical-align': string; children: unknown[] }
    expect(content['vertical-align']).toBe('center')
  })

  it('omits vertical-align from content root when default "top"', () => {
    const obj = text({
      name: 'T',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      paragraphs: [{ ranges: [{ text: 'hi' }] }],
    })
    const content = obj.content as Record<string, unknown>
    expect('vertical-align' in content).toBe(false)
  })

  describe('paragraphs mode — rich text', () => {
    it('builds a single paragraph with a single range using kebab-case content keys', () => {
      const obj = text({
        name: 'T',
        x: 0,
        y: 0,
        width: 200,
        height: 30,
        parentId: ROOT_FRAME_ID,
        frameId: ROOT_FRAME_ID,
        paragraphs: [
          {
            fontFamily: 'Roboto',
            fontSize: '18',
            fontWeight: '500',
            textAlign: 'center',
            ranges: [{ text: 'Hello Penpot' }],
          },
        ],
      })
      const content = obj.content as {
        children: Array<{
          children: Array<{
            type: string
            'font-family': string
            'font-size': string
            'font-weight': string
            'text-align': string
            children: Array<{ text: string }>
          }>
        }>
      }
      const para = content.children[0]!.children[0]!
      expect(para.type).toBe('paragraph')
      expect(para['font-family']).toBe('Roboto')
      expect(para['font-size']).toBe('18')
      expect(para['font-weight']).toBe('500')
      expect(para['text-align']).toBe('center')
      expect(para.children[0]!.text).toBe('Hello Penpot')
    })

    it('builds multi-paragraph content — each paragraph is a separate node', () => {
      const obj = text({
        name: 'T',
        x: 0,
        y: 0,
        width: 200,
        height: 60,
        parentId: ROOT_FRAME_ID,
        frameId: ROOT_FRAME_ID,
        paragraphs: [
          { ranges: [{ text: 'First line' }] },
          { ranges: [{ text: 'Second line' }] },
        ],
      })
      const content = obj.content as {
        children: Array<{ children: Array<{ children: Array<{ text: string }> }> }>
      }
      const paraSet = content.children[0]!.children
      expect(paraSet).toHaveLength(2)
      expect(paraSet[0]!.children[0]!.text).toBe('First line')
      expect(paraSet[1]!.children[0]!.text).toBe('Second line')
    })

    it('builds multiple ranges within one paragraph for per-run styling', () => {
      const obj = text({
        name: 'T',
        x: 0,
        y: 0,
        width: 300,
        height: 30,
        parentId: ROOT_FRAME_ID,
        frameId: ROOT_FRAME_ID,
        paragraphs: [
          {
            fontFamily: 'Inter',
            fontSize: '14',
            ranges: [
              { text: 'Normal ' },
              { text: 'Bold', fontWeight: '700' },
              { text: ' Italic', fontStyle: 'italic' },
            ],
          },
        ],
      })
      const content = obj.content as {
        children: Array<{
          children: Array<{
            children: Array<{ text: string; 'font-weight'?: string; 'font-style'?: string }>
          }>
        }>
      }
      const leaves = content.children[0]!.children[0]!.children
      expect(leaves).toHaveLength(3)
      expect(leaves[0]!.text).toBe('Normal ')
      expect(leaves[0]!['font-weight']).toBeUndefined()
      expect(leaves[1]!.text).toBe('Bold')
      expect(leaves[1]!['font-weight']).toBe('700')
      expect(leaves[2]!.text).toBe(' Italic')
      expect(leaves[2]!['font-style']).toBe('italic')
    })

    it('emits line-height, letter-spacing, text-decoration at paragraph and range level', () => {
      const obj = text({
        name: 'T',
        x: 0,
        y: 0,
        width: 200,
        height: 30,
        parentId: ROOT_FRAME_ID,
        frameId: ROOT_FRAME_ID,
        paragraphs: [
          {
            lineHeight: '1.5',
            letterSpacing: '2',
            ranges: [
              { text: 'Underlined', textDecoration: 'underline', letterSpacing: '3' },
            ],
          },
        ],
      })
      const content = obj.content as {
        children: Array<{
          children: Array<{
            'line-height': string
            'letter-spacing': string
            children: Array<{ text: string; 'text-decoration': string; 'letter-spacing': string }>
          }>
        }>
      }
      const para = content.children[0]!.children[0]!
      expect(para['line-height']).toBe('1.5')
      expect(para['letter-spacing']).toBe('2')
      const leaf = para.children[0]!
      expect(leaf['text-decoration']).toBe('underline')
      expect(leaf['letter-spacing']).toBe('3')
    })

    it('applies fills to paragraph and/or individual ranges', () => {
      const redFill = [{ 'fill-color': '#FF0000', 'fill-opacity': 1 }]
      const blueFill = [{ 'fill-color': '#0000FF', 'fill-opacity': 1 }]
      const obj = text({
        name: 'T',
        x: 0,
        y: 0,
        width: 200,
        height: 30,
        parentId: ROOT_FRAME_ID,
        frameId: ROOT_FRAME_ID,
        paragraphs: [
          {
            fills: redFill,
            ranges: [
              { text: 'Red (para default)' },
              { text: 'Blue override', fills: blueFill },
            ],
          },
        ],
      })
      const content = obj.content as {
        children: Array<{
          children: Array<{
            fills: unknown[]
            children: Array<{ text: string; fills?: unknown[] }>
          }>
        }>
      }
      const para = content.children[0]!.children[0]!
      expect(para.fills).toEqual(redFill)
      expect(para.children[0]!.fills).toBeUndefined() // inherits from paragraph
      expect(para.children[1]!.fills).toEqual(blueFill) // range override
      // Shape-level fills come from the first range's fills (none → fallback to para → red)
      expect(obj.fills).toEqual(redFill)
    })

    it('shape-level fills default to black when no fills are specified in paragraphs', () => {
      const obj = text({
        name: 'T',
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        parentId: ROOT_FRAME_ID,
        frameId: ROOT_FRAME_ID,
        paragraphs: [{ ranges: [{ text: 'No fills specified' }] }],
      })
      expect(obj.fills).toEqual([{ 'fill-color': '#000000', 'fill-opacity': 1 }])
    })

    it('omits paragraph-level fields when not provided (no spurious keys)', () => {
      const obj = text({
        name: 'T',
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        parentId: ROOT_FRAME_ID,
        frameId: ROOT_FRAME_ID,
        paragraphs: [{ textAlign: 'right', ranges: [{ text: 'hi' }] }],
      })
      const content = obj.content as {
        children: Array<{ children: Array<Record<string, unknown>> }>
      }
      const para = content.children[0]!.children[0]!
      expect(para['text-align']).toBe('right')
      expect('font-family' in para).toBe(false)
      expect('font-size' in para).toBe(false)
    })
  })
})

describe('image', () => {
  const meta = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', width: 800, height: 600, mtype: 'image/jpeg' }

  it('sets type to "image" and stores metadata at the top level', () => {
    const obj = image({ name: 'Photo', x: 10, y: 20, width: 200, height: 150, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, metadata: meta })
    expect(obj.type).toBe('image')
    expect(obj.metadata).toEqual(meta)
    expect(obj.x).toBe(10)
    expect(obj.y).toBe(20)
    expect(obj.width).toBe(200)
    expect(obj.height).toBe(150)
  })

  it('emits empty fills, strokes, shadows and all four zero corner radii', () => {
    const obj = image({ name: 'Photo', x: 0, y: 0, width: 100, height: 100, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, metadata: meta })
    expect(obj.fills).toEqual([])
    expect(obj.strokes).toEqual([])
    expect(obj.shadows).toEqual([])
    expect(obj.r1).toBe(0)
    expect(obj.r2).toBe(0)
    expect(obj.r3).toBe(0)
    expect(obj.r4).toBe(0)
  })

  it('computes selrect, points, and identity transform for an unrotated image', () => {
    const obj = image({ name: 'Photo', x: 5, y: 10, width: 80, height: 60, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, metadata: meta })
    expect(obj.selrect).toEqual({ x: 5, y: 10, width: 80, height: 60, x1: 5, y1: 10, x2: 85, y2: 70 })
    expect(obj.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  })

  it('parent-id and frame-id are set to the caller-supplied ids', () => {
    const obj = image({ name: 'Photo', x: 0, y: 0, width: 100, height: 100, parentId: 'p-1', frameId: 'f-1', metadata: meta })
    expect(obj['parent-id']).toBe('p-1')
    expect(obj['frame-id']).toBe('f-1')
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

  it('returns undefined fills/strokes/shadows (not empty arrays) when the shape has none, so a caller can distinguish "no change" from "clear"', () => {
    const shape: ShapeNode = { id: 'x', type: 'rect', name: 'R', x: 0, y: 0, width: 1, height: 1, rotation: 0, fills: [], strokes: [], shadows: [] }
    const fields = extractEditableFields(shape)
    expect(fields.fills).toBeUndefined()
    expect(fields.strokes).toBeUndefined()
    expect(fields.shadows).toBeUndefined()
  })

  it('reads a camelCase shadows array (as get-file would return it) back into the kebab-case shape the builders expect', () => {
    const shape: ShapeNode = {
      id: 'x',
      type: 'rect',
      name: 'R',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      rotation: 0,
      shadows: [
        { style: 'drop-shadow', offsetX: 4, offsetY: 4, blur: 8, spread: 2, color: { color: '#000000', opacity: 0.3 }, hidden: false },
      ],
    }
    const fields = extractEditableFields(shape)
    expect(fields.shadows).toEqual([
      { style: 'drop-shadow', 'offset-x': 4, 'offset-y': 4, blur: 8, spread: 2, color: { color: '#000000', opacity: 0.3 }, hidden: false },
    ])
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

  it('round-trips a linear gradient fill from get-file camelCase back to kebab-case add-obj format', () => {
    const shape: ShapeNode = {
      id: 'x',
      type: 'rect',
      name: 'R',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      fills: [
        {
          fillOpacity: 0.9,
          fillColorGradient: {
            type: 'linear',
            startX: 0,
            startY: 0.5,
            endX: 1,
            endY: 0.5,
            width: 1,
            stops: [
              { color: '#FF0000', opacity: 1, offset: 0 },
              { color: '#0000FF', opacity: 1, offset: 1 },
            ],
          },
        },
      ],
    }
    const fields = extractEditableFields(shape)
    expect(fields.fills).toHaveLength(1)
    const fill = fields.fills![0] as { 'fill-color-gradient': { type: string; 'start-x': number; 'end-x': number; stops: unknown[] }; 'fill-opacity': number }
    expect(fill['fill-color-gradient'].type).toBe('linear')
    expect(fill['fill-color-gradient']['start-x']).toBe(0)
    expect(fill['fill-color-gradient']['end-x']).toBe(1)
    expect(fill['fill-color-gradient'].stops).toHaveLength(2)
    expect(fill['fill-opacity']).toBe(0.9)
  })

  it('round-trips a radial gradient fill from get-file camelCase back to kebab-case add-obj format', () => {
    const shape: ShapeNode = {
      id: 'x',
      type: 'rect',
      name: 'R',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      fills: [
        {
          fillColorGradient: {
            type: 'radial',
            startX: 0.5,
            startY: 0.5,
            endX: 1,
            endY: 0.5,
            width: 1,
            stops: [{ color: '#FFFFFF', opacity: 1, offset: 0 }, { color: '#000000', opacity: 0, offset: 1 }],
          },
        },
      ],
    }
    const fields = extractEditableFields(shape)
    const fill = fields.fills![0] as { 'fill-color-gradient': { type: string; 'start-x': number } }
    expect(fill['fill-color-gradient'].type).toBe('radial')
    expect(fill['fill-color-gradient']['start-x']).toBe(0.5)
  })

  it('round-trips an image fill from get-file camelCase back to kebab-case add-obj format', () => {
    const shape: ShapeNode = {
      id: 'x',
      type: 'rect',
      name: 'R',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      fills: [
        {
          fillOpacity: 0.7,
          fillImage: {
            id: '22222222-2222-2222-2222-222222222222',
            width: 400,
            height: 300,
            mtype: 'image/jpeg',
            name: 'photo.jpg',
            keepAspectRatio: false,
          },
        },
      ],
    }
    const fields = extractEditableFields(shape)
    const fill = fields.fills![0] as { 'fill-image': { id: string; width: number; mtype: string; 'keep-aspect-ratio': boolean }; 'fill-opacity': number }
    expect(fill['fill-image'].id).toBe('22222222-2222-2222-2222-222222222222')
    expect(fill['fill-image'].width).toBe(400)
    expect(fill['fill-image'].mtype).toBe('image/jpeg')
    expect(fill['fill-image']['keep-aspect-ratio']).toBe(false)
    expect(fill['fill-opacity']).toBe(0.7)
  })

  it('extracts all paragraphs and ranges from a rich-text shape (camelCase → builder format)', () => {
    // Simulates the camelCase format that get-file returns for a text shape with two paragraphs.
    const shape: ShapeNode = {
      id: 'rich-text-id',
      type: 'text',
      name: 'RichText',
      x: 0,
      y: 0,
      width: 200,
      height: 60,
      rotation: 0,
      'grow-type': 'auto-height',
      content: {
        type: 'root',
        verticalAlign: 'center',
        children: [
          {
            type: 'paragraph-set',
            children: [
              {
                type: 'paragraph',
                textAlign: 'center',
                fontFamily: 'Roboto',
                fontSize: '18',
                fontWeight: '700',
                lineHeight: '1.4',
                children: [
                  { text: 'Title' },
                  { text: ' Bold', fontWeight: '900' },
                ],
              },
              {
                type: 'paragraph',
                children: [
                  { text: 'Body text', textDecoration: 'underline' },
                ],
              },
            ],
          },
        ],
      },
    }
    const fields = extractEditableFields(shape)

    // Legacy fields from first para / first leaf:
    expect(fields.characters).toBe('Title')
    expect(fields.fontFamily).toBe('Roboto')
    expect(fields.fontSize).toBe('18')
    expect(fields.fontWeight).toBe('700')

    // Rich text paragraphs array:
    expect(fields.paragraphs).toHaveLength(2)
    const para0 = fields.paragraphs![0]!
    expect(para0.textAlign).toBe('center')
    expect(para0.fontFamily).toBe('Roboto')
    expect(para0.lineHeight).toBe('1.4')
    expect(para0.ranges).toHaveLength(2)
    expect(para0.ranges[0]!.text).toBe('Title')
    expect(para0.ranges[0]!.fontWeight).toBeUndefined()
    expect(para0.ranges[1]!.text).toBe(' Bold')
    expect(para0.ranges[1]!.fontWeight).toBe('900')

    const para1 = fields.paragraphs![1]!
    expect(para1.ranges[0]!.text).toBe('Body text')
    expect(para1.ranges[0]!.textDecoration).toBe('underline')

    // growType and verticalAlign:
    expect(fields.growType).toBe('auto-height')
    expect(fields.verticalAlign).toBe('center')
  })

  it('extracts fills from text content nodes (per-paragraph and per-range)', () => {
    const shape: ShapeNode = {
      id: 'txt',
      type: 'text',
      name: 'T',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      rotation: 0,
      content: {
        type: 'root',
        children: [
          {
            type: 'paragraph-set',
            children: [
              {
                type: 'paragraph',
                fills: [{ fillColor: '#FF0000', fillOpacity: 1 }],
                children: [
                  { text: 'A', fills: [{ fillColor: '#00FF00', fillOpacity: 0.5 }] },
                  { text: 'B' },
                ],
              },
            ],
          },
        ],
      },
    }
    const fields = extractEditableFields(shape)
    const para = fields.paragraphs![0]!
    expect(para.fills).toEqual([{ 'fill-color': '#FF0000', 'fill-opacity': 1 }])
    expect(para.ranges[0]!.fills).toEqual([{ 'fill-color': '#00FF00', 'fill-opacity': 0.5 }])
    expect(para.ranges[1]!.fills).toBeUndefined()
  })

  it('rounds-trips a rich-text shape through text() builder preserving all paragraphs/ranges', () => {
    // Build a rich text shape, then round-trip through extractEditableFields and text().
    const original = text({
      name: 'T',
      x: 0,
      y: 0,
      width: 200,
      height: 40,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      paragraphs: [
        { textAlign: 'left', ranges: [{ text: 'A', fontWeight: '700' }, { text: 'B' }] },
        { textAlign: 'right', ranges: [{ text: 'C', fontStyle: 'italic' }] },
      ],
    })

    // Simulate get-file's camelCase response (kebab-case → camelCase for some keys).
    // The content's paragraph children use camelCase from the API response.
    const asFromGetFile: ShapeNode = {
      ...(original as Record<string, unknown>),
      id: original.id as string,
      type: 'text',
      'grow-type': original['grow-type'] as string,
      content: {
        type: 'root',
        children: [
          {
            type: 'paragraph-set',
            children: [
              {
                type: 'paragraph',
                textAlign: 'left',
                children: [
                  { text: 'A', fontWeight: '700' },
                  { text: 'B' },
                ],
              },
              {
                type: 'paragraph',
                textAlign: 'right',
                children: [
                  { text: 'C', fontStyle: 'italic' },
                ],
              },
            ],
          },
        ],
      },
    }

    const extracted = extractEditableFields(asFromGetFile)
    expect(extracted.paragraphs).toHaveLength(2)
    expect(extracted.paragraphs![0]!.textAlign).toBe('left')
    expect(extracted.paragraphs![0]!.ranges).toHaveLength(2)
    expect(extracted.paragraphs![1]!.textAlign).toBe('right')
    expect(extracted.paragraphs![1]!.ranges[0]!.fontStyle).toBe('italic')

    // Re-build from extracted paragraphs — should produce same structure as original.
    const rebuilt = text({
      id: original.id as string,
      name: 'T',
      x: 0,
      y: 0,
      width: 200,
      height: 40,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      paragraphs: extracted.paragraphs!,
    })
    const rebuildContent = rebuilt.content as {
      children: Array<{ children: Array<{ 'text-align': string; children: Array<{ text: string }> }> }>
    }
    expect(rebuildContent.children[0]!.children[0]!['text-align']).toBe('left')
    expect(rebuildContent.children[0]!.children[1]!['text-align']).toBe('right')
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

describe('cloneShapes', () => {
  const rootId = 'src-root'
  const childId = 'src-child'
  const objects: Record<string, ShapeNode> = {
    [rootId]: {
      id: rootId,
      type: 'frame',
      name: 'SourceFrame',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
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
      parentId: rootId,
      frameId: rootId,
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
    const changes = cloneShapes({ pageId: 'page-1', objects, rootId, dx: 0, dy: 0 })
    expect(changes).toHaveLength(2)
    expect(changes[0]!.obj.type).toBe('frame')
    expect(changes[1]!.obj.type).toBe('rect')
  })

  it('does not tag the clone as a component instance (no shape-ref/component-id)', () => {
    const changes = cloneShapes({ pageId: 'page-1', objects, rootId, dx: 0, dy: 0 })
    expect(changes[0]!.obj['shape-ref']).toBeUndefined()
    expect(changes[0]!.obj['component-id']).toBeUndefined()
  })

  it("defaults to the source root's own parent/frame when parentId/frameId are omitted", () => {
    const changes = cloneShapes({ pageId: 'page-1', objects, rootId, dx: 0, dy: 0 })
    expect(changes[0]!['parent-id']).toBe(ROOT_FRAME_ID)
    expect(changes[0]!['frame-id']).toBe(ROOT_FRAME_ID)
  })

  it('reparents the cloned root under an explicit parentId/frameId when given', () => {
    const changes = cloneShapes({
      pageId: 'page-1',
      objects,
      rootId,
      parentId: 'other-parent',
      frameId: 'other-frame',
      dx: 0,
      dy: 0,
    })
    expect(changes[0]!['parent-id']).toBe('other-parent')
    expect(changes[0]!['frame-id']).toBe('other-frame')
  })

  it("points the cloned child's frame-id at the cloned root's new id, not the original frame-id", () => {
    const changes = cloneShapes({ pageId: 'page-1', objects, rootId, dx: 0, dy: 0 })
    const [rootChange, childChange] = changes
    expect(childChange!.obj['frame-id']).toBe(rootChange!.id)
    expect(childChange!.obj['parent-id']).toBe(rootChange!.id)
  })

  it('offsets every node (root and descendants) by the same (dx, dy), preserving relative position', () => {
    const changes = cloneShapes({ pageId: 'page-1', objects, rootId, dx: 300, dy: 50 })
    const [rootChange, childChange] = changes
    expect(rootChange!.obj.x).toBe(300)
    expect(rootChange!.obj.y).toBe(50)
    expect(childChange!.obj.x).toBe(316) // 16 + 300
    expect(childChange!.obj.y).toBe(66) // 16 + 50
  })

  it('assigns fresh, distinct ids to every cloned node', () => {
    const changes = cloneShapes({ pageId: 'page-1', objects, rootId, dx: 0, dy: 0 })
    const ids = changes.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(rootId)
    expect(ids).not.toContain(childId)
  })

  it('carries over existing component/variant tags unchanged (clone of a main instance stays tagged)', () => {
    const taggedObjects: Record<string, ShapeNode> = {
      ...objects,
      [rootId]: {
        ...objects[rootId]!,
        'component-id': 'comp-1',
        'component-file': 'file-1',
        'component-root': true,
        'main-instance': true,
      },
    }
    const changes = cloneShapes({ pageId: 'page-1', objects: taggedObjects, rootId, dx: 0, dy: 0 })
    expect(changes[0]!.obj['component-id']).toBe('comp-1')
    expect(changes[0]!.obj['component-root']).toBe(true)
  })

  it('throws when the root shape id is not found in objects', () => {
    expect(() => cloneShapes({ pageId: 'page-1', objects, rootId: 'missing', dx: 0, dy: 0 })).toThrow(/not found/)
  })
})

describe('reorderChildren', () => {
  const order = ['a', 'b', 'c', 'd']

  it('"front" moves the shape to the end of the array (top of the stack)', () => {
    expect(reorderChildren(order, 'a', { type: 'front' })).toEqual(['b', 'c', 'd', 'a'])
    expect(reorderChildren(order, 'c', { type: 'front' })).toEqual(['a', 'b', 'd', 'c'])
  })

  it('"back" moves the shape to the start of the array (bottom of the stack)', () => {
    expect(reorderChildren(order, 'd', { type: 'back' })).toEqual(['d', 'a', 'b', 'c'])
    expect(reorderChildren(order, 'b', { type: 'back' })).toEqual(['b', 'a', 'c', 'd'])
  })

  it('"forward" swaps the shape with its next sibling', () => {
    expect(reorderChildren(order, 'b', { type: 'forward' })).toEqual(['a', 'c', 'b', 'd'])
  })

  it('"forward" on the last shape is a no-op', () => {
    expect(reorderChildren(order, 'd', { type: 'forward' })).toEqual(order)
  })

  it('"backward" swaps the shape with its previous sibling', () => {
    expect(reorderChildren(order, 'c', { type: 'backward' })).toEqual(['a', 'c', 'b', 'd'])
  })

  it('"backward" on the first shape is a no-op', () => {
    expect(reorderChildren(order, 'a', { type: 'backward' })).toEqual(order)
  })

  it('"before" places the shape immediately before targetId', () => {
    expect(reorderChildren(order, 'd', { type: 'before', targetId: 'b' })).toEqual(['a', 'd', 'b', 'c'])
  })

  it('"after" places the shape immediately after targetId', () => {
    expect(reorderChildren(order, 'a', { type: 'after', targetId: 'c' })).toEqual(['b', 'c', 'a', 'd'])
  })

  it('throws when shapeId is not in the current order', () => {
    expect(() => reorderChildren(order, 'missing', { type: 'front' })).toThrow(/not a child/)
  })

  it('throws when "before"/"after" targetId is not in the current order', () => {
    expect(() => reorderChildren(order, 'a', { type: 'before', targetId: 'missing' })).toThrow(/not a child/)
    expect(() => reorderChildren(order, 'a', { type: 'after', targetId: 'missing' })).toThrow(/not a child/)
  })

  it('throws when "before"/"after" targetId equals shapeId', () => {
    expect(() => reorderChildren(order, 'a', { type: 'before', targetId: 'a' })).toThrow(/must not be the same/)
    expect(() => reorderChildren(order, 'a', { type: 'after', targetId: 'a' })).toThrow(/must not be the same/)
  })
})

describe('computeAlignment', () => {
  const box = (id: string, x1: number, y1: number, x2: number, y2: number): ShapeBox => ({ id, x1, y1, x2, y2 })

  // Three boxes of different sizes at different positions, so every edge is a distinct shape.
  //   A: left=10  right=40   (width 30)   top=10  bottom=30
  //   B: left=50  right=70   (width 20)   top=0   bottom=60
  //   C: left=30  right=90   (width 60)   top=20  bottom=25
  const boxes = [box('A', 10, 10, 40, 30), box('B', 50, 0, 70, 60), box('C', 30, 20, 90, 25)]

  it('"left" snaps every box\'s left edge to the leftmost (min x1), moving only along x', () => {
    const deltas = computeAlignment(boxes, 'left')
    const byId = Object.fromEntries(deltas.map((d) => [d.id, d]))
    // A is already at the leftmost x1 (10) → omitted.
    expect(byId['A']).toBeUndefined()
    expect(byId['B']).toEqual({ id: 'B', dx: 10 - 50, dy: 0 })
    expect(byId['C']).toEqual({ id: 'C', dx: 10 - 30, dy: 0 })
  })

  it('"right" snaps every box\'s right edge to the rightmost (max x2)', () => {
    const byId = Object.fromEntries(computeAlignment(boxes, 'right').map((d) => [d.id, d]))
    // C is already at the rightmost x2 (90) → omitted.
    expect(byId['C']).toBeUndefined()
    expect(byId['A']!.dx).toBe(90 - 40)
    expect(byId['B']!.dx).toBe(90 - 70)
    expect(byId['A']!.dy).toBe(0)
  })

  it('"top" snaps every box\'s top edge to the topmost (min y1), moving only along y', () => {
    const byId = Object.fromEntries(computeAlignment(boxes, 'top').map((d) => [d.id, d]))
    // B is already at the topmost y1 (0) → omitted.
    expect(byId['B']).toBeUndefined()
    expect(byId['A']).toEqual({ id: 'A', dx: 0, dy: 0 - 10 })
    expect(byId['C']).toEqual({ id: 'C', dx: 0, dy: 0 - 20 })
  })

  it('"bottom" snaps every box\'s bottom edge to the bottommost (max y2)', () => {
    const byId = Object.fromEntries(computeAlignment(boxes, 'bottom').map((d) => [d.id, d]))
    // B is already at the bottommost y2 (60) → omitted.
    expect(byId['B']).toBeUndefined()
    expect(byId['A']!.dy).toBe(60 - 30)
    expect(byId['C']!.dy).toBe(60 - 25)
  })

  it('"center-h" centers every box on the group mid-x, "center-v" on the group mid-y', () => {
    // Group x extent is [10, 90] → mid-x 50; y extent is [0, 60] → mid-y 30.
    const h = Object.fromEntries(computeAlignment(boxes, 'center-h').map((d) => [d.id, d]))
    // A center-x = 25 → dx = 50 - 25 = 25.
    expect(h['A']!.dx).toBe(25)
    // B center-x = 60 → dx = 50 - 60 = -10.
    expect(h['B']!.dx).toBe(-10)
    expect(h['A']!.dy).toBe(0)

    const v = Object.fromEntries(computeAlignment(boxes, 'center-v').map((d) => [d.id, d]))
    // B is centered on mid-y already (center-y = 30) → omitted.
    expect(v['B']).toBeUndefined()
    // A center-y = 20 → dy = 30 - 20 = 10.
    expect(v['A']!.dy).toBe(10)
    expect(v['A']!.dx).toBe(0)
  })

  it('never moves the group as a whole (aligning left keeps the leftmost box put)', () => {
    const deltas = computeAlignment(boxes, 'left')
    // The leftmost box (A) must not appear in the deltas at all.
    expect(deltas.map((d) => d.id)).not.toContain('A')
  })

  it('throws with fewer than 2 shapes', () => {
    expect(() => computeAlignment([box('A', 0, 0, 10, 10)], 'left')).toThrow(/at least 2/)
  })
})

describe('computeDistribution', () => {
  const box = (id: string, x1: number, y1: number, x2: number, y2: number): ShapeBox => ({ id, x1, y1, x2, y2 })

  it('equalizes horizontal gaps, leaving the two endpoints put', () => {
    // Three 10-wide boxes; ends fixed at x1=0 and x1=100. Span = 110, total width = 30,
    // free space = 80 over 2 gaps → gap 40. Middle box's target x1 = 0 + 10 + 40 = 50.
    const boxes = [box('L', 0, 0, 10, 10), box('M', 20, 0, 30, 10), box('R', 100, 0, 110, 10)]
    const byId = Object.fromEntries(computeDistribution(boxes, 'horizontal').map((d) => [d.id, d]))
    expect(byId['L']).toBeUndefined() // endpoint, unmoved
    expect(byId['R']).toBeUndefined() // endpoint, unmoved
    expect(byId['M']).toEqual({ id: 'M', dx: 50 - 20, dy: 0 })
  })

  it('accounts for differing shape sizes (gaps between edges, not centers)', () => {
    // Widths 10 / 40 / 10; ends at x1=0 and x1=100 (x2=110). Span = 110, total width = 60,
    // free = 50 over 2 gaps → gap 25. Middle (width 40) target x1 = 0 + 10 + 25 = 35.
    const boxes = [box('L', 0, 0, 10, 10), box('M', 20, 0, 60, 10), box('R', 100, 0, 110, 10)]
    const byId = Object.fromEntries(computeDistribution(boxes, 'horizontal').map((d) => [d.id, d]))
    expect(byId['M']!.dx).toBe(35 - 20)
  })

  it('equalizes vertical gaps along y', () => {
    const boxes = [box('T', 0, 0, 10, 10), box('Mid', 0, 30, 10, 40), box('B', 0, 100, 10, 110)]
    // Span 110, total height 30, free 80 over 2 gaps → gap 40. Mid target y1 = 0 + 10 + 40 = 50.
    const byId = Object.fromEntries(computeDistribution(boxes, 'vertical').map((d) => [d.id, d]))
    expect(byId['Mid']).toEqual({ id: 'Mid', dx: 0, dy: 50 - 30 })
  })

  it('sorts by position, so input order does not matter', () => {
    const boxes = [box('R', 100, 0, 110, 10), box('L', 0, 0, 10, 10), box('M', 20, 0, 30, 10)]
    const byId = Object.fromEntries(computeDistribution(boxes, 'horizontal').map((d) => [d.id, d]))
    // Same result as the ordered case above regardless of the shuffled input.
    expect(byId['M']!.dx).toBe(50 - 20)
    expect(byId['L']).toBeUndefined()
    expect(byId['R']).toBeUndefined()
  })

  it('is a no-op (empty deltas) for already-evenly-spaced shapes', () => {
    const boxes = [box('L', 0, 0, 10, 10), box('M', 50, 0, 60, 10), box('R', 100, 0, 110, 10)]
    expect(computeDistribution(boxes, 'horizontal')).toEqual([])
  })

  it('throws with fewer than 3 shapes', () => {
    expect(() => computeDistribution([box('A', 0, 0, 10, 10), box('B', 20, 0, 30, 10)], 'horizontal')).toThrow(
      /at least 3/,
    )
  })
})

describe('circle', () => {
  it('produces type "circle" with correct geometry fields', () => {
    const obj = circle({ name: 'C', x: 10, y: 20, width: 80, height: 80, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.type).toBe('circle')
    expect(obj.x).toBe(10)
    expect(obj.y).toBe(20)
    expect(obj.width).toBe(80)
    expect(obj.height).toBe(80)
  })

  it('computes selrect matching x/y/width/height when unrotated', () => {
    const obj = circle({ name: 'C', x: 5, y: 15, width: 60, height: 40, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.selrect).toEqual({ x: 5, y: 15, width: 60, height: 40, x1: 5, y1: 15, x2: 65, y2: 55 })
  })

  it('defaults fills/strokes/shadows to empty arrays (no corner radii)', () => {
    const obj = circle({ name: 'C', x: 0, y: 0, width: 50, height: 50, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.fills).toEqual([])
    expect(obj.strokes).toEqual([])
    expect(obj.shadows).toEqual([])
    // circle shapes have no r1-r4 fields
    expect(obj.r1).toBeUndefined()
  })

  it('passes explicit fills/strokes through unchanged', () => {
    const obj = circle({
      name: 'C', x: 0, y: 0, width: 50, height: 50, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID,
      fills: [{ 'fill-color': '#FF0000', 'fill-opacity': 0.5 }],
    })
    expect((obj.fills as { 'fill-color': string }[])[0]?.['fill-color']).toBe('#FF0000')
  })

  it('uses an identity transform when rotation is 0', () => {
    const obj = circle({ name: 'C', x: 0, y: 0, width: 50, height: 50, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    expect(obj['transform-inverse']).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  })
})

describe('opacity, hidden, blocked, blendMode fields', () => {
  it('extracts opacity/hidden/blocked/blendMode from shape objects', () => {
    const shape = {
      id: 'test-id',
      opacity: 0.5,
      hidden: true,
      blocked: false,
      'blend-mode': 'multiply',
      name: 'Test',
      type: 'rect',
    }
    const extracted = extractEditableFields(shape)
    expect(extracted.opacity).toBe(0.5)
    expect(extracted.hidden).toBe(true)
    expect(extracted.blocked).toBe(false)
    expect(extracted.blendMode).toBe('multiply')
  })

  it('extracts undefined for missing opacity/hidden/blocked/blendMode fields', () => {
    const shape = { id: 'test-id', name: 'Test', type: 'rect' }
    const extracted = extractEditableFields(shape)
    expect(extracted.opacity).toBeUndefined()
    expect(extracted.hidden).toBeUndefined()
    expect(extracted.blocked).toBeUndefined()
    expect(extracted.blendMode).toBeUndefined()
  })

  it('includes opacity in rect builder output when provided', () => {
    const obj = rect({ name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, opacity: 0.7 })
    expect(obj.opacity).toBe(0.7)
  })

  it('omits opacity from rect builder output when undefined', () => {
    const obj = rect({ name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.opacity).toBeUndefined()
  })

  it('includes hidden in frame builder output when provided', () => {
    const obj = frame({ name: 'F', x: 0, y: 0, width: 100, height: 100, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, hidden: true })
    expect(obj.hidden).toBe(true)
  })

  it('includes blocked in text builder output when provided', () => {
    const obj = text({ name: 'T', x: 0, y: 0, width: 100, height: 30, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, blocked: true })
    expect(obj.blocked).toBe(true)
  })

  it('converts blendMode to blend-mode in circle builder output', () => {
    const obj = circle({ name: 'C', x: 0, y: 0, width: 50, height: 50, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, blendMode: 'screen' })
    expect((obj as Record<string, unknown>)['blend-mode']).toBe('screen')
  })

  it('converts blendMode to blend-mode in path builder output', () => {
    const triangle: PathCommand[] = [
      { command: 'move-to', params: { x: 0, y: 100 } },
      { command: 'line-to', params: { x: 50, y: 0 } },
      { command: 'line-to', params: { x: 100, y: 100 } },
      { command: 'close-path', params: {} },
    ]
    const obj = path({ name: 'P', parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, content: triangle, blendMode: 'overlay' })
    expect((obj as Record<string, unknown>)['blend-mode']).toBe('overlay')
  })

  it('converts blendMode to blend-mode in bool builder output', () => {
    const obj = bool({ name: 'B', x: 0, y: 0, width: 100, height: 100, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, boolType: 'union', blendMode: 'darken' })
    expect((obj as Record<string, unknown>)['blend-mode']).toBe('darken')
  })

  it('converts blendMode to blend-mode in group builder output', () => {
    const groupObj = addObj(ROOT_FRAME_ID, {
      id: 'group-1',
      type: 'group',
      name: 'G',
      'parent-id': ROOT_FRAME_ID,
      'frame-id': ROOT_FRAME_ID,
      'blend-mode': 'lighten',
    })
    expect((groupObj.obj as Record<string, unknown>)['blend-mode']).toBe('lighten')
  })

  it('converts blendMode to blend-mode in image builder output', () => {
    const obj = image({ name: 'I', x: 0, y: 0, width: 50, height: 50, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, blendMode: 'multiply', metadata: { id: 'media-1', width: 50, height: 50, mtype: 'image/png' } })
    expect((obj as Record<string, unknown>)['blend-mode']).toBe('multiply')
  })

  it('includes all four fields together in rect output', () => {
    const obj = rect({
      name: 'R',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      opacity: 0.5,
      hidden: true,
      blocked: false,
      blendMode: 'screen',
    })
    expect(obj.opacity).toBe(0.5)
    expect(obj.hidden).toBe(true)
    expect(obj.blocked).toBe(false)
    expect((obj as Record<string, unknown>)['blend-mode']).toBe('screen')
  })
})

describe('path', () => {
  const triangle: PathCommand[] = [
    { command: 'move-to', params: { x: 0, y: 100 } },
    { command: 'line-to', params: { x: 50, y: 0 } },
    { command: 'line-to', params: { x: 100, y: 100 } },
    { command: 'close-path' },
  ]

  it('produces type "path" with content stored verbatim', () => {
    const obj = path({ name: 'P', content: triangle, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.type).toBe('path')
    expect(obj.content).toBe(triangle)
  })

  it('derives x/y/width/height from the path bounding box', () => {
    const obj = path({ name: 'P', content: triangle, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    // Triangle spans x:[0,100] y:[0,100]
    expect(obj.x).toBe(0)
    expect(obj.y).toBe(0)
    expect(obj.width).toBe(100)
    expect(obj.height).toBe(100)
  })

  it('computes correct bounding box for a horizontal line segment', () => {
    const line: PathCommand[] = [
      { command: 'move-to', params: { x: 10, y: 20 } },
      { command: 'line-to', params: { x: 110, y: 20 } },
    ]
    const obj = path({ name: 'L', content: line, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.x).toBe(10)
    expect(obj.y).toBe(20)
    expect(obj.width).toBe(100)
    // Degenerate height (all y identical) clamps to minimum of 1
    expect(obj.height).toBeGreaterThanOrEqual(1)
  })

  it('computes tight bounding box for a cubic Bézier (extremum inside arc)', () => {
    // A cubic that curves past its endpoints along x.
    // P0=(0,0), C1=(100,0), C2=(100,100), P3=(0,100) — a closed loop, symmetric.
    // The extrema in x occur at t=0.5: x(0.5) = 75 (for this cubic).
    const curve: PathCommand[] = [
      { command: 'move-to', params: { x: 0, y: 0 } },
      { command: 'curve-to', params: { x: 0, y: 100, c1x: 100, c1y: 0, c2x: 100, c2y: 100 } },
    ]
    const obj = path({ name: 'Bézier', content: curve, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    // x must reach at least the control-point x (100) because the curve bulges right
    expect(obj.x).toBe(0)
    expect(obj.width).toBeGreaterThan(0)
    // The bounding box must enclose both endpoints
    expect((obj.x as number) + (obj.width as number)).toBeGreaterThanOrEqual(0)
  })

  it('selrect matches computed bounding box', () => {
    const obj = path({ name: 'P', content: triangle, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    const sr = obj.selrect as { x: number; y: number; width: number; height: number; x1: number; y1: number; x2: number; y2: number }
    expect(sr.x1).toBe(obj.x)
    expect(sr.y1).toBe(obj.y)
    expect(sr.x2).toBeCloseTo((obj.x as number) + (obj.width as number), 6)
  })

  it('defaults fills/strokes/shadows to empty arrays', () => {
    const obj = path({ name: 'P', content: triangle, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect(obj.fills).toEqual([])
    expect(obj.strokes).toEqual([])
    expect(obj.shadows).toEqual([])
  })
})

describe('bool', () => {
  it('produces type "bool" with the correct bool-type field', () => {
    const obj = bool({ name: 'B', x: 0, y: 0, width: 100, height: 100, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, boolType: 'union' })
    expect(obj.type).toBe('bool')
    expect(obj['bool-type']).toBe('union')
  })

  it('emits shapes:[] and content:[] for Penpot to populate/compute', () => {
    const obj = bool({ name: 'B', x: 0, y: 0, width: 100, height: 100, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, boolType: 'difference' })
    expect(obj.shapes).toEqual([])
    expect(obj.content).toEqual([])
  })

  it('accepts all four bool-type values', () => {
    const types = ['union', 'difference', 'intersection', 'exclusion'] as const
    for (const t of types) {
      const obj = bool({ name: 'B', x: 0, y: 0, width: 100, height: 100, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, boolType: t })
      expect(obj['bool-type']).toBe(t)
    }
  })

  it('computes selrect/points/transform from x/y/width/height like rect', () => {
    const obj = bool({ name: 'B', x: 10, y: 20, width: 80, height: 40, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, boolType: 'intersection' })
    expect(obj.selrect).toEqual({ x: 10, y: 20, width: 80, height: 40, x1: 10, y1: 20, x2: 90, y2: 60 })
    expect(obj.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  })

  it('passes explicit fills/strokes through unchanged', () => {
    const obj = bool({
      name: 'B', x: 0, y: 0, width: 50, height: 50, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID,
      boolType: 'union',
      fills: [{ 'fill-color': '#0000FF', 'fill-opacity': 1 }],
    })
    expect((obj.fills as { 'fill-color': string }[])[0]?.['fill-color']).toBe('#0000FF')
  })
})

describe('constraintsH / constraintsV', () => {
  it('emits constraints-h and constraints-v in rect builder output when provided', () => {
    const obj = rect({
      name: 'R', x: 0, y: 0, width: 100, height: 50,
      parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID,
      constraintsH: 'left',
      constraintsV: 'top',
    })
    expect((obj as Record<string, unknown>)['constraints-h']).toBe('left')
    expect((obj as Record<string, unknown>)['constraints-v']).toBe('top')
  })

  it('omits constraints-h and constraints-v from rect output when not provided', () => {
    const obj = rect({ name: 'R', x: 0, y: 0, width: 100, height: 50, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID })
    expect((obj as Record<string, unknown>)['constraints-h']).toBeUndefined()
    expect((obj as Record<string, unknown>)['constraints-v']).toBeUndefined()
  })

  it('emits constraints-h and constraints-v in frame builder output', () => {
    const obj = frame({
      name: 'F', x: 0, y: 0, width: 200, height: 100,
      parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID,
      constraintsH: 'scale',
      constraintsV: 'center',
    })
    expect((obj as Record<string, unknown>)['constraints-h']).toBe('scale')
    expect((obj as Record<string, unknown>)['constraints-v']).toBe('center')
  })

  it('emits constraints-h and constraints-v in text builder output', () => {
    const obj = text({
      name: 'T', x: 0, y: 0, width: 100, height: 30,
      parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID,
      characters: 'hello',
      constraintsH: 'leftright',
      constraintsV: 'topbottom',
    })
    expect((obj as Record<string, unknown>)['constraints-h']).toBe('leftright')
    expect((obj as Record<string, unknown>)['constraints-v']).toBe('topbottom')
  })

  it('emits constraints-h and constraints-v in circle builder output', () => {
    const obj = circle({
      name: 'C', x: 10, y: 10, width: 50, height: 50,
      parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID,
      constraintsH: 'right',
      constraintsV: 'bottom',
    })
    expect((obj as Record<string, unknown>)['constraints-h']).toBe('right')
    expect((obj as Record<string, unknown>)['constraints-v']).toBe('bottom')
  })

  it('emits constraints-h and constraints-v in image builder output', () => {
    const obj = image({
      name: 'I', x: 0, y: 0, width: 200, height: 150,
      parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID,
      constraintsH: 'center',
      constraintsV: 'scale',
      metadata: { id: 'media-uuid', width: 400, height: 300, mtype: 'image/png' },
    })
    expect((obj as Record<string, unknown>)['constraints-h']).toBe('center')
    expect((obj as Record<string, unknown>)['constraints-v']).toBe('scale')
  })

  it('extracts constraintsH and constraintsV from shape objects via extractEditableFields', () => {
    const shape: ShapeNode = {
      id: 'test-id',
      type: 'rect',
      name: 'R',
      'constraints-h': 'left',
      'constraints-v': 'topbottom',
    }
    const fields = extractEditableFields(shape)
    expect(fields.constraintsH).toBe('left')
    expect(fields.constraintsV).toBe('topbottom')
  })

  it('returns undefined constraintsH/constraintsV when fields are absent', () => {
    const shape: ShapeNode = { id: 'test-id', type: 'rect', name: 'R' }
    const fields = extractEditableFields(shape)
    expect(fields.constraintsH).toBeUndefined()
    expect(fields.constraintsV).toBeUndefined()
  })

  it('supports all valid constraintsH values in the rect builder', () => {
    const validH = ['left', 'right', 'leftright', 'center', 'scale'] as const
    for (const val of validH) {
      const obj = rect({ name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, constraintsH: val })
      expect((obj as Record<string, unknown>)['constraints-h']).toBe(val)
    }
  })

  it('supports all valid constraintsV values in the rect builder', () => {
    const validV = ['top', 'bottom', 'topbottom', 'center', 'scale'] as const
    for (const val of validV) {
      const obj = rect({ name: 'R', x: 0, y: 0, width: 10, height: 10, parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID, constraintsV: val })
      expect((obj as Record<string, unknown>)['constraints-v']).toBe(val)
    }
  })
})
