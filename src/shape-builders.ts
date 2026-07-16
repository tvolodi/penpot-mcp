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

/** Solid color fill — a hex color plus overall opacity. */
export type SolidFill = { 'fill-color': string; 'fill-opacity': number }

/** A single stop in a gradient fill. `offset` is 0–1 (position along the gradient). */
export type GradientStop = { color: string; opacity: number; offset: number }

/**
 * Linear or radial gradient descriptor, used in `GradientFill['fill-color-gradient']`.
 * All coordinates (`start-x`/`start-y`/`end-x`/`end-y`) are relative to the shape's
 * bounding box (0 = left/top edge, 1 = right/bottom edge). `width` controls the spread
 * perpendicular to the gradient axis (1 = full shape width — the common default).
 */
export type Gradient = {
  type: 'linear' | 'radial'
  'start-x': number
  'start-y': number
  'end-x': number
  'end-y': number
  width: number
  stops: GradientStop[]
}

/** Gradient fill (linear or radial). `fill-opacity` is the overall layer opacity (1 = fully opaque). */
export type GradientFill = {
  'fill-color-gradient': Gradient
  'fill-opacity'?: number
}

/**
 * Image fill metadata referencing an already-uploaded Penpot media object by UUID.
 * The caller is responsible for uploading the image to Penpot first (via the Penpot UI
 * or a separate upload step) and supplying its media-object `id` here.
 */
export type ImageFillMetadata = {
  id: string
  width: number
  height: number
  mtype: string
  name?: string
  'keep-aspect-ratio'?: boolean
}

/** Image fill — references a Penpot media object. `fill-opacity` is the overall layer opacity. */
export type ImageFill = {
  'fill-image': ImageFillMetadata
  'fill-opacity'?: number
}

/** Any valid Penpot fill: solid color, linear/radial gradient, or image. */
export type Fill = SolidFill | GradientFill | ImageFill

export type Stroke = {
  'stroke-color': string
  'stroke-opacity': number
  'stroke-width': number
  'stroke-style': 'solid' | 'dotted' | 'dashed' | 'mixed'
  'stroke-alignment': 'inner' | 'outer' | 'center'
}

/**
 * Drop/inner shadow, verified live against a real instance's `add-obj`/`get-file`: the wire
 * field is `shadows` (an array, applied back-to-front like `fills`/`strokes`), `style` is
 * `"drop-shadow"` | `"inner-shadow"` (not `shadowType` as the plugin API's `Shadow` type
 * suggests), offsets are kebab-case `offset-x`/`offset-y`, and `color` is a nested
 * `{ color, opacity }` object rather than flattened `shadow-color`/`shadow-opacity` keys.
 */
export type Shadow = {
  style: 'drop-shadow' | 'inner-shadow'
  'offset-x': number
  'offset-y': number
  blur: number
  spread: number
  color: { color: string; opacity: number }
  hidden: boolean
}

/**
 * A single text run within a paragraph. The `text` field carries the raw characters;
 * all other fields are per-run style overrides that take precedence over the parent
 * paragraph's defaults. Only set a field if it differs from the paragraph default —
 * unset fields inherit from the paragraph. Verified field names against Penpot's
 * `types/text.cljc` `text-node-attrs` and `text-span-attrs`.
 */
export type TextRange = {
  text: string
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  fontStyle?: string
  lineHeight?: string
  letterSpacing?: string
  textDecoration?: string
  textTransform?: string
  fills?: Fill[]
}

/**
 * A paragraph within a text shape's content tree. `textAlign` and `textDirection` are
 * paragraph-level only (they affect the whole paragraph, not individual runs). All other
 * style fields are inherited defaults for the paragraph's `ranges`; individual `TextRange`
 * entries may override any of them. Verified against Penpot's `types/text.cljc`
 * `paragraph-attrs` (text-align, text-direction) and `text-node-attrs` (everything else).
 */
export type TextParagraph = {
  textAlign?: 'left' | 'right' | 'center' | 'justify'
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  fontStyle?: string
  lineHeight?: string
  letterSpacing?: string
  textDecoration?: string
  textTransform?: string
  fills?: Fill[]
  ranges: TextRange[]
}

/**
 * A single segment of a `path` shape's geometry, in Penpot's wire format.
 * Commands are kebab-case (`move-to`, `line-to`, `curve-to`, `close-path`);
 * params carry the relevant coordinates. The full path is an ordered array of
 * these segments — the same structure Penpot's own editor writes when you draw a
 * custom path or extract one from a boolean-operation result.
 */
