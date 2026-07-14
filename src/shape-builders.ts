/**
 * shape-builders.ts
 *
 * Constructs Penpot shape objects and `add-obj` changes by hand, matching
 * the internal schema Penpot's own frontend produces (verified by reading
 * penpot/penpot's common/src/app/common/types/shape.cljc and
 * common/src/app/common/files/changes.cljc, and confirmed empirically
 * against a live instance).
 *
 * Supports rotated shapes: `points` are the shape's corners rotated about
 * its center, `selrect` is the axis-aligned bounding box of those rotated
 * points, and `transform`/`transform-inverse` are the rotation matrix (and
 * its inverse) about the center — see `setup-rect` in shape.cljc.
 *
 * Also supports flex/grid auto-layout (`layoutAttrs`/`layoutItemAttrs`) and
 * components (`componentRootAttrs`/`addComponent`/`cloneComponentInstance`),
 * whose exact wire attribute names were verified empirically against a live
 * instance rather than assumed from the Clojure source.
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
type Point = { x: number; y: number }
type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number }

/** Rotates `point` by `degrees` around `center` (clockwise, matching Penpot's screen-space convention). */
function rotatePoint(point: Point, center: Point, degrees: number): Point {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  }
}

/** Builds the 2D affine rotation matrix (by `degrees`, about `center`) in Penpot's `a,b,c,d,e,f` form. */
function rotationMatrix(center: Point, degrees: number): Matrix {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: center.x - center.x * cos + center.y * sin,
    f: center.y - center.x * sin - center.y * cos,
  }
}

/**
 * `points` are the shape's corners rotated about its center; `selrect` is the
 * axis-aligned box enclosing those rotated points (matching Penpot's
 * `setup-rect`). `width`/`height` on the shape itself always stay the
 * pre-rotation dimensions — only `selrect`'s span reflects the rotated bbox.
 */
function selrectAndPoints(rect: Rect, rotation: number) {
  const { x, y, width, height } = rect
  const corners: Point[] = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ]
  if (rotation === 0) {
    return {
      selrect: { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height },
      points: corners,
    }
  }
  const center = { x: x + width / 2, y: y + height / 2 }
  const points = corners.map((p) => rotatePoint(p, center, rotation))
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x1 = Math.min(...xs)
  const y1 = Math.min(...ys)
  const x2 = Math.max(...xs)
  const y2 = Math.max(...ys)
  return {
    selrect: { x: x1, y: y1, width: x2 - x1, height: y2 - y1, x1, y1, x2, y2 },
    points,
  }
}

function transforms(rect: Rect, rotation: number) {
  if (rotation === 0) {
    return { transform: IDENTITY_MATRIX, 'transform-inverse': IDENTITY_MATRIX }
  }
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  return {
    transform: rotationMatrix(center, rotation),
    'transform-inverse': rotationMatrix(center, -rotation),
  }
}

type BaseParams = {
  id?: string
  name: string
  x: number
  y: number
  width: number
  height: number
  rotation?: number
  parentId: string
  frameId: string
  /** Placement within the parent's auto-layout, if the parent has one. */
  layoutItem?: LayoutItem
}

type CornerRadii = { r1?: number; r2?: number; r3?: number; r4?: number }

type GridTrack = { type: 'fixed' | 'percent' | 'flex' | 'auto'; value?: number }

/** Auto-layout config for a `frame`, verified against a live Penpot instance's `add-obj` schema. */
export type FlexLayout = {
  type: 'flex'
  dir?: 'row' | 'row-reverse' | 'column' | 'column-reverse'
  rowGap?: number
  columnGap?: number
  wrapType?: 'wrap' | 'nowrap'
  paddingType?: 'simple' | 'multiple'
  /** Applies to all four sides when `paddingType` is 'simple'; only p1 is read in that case. */
  padding?: { p1?: number; p2?: number; p3?: number; p4?: number }
  alignItems?: 'start' | 'center' | 'end' | 'stretch'
  alignContent?: 'start' | 'center' | 'end' | 'stretch' | 'space-between' | 'space-around' | 'space-evenly'
  justifyItems?: 'start' | 'center' | 'end' | 'stretch'
  justifyContent?: 'start' | 'center' | 'end' | 'stretch' | 'space-between' | 'space-around' | 'space-evenly'
}

