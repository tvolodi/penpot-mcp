/**
 * shape-builders.ts
 *
 * Constructs Penpot shape objects and `add-obj` changes by hand, matching
 * the internal schema Penpot's own frontend produces (verified by reading
 * penpot/penpot's common/src/app/common/types/shape.cljc and
 * common/src/app/common/files/changes.cljc, and confirmed empirically
 * against a live instance).
 *
 * Scope: unrotated shapes only (rotation: 0). For those, `selrect`/`points`
 * are pure functions of x/y/width/height, and `transform`/`transform-inverse`
 * are the identity matrix — see `setup-rect` in shape.cljc. Rotated shapes
 * need real point-transform math and are out of scope here.
 *
 * This does NOT talk to the network and carries no project-specific colors
 * or fonts — every fill/stroke/font value is a caller-supplied parameter.
 * See `rpc-client.ts` for the client that sends these changes via
 * `update-file`, and `tools/content.ts` for the MCP tool that resolves
 * design-token references before calling these builders.
 */

import { randomUUID } from 'node:crypto'

export type Fill = { 'fill-color': string; 'fill-opacity': number }
export type Stroke = {
  'stroke-color': string
  'stroke-opacity': number
  'stroke-width': number
  'stroke-style': 'solid' | 'dotted' | 'dashed' | 'mixed'
  'stroke-alignment': 'inner' | 'outer' | 'center'
}

const IDENTITY_MATRIX = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export const ROOT_FRAME_ID = '00000000-0000-0000-0000-000000000000'

type Rect = { x: number; y: number; width: number; height: number }

function selrectAndPoints(rect: Rect) {
  const { x, y, width, height } = rect
  return {
    selrect: { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height },
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
  }
}

type BaseParams = {
  id?: string
  name: string
  x: number
  y: number
  width: number
  height: number
  parentId: string
  frameId: string
}

type CornerRadii = { r1?: number; r2?: number; r3?: number; r4?: number }

export function rect(
  params: BaseParams & {
    fills?: Fill[]
    strokes?: Stroke[]
  } & CornerRadii,
): Record<string, unknown> {
  const { id = randomUUID(), name, x, y, width, height, parentId, frameId, fills, strokes, r1, r2, r3, r4 } =
    params
  return {
    id,
    type: 'rect',
    name,
    x,
    y,
    width,
    height,
    rotation: 0,
    'parent-id': parentId,
    'frame-id': frameId,
    ...selrectAndPoints({ x, y, width, height }),
    transform: IDENTITY_MATRIX,
    'transform-inverse': IDENTITY_MATRIX,
    fills: fills ?? [],
    strokes: strokes ?? [],
    r1: r1 ?? 0,
    r2: r2 ?? 0,
    r3: r3 ?? 0,
    r4: r4 ?? 0,
  }
}

export function frame(
  params: BaseParams & {
    fills?: Fill[]
    strokes?: Stroke[]
  } & CornerRadii,
): Record<string, unknown> {
  const { id = randomUUID(), name, x, y, width, height, parentId, frameId, fills, strokes, r1, r2, r3, r4 } =
    params
  return {
    id,
    type: 'frame',
    name,
    x,
    y,
    width,
    height,
    rotation: 0,
    'parent-id': parentId,
    'frame-id': frameId,
    ...selrectAndPoints({ x, y, width, height }),
    transform: IDENTITY_MATRIX,
    'transform-inverse': IDENTITY_MATRIX,
    fills: fills ?? [{ 'fill-color': '#FFFFFF', 'fill-opacity': 1 }],
    strokes: strokes ?? [],
    r1: r1 ?? 0,
    r2: r2 ?? 0,
    r3: r3 ?? 0,
    r4: r4 ?? 0,
    shapes: [],
    'hide-fill-on-export': false,
  }
}

export function text(
  params: BaseParams & {
    characters: string
    fontFamily?: string
    fontSize?: string
    fontWeight?: string
    fillColor?: string
  },
): Record<string, unknown> {
  const {
    id = randomUUID(),
    name,
    x,
    y,
    width,
    height,
    parentId,
    frameId,
    characters,
    fontFamily = 'Inter',
    fontSize = '14',
    fontWeight = '400',
    fillColor = '#000000',
  } = params

  const fills: Fill[] = [{ 'fill-color': fillColor, 'fill-opacity': 1 }]

  return {
    id,
    type: 'text',
    name,
    x,
    y,
    width,
    height,
    rotation: 0,
    'parent-id': parentId,
    'frame-id': frameId,
    ...selrectAndPoints({ x, y, width, height }),
    transform: IDENTITY_MATRIX,
    'transform-inverse': IDENTITY_MATRIX,
    fills,
    'grow-type': 'auto-width',
    content: {
      type: 'root',
      children: [
        {
          type: 'paragraph-set',
          children: [
            {
              type: 'paragraph',
              fills,
              'font-family': fontFamily,
              'font-size': fontSize,
              'font-weight': fontWeight,
              children: [
                {
                  text: characters,
                  fills,
                  'font-family': fontFamily,
                  'font-size': fontSize,
                  'font-weight': fontWeight,
                },
              ],
            },
          ],
        },
      ],
    },
  }
}

export type AddObjChange = {
  type: 'add-obj'
  id: string
  'page-id': string
  'frame-id': string
  'parent-id': string
  obj: Record<string, unknown>
}

/** Wraps a shape object (from `rect`/`frame`/`text`) as an `add-obj` change. */
export function addObj(pageId: string, obj: Record<string, unknown>): AddObjChange {
  return {
    type: 'add-obj',
    id: obj.id as string,
    'page-id': pageId,
    'frame-id': obj['frame-id'] as string,
    'parent-id': obj['parent-id'] as string,
    obj,
  }
}

export type AddPageChange = { type: 'add-page'; id: string; name: string }

export function addPage(name: string, id: string = randomUUID()): AddPageChange {
  return { type: 'add-page', id, name }
}