export type PathCommand =
  | { command: 'move-to'; params: { x: number; y: number } }
  | { command: 'line-to'; params: { x: number; y: number } }
  | { command: 'curve-to'; params: { x: number; y: number; c1x: number; c1y: number; c2x: number; c2y: number } }
  | { command: 'close-path'; params?: Record<string, never> }

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
  /** Overall layer opacity (0-1). Defaults to 1 (fully opaque). */
  opacity?: number
  /** Whether the shape is hidden (eye icon in Penpot UI). */
  hidden?: boolean
  /** Whether the shape is locked (lock icon in Penpot UI). */
  blocked?: boolean
  /** Blend mode (e.g. 'normal', 'multiply', 'screen', 'overlay'). Defaults to 'normal'. */
  blendMode?: string
  /**
   * Horizontal resize constraint — how the shape behaves when its parent frame resizes.
   * `left`/`right`: fix distance to the left/right edge. `leftright`: fix both edges (stretch).
   * `center`: stay centered. `scale`: scale proportionally (default).
   */
  constraintsH?: 'left' | 'right' | 'leftright' | 'center' | 'scale'
  /**
   * Vertical resize constraint — how the shape behaves when its parent frame resizes.
   * `top`/`bottom`: fix distance to the top/bottom edge. `topbottom`: fix both edges (stretch).
   * `center`: stay centered. `scale`: scale proportionally (default).
   */
  constraintsV?: 'top' | 'bottom' | 'topbottom' | 'center' | 'scale'
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
    shadows?: Shadow[]
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
    opacity,
    hidden,
    blocked,
    blendMode,
    fills,
    strokes,
    shadows,
    r1,
    r2,
    r3,
    r4,
    constraintsH,
    constraintsV,
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
    ...(opacity !== undefined && { opacity }),
    ...(hidden !== undefined && { hidden }),
    ...(blocked !== undefined && { blocked }),
    ...(blendMode !== undefined && { 'blend-mode': blendMode }),
    ...(constraintsH !== undefined && { 'constraints-h': constraintsH }),
    ...(constraintsV !== undefined && { 'constraints-v': constraintsV }),
    fills: fills ?? [],
    strokes: strokes ?? [],
    shadows: shadows ?? [],
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
    shadows?: Shadow[]
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
    opacity,
    hidden,
    blocked,
    blendMode,
    layout,
    fills,
    strokes,
    shadows,
    r1,
    r2,
    r3,
    r4,
    constraintsH,
    constraintsV,
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
    ...(opacity !== undefined && { opacity }),
    ...(hidden !== undefined && { hidden }),
    ...(blocked !== undefined && { blocked }),
    ...(blendMode !== undefined && { 'blend-mode': blendMode }),
    ...(constraintsH !== undefined && { 'constraints-h': constraintsH }),
    ...(constraintsV !== undefined && { 'constraints-v': constraintsV }),
    fills: fills ?? [{ 'fill-color': '#FFFFFF', 'fill-opacity': 1 }],
    strokes: strokes ?? [],
    shadows: shadows ?? [],
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

/** Builds a single paragraph node (for the content tree) from a `TextParagraph` descriptor. */
function buildTextParagraphNode(para: TextParagraph): Record<string, unknown> {
  return {
    type: 'paragraph',
    ...(para.textAlign !== undefined && { 'text-align': para.textAlign }),
    ...(para.fontFamily !== undefined && { 'font-family': para.fontFamily }),
    ...(para.fontSize !== undefined && { 'font-size': para.fontSize }),
    ...(para.fontWeight !== undefined && { 'font-weight': para.fontWeight }),
    ...(para.fontStyle !== undefined && { 'font-style': para.fontStyle }),
    ...(para.lineHeight !== undefined && { 'line-height': para.lineHeight }),
    ...(para.letterSpacing !== undefined && { 'letter-spacing': para.letterSpacing }),
    ...(para.textDecoration !== undefined && { 'text-decoration': para.textDecoration }),
    ...(para.textTransform !== undefined && { 'text-transform': para.textTransform }),
    ...(para.fills !== undefined && { fills: para.fills }),
    children: para.ranges.map((range) => ({
      text: range.text,
      ...(range.fontFamily !== undefined && { 'font-family': range.fontFamily }),
      ...(range.fontSize !== undefined && { 'font-size': range.fontSize }),
      ...(range.fontWeight !== undefined && { 'font-weight': range.fontWeight }),
      ...(range.fontStyle !== undefined && { 'font-style': range.fontStyle }),
      ...(range.lineHeight !== undefined && { 'line-height': range.lineHeight }),
      ...(range.letterSpacing !== undefined && { 'letter-spacing': range.letterSpacing }),
      ...(range.textDecoration !== undefined && { 'text-decoration': range.textDecoration }),
      ...(range.textTransform !== undefined && { 'text-transform': range.textTransform }),
      ...(range.fills !== undefined && { fills: range.fills }),
    })),
  }
}

export function text(
  params: BaseParams & {
    /**
     * Rich text mode: supply an array of paragraphs (each with its own style and text
     * ranges). When present, `characters`/`fontFamily`/`fontSize`/`fontWeight`/`fillColor`
     * are ignored. Paragraph-level style fields are inherited defaults for all ranges within
     * that paragraph; individual ranges may override any of them.
     */
    paragraphs?: TextParagraph[]
    /** Legacy mode: a single string of text across one paragraph. Used when `paragraphs` is absent. */
    characters?: string
    fontFamily?: string
    fontSize?: string
    fontWeight?: string
    fillColor?: string
    /**
     * How the text box grows to fit its content. `"auto-width"` (default): box width expands
     * as text grows. `"auto-height"`: width is fixed, height expands. `"fixed"`: both dimensions
     * are fixed. Matches Penpot's `grow-type` wire field.
     */
    growType?: 'auto-width' | 'auto-height' | 'fixed'
    /**
     * Vertical alignment of the text block within its bounding box. Stored on the content's
     * root node as `vertical-align`. Default: `"top"`.
     */
    verticalAlign?: 'top' | 'center' | 'bottom'
    shadows?: Shadow[]
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
    opacity,
    hidden,
    blocked,
    blendMode,
    paragraphs,
    characters = '',
    fontFamily = 'Inter',
    fontSize = '14',
    fontWeight = '400',
    fillColor = '#000000',
    growType = 'auto-width',
    verticalAlign = 'top',
    shadows,
    constraintsH,
    constraintsV,
  } = params

  let fills: Fill[]
  let content: Record<string, unknown>

  if (paragraphs) {
    // Rich text mode: build content from the paragraphs array.
    // Shape-level fills default to the first range's fills, or the first paragraph's fills,
    // or solid black — kept in sync with content so Penpot has a consistent fallback.
    const firstParaFills = paragraphs[0]?.fills
    const firstRangeFills = paragraphs[0]?.ranges[0]?.fills
    fills = firstRangeFills ?? firstParaFills ?? [{ 'fill-color': '#000000', 'fill-opacity': 1 }]
    content = {
      type: 'root',
      ...(verticalAlign !== 'top' && { 'vertical-align': verticalAlign }),
      children: [
        {
          type: 'paragraph-set',
          children: paragraphs.map(buildTextParagraphNode),
        },
      ],
    }
  } else {
    // Legacy single-paragraph mode: same structure as before, fully backward-compatible.
    fills = [{ 'fill-color': fillColor, 'fill-opacity': 1 }]
    content = {
      type: 'root',
      ...(verticalAlign !== 'top' && { 'vertical-align': verticalAlign }),
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
    }
  }

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
    ...(opacity !== undefined && { opacity }),
    ...(hidden !== undefined && { hidden }),
    ...(blocked !== undefined && { blocked }),
    ...(blendMode !== undefined && { 'blend-mode': blendMode }),
    ...(constraintsH !== undefined && { 'constraints-h': constraintsH }),
    ...(constraintsV !== undefined && { 'constraints-v': constraintsV }),
    fills,
    shadows: shadows ?? [],
    'grow-type': growType,
    ...layoutItemAttrs(layoutItem),
    content,
  }
}