export type GridLayout = {
  type: 'grid'
  dir?: 'row' | 'column'
  rowGap?: number
  columnGap?: number
  paddingType?: 'simple' | 'multiple'
  /** Applies to all four sides when `paddingType` is 'simple'; only p1 is read in that case. */
  padding?: { p1?: number; p2?: number; p3?: number; p4?: number }
  alignItems?: 'start' | 'center' | 'end' | 'stretch'
  alignContent?: 'start' | 'center' | 'end' | 'stretch' | 'space-between' | 'space-around' | 'space-evenly'
  justifyItems?: 'start' | 'center' | 'end' | 'stretch'
  justifyContent?: 'start' | 'center' | 'end' | 'stretch' | 'space-between' | 'space-around' | 'space-evenly'
  rows?: GridTrack[]
  columns?: GridTrack[]
}

export type Layout = FlexLayout | GridLayout

function layoutAttrs(layout: Layout | undefined): Record<string, unknown> {
  if (!layout) return {}
  const padding = layout.padding
  const attrs: Record<string, unknown> = {
    layout: layout.type,
    'layout-gap': { 'row-gap': layout.rowGap ?? 0, 'column-gap': layout.columnGap ?? 0 },
    'layout-padding-type': layout.paddingType ?? 'simple',
    'layout-padding': { p1: padding?.p1 ?? 0, p2: padding?.p2 ?? 0, p3: padding?.p3 ?? 0, p4: padding?.p4 ?? 0 },
    'layout-align-items': layout.alignItems ?? 'start',
    'layout-justify-content': layout.justifyContent ?? 'start',
  }
  if (layout.alignContent) attrs['layout-align-content'] = layout.alignContent
  if (layout.justifyItems) attrs['layout-justify-items'] = layout.justifyItems
  if (layout.type === 'flex') {
    attrs['layout-flex-dir'] = layout.dir ?? 'row'
    attrs['layout-wrap-type'] = layout.wrapType ?? 'nowrap'
  } else {
    attrs['layout-grid-dir'] = layout.dir ?? 'row'
    attrs['layout-grid-rows'] = layout.rows ?? [{ type: 'flex', value: 1 }]
    attrs['layout-grid-columns'] = layout.columns ?? [{ type: 'flex', value: 1 }]
  }
  return attrs
}

/** Placement of a shape within an ancestor's auto-layout (flex or grid). */
export type LayoutItem = {
  absolute?: boolean
  zIndex?: number
  horizontalSizing?: 'fill' | 'auto' | 'fix'
  verticalSizing?: 'fill' | 'auto' | 'fix'
  alignSelf?: 'start' | 'center' | 'end' | 'auto' | 'stretch'
  margin?: { m1?: number; m2?: number; m3?: number; m4?: number }
  maxWidth?: number
  maxHeight?: number
  minWidth?: number
  minHeight?: number
  /** Only meaningful when the parent has a grid layout. 1-based. */
  row?: number
  column?: number
  rowSpan?: number
  columnSpan?: number
}

function layoutItemAttrs(item: LayoutItem | undefined): Record<string, unknown> {
  if (!item) return {}
  const attrs: Record<string, unknown> = {}
  if (item.absolute !== undefined) attrs['layout-item-absolute'] = item.absolute
  if (item.zIndex !== undefined) attrs['layout-item-z-index'] = item.zIndex
  if (item.horizontalSizing) attrs['layout-item-h-sizing'] = item.horizontalSizing
  if (item.verticalSizing) attrs['layout-item-v-sizing'] = item.verticalSizing
  if (item.alignSelf) attrs['layout-item-align-self'] = item.alignSelf
  if (item.margin) {
    const m = item.margin
    attrs['layout-item-margin'] = { m1: m.m1 ?? 0, m2: m.m2 ?? 0, m3: m.m3 ?? 0, m4: m.m4 ?? 0 }
  }
  if (item.maxWidth !== undefined) attrs['layout-item-max-w'] = item.maxWidth
  if (item.maxHeight !== undefined) attrs['layout-item-max-h'] = item.maxHeight
  if (item.minWidth !== undefined) attrs['layout-item-min-w'] = item.minWidth
  if (item.minHeight !== undefined) attrs['layout-item-min-h'] = item.minHeight
  if (item.row !== undefined) attrs['layout-item-row'] = item.row
  if (item.column !== undefined) attrs['layout-item-column'] = item.column
  if (item.rowSpan !== undefined) attrs['layout-item-row-span'] = item.rowSpan
  if (item.columnSpan !== undefined) attrs['layout-item-column-span'] = item.columnSpan
  return attrs
}