/**
 * Returns [min, max] values along a single axis for a cubic Bézier from p0 through
 * control points p1/p2 to p3, by finding derivative roots (where dB/dt = 0) and
 * evaluating the curve at t=0, t=1, and any roots in (0,1). Used by `pathBoundingBox`.
 */
function bezierBounds(p0: number, p1: number, p2: number, p3: number): [number, number] {
  // dB/dt = 3[at² + bt + c], coefficients:
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0

  const ts: number[] = [0, 1]
  if (Math.abs(a) > 1e-12) {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc)
      ts.push((-b + sqrtDisc) / (2 * a), (-b - sqrtDisc) / (2 * a))
    }
  } else if (Math.abs(b) > 1e-12) {
    ts.push(-c / b)
  }

  const at = (t: number) =>
    (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3
  const vals = ts.filter((t) => t >= 0 && t <= 1).map(at)
  return [Math.min(...vals), Math.max(...vals)]
}

/**
 * Computes the tight axis-aligned bounding box of a sequence of path commands.
 * Line-to/move-to extrema are exact; curve-to extrema use `bezierBounds` (real
 * cubic roots, not just control-point envelopes). Returns a 1×1 box at the origin
 * for an empty/degenerate path rather than throwing.
 */
function pathBoundingBox(content: PathCommand[]): { x: number; y: number; width: number; height: number } {
  const xs: number[] = []
  const ys: number[] = []
  let curX = 0
  let curY = 0

  for (const cmd of content) {
    if (cmd.command === 'move-to' || cmd.command === 'line-to') {
      xs.push(cmd.params.x)
      ys.push(cmd.params.y)
      curX = cmd.params.x
      curY = cmd.params.y
    } else if (cmd.command === 'curve-to') {
      const { x, y, c1x, c1y, c2x, c2y } = cmd.params
      const [minX, maxX] = bezierBounds(curX, c1x, c2x, x)
      const [minY, maxY] = bezierBounds(curY, c1y, c2y, y)
      xs.push(minX, maxX)
      ys.push(minY, maxY)
      curX = x
      curY = y
    }
    // close-path: no new extrema
  }

  if (xs.length === 0) return { x: 0, y: 0, width: 1, height: 1 }
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(Math.max(...xs) - x, 1), height: Math.max(Math.max(...ys) - y, 1) }
}

/** Ellipse/circle shape. Penpot uses type `circle` internally; the bounding rect (x, y, width, height)
 * defines the ellipse, so width === height gives a true circle. Same fill/stroke/shadow support as
 * `rect`; no corner radii (they don't apply to ellipses). */
export function circle(
  params: BaseParams & {
    fills?: Fill[]
    strokes?: Stroke[]
    shadows?: Shadow[]
  },
): Record<string, unknown> {
  const { id = randomUUID(), name, x, y, width, height, rotation = 0, parentId, frameId, layoutItem, opacity, hidden, blocked, blendMode, constraintsH, constraintsV, fills, strokes, shadows } = params
  return {
    id,
    type: 'circle',
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
    ...(opacity !== undefined && { opacity }),
    ...(hidden !== undefined && { hidden }),
    ...(blocked !== undefined && { blocked }),
    ...(blendMode !== undefined && { 'blend-mode': blendMode }),
    ...(constraintsH !== undefined && { 'constraints-h': constraintsH }),
    ...(constraintsV !== undefined && { 'constraints-v': constraintsV }),
    fills: fills ?? [],
    strokes: strokes ?? [],
    shadows: shadows ?? [],
    ...layoutItemAttrs(layoutItem),
  }
}

/**
 * Free-form path shape. The caller supplies `content` (an array of `PathCommand`s);
 * `x`/`y`/`width`/`height` and all geometry fields are derived automatically from the
 * path's bounding box via `pathBoundingBox` (tight bounds, not just control-point
 * envelopes for curves). Supports fills, strokes, and shadows like `rect`/`circle`.
 *
 * To build an ellipse as a path (e.g. as a boolean operand), approximate it with four
 * cubic Bézier curves using the standard k≈0.5523 constant.
 */
export function path(
  params: Omit<BaseParams, 'x' | 'y' | 'width' | 'height'> & {
    content: PathCommand[]
    fills?: Fill[]
    strokes?: Stroke[]
    shadows?: Shadow[]
  },
): Record<string, unknown> {
  const { id = randomUUID(), name, rotation = 0, parentId, frameId, layoutItem, opacity, hidden, blocked, blendMode, constraintsH, constraintsV, content, fills, strokes, shadows } = params
  const bbox = pathBoundingBox(content)
  const { x, y, width, height } = bbox
  return {
    id,
    type: 'path',
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
    ...(opacity !== undefined && { opacity }),
    ...(hidden !== undefined && { hidden }),
    ...(blocked !== undefined && { blocked }),
    ...(blendMode !== undefined && { 'blend-mode': blendMode }),
    ...(constraintsH !== undefined && { 'constraints-h': constraintsH }),
    ...(constraintsV !== undefined && { 'constraints-v': constraintsV }),
    fills: fills ?? [],
    strokes: strokes ?? [],
    shadows: shadows ?? [],
    content,
    ...layoutItemAttrs(layoutItem),
  }
}

export type BoolType = 'union' | 'difference' | 'intersection' | 'exclusion'

/**
 * Boolean-operation shape. Penpot uses type `bool` with a `bool-type` field for the
 * operation. Children (added via separate `add-obj` changes with `parent-id` pointing at
 * this shape) are the operands; Penpot's editor computes the visual result path from them
 * when the file is opened. The `content` field (the cached result path) is intentionally
 * left empty here — the same way a newly drawn bool in the UI starts before Penpot's
 * browser-side WASM geometry engine has run. Setting `shapes: []` is also correct: Penpot's
 * server-side `add-obj` handler appends each child's id to the parent's `shapes` array
 * when the child's `parent-id` points here (exactly as it does for `frame`).
 *
 * Caller must supply `x`/`y`/`width`/`height` (typically the bounding box of the children).
 */
export function bool(
  params: BaseParams & {
    boolType: BoolType
    fills?: Fill[]
    strokes?: Stroke[]
    shadows?: Shadow[]
  },
): Record<string, unknown> {
  const { id = randomUUID(), name, x, y, width, height, rotation = 0, parentId, frameId, layoutItem, opacity, hidden, blocked, blendMode, constraintsH, constraintsV, boolType, fills, strokes, shadows } = params
  return {
    id,
    type: 'bool',
    'bool-type': boolType,
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
    ...(opacity !== undefined && { opacity }),
    ...(hidden !== undefined && { hidden }),
    ...(blocked !== undefined && { blocked }),
    ...(blendMode !== undefined && { 'blend-mode': blendMode }),
    ...(constraintsH !== undefined && { 'constraints-h': constraintsH }),
    ...(constraintsV !== undefined && { 'constraints-v': constraintsV }),
    fills: fills ?? [],
    strokes: strokes ?? [],
    shadows: shadows ?? [],
    shapes: [],
    content: [],
    ...layoutItemAttrs(layoutItem),
  }
}

/**
 * Group shape. Groups are transparent containers — no fills, strokes, or corner radii of
 * their own. `shapes` carries the ordered child ids. Geometry (x/y/width/height) is normally
 * derived from the children's visible bounding box by Penpot's editor; updating a group's
 * own geometry via `add-obj` only changes the group's stored bounding-box representation —
 * it does NOT move the children (for that, translate each child separately or use
 * `penpot_align_shapes`/`penpot_distribute_shapes`).
 */
export function group(
  params: BaseParams & { shapes?: string[] },
): Record<string, unknown> {
  const { id = randomUUID(), name, x, y, width, height, rotation = 0, parentId, frameId, layoutItem, opacity, hidden, blocked, blendMode, constraintsH, constraintsV, shapes } = params
  return {
    id,
    type: 'group',
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
    ...(opacity !== undefined && { opacity }),
    ...(hidden !== undefined && { hidden }),
    ...(blocked !== undefined && { blocked }),
    ...(blendMode !== undefined && { 'blend-mode': blendMode }),
    ...(constraintsH !== undefined && { 'constraints-h': constraintsH }),
    ...(constraintsV !== undefined && { 'constraints-v': constraintsV }),
    shapes: shapes ?? [],
    ...layoutItemAttrs(layoutItem),
  }
}

/** Metadata for an `image` shape — identifies the Penpot media object being displayed. */
export type ImageMetadata = {
  /** UUID of the Penpot media object (returned by `upload-file-media-object`). */
  id: string
  /** Pixel width of the source image (used for aspect-ratio calculations). */
  width: number
  /** Pixel height of the source image. */
  height: number
  /** MIME type, e.g. `"image/png"` or `"image/jpeg"`. */
  mtype?: string
}

/**
 * Image shape. Penpot uses `type: "image"` with a `metadata` field that identifies the
 * uploaded media object. The shape's `x`/`y`/`width`/`height` control the placement and
 * display size on the canvas; the media object's own dimensions (in `metadata`) are used
 * for aspect-ratio preservation when the user holds Shift while resizing in the UI.
 *
 * The media object must already exist in Penpot (created via `upload-file-media-object`
 * or `create-file-media-object-from-url`). Use `penpot_upload_media` to get the `id`
 * and then pass it here as `metadata.id`.
 */
export function image(
  params: BaseParams & { metadata: ImageMetadata },
): Record<string, unknown> {
  const { id = randomUUID(), name, x, y, width, height, rotation = 0, parentId, frameId, layoutItem, opacity, hidden, blocked, blendMode, constraintsH, constraintsV, metadata } = params
  return {
    id,
    type: 'image',
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
    ...(opacity !== undefined && { opacity }),
    ...(hidden !== undefined && { hidden }),
    ...(blocked !== undefined && { blocked }),
    ...(blendMode !== undefined && { 'blend-mode': blendMode }),
    ...(constraintsH !== undefined && { 'constraints-h': constraintsH }),
    ...(constraintsV !== undefined && { 'constraints-v': constraintsV }),
    fills: [],
    strokes: [],
    shadows: [],
    r1: 0,
    r2: 0,
    r3: 0,
    r4: 0,
    metadata,
    ...layoutItemAttrs(layoutItem),
  }
}

/**
 * Computes the geometry fields (`selrect`, `points`, `transform`, `transform-inverse`) for a
 * shape with the given bounding rectangle and rotation — the same side-effects applied by all
 * shape builders internally. Used by `buildUpdateChange` in `content.ts` to correctly
 * reconstruct geometry for shape types that have no dedicated builder (svg-raw, etc.)
 * when their position or size is patched.
 */