export function rect(
  params: BaseParams & {
    fills?: Fill[]
    strokes?: Stroke[]
  } & CornerRadii,
): Record<string, unknown> {
  const {
    id = randomUUID(),
    name,
    x,
    y,
    width,
    height,
    rotation = 0,
    parentId,
    frameId,
    layoutItem,
    fills,
    strokes,
    r1,
    r2,
    r3,
    r4,
  } = params
  return {
    id,
    type: 'rect',
    name,
    x,
    y,
    width,
    height,
    rotation,
    'parent-id': parentId,
    'frame-id': frameId,
    ...selrectAndPoints({ x, y, width, height }, rotation),
    ...transforms({ x, y, width, height }, rotation),
    fills: fills ?? [],
    strokes: strokes ?? [],
    r1: r1 ?? 0,
    r2: r2 ?? 0,
    r3: r3 ?? 0,
    r4: r4 ?? 0,
    ...layoutItemAttrs(layoutItem),
  }
}

export function frame(
  params: BaseParams & {
    fills?: Fill[]
    strokes?: Stroke[]
    /** Adds flex or grid auto-layout to this frame, controlling how its children are positioned. */
    layout?: Layout
  } & CornerRadii,
): Record<string, unknown> {
  const {
    id = randomUUID(),
    name,
    x,
    y,
    width,
    height,
    rotation = 0,
    parentId,
    frameId,
    layoutItem,
    layout,
    fills,
    strokes,
    r1,
    r2,
    r3,
    r4,
  } = params
  return {
    id,
    type: 'frame',
    name,
    x,
    y,
    width,
    height,
    rotation,
    'parent-id': parentId,
    'frame-id': frameId,
    ...selrectAndPoints({ x, y, width, height }, rotation),
    ...transforms({ x, y, width, height }, rotation),
    fills: fills ?? [{ 'fill-color': '#FFFFFF', 'fill-opacity': 1 }],
    strokes: strokes ?? [],
    r1: r1 ?? 0,
    r2: r2 ?? 0,
    r3: r3 ?? 0,
    r4: r4 ?? 0,
    shapes: [],
    'hide-fill-on-export': false,
    ...layoutAttrs(layout),
    ...layoutItemAttrs(layoutItem),
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
    rotation = 0,
    parentId,
    frameId,
    layoutItem,
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
    rotation,
    'parent-id': parentId,
    'frame-id': frameId,
    ...selrectAndPoints({ x, y, width, height }, rotation),
    ...transforms({ x, y, width, height }, rotation),
    fills,
    'grow-type': 'auto-width',
    ...layoutItemAttrs(layoutItem),
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

/**
 * The subset of a shape's own fields (geometry, name, fills, strokes, corner radii,
 * text content/font) that `updateShapeFields` round-trips through the `rect`/
 * `frame`/`text` builders. Deliberately narrower than every attribute a shape can
 * carry (e.g. layout/layoutItem/component/variant tags are left untouched, not
 * read back and reapplied) — those are set once at creation and rarely need
 * hand-editing after the fact, and extracting them correctly would mean hand-
 * mapping camelCase field names Penpot has never been confirmed to return in a
 * form matching the builders' inputs.
 */
export type EditableShapeFields = {
  name: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  fills?: Fill[]
  strokes?: Stroke[]
  r1?: number
  r2?: number
  r3?: number
  r4?: number
  characters?: string
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
}

/**
 * Reads a shape object back from `get-file` (camelCase) into the field shape the
 * `rect`/`frame`/`text` builders expect (kebab-case keys), for the editable-field
 * subset above. `fills`/`strokes` are read from their camelCase inner keys
 * (`fillColor`/`fillOpacity`, `strokeColor`/etc.) — verified live against a real
 * instance's `get-file` response during the components/variants investigation.
 * Text content is read from the first paragraph/leaf of `content`, matching the
 * single-paragraph structure `text()` always produces; a shape with richer
 * multi-paragraph content (e.g. hand-edited in the Penpot UI) will only have its
 * first paragraph's text/font reflected here.
 */
export function extractEditableFields(shape: ShapeNode): EditableShapeFields {
  const fillsRaw = (shape.fills as Array<{ fillColor: string; fillOpacity: number }> | undefined) ?? []
  const fills: Fill[] | undefined =
    fillsRaw.length > 0
      ? fillsRaw.map((f) => ({ 'fill-color': f.fillColor, 'fill-opacity': f.fillOpacity }))
      : undefined

  const strokesRaw =
    (shape.strokes as
      | Array<{
          strokeColor: string
          strokeOpacity: number
          strokeWidth: number
          strokeStyle: Stroke['stroke-style']
          strokeAlignment: Stroke['stroke-alignment']
        }>
      | undefined) ?? []
  const strokes: Stroke[] | undefined =
    strokesRaw.length > 0
      ? strokesRaw.map((s) => ({
          'stroke-color': s.strokeColor,
          'stroke-opacity': s.strokeOpacity,
          'stroke-width': s.strokeWidth,
          'stroke-style': s.strokeStyle,
          'stroke-alignment': s.strokeAlignment,
        }))
      : undefined

  const content = shape.content as
    | { children?: Array<{ children?: Array<{ children?: Array<{ text?: string }>; fontFamily?: string; fontSize?: string; fontWeight?: string }> }> }
    | undefined
  const paragraph = content?.children?.[0]?.children?.[0]
  const leaf = paragraph?.children?.[0]

  return {
    name: shape.name as string,
    x: shape.x as number,
    y: shape.y as number,
    width: shape.width as number,
    height: shape.height as number,
    rotation: (shape.rotation as number) ?? 0,
    fills,
    strokes,
    r1: shape.r1 as number | undefined,
    r2: shape.r2 as number | undefined,
    r3: shape.r3 as number | undefined,
    r4: shape.r4 as number | undefined,
    characters: leaf?.text,
    fontFamily: paragraph?.fontFamily,
    fontSize: paragraph?.fontSize,
    fontWeight: paragraph?.fontWeight,
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

/**
 * Attributes that mark a shape object as the main instance (root) of a component,
 * verified against a live instance: only the root shape of the main-instance tree
 * carries `component-id`/`component-file`/`component-root`/`main-instance` — its
 * descendants (if any) are plain shapes, no different from a non-component tree.
 *
 * When `variant` is given, also tags the shape as belonging to a variant group:
 * `variant-id` (the group's id — see the important note on `variantContainerAttrs`
 * about what this id must be) and `variant-name` (this variant's display label,
 * e.g. "Primary" — the shape-level field is just a label; the structured
 * property/value pairs live on the component's `add-component` entry instead, see
 * `addComponent`). Verified end-to-end against a live instance: after building a
 * group this way, `container.variants.properties`/`variantComponents()` and
 * `instance.switchVariant(pos, value)` all behave exactly as they do for a group
 * built through Penpot's own plugin API (`createVariantFromComponents`).
 */
export function componentRootAttrs(
  componentId: string,
  fileId: string,
  variant?: { variantId: string; name: string },
): Record<string, unknown> {
  return {
    'component-id': componentId,
    'component-file': fileId,
    'component-root': true,
    'main-instance': true,
    ...(variant ? { 'variant-id': variant.variantId, 'variant-name': variant.name } : {}),
  }
}

export type VariantProperty = { name: string; value: string }

export type AddComponentChange = {
  type: 'add-component'
  id: string
  name: string
  path: string
  'main-instance-id': string
  'main-instance-page': string
  'variant-id'?: string
  'variant-properties'?: VariantProperty[]
}

/**
 * Registers a shape tree (already added via `add-obj`) as a component in the file's
 * components map. When `variant` is given, also records this component's
 * `variant-id` (shared across the group) and `variant-properties` (this component's
 * own name/value pairs, e.g. `[{ name: "Type", value: "Primary" }]`) — verified live:
 * these are accepted and persisted on the components-map entry, independently of the
 * shape-level `variant-name` set via `componentRootAttrs`.
 */
export function addComponent(
  componentId: string,
  name: string,
  mainInstanceId: string,
  mainInstancePage: string,
  path: string = '',
  variant?: { variantId: string; properties: VariantProperty[] },
): AddComponentChange {
  return {
    type: 'add-component',
    id: componentId,
    name,
    path,
    'main-instance-id': mainInstanceId,
    'main-instance-page': mainInstancePage,
    ...(variant ? { 'variant-id': variant.variantId, 'variant-properties': variant.properties } : {}),
  }
}

/**
 * Attributes for the `frame` that physically groups a variant group's main
 * instances (Penpot's `VariantContainer`, verified live: `is-variant-container`
 * and `variant-id` on a `frame` shape). Its `shapes` array must list every main
 * instance's id, and each of those main instances' `parent-id`/`frame-id` must
 * point at this container — set both at `add-obj` time, since reparenting an
 * already-created shape via `mov-objects` was tested and found not to work
 * through this RPC surface (the change is accepted but silently has no effect).
 *
 * IMPORTANT, found only by diffing against a group built through Penpot's own
 * plugin API: `variantId` must be the container shape's OWN id, not an
 * independently generated id. A group built with a separate variant-id round-trips
 * through the RPC schema without error, but the editor then can't resolve the
 * group — `Variants.properties` and `variantComponents()` silently come back
 * empty, so the swap UI has nothing to show. Always call this as
 * `variantContainerAttrs(containerId)`.
 */
export function variantContainerAttrs(variantId: string): Record<string, unknown> {
  return {
    'is-variant-container': true,
    'variant-id': variantId,
  }
}

/**
 * A plain shape tree node, as read back from `get-file` (camelCase) — the minimum
 * shape needed to clone a main-instance tree into a new component instance/copy.
 */
export type ShapeNode = {
  id: string
  type: string
  shapes?: string[]
} & Record<string, unknown>

/**
 * Deep-clones a main-instance shape tree (root + descendants, looked up by id in
 * `objects`) into a fresh copy with new ids, offset by `(dx, dy)`, parented under
 * `parentId`/`frameId`. Every cloned node gets `shape-ref` pointing at its main-tree
 * counterpart (verified live: this applies to every node, root included); only the
 * root of the copy additionally gets `component-id`/`component-file` so Penpot
 * recognizes the copy as a component instance. Returns one `add-obj` change per
 * cloned node, in parent-before-child order.
 */
export function cloneComponentInstance(params: {
  pageId: string
  objects: Record<string, ShapeNode>
  mainRootId: string
  componentId: string
  componentFileId: string
  parentId: string
  frameId: string
  dx: number
  dy: number
}): AddObjChange[] {
  const { pageId, objects, mainRootId, componentId, componentFileId, parentId, frameId, dx, dy } = params
  const changes: AddObjChange[] = []

  function cloneNode(
    mainId: string,
    newParentId: string,
    newFrameId: string,
    isRoot: boolean,
    newId: string = randomUUID(),
  ): string {
    const main = objects[mainId]
    if (!main) throw new Error(`Main instance shape ${mainId} not found in file`)

    const obj: Record<string, unknown> = {
      ...main,
      id: newId,
      x: (main.x as number) + dx,
      y: (main.y as number) + dy,
      'parent-id': newParentId,
      'frame-id': newFrameId,
      'shape-ref': mainId,
    }
    // Drop camelCase duplicates from the source (get-file returns camelCase; add-obj needs kebab-case).
    delete obj.parentId
    delete obj.frameId
    delete obj.transformInverse
    delete obj['transform-inverse']
    delete obj.shapeRef
    delete obj.componentId
    delete obj.componentFile
    delete obj.componentRoot
    delete obj.mainInstance

    // Rotation matrices are pivot-relative; a pure translation shifts the pivot by (dx, dy)
    // while the rotation part (a, b, c, d) is unchanged.
    const transform = (main.transform as Matrix) ?? IDENTITY_MATRIX
    const transformInverse = (main.transformInverse as Matrix) ?? (main['transform-inverse'] as Matrix) ?? IDENTITY_MATRIX
    obj.transform = { ...transform, e: transform.e + dx, f: transform.f + dy }
    obj['transform-inverse'] = { ...transformInverse, e: transformInverse.e - dx, f: transformInverse.f - dy }

    if (isRoot) {
      obj['component-id'] = componentId
      obj['component-file'] = componentFileId
    } else {
      obj['component-root'] = false
      delete obj['main-instance']
    }

    const selrect = main.selrect as Rect & { x1: number; y1: number; x2: number; y2: number }
    obj.selrect = {
      x: selrect.x1 + dx,
      y: selrect.y1 + dy,
      width: selrect.width,
      height: selrect.height,
      x1: selrect.x1 + dx,
      y1: selrect.y1 + dy,
      x2: selrect.x2 + dx,
      y2: selrect.y2 + dy,
    }
    const points = (main.points as Point[]) ?? []
    obj.points = points.map((p) => ({ x: p.x + dx, y: p.y + dy }))

    const childIds = main.shapes ?? []
    const isFrame = main.type === 'frame'
    // Pre-compute the children's new ids so `obj.shapes` is correct, but don't recurse into
    // them (i.e. don't push their add-obj changes) until after this node's own change is
    // pushed, so `changes` comes out parent-before-child.
    const childNewIds = childIds.map(() => randomUUID())
    obj.shapes = childNewIds

    changes.push({
      type: 'add-obj',
      id: newId,
      'page-id': pageId,
      'frame-id': newFrameId,
      'parent-id': newParentId,
      obj,
    })

    childIds.forEach((childId, i) => {
      cloneNode(childId, newId, isFrame ? newId : newFrameId, false, childNewIds[i]!)
    })
    return newId
  }

  cloneNode(mainRootId, parentId, frameId, true)
  return changes
}