export function computeShapeGeometry(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
): Record<string, unknown> {
  return {
    ...selrectAndPoints({ x, y, width, height }, rotation),
    ...transforms({ x, y, width, height }, rotation),
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
  opacity?: number
  hidden?: boolean
  blocked?: boolean
  blendMode?: string
  fills?: Fill[]
  strokes?: Stroke[]
  shadows?: Shadow[]
  r1?: number
  r2?: number
  r3?: number
  r4?: number
  /** Legacy single-paragraph text fields (from the first paragraph's first leaf). */
  characters?: string
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  /**
   * All paragraphs extracted from the text shape's content tree, in the same format
   * `text()` accepts for its `paragraphs` parameter. Populated for text shapes;
   * undefined for all other types. Used by `buildUpdateChange` to preserve existing
   * rich text when a geometry-only patch is applied.
   */
  paragraphs?: TextParagraph[]
  /**
   * Text shape grow mode (`"auto-width"` | `"auto-height"` | `"fixed"`).
   * Populated for text shapes, undefined for others.
   */
  growType?: string
  /**
   * Vertical alignment of the text block within its box (`"top"` | `"center"` | `"bottom"`).
   * Stored on the content root node; populated for text shapes, undefined for others.
   */
  verticalAlign?: string
  /**
   * Horizontal resize constraint (`constraints-h`): how the shape behaves when its parent
   * frame resizes. `left`/`right`: fix distance to that edge. `leftright`: fix both.
   * `center`: stay centered. `scale`: scale proportionally.
   */
  constraintsH?: string
  /**
   * Vertical resize constraint (`constraints-v`): how the shape behaves when its parent
   * frame resizes. `top`/`bottom`: fix distance to that edge. `topbottom`: fix both.
   * `center`: stay centered. `scale`: scale proportionally.
   */
  constraintsV?: string
}

/**
 * Converts fills from the camelCase format returned by `get-file` into the kebab-case
 * `Fill[]` format the shape builders expect. Shared by `extractEditableFields`
 * (for shape-level fills) and `extractParagraphsFromContent` (for per-paragraph/range fills).
 */
function convertRawFills(
  fillsRaw: Array<{
    fillColor?: string
    fillOpacity?: number
    fillColorGradient?: {
      type: 'linear' | 'radial'
      startX: number
      startY: number
      endX: number
      endY: number
      width: number
      stops: Array<{ color: string; opacity: number; offset: number }>
    }
    fillImage?: {
      id: string
      width: number
      height: number
      mtype: string
      name?: string
      keepAspectRatio?: boolean
    }
  }>,
): Fill[] {
  return fillsRaw.map((f): Fill => {
    if (f.fillColorGradient) {
      const g = f.fillColorGradient
      return {
        'fill-color-gradient': {
          type: g.type,
          'start-x': g.startX,
          'start-y': g.startY,
          'end-x': g.endX,
          'end-y': g.endY,
          width: g.width,
          stops: g.stops,
        },
        ...(f.fillOpacity !== undefined ? { 'fill-opacity': f.fillOpacity } : {}),
      }
    }
    if (f.fillImage) {
      const img = f.fillImage
      return {
        'fill-image': {
          id: img.id,
          width: img.width,
          height: img.height,
          mtype: img.mtype,
          ...(img.name !== undefined ? { name: img.name } : {}),
          ...(img.keepAspectRatio !== undefined ? { 'keep-aspect-ratio': img.keepAspectRatio } : {}),
        },
        ...(f.fillOpacity !== undefined ? { 'fill-opacity': f.fillOpacity } : {}),
      }
    }
    // Default: solid fill
    return { 'fill-color': f.fillColor ?? '#000000', 'fill-opacity': f.fillOpacity ?? 1 }
  })
}

/**
 * Converts a text content tree as returned by `get-file` (camelCase keys) into our
 * `TextParagraph[]` builder format (camelCase TypeScript fields, resolved `Fill[]`).
 * Used by `extractEditableFields` so `buildUpdateChange` can preserve existing rich
 * text when a geometry-only patch is applied.
 */
function extractParagraphsFromContent(content: unknown): TextParagraph[] {
  type RawFillRef = Parameters<typeof convertRawFills>[0][number]
  type RawLeaf = {
    text?: string
    fontFamily?: string
    fontSize?: string
    fontWeight?: string
    fontStyle?: string
    lineHeight?: string
    letterSpacing?: string
    textDecoration?: string
    textTransform?: string
    fills?: RawFillRef[]
  }
  type RawParagraph = RawLeaf & {
    type?: string
    textAlign?: string
    children?: RawLeaf[]
  }
  type RawRoot = { children?: Array<{ children?: RawParagraph[] }> }

  const c = content as RawRoot | undefined
  const paragraphNodes = c?.children?.[0]?.children ?? []

  return paragraphNodes
    .filter((p) => p.type === 'paragraph' || p.type === undefined)
    .map((para): TextParagraph => {
      const paraFillsRaw = (para.fills ?? []) as RawFillRef[]
      return {
        ...(para.textAlign !== undefined && { textAlign: para.textAlign as TextParagraph['textAlign'] }),
        ...(para.fontFamily !== undefined && { fontFamily: para.fontFamily }),
        ...(para.fontSize !== undefined && { fontSize: para.fontSize }),
        ...(para.fontWeight !== undefined && { fontWeight: para.fontWeight }),
        ...(para.fontStyle !== undefined && { fontStyle: para.fontStyle }),
        ...(para.lineHeight !== undefined && { lineHeight: para.lineHeight }),
        ...(para.letterSpacing !== undefined && { letterSpacing: para.letterSpacing }),
        ...(para.textDecoration !== undefined && { textDecoration: para.textDecoration }),
        ...(para.textTransform !== undefined && { textTransform: para.textTransform }),
        ...(paraFillsRaw.length > 0 && { fills: convertRawFills(paraFillsRaw) }),
        ranges: (para.children ?? []).map((leaf): TextRange => {
          const leafFillsRaw = (leaf.fills ?? []) as RawFillRef[]
          return {
            text: leaf.text ?? '',
            ...(leaf.fontFamily !== undefined && { fontFamily: leaf.fontFamily }),
            ...(leaf.fontSize !== undefined && { fontSize: leaf.fontSize }),
            ...(leaf.fontWeight !== undefined && { fontWeight: leaf.fontWeight }),
            ...(leaf.fontStyle !== undefined && { fontStyle: leaf.fontStyle }),
            ...(leaf.lineHeight !== undefined && { lineHeight: leaf.lineHeight }),
            ...(leaf.letterSpacing !== undefined && { letterSpacing: leaf.letterSpacing }),
            ...(leaf.textDecoration !== undefined && { textDecoration: leaf.textDecoration }),
            ...(leaf.textTransform !== undefined && { textTransform: leaf.textTransform }),
            ...(leafFillsRaw.length > 0 && { fills: convertRawFills(leafFillsRaw) }),
          }
        }),
      }
    })
}

/**
 * Reads a shape object back from `get-file` (camelCase) into the field shape the
 * `rect`/`frame`/`text` builders expect (kebab-case keys), for the editable-field
 * subset above. `fills`/`strokes` are read from their camelCase inner keys
 * (`fillColor`/`fillOpacity`, `strokeColor`/etc.) — verified live against a real
 * instance's `get-file` response during the components/variants investigation.
 * For text shapes, all paragraphs and ranges are extracted into `paragraphs` (full
 * fidelity round-trip); the legacy `characters`/`fontFamily`/`fontSize`/`fontWeight`
 * fields are populated from the first paragraph's first leaf for backward compat.
 */
export function extractEditableFields(shape: ShapeNode): EditableShapeFields {
  type RawFill = Parameters<typeof convertRawFills>[0][number]
  const fillsRaw = (shape.fills as RawFill[] | undefined) ?? []
  const fills: Fill[] | undefined = fillsRaw.length > 0 ? convertRawFills(fillsRaw) : undefined

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

  const shadowsRaw =
    (shape.shadows as
      | Array<{
          style: Shadow['style']
          offsetX: number
          offsetY: number
          blur: number
          spread: number
          color: { color: string; opacity: number }
          hidden: boolean
        }>
      | undefined) ?? []
  const shadows: Shadow[] | undefined =
    shadowsRaw.length > 0
      ? shadowsRaw.map((s) => ({
          style: s.style,
          'offset-x': s.offsetX,
          'offset-y': s.offsetY,
          blur: s.blur,
          spread: s.spread,
          color: s.color,
          hidden: s.hidden,
        }))
      : undefined

  const content = shape.content as
    | { verticalAlign?: string; children?: Array<{ children?: Array<{ children?: Array<{ text?: string }>; fontFamily?: string; fontSize?: string; fontWeight?: string }> }> }
    | undefined
  const paragraph = content?.children?.[0]?.children?.[0]
  const leaf = paragraph?.children?.[0]

  // Extract all paragraphs for rich text round-trip fidelity.
  const paragraphs =
    shape.type === 'text' && content !== undefined ? extractParagraphsFromContent(content) : undefined

  return {
    name: shape.name as string,
    x: shape.x as number,
    y: shape.y as number,
    width: shape.width as number,
    height: shape.height as number,
    rotation: (shape.rotation as number) ?? 0,
    opacity: shape.opacity as number | undefined,
    hidden: shape.hidden as boolean | undefined,
    blocked: shape.blocked as boolean | undefined,
    blendMode: (shape as Record<string, unknown>)['blend-mode'] as string | undefined,
    fills,
    strokes,
    shadows,
    r1: shape.r1 as number | undefined,
    r2: shape.r2 as number | undefined,
    r3: shape.r3 as number | undefined,
    r4: shape.r4 as number | undefined,
    // Legacy text fields from first paragraph/leaf:
    characters: leaf?.text,
    fontFamily: paragraph?.fontFamily,
    fontSize: paragraph?.fontSize,
    fontWeight: paragraph?.fontWeight,
    // Rich text round-trip:
    paragraphs,
    growType: ((shape as Record<string, unknown>)['grow-type'] ?? (shape as Record<string, unknown>).growType) as string | undefined,
    verticalAlign: content?.verticalAlign,
    constraintsH: (shape as Record<string, unknown>)['constraints-h'] as string | undefined,
    constraintsV: (shape as Record<string, unknown>)['constraints-v'] as string | undefined,
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

export type DelObjChange = { type: 'del-obj'; id: string; 'page-id': string }

/** Wraps a shape id as a `del-obj` change, removing it (and, per Penpot's own semantics, its descendants). */
export function delObj(pageId: string, shapeId: string): DelObjChange {
  return { type: 'del-obj', id: shapeId, 'page-id': pageId }
}

/**
 * Wraps a shape object exactly as `get-file` returned it (camelCase) back into an
 * `add-obj` change, for restoring a shape verbatim to prior state — e.g. recreating a
 * shape deleted after a checkpoint, or overwriting a shape's current fields back to a
 * snapshotted version. Unlike `buildUpdateChange`/`buildReorderChange` in tools/content.ts
 * (which rebuild an object from scratch via `rect`/`frame`/`text` and only need to strip
 * stale camelCase duplicates), this doesn't reconstruct anything — it round-trips the
 * whole object as-is, so `transform-inverse`/`hide-fill-on-export` must be explicitly
 * renamed from their camelCase form (not just dropped), matching the same fields
 * `penpot_reorder_shapes` was found to require live (see the note there): dropping
 * `transform-inverse` entirely is rejected by Penpot's malli schema (`nil` where a
 * matrix is required).
 */
export function restoreShapeAsAddObj(pageId: string, shape: ShapeNode): AddObjChange {
  const merged: Record<string, unknown> = {
    ...shape,
    'parent-id': (shape.parentId as string | undefined) ?? (shape['parent-id'] as string),
    'frame-id': (shape.frameId as string | undefined) ?? (shape['frame-id'] as string),
    'transform-inverse': shape.transformInverse ?? shape['transform-inverse'],
    'hide-fill-on-export': shape.hideFillOnExport ?? shape['hide-fill-on-export'] ?? false,
  }
  delete merged.parentId
  delete merged.frameId
  delete merged.transformInverse
  delete merged.hideFillOnExport
  delete merged.growType
  return addObj(pageId, merged)
}

/** Where a shape moves to within its parent's `shapes` (z-order) array — see `reorderChildren`. */
export type ReorderAction =
  | { type: 'front' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'backward' }
  | { type: 'before'; targetId: string }
  | { type: 'after'; targetId: string }

/**
 * Computes a parent's new child-order array after moving `shapeId` per `action`,
 * matching Penpot's own z-order semantics: later entries in `shapes` render on top
 * (`front` moves an id to the end of the array, `back` to the start). `forward`/
 * `backward` swap with the next/previous sibling; a shape already at that end is
 * left untouched (no-op) rather than throwing, matching Penpot's own UI behavior
 * when "Bring to front" etc. is pressed on a shape already at the front/back.
 * `before`/`after` place `shapeId` immediately before/after `targetId`.
 *
 * This only computes the new array — the caller still needs to persist it (see
 * `penpot_reorder_shapes` in tools/content.ts, which round-trips the parent shape
 * object through `add-obj` the same way `penpot_update_shapes` already does,
 * rather than trusting the unverified `reorder-children` RPC change or the
 * `mov-objects` RPC already found to be a silent no-op — see the note on
 * `variantContainerAttrs` above).
 */
export function reorderChildren(currentOrder: string[], shapeId: string, action: ReorderAction): string[] {
  const index = currentOrder.indexOf(shapeId)
  if (index === -1) throw new Error(`reorderChildren: shape ${shapeId} is not a child of this parent`)

  const withoutShape = currentOrder.filter((id) => id !== shapeId)

  switch (action.type) {
    case 'front':
      return [...withoutShape, shapeId]
    case 'back':
      return [shapeId, ...withoutShape]
    case 'forward': {
      if (index === currentOrder.length - 1) return currentOrder
      const next = index + 1
      const result = [...currentOrder]
      ;[result[index], result[next]] = [result[next]!, result[index]!]
      return result
    }
    case 'backward': {
      if (index === 0) return currentOrder
      const prev = index - 1
      const result = [...currentOrder]
      ;[result[index], result[prev]] = [result[prev]!, result[index]!]
      return result
    }
    case 'before': {
      if (action.targetId === shapeId) {
        throw new Error('reorderChildren: targetId must not be the same as shapeId')
      }
      const targetIndex = withoutShape.indexOf(action.targetId)
      if (targetIndex === -1) {
        throw new Error(`reorderChildren: target shape ${action.targetId} is not a child of this parent`)
      }
      return [...withoutShape.slice(0, targetIndex), shapeId, ...withoutShape.slice(targetIndex)]
    }
    case 'after': {
      if (action.targetId === shapeId) {
        throw new Error('reorderChildren: targetId must not be the same as shapeId')
      }
      const targetIndex = withoutShape.indexOf(action.targetId)
      if (targetIndex === -1) {
        throw new Error(`reorderChildren: target shape ${action.targetId} is not a child of this parent`)
      }
      return [...withoutShape.slice(0, targetIndex + 1), shapeId, ...withoutShape.slice(targetIndex + 1)]
    }
  }
}

/** The axis-aligned bounding box of one shape, keyed by id — the unit align/distribute operate on. */
export type ShapeBox = { id: string; x1: number; y1: number; x2: number; y2: number }

/** A translation to apply to one shape, keyed by id. Zero-delta entries are omitted by the callers below. */
export type ShapeDelta = { id: string; dx: number; dy: number }

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v'

/**
 * Computes the per-shape translation that aligns every box in `boxes` to a common edge/center,
 * matching Penpot's own align actions. Horizontal edges (`left`/`right`/`center-h`) move shapes
 * along x only; vertical edges (`top`/`bottom`/`center-v`) move along y only. The reference line
 * is taken from the group's own bounding box (the min/max/mid across all boxes), so aligning e.g.
 * `left` snaps every shape's left edge to the leftmost shape's left edge — never moving the group
 * as a whole. Returns one `ShapeDelta` per box whose position actually changes (zero-delta boxes,
 * i.e. shapes already on the reference line, are omitted).
 */
export function computeAlignment(boxes: ShapeBox[], edge: AlignEdge): ShapeDelta[] {
  if (boxes.length < 2) throw new Error('computeAlignment: need at least 2 shapes to align')

  const minX = Math.min(...boxes.map((b) => b.x1))
  const maxX = Math.max(...boxes.map((b) => b.x2))
  const minY = Math.min(...boxes.map((b) => b.y1))
  const maxY = Math.max(...boxes.map((b) => b.y2))
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2

  const deltas: ShapeDelta[] = []
  for (const box of boxes) {
    let dx = 0
    let dy = 0
    switch (edge) {
      case 'left':
        dx = minX - box.x1
        break
      case 'right':
        dx = maxX - box.x2
        break
      case 'center-h':
        dx = midX - (box.x1 + box.x2) / 2
        break
      case 'top':
        dy = minY - box.y1
        break
      case 'bottom':
        dy = maxY - box.y2
        break
      case 'center-v':
        dy = midY - (box.y1 + box.y2) / 2
        break
    }
    if (dx !== 0 || dy !== 0) deltas.push({ id: box.id, dx, dy })
  }
  return deltas
}

export type DistributeAxis = 'horizontal' | 'vertical'

/**
 * Computes the per-shape translation that distributes every box in `boxes` so the gaps BETWEEN
 * adjacent shapes are equal along `axis`, matching Penpot's own "distribute horizontal spacing" /
 * "distribute vertical spacing" actions. The two outermost shapes (by leading edge, then trailing
 * edge) stay put; the shapes in between slide so every gap equals the total free space divided by
 * the number of gaps. Free space can be negative (overlapping shapes), in which case they're spread
 * to an even negative overlap rather than throwing. Needs at least 3 shapes (fewer has nothing to
 * distribute). Returns one `ShapeDelta` per box that actually moves (the two ends, and any interior
 * shape already evenly spaced, are omitted).
 */
export function computeDistribution(boxes: ShapeBox[], axis: DistributeAxis): ShapeDelta[] {
  if (boxes.length < 3) throw new Error('computeDistribution: need at least 3 shapes to distribute')

  const horizontal = axis === 'horizontal'
  const lead = (b: ShapeBox) => (horizontal ? b.x1 : b.y1)
  const trail = (b: ShapeBox) => (horizontal ? b.x2 : b.y2)
  const size = (b: ShapeBox) => trail(b) - lead(b)

  // Sort by leading edge (tie-break on trailing edge) so the outermost shapes are the endpoints.
  const sorted = [...boxes].sort((a, b) => lead(a) - lead(b) || trail(a) - trail(b))
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!

  const span = trail(last) - lead(first)
  const totalSize = sorted.reduce((sum, b) => sum + size(b), 0)
  const gap = (span - totalSize) / (sorted.length - 1)

  const deltas: ShapeDelta[] = []
  let cursor = lead(first)
  for (const box of sorted) {
    const targetLead = cursor
    const delta = targetLead - lead(box)
    if (delta !== 0) {
      deltas.push({ id: box.id, dx: horizontal ? delta : 0, dy: horizontal ? 0 : delta })
    }
    cursor = targetLead + size(box) + gap
  }
  return deltas
}

export type AddPageChange = { type: 'add-page'; id: string; name: string }

export function addPage(name: string, id: string = randomUUID()): AddPageChange {
  return { type: 'add-page', id, name }
}

export type RenamePageChange = { type: 'rename-page'; id: string; name: string }

export function renamePage(id: string, name: string): RenamePageChange {
  return { type: 'rename-page', id, name }
}

export type DelPageChange = { type: 'del-page'; id: string }

export function delPage(id: string): DelPageChange {
  return { type: 'del-page', id }
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

/**
 * Deep-clones a plain shape tree (root + descendants, looked up by id in `objects`)
 * into a fresh copy with new ids, offset by `(dx, dy)`, optionally reparented under
 * `parentId`/`frameId` (defaults to the original root's own parent/frame, i.e. a
 * duplicate placed alongside the source). Unlike `cloneComponentInstance`, this
 * does NOT tag the copy as a component instance — no `shape-ref`/`component-id`/
 * `component-root`/`main-instance` are set or carried over, since this is plain
 * shape duplication (e.g. Penpot's own Ctrl+D), not a component copy. If the
 * source root itself happens to carry component/variant tags (it's a component's
 * main instance or an existing instance), those tags ARE carried over unchanged on
 * the clone, since blanking them would silently detach the duplicate from a
 * component it was actually meant to stay linked to; use
 * `penpot_add_component_instance` instead if a fresh, independent instance is
 * wanted. Returns one `add-obj` change per cloned node, in parent-before-child order.
 */
export function cloneShapes(params: {
  pageId: string
  objects: Record<string, ShapeNode>
  rootId: string
  parentId?: string
  frameId?: string
  dx: number
  dy: number
}): AddObjChange[] {
  const { pageId, objects, rootId, dx, dy } = params
  const changes: AddObjChange[] = []

  const sourceRoot = objects[rootId]
  if (!sourceRoot) throw new Error(`Shape ${rootId} not found in file`)
  const parentId = params.parentId ?? (sourceRoot['parent-id'] as string | undefined) ?? (sourceRoot.parentId as string)
  const frameId = params.frameId ?? (sourceRoot['frame-id'] as string | undefined) ?? (sourceRoot.frameId as string)

  function cloneNode(sourceId: string, newParentId: string, newFrameId: string, newId: string = randomUUID()): string {
    const source = objects[sourceId]
    if (!source) throw new Error(`Shape ${sourceId} not found in file`)

    const obj: Record<string, unknown> = {
      ...source,
      id: newId,
      x: (source.x as number) + dx,
      y: (source.y as number) + dy,
      'parent-id': newParentId,
      'frame-id': newFrameId,
    }
    // Drop camelCase duplicates from the source (get-file returns camelCase; add-obj needs kebab-case).
    delete obj.parentId
    delete obj.frameId
    delete obj.transformInverse

    // Rotation matrices are pivot-relative; a pure translation shifts the pivot by (dx, dy)
    // while the rotation part (a, b, c, d) is unchanged.
    const transform = (source.transform as Matrix) ?? IDENTITY_MATRIX
    const transformInverse =
      (source.transformInverse as Matrix) ?? (source['transform-inverse'] as Matrix) ?? IDENTITY_MATRIX
    obj.transform = { ...transform, e: transform.e + dx, f: transform.f + dy }
    obj['transform-inverse'] = { ...transformInverse, e: transformInverse.e - dx, f: transformInverse.f - dy }

    const selrect = source.selrect as Rect & { x1: number; y1: number; x2: number; y2: number }
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
    const points = (source.points as Point[]) ?? []
    obj.points = points.map((p) => ({ x: p.x + dx, y: p.y + dy }))

    const childIds = source.shapes ?? []
    const isFrame = source.type === 'frame'
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
      cloneNode(childId, newId, isFrame ? newId : newFrameId, childNewIds[i]!)
    })
    return newId
  }

  cloneNode(rootId, parentId, frameId)
  return changes
}
