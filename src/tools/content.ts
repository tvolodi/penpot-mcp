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
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Change, MediaObject, PenpotRpcClient } from '../rpc-client.js'
import {
  addObj,
  addComponent,
  addPage,
  renamePage,
  delPage,
  bool,
  circle,
  cloneComponentInstance,
  cloneShapes as cloneShapesBuilder,
  componentRootAttrs,
  computeAlignment,
  computeDistribution,
  computeShapeGeometry,
  delObj,
  extractEditableFields,
  frame,
  group,
  image,
  path,
  rect,
  reorderChildren,
  restoreShapeAsAddObj,
  text,
  variantContainerAttrs,
  ROOT_FRAME_ID,
  type AlignEdge,
  type BoolType,
  type DistributeAxis,
  type ImageMetadata,
  type Layout,
  type LayoutItem,
  type PathCommand,
  type ReorderAction,
  type ShapeBox,
  type ShapeDelta,
  type ShapeNode,
  type TextParagraph,
  type TextRange,
} from '../shape-builders.js'
import {
  colorValueSchema,
  loadTokenFile,
  numberValueSchema,
  resolveColor,
  resolveRadius,
  resolveShadow,
  resolveSpacing,
  shadowValueSchema,
  type NumberValue,
  type TokenFile,
} from './tokens.js'
import type { ToolDefinition } from './project-files.js'
import { loadFont, measureText, FontFetchError } from '../font-metrics.js'
import { saveCheckpoint, getCheckpoint, deleteCheckpoint } from '../checkpoints.js'

const strokeSchema = z.object({
  color: colorValueSchema,
  opacity: z.number().min(0).max(1).default(1),
  width: z.number().min(0).default(1),
  style: z.enum(['solid', 'dotted', 'dashed', 'mixed']).default('solid'),
  alignment: z.enum(['inner', 'outer', 'center']).default('inner'),
})

// ── Fill schemas ─────────────────────────────────────────────────────────────

/** A single color stop in a gradient fill. `offset` is 0–1 (0 = gradient start, 1 = end). */
const gradientStopSchema = z.object({
  color: colorValueSchema,
  opacity: z.number().min(0).max(1).default(1),
  offset: z.number().min(0).max(1),
})

/**
 * Linear gradient fill. All x/y coordinates are relative to the shape's bounding box
 * (0 = left/top edge, 1 = right/bottom edge). Defaults produce a horizontal
 * left-to-right gradient.
 */
const linearGradientFillSchema = z.object({
  type: z.literal('linear-gradient'),
  /** X-coordinate of the gradient start point (0–1, relative to shape width). Default: 0. */
  startX: z.number().min(0).max(1).default(0),
  /** Y-coordinate of the gradient start point (0–1, relative to shape height). Default: 0.5. */
  startY: z.number().min(0).max(1).default(0.5),
  /** X-coordinate of the gradient end point (0–1). Default: 1. */
  endX: z.number().min(0).max(1).default(1),
  /** Y-coordinate of the gradient end point (0–1). Default: 0.5. */
  endY: z.number().min(0).max(1).default(0.5),
  /** Width of the gradient band perpendicular to the axis (1 = full shape width, the usual default). */
  width: z.number().positive().default(1),
  /** At least 2 color stops ordered by offset. */
  stops: z.array(gradientStopSchema).min(2),
  /** Overall layer opacity (1 = fully opaque). */
  opacity: z.number().min(0).max(1).default(1),
})

/**
 * Radial gradient fill. `startX`/`startY` is the center; `endX`/`endY` determines the
 * radius along the x-axis. Defaults produce a circle gradient centered on the shape.
 */
const radialGradientFillSchema = z.object({
  type: z.literal('radial-gradient'),
  startX: z.number().min(0).max(1).default(0.5),
  startY: z.number().min(0).max(1).default(0.5),
  endX: z.number().min(0).max(1).default(1),
  endY: z.number().min(0).max(1).default(0.5),
  width: z.number().positive().default(1),
  stops: z.array(gradientStopSchema).min(2),
  opacity: z.number().min(0).max(1).default(1),
})

/**
 * Image fill. References a Penpot media object that must already be uploaded to the
 * Penpot instance (via the Penpot UI or a separate upload step). Supply the media
 * object's UUID as `mediaId` along with its pixel dimensions and MIME type.
 */
const imageFillSchema = z.object({
  type: z.literal('image'),
  /** UUID of the already-uploaded Penpot media object. */
  mediaId: z.string().uuid(),
  /** Pixel width of the source image (must match the uploaded media object). */
  mediaWidth: z.number().int().positive(),
  /** Pixel height of the source image. */
  mediaHeight: z.number().int().positive(),
  /** MIME type, e.g. "image/png" or "image/jpeg". Defaults to "image/png". */
  mtype: z.string().default('image/png'),
  /** Optional filename shown in Penpot's asset panel. */
  name: z.string().optional(),
  /** When true, Penpot preserves the image's original aspect ratio within the shape. */
  keepAspectRatio: z.boolean().optional(),
  opacity: z.number().min(0).max(1).default(1),
})

/** Explicit solid fill (use when mixing fills of different types in the same `fills` array). */
const solidFillSchema = z.object({
  type: z.literal('solid'),
  color: colorValueSchema,
  opacity: z.number().min(0).max(1).default(1),
})

/**
 * A single entry in a shape's `fills` array. Discriminated by `type`:
 * - `"solid"` — flat color fill (same as `fillColor`/`fillOpacity` but composable with other types)
 * - `"linear-gradient"` — linear gradient between two or more color stops
 * - `"radial-gradient"` — radial gradient
 * - `"image"` — image fill referencing an already-uploaded Penpot media object
 *
 * When `fills` is provided it overrides `fillColor`/`fillOpacity` entirely.
 */
const fillSpecSchema = z.discriminatedUnion('type', [
  solidFillSchema,
  linearGradientFillSchema,
  radialGradientFillSchema,
  imageFillSchema,
])

const fillsSchema = z.array(fillSpecSchema)

// ─────────────────────────────────────────────────────────────────────────────

const shadowsSchema = z.array(shadowValueSchema)

const cornerRadiiSchema = z.object({
  r1: numberValueSchema.optional(),
  r2: numberValueSchema.optional(),
  r3: numberValueSchema.optional(),
  r4: numberValueSchema.optional(),
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
  p1: numberValueSchema.optional(),
  p2: numberValueSchema.optional(),
  p3: numberValueSchema.optional(),
  p4: numberValueSchema.optional(),
})
const gridTrackSchema = z.object({
  type: z.enum(['fixed', 'percent', 'flex', 'auto']),
  value: numberValueSchema.optional(),
})

const flexLayoutSchema = z.object({
  type: z.literal('flex'),
  dir: z.enum(['row', 'row-reverse', 'column', 'column-reverse']).optional(),
  rowGap: numberValueSchema.optional(),
  columnGap: numberValueSchema.optional(),
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
  rowGap: numberValueSchema.optional(),
  columnGap: numberValueSchema.optional(),
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
      m1: numberValueSchema.optional(),
      m2: numberValueSchema.optional(),
      m3: numberValueSchema.optional(),
      m4: numberValueSchema.optional(),
    })
    .optional(),
  maxWidth: numberValueSchema.optional(),
  maxHeight: numberValueSchema.optional(),
  minWidth: numberValueSchema.optional(),
  minHeight: numberValueSchema.optional(),
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
  /** Overall layer opacity (0-1). 1 = fully opaque. */
  opacity: z.number().min(0).max(1).optional(),
  /** Whether the shape is hidden (eye icon visibility toggle). */
  hidden: z.boolean().optional(),
  /** Whether the shape is locked (lock icon). */
  blocked: z.boolean().optional(),
  /** Blend mode (e.g. 'normal', 'multiply', 'screen', 'overlay'). Defaults to 'normal'. */
  blendMode: z.string().optional(),
  /**
   * Horizontal resize constraint — how this shape behaves when its parent frame resizes.
   * `left`/`right`: fix the distance to that edge. `leftright`: fix both sides (stretch).
   * `center`: stay horizontally centered. `scale`: scale proportionally (default).
   */
  constraintsH: z.enum(['left', 'right', 'leftright', 'center', 'scale']).optional(),
  /**
   * Vertical resize constraint — how this shape behaves when its parent frame resizes.
   * `top`/`bottom`: fix the distance to that edge. `topbottom`: fix both sides (stretch).
   * `center`: stay vertically centered. `scale`: scale proportionally (default).
   */
  constraintsV: z.enum(['top', 'bottom', 'topbottom', 'center', 'scale']).optional(),
}

const rectShapeSchema = z.object({
  type: z.literal('rect'),
  ...baseShapeFields,
  fillColor: colorValueSchema.optional(),
  fillOpacity: z.number().min(0).max(1).default(1),
  /** Explicit fills array (solid, linear-gradient, radial-gradient, or image). When provided,
   * overrides fillColor/fillOpacity. Multiple fills are composited back-to-front. */
  fills: fillsSchema.optional(),
  stroke: strokeSchema.optional(),
  ...cornerRadiiSchema.shape,
  shadows: shadowsSchema.optional(),
})

const frameShapeSchema = z.object({
  type: z.literal('frame'),
  ...baseShapeFields,
  fillColor: colorValueSchema.optional(),
  fillOpacity: z.number().min(0).max(1).default(1),
  /** Explicit fills array (solid, linear-gradient, radial-gradient, or image). When provided,
   * overrides fillColor/fillOpacity. Multiple fills are composited back-to-front. */
  fills: fillsSchema.optional(),
  stroke: strokeSchema.optional(),
  ...cornerRadiiSchema.shape,
  shadows: shadowsSchema.optional(),
  /** Adds flex or grid auto-layout, controlling how this frame's children are positioned. */
  layout: layoutSchema.optional(),
})

// ── Rich text schemas ─────────────────────────────────────────────────────────

/**
 * A single text run (leaf node) within a paragraph. The `text` string is required;
 * all style fields are optional overrides that take precedence over the parent paragraph's
 * defaults. Only specify what differs from the paragraph — unset fields inherit.
 */
const textRangeSchema = z.object({
  /** The characters in this text run. */
  text: z.string(),
  fontFamily: z.string().optional(),
  /** Font size in points, as a string (e.g. `"14"`). */
  fontSize: z.string().optional(),
  /** Font weight as a string (e.g. `"400"`, `"700"`). */
  fontWeight: z.string().optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  /** Line height as a string (e.g. `"1.2"` for 120%). */
  lineHeight: z.string().optional(),
  /** Letter spacing in pixels as a string (e.g. `"0"`, `"1.5"`). */
  letterSpacing: z.string().optional(),
  textDecoration: z.enum(['none', 'underline', 'line-through']).optional(),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize', 'title-case']).optional(),
  /** Shorthand solid fill color for this range; overrides paragraph-level fillColor. */
  fillColor: colorValueSchema.optional(),
  /** Explicit fills for this range (solid, gradient, or image). Overrides fillColor. */
  fills: fillsSchema.optional(),
})

/**
 * A paragraph within a text shape. `textAlign` applies to the whole paragraph.
 * Other style fields are defaults inherited by all `ranges`; individual ranges may
 * override any of them.
 */
const textParagraphSchema = z.object({
  textAlign: z.enum(['left', 'right', 'center', 'justify']).optional(),
  fontFamily: z.string().optional(),
  fontSize: z.string().optional(),
  fontWeight: z.string().optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  lineHeight: z.string().optional(),
  letterSpacing: z.string().optional(),
  textDecoration: z.enum(['none', 'underline', 'line-through']).optional(),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize', 'title-case']).optional(),
  /** Shorthand solid fill color for this paragraph's text. */
  fillColor: colorValueSchema.optional(),
  /** Explicit fills for this paragraph (solid, gradient, or image). Overrides fillColor. */
  fills: fillsSchema.optional(),
  /** One or more text runs within this paragraph. Use multiple entries for per-range styling. */
  ranges: z.array(textRangeSchema).min(1),
})

// ─────────────────────────────────────────────────────────────────────────────

const textShapeSchema = z.object({
  type: z.literal('text'),
  ...baseShapeFields,
  /**
   * Rich text mode: an array of paragraphs, each with its own alignment, typography
   * defaults, and per-range style runs. When `paragraphs` is present, `characters`,
   * `fontFamily`, `fontSize`, `fontWeight`, and `fillColor` are ignored.
   *
   * Each paragraph's top-level style fields are defaults for its `ranges`; individual
   * ranges may override `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`,
   * `lineHeight`, `letterSpacing`, `textDecoration`, `textTransform`, and `fills`/
   * `fillColor`. For a plain text shape with one font/color throughout, a single
   * paragraph with a single range is sufficient.
   */
  paragraphs: z.array(textParagraphSchema).min(1).optional(),
  /** Simple text content (legacy). Ignored when `paragraphs` is present. */
  characters: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.string().optional(),
  fontWeight: z.string().optional(),
  /** Text color (legacy, ignored when `paragraphs` is present or when `paragraphs[].fills` is set). */
  fillColor: colorValueSchema.optional(),
  shadows: shadowsSchema.optional(),
  /**
   * How the text box grows to fit its content. `"auto-width"` (default): box width expands
   * as text grows. `"auto-height"`: width is fixed, height expands. `"fixed"`: both fixed.
   */
  growType: z.enum(['auto-width', 'auto-height', 'fixed']).optional(),
  /** Vertical alignment of text within the bounding box. Default: `"top"`. */
  verticalAlign: z.enum(['top', 'center', 'bottom']).optional(),
})

const pathCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('move-to'), params: z.object({ x: z.number(), y: z.number() }) }),
  z.object({ command: z.literal('line-to'), params: z.object({ x: z.number(), y: z.number() }) }),
  z.object({
    command: z.literal('curve-to'),
    params: z.object({ x: z.number(), y: z.number(), c1x: z.number(), c1y: z.number(), c2x: z.number(), c2y: z.number() }),
  }),
  z.object({ command: z.literal('close-path'), params: z.object({}).optional() }),
])

const circleShapeSchema = z.object({
  type: z.literal('circle'),
  ...baseShapeFields,
  fillColor: colorValueSchema.optional(),
  fillOpacity: z.number().min(0).max(1).default(1),
  /** Explicit fills array (solid, linear-gradient, radial-gradient, or image). When provided,
   * overrides fillColor/fillOpacity. Multiple fills are composited back-to-front. */
  fills: fillsSchema.optional(),
  stroke: strokeSchema.optional(),
  shadows: shadowsSchema.optional(),
})

/** Path shape — x/y/width/height are derived from the content's bounding box, not supplied by the caller. */
const pathShapeSchema = z.object({
  type: z.literal('path'),
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  rotation: z.number().default(0),
  parentId: z.string().default(ROOT_FRAME_ID),
  frameId: z.string().default(ROOT_FRAME_ID),
  layoutItem: layoutItemSchema.optional(),
  /** Overall layer opacity (0-1). 1 = fully opaque. */
  opacity: z.number().min(0).max(1).optional(),
  /** Whether the shape is hidden (eye icon visibility toggle). */
  hidden: z.boolean().optional(),
  /** Whether the shape is locked (lock icon). */
  blocked: z.boolean().optional(),
  /** Blend mode (e.g. 'normal', 'multiply', 'screen', 'overlay'). Defaults to 'normal'. */
  blendMode: z.string().optional(),
  /** Horizontal resize constraint. See `baseShapeFields.constraintsH` for values. */
  constraintsH: z.enum(['left', 'right', 'leftright', 'center', 'scale']).optional(),
  /** Vertical resize constraint. See `baseShapeFields.constraintsV` for values. */
  constraintsV: z.enum(['top', 'bottom', 'topbottom', 'center', 'scale']).optional(),
  /** Ordered path segments. Bounding box (x/y/width/height) is computed automatically. */
  content: z.array(pathCommandSchema).min(1),
  fillColor: colorValueSchema.optional(),
  fillOpacity: z.number().min(0).max(1).default(1),
  /** Explicit fills array (solid, linear-gradient, radial-gradient, or image). When provided,
   * overrides fillColor/fillOpacity. */
  fills: fillsSchema.optional(),
  stroke: strokeSchema.optional(),
  shadows: shadowsSchema.optional(),
})

const boolShapeSchema = z.object({
  type: z.literal('bool'),
  ...baseShapeFields,
  /**
   * The boolean operation to apply to this shape's children (added as separate shapes
   * with `parentId` matching this shape's `id`). "union" merges all children;
   * "difference" subtracts subsequent children from the first; "intersection" keeps
   * only the overlapping region; "exclusion" keeps non-overlapping regions.
   * Penpot's editor computes the visual result path when the file is opened.
   */
  boolType: z.enum(['union', 'difference', 'intersection', 'exclusion']),
  fillColor: colorValueSchema.optional(),
  fillOpacity: z.number().min(0).max(1).default(1),
  /** Explicit fills array (solid, linear-gradient, radial-gradient, or image). When provided,
   * overrides fillColor/fillOpacity. */
  fills: fillsSchema.optional(),
  stroke: strokeSchema.optional(),
  shadows: shadowsSchema.optional(),
})

/**
 * Image shape. Displays a media object (photo, icon, SVG art) that was previously uploaded
 * with `penpot_upload_media`. The shape's x/y/width/height control the canvas placement
 * and display size; `mediaWidth`/`mediaHeight` are the source image's original pixel
 * dimensions (returned by `penpot_upload_media`) and are stored in Penpot's `metadata`
 * field for aspect-ratio calculations. To resize the image on canvas without distorting
 * it, set width/height proportionally to mediaWidth/mediaHeight.
 */
const imageShapeSchema = z.object({
  type: z.literal('image'),
  ...baseShapeFields,
  /** UUID of the uploaded Penpot media object (from `penpot_upload_media`'s `id` field). */
  mediaId: z.string().uuid(),
  /** Source image pixel width (from `penpot_upload_media`'s `width` field). */
  mediaWidth: z.number().int().positive(),
  /** Source image pixel height (from `penpot_upload_media`'s `height` field). */
  mediaHeight: z.number().int().positive(),
  /** MIME type (from `penpot_upload_media`'s `mtype` field). Defaults to "image/png". */
  mtype: z.string().default('image/png'),
})

const shapeSpecSchema = z.discriminatedUnion('type', [
  rectShapeSchema,
  frameShapeSchema,
  textShapeSchema,
  circleShapeSchema,
  pathShapeSchema,
  boolShapeSchema,
  imageShapeSchema,
])
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

function resolveShadows(specs: z.infer<typeof shadowsSchema> | undefined, tokens: TokenFile) {
  if (!specs) return undefined
  return specs.map((spec) => {
    const shadow = resolveShadow(spec, tokens)
    return {
      style: shadow.style,
      'offset-x': shadow.offsetX,
      'offset-y': shadow.offsetY,
      blur: shadow.blur,
      spread: shadow.spread,
      color: { color: resolveColor(shadow.color, tokens), opacity: shadow.opacity },
      hidden: false,
    }
  })
}

/**
 * Resolves a single fill spec (solid / linear-gradient / radial-gradient / image) into the
 * kebab-case wire format Penpot's `update-file` / `add-obj` expects. Stop colors may be
 * token references — they are resolved against the token file's `colors` table.
 */
function resolveFill(spec: z.infer<typeof fillSpecSchema>, tokens: TokenFile): import('../shape-builders.js').Fill {
  if (spec.type === 'solid') {
    return { 'fill-color': resolveColor(spec.color, tokens), 'fill-opacity': spec.opacity }
  }
  if (spec.type === 'linear-gradient' || spec.type === 'radial-gradient') {
    return {
      'fill-color-gradient': {
        type: spec.type === 'linear-gradient' ? 'linear' : 'radial',
        'start-x': spec.startX,
        'start-y': spec.startY,
        'end-x': spec.endX,
        'end-y': spec.endY,
        width: spec.width,
        stops: spec.stops.map((stop) => ({
          color: resolveColor(stop.color, tokens),
          opacity: stop.opacity,
          offset: stop.offset,
        })),
      },
      'fill-opacity': spec.opacity,
    }
  }
  // image
  return {
    'fill-image': {
      id: spec.mediaId,
      width: spec.mediaWidth,
      height: spec.mediaHeight,
      mtype: spec.mtype,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      ...(spec.keepAspectRatio !== undefined ? { 'keep-aspect-ratio': spec.keepAspectRatio } : {}),
    },
    'fill-opacity': spec.opacity,
  }
}

/** Resolves a `fills` array (when provided by the caller) into the wire-format fills array. */
function resolveFillSpecs(specs: z.infer<typeof fillsSchema> | undefined, tokens: TokenFile) {
  if (!specs) return undefined
  return specs.map((spec) => resolveFill(spec, tokens))
}

/**
 * Resolves token references in a single text range's fill fields and returns a `TextRange`
 * with resolved `Fill[]` ready for the `text()` builder.
 */
function resolveTextRange(range: z.infer<typeof textRangeSchema>, tokens: TokenFile): TextRange {
  return {
    text: range.text,
    ...(range.fontFamily !== undefined && { fontFamily: range.fontFamily }),
    ...(range.fontSize !== undefined && { fontSize: range.fontSize }),
    ...(range.fontWeight !== undefined && { fontWeight: range.fontWeight }),
    ...(range.fontStyle !== undefined && { fontStyle: range.fontStyle }),
    ...(range.lineHeight !== undefined && { lineHeight: range.lineHeight }),
    ...(range.letterSpacing !== undefined && { letterSpacing: range.letterSpacing }),
    ...(range.textDecoration !== undefined && { textDecoration: range.textDecoration }),
    ...(range.textTransform !== undefined && { textTransform: range.textTransform }),
    fills: range.fills
      ? resolveFillSpecs(range.fills, tokens)
      : range.fillColor !== undefined
        ? [{ 'fill-color': resolveColor(range.fillColor, tokens), 'fill-opacity': 1 }]
        : undefined,
  }
}

/**
 * Resolves token references in a paragraphs array (fill colors, spacing tokens) and returns
 * a `TextParagraph[]` ready for the `text()` builder.
 */
function resolveParagraphsForBuilder(
  paragraphs: z.infer<typeof textParagraphSchema>[],
  tokens: TokenFile,
): TextParagraph[] {
  return paragraphs.map((para): TextParagraph => ({
    ...(para.textAlign !== undefined && { textAlign: para.textAlign }),
    ...(para.fontFamily !== undefined && { fontFamily: para.fontFamily }),
    ...(para.fontSize !== undefined && { fontSize: para.fontSize }),
    ...(para.fontWeight !== undefined && { fontWeight: para.fontWeight }),
    ...(para.fontStyle !== undefined && { fontStyle: para.fontStyle }),
    ...(para.lineHeight !== undefined && { lineHeight: para.lineHeight }),
    ...(para.letterSpacing !== undefined && { letterSpacing: para.letterSpacing }),
    ...(para.textDecoration !== undefined && { textDecoration: para.textDecoration }),
    ...(para.textTransform !== undefined && { textTransform: para.textTransform }),
    fills: para.fills
      ? resolveFillSpecs(para.fills, tokens)
      : para.fillColor !== undefined
        ? [{ 'fill-color': resolveColor(para.fillColor, tokens), 'fill-opacity': 1 }]
        : undefined,
    ranges: para.ranges.map((range) => resolveTextRange(range, tokens)),
  }))
}

/** Resolves every `NumberValue` (raw number or `{ token: "name" }`) field on a padding/margin-shaped
 * object (p1-p4 or m1-m4) against the token file's `spacing` table. */
function resolveSpacingFields<K extends string>(
  spec: Partial<Record<K, NumberValue>> | undefined,
  tokens: TokenFile,
): Partial<Record<K, number>> | undefined {
  if (!spec) return undefined
  const resolved: Partial<Record<K, number>> = {}
  for (const key of Object.keys(spec) as K[]) {
    resolved[key] = resolveSpacing(spec[key], tokens)
  }
  return resolved
}

function resolveLayout(layout: z.infer<typeof layoutSchema> | undefined, tokens: TokenFile): Layout | undefined {
  if (!layout) return undefined
  const rowGap = resolveSpacing(layout.rowGap, tokens)
  const columnGap = resolveSpacing(layout.columnGap, tokens)
  const padding = resolveSpacingFields(layout.padding, tokens)
  if (layout.type === 'grid') {
    return {
      ...layout,
      rowGap,
      columnGap,
      padding,
      rows: layout.rows?.map((track) => ({ ...track, value: resolveSpacing(track.value, tokens) })),
      columns: layout.columns?.map((track) => ({ ...track, value: resolveSpacing(track.value, tokens) })),
    }
  }
  return { ...layout, rowGap, columnGap, padding }
}

function resolveLayoutItem(item: z.infer<typeof layoutItemSchema> | undefined, tokens: TokenFile) {
  if (!item) return undefined
  return {
    ...item,
    margin: resolveSpacingFields(item.margin, tokens),
    maxWidth: resolveSpacing(item.maxWidth, tokens),
    maxHeight: resolveSpacing(item.maxHeight, tokens),
    minWidth: resolveSpacing(item.minWidth, tokens),
    minHeight: resolveSpacing(item.minHeight, tokens),
  }
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
        layoutItem: resolveLayoutItem(spec.layoutItem, tokens),
        constraintsH: spec.constraintsH,
        constraintsV: spec.constraintsV,
        fills: spec.fills
          ? resolveFillSpecs(spec.fills, tokens)
          : spec.fillColor
            ? [{ 'fill-color': resolveColor(spec.fillColor, tokens), 'fill-opacity': spec.fillOpacity }]
            : undefined,
        strokes: resolveStroke(spec.stroke, tokens),
        shadows: resolveShadows(spec.shadows, tokens),
        r1: resolveRadius(spec.r1, tokens),
        r2: resolveRadius(spec.r2, tokens),
        r3: resolveRadius(spec.r3, tokens),
        r4: resolveRadius(spec.r4, tokens),
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
        layoutItem: resolveLayoutItem(spec.layoutItem, tokens),
        layout: resolveLayout(spec.layout, tokens),
        constraintsH: spec.constraintsH,
        constraintsV: spec.constraintsV,
        fills: spec.fills
          ? resolveFillSpecs(spec.fills, tokens)
          : spec.fillColor
            ? [{ 'fill-color': resolveColor(spec.fillColor, tokens), 'fill-opacity': spec.fillOpacity }]
            : undefined,
        strokes: resolveStroke(spec.stroke, tokens),
        shadows: resolveShadows(spec.shadows, tokens),
        r1: resolveRadius(spec.r1, tokens),
        r2: resolveRadius(spec.r2, tokens),
        r3: resolveRadius(spec.r3, tokens),
        r4: resolveRadius(spec.r4, tokens),
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
        layoutItem: resolveLayoutItem(spec.layoutItem, tokens),
        constraintsH: spec.constraintsH,
        constraintsV: spec.constraintsV,
        paragraphs: spec.paragraphs ? resolveParagraphsForBuilder(spec.paragraphs, tokens) : undefined,
        characters: spec.characters,
        fontFamily: spec.fontFamily,
        fontSize: spec.fontSize,
        fontWeight: spec.fontWeight,
        fillColor: spec.fillColor ? resolveColor(spec.fillColor, tokens) : undefined,
        shadows: resolveShadows(spec.shadows, tokens),
        growType: spec.growType,
        verticalAlign: spec.verticalAlign,
      })
    case 'circle':
      return circle({
        id: spec.id,
        name: spec.name,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        rotation: spec.rotation,
        parentId: spec.parentId,
        frameId: spec.frameId,
        layoutItem: resolveLayoutItem(spec.layoutItem, tokens),
        constraintsH: spec.constraintsH,
        constraintsV: spec.constraintsV,
        fills: spec.fills
          ? resolveFillSpecs(spec.fills, tokens)
          : spec.fillColor
            ? [{ 'fill-color': resolveColor(spec.fillColor, tokens), 'fill-opacity': spec.fillOpacity }]
            : undefined,
        strokes: resolveStroke(spec.stroke, tokens),
        shadows: resolveShadows(spec.shadows, tokens),
      })
    case 'path':
      return path({
        id: spec.id,
        name: spec.name,
        rotation: spec.rotation,
        parentId: spec.parentId,
        frameId: spec.frameId,
        layoutItem: resolveLayoutItem(spec.layoutItem, tokens),
        constraintsH: spec.constraintsH,
        constraintsV: spec.constraintsV,
        content: spec.content as PathCommand[],
        fills: spec.fills
          ? resolveFillSpecs(spec.fills, tokens)
          : spec.fillColor
            ? [{ 'fill-color': resolveColor(spec.fillColor, tokens), 'fill-opacity': spec.fillOpacity }]
            : undefined,
        strokes: resolveStroke(spec.stroke, tokens),
        shadows: resolveShadows(spec.shadows, tokens),
      })
    case 'bool':
      return bool({
        id: spec.id,
        name: spec.name,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        rotation: spec.rotation,
        parentId: spec.parentId,
        frameId: spec.frameId,
        layoutItem: resolveLayoutItem(spec.layoutItem, tokens),
        constraintsH: spec.constraintsH,
        constraintsV: spec.constraintsV,
        boolType: spec.boolType as BoolType,
        fills: spec.fills
          ? resolveFillSpecs(spec.fills, tokens)
          : spec.fillColor
            ? [{ 'fill-color': resolveColor(spec.fillColor, tokens), 'fill-opacity': spec.fillOpacity }]
            : undefined,
        strokes: resolveStroke(spec.stroke, tokens),
        shadows: resolveShadows(spec.shadows, tokens),
      })
    case 'image':
      return image({
        id: spec.id,
        name: spec.name,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        rotation: spec.rotation,
        parentId: spec.parentId,
        frameId: spec.frameId,
        layoutItem: resolveLayoutItem(spec.layoutItem, tokens),
        constraintsH: spec.constraintsH,
        constraintsV: spec.constraintsV,
        metadata: { id: spec.mediaId, width: spec.mediaWidth, height: spec.mediaHeight, mtype: spec.mtype },
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

const listPagesInput = z.object({
  fileId: z.string().min(1),
})

const listPages: ToolDefinition<z.infer<typeof listPagesInput>> = {
  name: 'penpot_list_pages',
  description: 'List all pages in a Penpot file, returning each page\'s id and name in order.',
  inputSchema: listPagesInput,
  handler: async (client, { fileId }) => {
    const file = await client.getFile(fileId)
    const pages = file.data.pages.map((id) => ({
      id,
      name: file.data.pagesIndex[id]?.name ?? id,
    }))
    return { pages }
  },
}

const renamePageInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  name: z.string().min(1),
})

const renamePageTool: ToolDefinition<z.infer<typeof renamePageInput>> = {
  name: 'penpot_rename_page',
  description: 'Rename an existing page in a Penpot file.',
  inputSchema: renamePageInput,
  handler: async (client, { fileId, pageId, name }) => {
    const file = await client.getFile(fileId)
    if (!file.data.pagesIndex[pageId]) {
      throw new Error(`penpot_rename_page: page ${pageId} not found in file ${fileId}`)
    }
    const result = await client.updateFile(fileId, file.revn, file.vern, [renamePage(pageId, name)])
    return { pageId, name, revn: result.revn }
  },
}

const deletePageInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
})

const deletePageTool: ToolDefinition<z.infer<typeof deletePageInput>> = {
  name: 'penpot_delete_page',
  description: 'Delete a page from a Penpot file. The file must have at least two pages; deleting the last page is not allowed.',
  inputSchema: deletePageInput,
  handler: async (client, { fileId, pageId }) => {
    const file = await client.getFile(fileId)
    if (!file.data.pagesIndex[pageId]) {
      throw new Error(`penpot_delete_page: page ${pageId} not found in file ${fileId}`)
    }
    if (file.data.pages.length < 2) {
      throw new Error(`penpot_delete_page: cannot delete the last page of a file`)
    }
    const result = await client.updateFile(fileId, file.revn, file.vern, [delPage(pageId)])
    return { deleted: pageId, revn: result.revn }
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
      'Add one or more shapes (rect, frame, text, circle, path, bool, image) to a page in a Penpot file. ' +
      '"circle" is an ellipse bounded by x/y/width/height (width === height for a true circle). ' +
      '"path" takes a "content" array of path commands ({ command: "move-to"|"line-to"|"curve-to"|"close-path", params: {x,y,...} }); ' +
      'its bounding box is derived automatically from the commands. ' +
      '"bool" is a boolean operation (boolType: "union"|"difference"|"intersection"|"exclusion") over its ' +
      'children — add the bool shape first (with an explicit "id"), then add children with "parentId" matching ' +
      'that id (same pattern as frames); Penpot\'s editor computes the visual result when the file is opened. ' +
      '"image" displays an uploaded media object — first call penpot_upload_media to get a mediaId, then ' +
      'provide mediaId/mediaWidth/mediaHeight (source pixel dimensions) along with x/y/width/height for the ' +
      'canvas placement. ' +
      'Colors accept either a literal hex string or a { token: "name" } reference resolved against the project ' +
      'token file; the same applies to numeric spacing/radius fields (layout gaps/padding, layoutItem ' +
      'margins/min/max sizes, corner radii r1-r4), resolved against the token file\'s "spacing"/"radii" tables, ' +
      'and to a shape\'s "shadows" array (each entry either an inline { style, color, opacity, offsetX, offsetY, ' +
      'blur, spread } object or a { token: "name" } reference into the token file\'s "shadows" table). Shapes ' +
      'may be rotated via the "rotation" field (degrees, clockwise, about the shape\'s center). Frames may ' +
      'declare flex or grid auto-layout via "layout"; any shape may set "layoutItem" to control its own ' +
      'placement within an auto-layout parent (sizing, alignment, margins, and, for grid parents, row/column).',
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

const shapePatchSchema = z.object({
  shapeId: z.string().min(1),
  name: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  rotation: z.number().optional(),
  /** Overall layer opacity (0-1). 1 = fully opaque. */
  opacity: z.number().min(0).max(1).optional(),
  /** Whether the shape is hidden (eye icon visibility toggle). */
  hidden: z.boolean().optional(),
  /** Whether the shape is locked (lock icon). */
  blocked: z.boolean().optional(),
  /** Blend mode (e.g. 'normal', 'multiply', 'screen', 'overlay'). */
  blendMode: z.string().optional(),
  fillColor: colorValueSchema.optional(),
  fillOpacity: z.number().min(0).max(1).optional(),
  /** Explicit fills array (solid, linear-gradient, radial-gradient, or image). When provided,
   * overrides fillColor/fillOpacity entirely. Pass an empty array to clear all fills. */
  fills: fillsSchema.optional(),
  stroke: strokeSchema.optional(),
  /** Removes all strokes from the shape. Ignored if `stroke` is also given. */
  clearStroke: z.boolean().optional(),
  ...cornerRadiiSchema.shape,
  shadows: shadowsSchema.optional(),
  /** Removes all shadows from the shape. Ignored if `shadows` is also given. */
  clearShadows: z.boolean().optional(),
  /** Text shapes only: replaces the shape's text content/font. Ignored for other types. */
  characters: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.string().optional(),
  fontWeight: z.string().optional(),
  /**
   * Text shapes only: replaces the shape's entire text content with rich per-paragraph/
   * per-range styling. When provided, `characters`/`fontFamily`/`fontSize`/`fontWeight`
   * and `fillColor` are ignored. Each paragraph may have its own `textAlign`, typography
   * defaults, and an array of `ranges` for per-run formatting.
   */
  paragraphs: z.array(textParagraphSchema).min(1).optional(),
  /** Text shapes only: how the text box grows to fit content (`"auto-width"` | `"auto-height"` | `"fixed"`). */
  growType: z.enum(['auto-width', 'auto-height', 'fixed']).optional(),
  /** Text shapes only: vertical alignment of the text block within its box. */
  verticalAlign: z.enum(['top', 'center', 'bottom']).optional(),
  /** Path shapes only: replaces the path's geometry (and automatically recomputes its bounding box).
   * Ignored for non-path shapes. x/y/width/height are always derived from path content and cannot
   * be set independently for path shapes. */
  content: z.array(pathCommandSchema).optional(),
  /** Bool shapes only: replaces the boolean operation type. Ignored for non-bool shapes. */
  boolType: z.enum(['union', 'difference', 'intersection', 'exclusion']).optional(),
  /** Image shapes only: replaces the media object being displayed. Ignored for non-image shapes.
   * Obtain the UUID by calling `penpot_upload_media` first. */
  mediaId: z.string().uuid().optional(),
  /** Image shapes only: source pixel width of the replacement media object. */
  mediaWidth: z.number().int().positive().optional(),
  /** Image shapes only: source pixel height of the replacement media object. */
  mediaHeight: z.number().int().positive().optional(),
  /** Image shapes only: MIME type of the replacement media object (e.g. "image/png"). */
  mtype: z.string().optional(),
  /**
   * Horizontal resize constraint — how this shape behaves when its parent frame resizes.
   * `left`/`right`: fix the distance to that edge. `leftright`: fix both sides (stretch).
   * `center`: stay horizontally centered. `scale`: scale proportionally.
   */
  constraintsH: z.enum(['left', 'right', 'leftright', 'center', 'scale']).optional(),
  /**
   * Vertical resize constraint — how this shape behaves when its parent frame resizes.
   * `top`/`bottom`: fix the distance to that edge. `topbottom`: fix both sides (stretch).
   * `center`: stay vertically centered. `scale`: scale proportionally.
   */
  constraintsV: z.enum(['top', 'bottom', 'topbottom', 'center', 'scale']).optional(),
  /** Frame shapes only: sets or replaces the frame's auto-layout (flex or grid). To remove layout,
   * pass null (not currently supported — create a new frame without layout instead). */
  layout: layoutSchema.optional(),
  /** Any shape: sets or replaces the shape's placement within its parent auto-layout frame.
   * When provided, fully replaces any existing layoutItem attrs on the shape. */
  layoutItem: layoutItemSchema.optional(),
})

type ShapePatch = z.infer<typeof shapePatchSchema>

/**
 * Builds the `add-obj` change that applies `patch` on top of `existing`, shared by
 * `penpot_update_shapes` and `penpot_batch`. Supports rect, frame, text, circle, bool, path,
 * group, and image; falls back to a generic geometry-only rebuild for svg-raw and any other
 * type. See the note on `merged` below for why stale camelCase duplicates of fields `obj`
 * recomputes must be deleted explicitly.
 */
function buildUpdateChange(
  pageId: string,
  patch: ShapePatch,
  existing: ShapeNode,
  tokens: TokenFile,
  toolName: string,
): ReturnType<typeof addObj> {
  const current = extractEditableFields(existing)

  // Resolved layoutItem — if provided in the patch, fully replaces the existing layoutItem
  // attrs on the rebuilt `obj`; if absent, the existing camelCase layoutItem fields in
  // `existing` are carried forward by the `{ ...existing, ...obj }` merge below (Penpot
  // accepts camelCase keys on the update-file input alongside kebab-case ones).
  const resolvedLayoutItem: LayoutItem | undefined = patch.layoutItem
    ? (resolveLayoutItem(patch.layoutItem, tokens) as LayoutItem)
    : undefined

  const parentId = (existing.parentId as string | undefined) ?? (existing['parent-id'] as string)
  const frameId = (existing.frameId as string | undefined) ?? (existing['frame-id'] as string)

  const mergedFills =
    patch.fills !== undefined
      ? resolveFillSpecs(patch.fills, tokens)
      : patch.fillColor !== undefined
        ? [{ 'fill-color': resolveColor(patch.fillColor, tokens), 'fill-opacity': patch.fillOpacity ?? 1 }]
        : current.fills
  const mergedStrokes = patch.stroke ? resolveStroke(patch.stroke, tokens) : patch.clearStroke ? [] : current.strokes
  const mergedShadows = patch.shadows ? resolveShadows(patch.shadows, tokens) : patch.clearShadows ? [] : current.shadows

  const mergedFields = {
    id: patch.shapeId,
    name: patch.name ?? current.name,
    x: patch.x ?? current.x,
    y: patch.y ?? current.y,
    width: patch.width ?? current.width,
    height: patch.height ?? current.height,
    rotation: patch.rotation ?? current.rotation,
    parentId,
    frameId,
    opacity: patch.opacity !== undefined ? patch.opacity : current.opacity,
    hidden: patch.hidden !== undefined ? patch.hidden : current.hidden,
    blocked: patch.blocked !== undefined ? patch.blocked : current.blocked,
    blendMode: patch.blendMode !== undefined ? patch.blendMode : current.blendMode,
    fills: mergedFills,
    strokes: mergedStrokes,
    shadows: mergedShadows,
    r1: patch.r1 !== undefined ? resolveRadius(patch.r1, tokens) : current.r1,
    r2: patch.r2 !== undefined ? resolveRadius(patch.r2, tokens) : current.r2,
    r3: patch.r3 !== undefined ? resolveRadius(patch.r3, tokens) : current.r3,
    r4: patch.r4 !== undefined ? resolveRadius(patch.r4, tokens) : current.r4,
    layoutItem: resolvedLayoutItem,
    constraintsH: patch.constraintsH !== undefined ? patch.constraintsH : current.constraintsH as 'left' | 'right' | 'leftright' | 'center' | 'scale' | undefined,
    constraintsV: patch.constraintsV !== undefined ? patch.constraintsV : current.constraintsV as 'top' | 'bottom' | 'topbottom' | 'center' | 'scale' | undefined,
  }

  let obj: Record<string, unknown>
  if (existing.type === 'frame') {
    obj = frame({
      ...mergedFields,
      layout: patch.layout !== undefined ? resolveLayout(patch.layout, tokens) : undefined,
    })
    obj.shapes = existing.shapes ?? []
  } else if (existing.type === 'text') {
    // Resolve grow-type and vertical-align: patch overrides current; current falls back from existing.
    const resolvedGrowType = patch.growType ?? current.growType
    const resolvedVerticalAlign = patch.verticalAlign ?? current.verticalAlign

    if (patch.paragraphs) {
      // Rich text patch: replace entire content with resolved paragraphs.
      obj = text({
        ...mergedFields,
        paragraphs: resolveParagraphsForBuilder(patch.paragraphs, tokens),
        growType: resolvedGrowType as 'auto-width' | 'auto-height' | 'fixed' | undefined,
        verticalAlign: resolvedVerticalAlign as 'top' | 'center' | 'bottom' | undefined,
      })
    } else if (current.paragraphs && !patch.characters && patch.fontFamily === undefined && patch.fontSize === undefined && patch.fontWeight === undefined) {
      // No text content fields in the patch and the existing shape has rich text — preserve it.
      obj = text({
        ...mergedFields,
        paragraphs: current.paragraphs,
        growType: resolvedGrowType as 'auto-width' | 'auto-height' | 'fixed' | undefined,
        verticalAlign: resolvedVerticalAlign as 'top' | 'center' | 'bottom' | undefined,
      })
    } else {
      // Legacy mode: single-paragraph content built from characters/font fields.
      obj = text({
        ...mergedFields,
        characters: patch.characters ?? current.characters ?? '',
        fontFamily: patch.fontFamily ?? current.fontFamily,
        fontSize: patch.fontSize ?? current.fontSize,
        fontWeight: patch.fontWeight ?? current.fontWeight,
        growType: resolvedGrowType as 'auto-width' | 'auto-height' | 'fixed' | undefined,
        verticalAlign: resolvedVerticalAlign as 'top' | 'center' | 'bottom' | undefined,
      })
    }
  } else if (existing.type === 'rect') {
    obj = rect(mergedFields)
  } else if (existing.type === 'circle') {
    obj = circle(mergedFields)
  } else if (existing.type === 'bool') {
    const boolType = (patch.boolType ?? (existing['bool-type'] as BoolType | undefined) ?? 'union') as BoolType
    obj = bool({ ...mergedFields, boolType })
    obj.shapes = existing.shapes ?? []
  } else if (existing.type === 'path') {
    // Path geometry (x/y/width/height) is always derived from path content — direct x/y/width/height
    // patches are ignored. Provide new `content` in the patch to relocate or reshape the path.
    const pathContent = (patch.content as PathCommand[] | undefined) ?? (existing.content as PathCommand[] | undefined) ?? []
    obj = path({
      id: patch.shapeId,
      name: patch.name ?? current.name,
      rotation: patch.rotation ?? current.rotation,
      parentId,
      frameId,
      opacity: patch.opacity !== undefined ? patch.opacity : current.opacity,
      hidden: patch.hidden !== undefined ? patch.hidden : current.hidden,
      blocked: patch.blocked !== undefined ? patch.blocked : current.blocked,
      blendMode: patch.blendMode !== undefined ? patch.blendMode : current.blendMode,
      content: pathContent,
      fills: mergedFills,
      strokes: mergedStrokes,
      shadows: mergedShadows,
      layoutItem: resolvedLayoutItem,
    })
  } else if (existing.type === 'group') {
    // Groups are transparent containers — no fills, strokes, or corner radii.
    // Updating a group's x/y/width/height here only adjusts the group's own stored bounding box;
    // child shapes keep their existing absolute positions. To move a group as a unit, use
    // penpot_align_shapes or translate each child individually.
    obj = group({
      id: patch.shapeId,
      name: patch.name ?? current.name,
      x: patch.x ?? current.x,
      y: patch.y ?? current.y,
      width: patch.width ?? current.width,
      height: patch.height ?? current.height,
      rotation: patch.rotation ?? current.rotation,
      parentId,
      frameId,
      opacity: patch.opacity !== undefined ? patch.opacity : current.opacity,
      hidden: patch.hidden !== undefined ? patch.hidden : current.hidden,
      blocked: patch.blocked !== undefined ? patch.blocked : current.blocked,
      blendMode: patch.blendMode !== undefined ? patch.blendMode : current.blendMode,
      shapes: existing.shapes ?? [],
      layoutItem: resolvedLayoutItem,
    })
  } else if (existing.type === 'image') {
    // Image shapes: rebuild geometry and carry over (or replace) the media metadata.
    // `metadata` comes back from get-file as a plain object with id/width/height/mtype
    // at the same keys in both camelCase and kebab-case (no conversion needed).
    const existingMeta = existing.metadata as ImageMetadata | undefined
    const metadata: ImageMetadata = {
      id: patch.mediaId ?? existingMeta?.id ?? '',
      width: patch.mediaWidth ?? existingMeta?.width ?? 0,
      height: patch.mediaHeight ?? existingMeta?.height ?? 0,
      mtype: patch.mtype ?? existingMeta?.mtype,
    }
    obj = image({
      id: patch.shapeId,
      name: patch.name ?? current.name,
      x: patch.x ?? current.x,
      y: patch.y ?? current.y,
      width: patch.width ?? current.width,
      height: patch.height ?? current.height,
      rotation: patch.rotation ?? current.rotation,
      parentId,
      frameId,
      opacity: patch.opacity !== undefined ? patch.opacity : current.opacity,
      hidden: patch.hidden !== undefined ? patch.hidden : current.hidden,
      blocked: patch.blocked !== undefined ? patch.blocked : current.blocked,
      blendMode: patch.blendMode !== undefined ? patch.blendMode : current.blendMode,
      layoutItem: resolvedLayoutItem,
      metadata,
    })
  } else {
    // Generic fallback for svg-raw and any other type. Rebuilds geometry and common
    // fields (name, fills, strokes, shadows); type-specific fields are preserved via the
    // `{ ...existing, ...obj }` merge below.
    const x = patch.x ?? current.x
    const y = patch.y ?? current.y
    const width = patch.width ?? current.width
    const height = patch.height ?? current.height
    const rotation = patch.rotation ?? current.rotation
    obj = {
      id: patch.shapeId,
      type: existing.type,
      name: patch.name ?? current.name,
      x,
      y,
      width,
      height,
      rotation,
      'parent-id': parentId,
      'frame-id': frameId,
      ...computeShapeGeometry(x, y, width, height, rotation),
      ...(patch.opacity !== undefined ? { opacity: patch.opacity } : current.opacity !== undefined && { opacity: current.opacity }),
      ...(patch.hidden !== undefined ? { hidden: patch.hidden } : current.hidden !== undefined && { hidden: current.hidden }),
      ...(patch.blocked !== undefined ? { blocked: patch.blocked } : current.blocked !== undefined && { blocked: current.blocked }),
      ...(patch.blendMode !== undefined ? { 'blend-mode': patch.blendMode } : current.blendMode !== undefined && { 'blend-mode': current.blendMode }),
      fills: mergedFills ?? [],
      strokes: mergedStrokes ?? [],
      shadows: mergedShadows ?? [],
    }
  }

  // Carry forward attributes this tool doesn't know how to round-trip (layout, layoutItem when not
  // changed, component/variant tags, shape-ref, etc.) by starting from the existing object and
  // overlaying the freshly rebuilt fields. `existing` is camelCase (as returned by get-file)
  // while `obj` is kebab-case (as add-obj expects) — an object spread doesn't "overwrite" a
  // camelCase key with its kebab-case counterpart since they're different property names, so
  // every TOP-LEVEL field `obj` recomputed must have its stale camelCase twin deleted explicitly
  // (same pattern as `cloneComponentInstance`). Nested keys (fillColor/strokeColor/etc. inside
  // fills/strokes array elements) aren't top-level shape keys, so there's no stale twin to strip —
  // `obj.fills`/`obj.strokes` fully replace `existing.fills`/`existing.strokes` via the spread.
  const merged: Record<string, unknown> = { ...existing, ...obj }
  delete merged.parentId
  delete merged.frameId
  delete merged.transformInverse
  delete merged.hideFillOnExport
  delete merged.growType
  return addObj(pageId, merged)
}

function makeUpdateShapesInput(tokensPath: string) {
  return z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    patches: z.array(shapePatchSchema).min(1),
    tokensPath: z.string().default(tokensPath),
  })
}

function makeUpdateShapes(defaultTokensPath: string): ToolDefinition<z.infer<ReturnType<typeof makeUpdateShapesInput>>> {
  return {
    name: 'penpot_update_shapes',
    description:
      'Update one or more existing shapes in place, by id. Supports rect, frame, text, circle, bool, path, ' +
      'group, image, svg-raw, and any other shape type. Only the fields you pass are changed — everything ' +
      'else on the shape (child positions, component/variant tags, etc.) is left untouched. Geometry fields ' +
      '(x/y/width/height/rotation) automatically recompute the shape\'s selection box and transform, so ' +
      'partial geometry edits stay consistent. Exception: for path shapes, x/y/width/height are always ' +
      'derived from path content and cannot be set directly — provide "content" (an array of path commands) ' +
      'to relocate or reshape a path. For image shapes, use "mediaId"/"mediaWidth"/"mediaHeight"/"mtype" to ' +
      'swap the displayed image to a different already-uploaded media object. Colors, corner radii (r1-r4), ' +
      'and shadows each accept either a literal value or a { token: "name" } reference resolved against the ' +
      'project token file (colors/radii/shadows tables respectively); "clearStroke"/"clearShadows" remove ' +
      'strokes/shadows entirely (ignored if "stroke"/"shadows" is also given). "layout" (frame shapes only) ' +
      'sets or replaces the frame\'s auto-layout; "layoutItem" sets or replaces the shape\'s own placement ' +
      'within its parent auto-layout frame — both accept the same schema as penpot_add_shapes. Note: ' +
      'updating a group\'s x/y/width/height only adjusts the group\'s stored bounding box and does not move ' +
      'its children — use penpot_align_shapes or penpot_distribute_shapes to move a group as a unit.',
    inputSchema: makeUpdateShapesInput(defaultTokensPath),
    handler: async (client, { fileId, pageId, patches, tokensPath }) => {
      const tokens = await loadTokenFile(tokensPath)
      const file = await client.getFile(fileId)
      const page = file.data.pagesIndex[pageId]
      if (!page) throw new Error(`penpot_update_shapes: page ${pageId} not found in file ${fileId}`)

      const changes = patches.map((patch) => {
        const existing = page.objects[patch.shapeId] as ShapeNode | undefined
        if (!existing) {
          throw new Error(`penpot_update_shapes: shape ${patch.shapeId} not found on page ${pageId}`)
        }
        return buildUpdateChange(pageId, patch, existing, tokens, 'penpot_update_shapes')
      })

      const result = await client.updateFile(fileId, file.revn, file.vern, changes)
      return { shapeIds: changes.map((c) => c.id), revn: result.revn }
    },
  }
}

const deleteShapesInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  shapeIds: z.array(z.string().min(1)).min(1),
})

const deleteShapes: ToolDefinition<z.infer<typeof deleteShapesInput>> = {
  name: 'penpot_delete_shapes',
  description:
    'Delete one or more existing shapes from a page in a Penpot file, by id. Deleting a frame or group also ' +
    "removes its children, matching Penpot's own delete behavior. This is the only way to remove a shape — " +
    'there is no undo via this tool once the change is sent.',
  inputSchema: deleteShapesInput,
  handler: async (client, { fileId, pageId, shapeIds }) => {
    const file = await client.getFile(fileId)
    const page = file.data.pagesIndex[pageId]
    if (!page) throw new Error(`penpot_delete_shapes: page ${pageId} not found in file ${fileId}`)

    for (const shapeId of shapeIds) {
      if (!page.objects[shapeId]) {
        throw new Error(`penpot_delete_shapes: shape ${shapeId} not found on page ${pageId}`)
      }
    }

    const changes = shapeIds.map((shapeId) => delObj(pageId, shapeId))
    const result = await client.updateFile(fileId, file.revn, file.vern, changes)
    return { deletedShapeIds: shapeIds, revn: result.revn }
  },
}

const cloneShapesInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  shapeIds: z.array(z.string().min(1)).min(1),
  /** Shifts every clone's position relative to its source shape. Defaults to no offset (0, 0) — an exact
   * duplicate stacked directly on top of the original, matching Penpot's own Ctrl+D before you drag it. */
  dx: z.number().default(0),
  dy: z.number().default(0),
  /** Reparents every cloned root under this shape instead of the source root's own parent. Omit to keep
   * each clone alongside its source (same parent/frame). */
  parentId: z.string().optional(),
  frameId: z.string().optional(),
})

const cloneShapes: ToolDefinition<z.infer<typeof cloneShapesInput>> = {
  name: 'penpot_clone_shapes',
  description:
    'Duplicate one or more existing shapes (and, for frames/groups, their full descendant subtree) on a page, ' +
    'each with fresh ids. This is plain shape duplication — like Penpot\'s own Ctrl+D — not a component ' +
    'instance; use penpot_add_component_instance instead if you want a copy linked back to a component\'s main ' +
    'instance via shape-ref. Optional dx/dy offset each clone from its source (default: no offset, stacked ' +
    'directly on top of the original); optional parentId/frameId reparent every cloned root onto a new parent ' +
    'instead of staying alongside its source. If a cloned shape already carries component/variant tags (it is ' +
    'itself a component\'s main instance or an existing instance), those tags are carried over unchanged.',
  inputSchema: cloneShapesInput,
  handler: async (client, { fileId, pageId, shapeIds, dx, dy, parentId, frameId }) => {
    const file = await client.getFile(fileId)
    const page = file.data.pagesIndex[pageId]
    if (!page) throw new Error(`penpot_clone_shapes: page ${pageId} not found in file ${fileId}`)

    for (const shapeId of shapeIds) {
      if (!page.objects[shapeId]) {
        throw new Error(`penpot_clone_shapes: shape ${shapeId} not found on page ${pageId}`)
      }
    }

    const objects = page.objects as Record<string, ShapeNode>
    const changesPerRoot = shapeIds.map((rootId) =>
      cloneShapesBuilder({ pageId, objects, rootId, parentId, frameId, dx, dy }),
    )
    const changes = changesPerRoot.flat()

    const result = await client.updateFile(fileId, file.revn, file.vern, changes)
    const clonedRootIds = changesPerRoot.map((rootChanges) => rootChanges[0]!.id)
    return { clonedRootIds, shapeIds: changes.map((c) => c.id), revn: result.revn }
  },
}

const reorderShapesInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  shapeId: z.string().min(1),
  /** 'front'/'back' move to the top/bottom of the stack; 'forward'/'backward' swap with the next/previous
   * sibling; 'before'/'after' place shapeId immediately before/after another sibling (targetId required). */
  action: z.enum(['front', 'back', 'forward', 'backward', 'before', 'after']),
  /** Required for action 'before'/'after': the sibling shapeId should be placed relative to. */
  targetId: z.string().min(1).optional(),
})

/**
 * Builds the `add-obj` change that reorders `shapeId` within its parent's `shapes` array
 * per `action`, shared by `penpot_reorder_shapes` and `penpot_batch`. Looks up the shape
 * and its parent in `objects`, so callers building up a batch can pass an in-memory map
 * reflecting earlier ops in the same call, not just what `get-file` originally returned.
 */
function buildReorderChange(
  pageId: string,
  objects: Record<string, ShapeNode>,
  shapeId: string,
  action: ReorderAction,
  toolName: string,
): { change: ReturnType<typeof addObj>; parentId: string; order: string[] } {
  const shape = objects[shapeId]
  if (!shape) throw new Error(`${toolName}: shape ${shapeId} not found`)

  const parentId = (shape.parentId as string | undefined) ?? (shape['parent-id'] as string | undefined)
  if (!parentId) throw new Error(`${toolName}: shape ${shapeId} has no parent to reorder within`)
  const parent = objects[parentId]
  if (!parent) throw new Error(`${toolName}: parent ${parentId} of shape ${shapeId} not found`)

  const currentOrder = parent.shapes ?? []
  const newOrder = reorderChildren(currentOrder, shapeId, action)

  const parentOfParentId =
    (parent.parentId as string | undefined) ?? (parent['parent-id'] as string | undefined) ?? ROOT_FRAME_ID
  const parentFrameId =
    (parent.frameId as string | undefined) ?? (parent['frame-id'] as string | undefined) ?? ROOT_FRAME_ID

  // `parent` is camelCase (as returned by get-file); `add-obj` needs kebab-case keys on the object
  // itself. Unlike penpot_update_shapes (which rebuilds the object from scratch via the `frame`
  // builder), this only touches `shapes` — every other field is carried over from `parent` as-is, so
  // camelCase fields that are actually required (not stale duplicates), like `transformInverse` and
  // `hideFillOnExport`, must be renamed to their kebab-case form rather than just deleted: dropping
  // `transform-inverse` entirely was tried and rejected live by Penpot's malli schema (`nil` where a
  // matrix is required), unlike `parentId`/`frameId` which truly are redundant with `parent-id`/`frame-id`.
  const merged: Record<string, unknown> = {
    ...parent,
    shapes: newOrder,
    'parent-id': parentOfParentId,
    'frame-id': parentFrameId,
    'transform-inverse': parent.transformInverse ?? parent['transform-inverse'],
    'hide-fill-on-export': parent.hideFillOnExport ?? parent['hide-fill-on-export'] ?? false,
  }
  delete merged.parentId
  delete merged.frameId
  delete merged.transformInverse
  delete merged.hideFillOnExport
  delete merged.growType

  return { change: addObj(pageId, merged), parentId, order: newOrder }
}

const reorderShapes: ToolDefinition<z.infer<typeof reorderShapesInput>> = {
  name: 'penpot_reorder_shapes',
  description:
    'Change a shape\'s stacking (z-)order among its siblings, matching Penpot\'s own "Bring to front" / ' +
    '"Send to back" / "Forward" / "Backward" UI actions. Shapes have no explicit z-index — order is implicit ' +
    'in their parent\'s child list, where later entries render on top. "front"/"back" move the shape to the ' +
    'top/bottom of the stack; "forward"/"backward" swap it with the next/previous sibling (a no-op if already ' +
    'at that end); "before"/"after" place it immediately before/after another sibling given as targetId. Only ' +
    'reorders among existing siblings — does not reparent (use penpot_update_shapes\'s parentId/frameId for that).',
  inputSchema: reorderShapesInput,
  handler: async (client, { fileId, pageId, shapeId, action, targetId }) => {
    if ((action === 'before' || action === 'after') && !targetId) {
      throw new Error(`penpot_reorder_shapes: action "${action}" requires targetId`)
    }

    const file = await client.getFile(fileId)
    const page = file.data.pagesIndex[pageId]
    if (!page) throw new Error(`penpot_reorder_shapes: page ${pageId} not found in file ${fileId}`)

    const objects = page.objects as Record<string, ShapeNode>
    const reorderAction = { type: action, targetId } as ReorderAction
    const { change, parentId, order } = buildReorderChange(pageId, objects, shapeId, reorderAction, 'penpot_reorder_shapes')

    const result = await client.updateFile(fileId, file.revn, file.vern, [change])
    return { parentId, order, revn: result.revn }
  },
}

/**
 * Reads a shape's visible bounding box (its `selrect` — the axis-aligned box that already accounts
 * for rotation), falling back to raw x/y/width/height for the rare shape without one. This is the box
 * Penpot's own align/distribute operate on, so a rotated shape lines up by its rendered bounds, not
 * its pre-rotation frame.
 */
function shapeBox(shape: ShapeNode): ShapeBox {
  const selrect = shape.selrect as { x1?: number; y1?: number; x2?: number; y2?: number } | undefined
  if (selrect?.x1 !== undefined && selrect.y1 !== undefined && selrect.x2 !== undefined && selrect.y2 !== undefined) {
    return { id: shape.id, x1: selrect.x1, y1: selrect.y1, x2: selrect.x2, y2: selrect.y2 }
  }
  const x = shape.x as number
  const y = shape.y as number
  const width = shape.width as number
  const height = shape.height as number
  return { id: shape.id, x1: x, y1: y, x2: x + width, y2: y + height }
}

/**
 * Turns a computed `(dx, dy)` translation into the same `add-obj` update change
 * `penpot_update_shapes` produces, by shifting the shape's OWN x/y by the delta (a pure
 * translation moves the shape and its selrect/points/transform together, which `buildUpdateChange`
 * recomputes from the new x/y). Reuses the well-tested update path rather than hand-editing
 * geometry, so rotated shapes and every carried-over attribute round-trip exactly as they do there.
 */
function buildTranslateChange(
  pageId: string,
  shapeId: string,
  dx: number,
  dy: number,
  existing: ShapeNode,
  tokens: TokenFile,
  toolName: string,
): ReturnType<typeof addObj> {
  const patch: ShapePatch = {
    shapeId,
    x: (existing.x as number) + dx,
    y: (existing.y as number) + dy,
  }
  return buildUpdateChange(pageId, patch, existing, tokens, toolName)
}

/**
 * Expands each aligned/distributed shape's `(dx, dy)` into the translate changes needed to move that
 * shape AND its full descendant subtree by the same delta. A frame/group's children have absolute
 * positions, so moving only the container's own x/y would leave the children behind (matching how
 * `buildUpdateChange` deliberately doesn't touch a frame's/group's `shapes`) — Penpot's own
 * align/distribute moves a frame or group as a unit by translating both the container and every
 * descendant by the same offset.
 */
function expandTranslateChanges(
  pageId: string,
  deltas: ShapeDelta[],
  objects: Record<string, ShapeNode>,
  tokens: TokenFile,
  toolName: string,
): ReturnType<typeof addObj>[] {
  const changes: ReturnType<typeof addObj>[] = []
  const collectSubtree = (id: string, dx: number, dy: number) => {
    const shape = objects[id]
    if (!shape) throw new Error(`${toolName}: shape ${id} not found`)
    changes.push(buildTranslateChange(pageId, id, dx, dy, shape, tokens, toolName))
    for (const childId of shape.shapes ?? []) collectSubtree(childId, dx, dy)
  }
  for (const delta of deltas) collectSubtree(delta.id, delta.dx, delta.dy)
  return changes
}

function makeAlignShapesInput(tokensPath: string) {
  return z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    shapeIds: z.array(z.string().min(1)).min(2),
    /** Which edge/center to line every shape up on. Horizontal edges move shapes along x, vertical along y. */
    edge: z.enum(['left', 'right', 'top', 'bottom', 'center-h', 'center-v']),
    tokensPath: z.string().default(tokensPath),
  })
}

function makeAlignShapes(defaultTokensPath: string): ToolDefinition<z.infer<ReturnType<typeof makeAlignShapesInput>>> {
  return {
    name: 'penpot_align_shapes',
    description:
      'Align two or more shapes to a common edge or center, matching Penpot\'s own align actions — instead of the ' +
      'caller computing pixel positions itself from penpot_get_shape results. "edge" is one of: "left"/"right" ' +
      '(snap every shape\'s left/right edge to the leftmost/rightmost shape\'s), "top"/"bottom" (same, vertically), ' +
      '"center-h" (center every shape horizontally on the group\'s mid-x), or "center-v" (center vertically on the ' +
      'group\'s mid-y). Aligns on each shape\'s visible bounding box (its selrect), so rotated shapes line up by ' +
      'their rendered bounds; the group as a whole never moves (the reference line comes from the shapes\' own ' +
      'extent). Applied as a single update-file change-set; shapes already on the reference line are left untouched.',
    inputSchema: makeAlignShapesInput(defaultTokensPath),
    handler: async (client, { fileId, pageId, shapeIds, edge, tokensPath }) => {
      const tokens = await loadTokenFile(tokensPath)
      const file = await client.getFile(fileId)
      const page = file.data.pagesIndex[pageId]
      if (!page) throw new Error(`penpot_align_shapes: page ${pageId} not found in file ${fileId}`)

      const objects = page.objects as Record<string, ShapeNode>
      const boxes = shapeIds.map((shapeId) => {
        const shape = objects[shapeId]
        if (!shape) throw new Error(`penpot_align_shapes: shape ${shapeId} not found on page ${pageId}`)
        return shapeBox(shape)
      })

      const deltas = computeAlignment(boxes, edge as AlignEdge)
      if (deltas.length === 0) return { movedShapeIds: [], revn: file.revn }

      const changes = expandTranslateChanges(pageId, deltas, objects, tokens, 'penpot_align_shapes')
      const result = await client.updateFile(fileId, file.revn, file.vern, changes)
      return { movedShapeIds: deltas.map((d) => d.id), revn: result.revn }
    },
  }
}

function makeDistributeShapesInput(tokensPath: string) {
  return z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    shapeIds: z.array(z.string().min(1)).min(3),
    /** "horizontal" equalizes the gaps between shapes left-to-right; "vertical" does so top-to-bottom. */
    axis: z.enum(['horizontal', 'vertical']),
    tokensPath: z.string().default(tokensPath),
  })
}

function makeDistributeShapes(
  defaultTokensPath: string,
): ToolDefinition<z.infer<ReturnType<typeof makeDistributeShapesInput>>> {
  return {
    name: 'penpot_distribute_shapes',
    description:
      'Distribute three or more shapes so the gaps between adjacent shapes are equal, matching Penpot\'s own ' +
      '"distribute horizontal/vertical spacing" actions — instead of the caller computing even spacing itself. ' +
      '"axis" is "horizontal" (equalize left-to-right gaps) or "vertical" (top-to-bottom). The two outermost ' +
      'shapes stay put and the ones between them slide so every gap is identical; distributes on each shape\'s ' +
      'visible bounding box (selrect), accounting for differing shape sizes. Applied as a single update-file ' +
      'change-set; shapes already evenly spaced (and the two endpoints) are left untouched.',
    inputSchema: makeDistributeShapesInput(defaultTokensPath),
    handler: async (client, { fileId, pageId, shapeIds, axis, tokensPath }) => {
      const tokens = await loadTokenFile(tokensPath)
      const file = await client.getFile(fileId)
      const page = file.data.pagesIndex[pageId]
      if (!page) throw new Error(`penpot_distribute_shapes: page ${pageId} not found in file ${fileId}`)

      const objects = page.objects as Record<string, ShapeNode>
      const boxes = shapeIds.map((shapeId) => {
        const shape = objects[shapeId]
        if (!shape) throw new Error(`penpot_distribute_shapes: shape ${shapeId} not found on page ${pageId}`)
        return shapeBox(shape)
      })

      const deltas = computeDistribution(boxes, axis as DistributeAxis)
      if (deltas.length === 0) return { movedShapeIds: [], revn: file.revn }

      const changes = expandTranslateChanges(pageId, deltas, objects, tokens, 'penpot_distribute_shapes')
      const result = await client.updateFile(fileId, file.revn, file.vern, changes)
      return { movedShapeIds: deltas.map((d) => d.id), revn: result.revn }
    },
  }
}

const batchCreateOpSchema = z.object({
  op: z.literal('create'),
  shape: shapeSpecSchema,
})

const batchUpdateOpSchema = z.object({
  op: z.literal('update'),
  patch: shapePatchSchema,
})

const batchDeleteOpSchema = z.object({
  op: z.literal('delete'),
  shapeId: z.string().min(1),
})

const batchReorderOpSchema = z.object({
  op: z.literal('reorder'),
  shapeId: z.string().min(1),
  action: z.enum(['front', 'back', 'forward', 'backward', 'before', 'after']),
  targetId: z.string().min(1).optional(),
})

const batchOpSchema = z.discriminatedUnion('op', [
  batchCreateOpSchema,
  batchUpdateOpSchema,
  batchDeleteOpSchema,
  batchReorderOpSchema,
])
type BatchOp = z.infer<typeof batchOpSchema>

function makeBatchInput(tokensPath: string) {
  return z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    /** Applied in order, as a single update-file change-set (one revn/vern round trip). A
     * "create" may set an explicit shape id and be referenced as a parentId/frameId, or
     * updated/deleted/reordered, by any later op in the same call. */
    ops: z.array(batchOpSchema).min(1),
    tokensPath: z.string().default(tokensPath),
  })
}

function makeBatch(defaultTokensPath: string): ToolDefinition<z.infer<ReturnType<typeof makeBatchInput>>> {
  return {
    name: 'penpot_batch',
    description:
      'Apply an ordered list of create/update/delete/reorder operations to a page as a single update-file ' +
      'change-set — one revn/vern round trip no matter how many shapes are touched, instead of one RPC call ' +
      'per shape (and the races on revn that come with that). Each op is one of: ' +
      '{ op: "create", shape: <same spec as penpot_add_shapes> }, ' +
      '{ op: "update", patch: <same spec as penpot_update_shapes> }, ' +
      '{ op: "delete", shapeId }, or ' +
      '{ op: "reorder", shapeId, action, targetId? } (same actions as penpot_reorder_shapes). ' +
      'Ops are applied in array order and each sees the effect of every earlier op in the same call — a ' +
      '"create" can set an explicit "id" (a UUID) and be referenced as a later shape\'s parentId/frameId (to ' +
      'build a frame and its children in one call), and a later op can update/delete/reorder a shape created ' +
      'earlier in the same batch. Returns one result entry per op, in the same order as "ops".',
    inputSchema: makeBatchInput(defaultTokensPath),
    handler: async (client, { fileId, pageId, ops, tokensPath }) => {
      const tokens = await loadTokenFile(tokensPath)
      const file = await client.getFile(fileId)
      const page = file.data.pagesIndex[pageId]
      if (!page) throw new Error(`penpot_batch: page ${pageId} not found in file ${fileId}`)

      // Shadow copy of the page's shapes, mutated as ops are processed so a later op can see
      // shapes created/updated/reordered/deleted earlier in this same batch — mirroring how
      // update-file applies `changes` sequentially server-side.
      const objects = { ...(page.objects as Record<string, ShapeNode>) }
      const changes: Change[] = []
      const results: unknown[] = []

      ops.forEach((op: BatchOp, index) => {
        switch (op.op) {
          case 'create': {
            const spec = op.shape.id ? op.shape : { ...op.shape, id: randomUUID() }
            const obj = buildShapeObject(spec, tokens)
            const change = addObj(pageId, obj)
            changes.push(change)
            objects[change.id] = obj as ShapeNode
            const parent = objects[spec.parentId]
            if (parent) parent.shapes = [...(parent.shapes ?? []), change.id]
            results.push({ op: 'create', shapeId: change.id })
            break
          }
          case 'update': {
            const existing = objects[op.patch.shapeId]
            if (!existing) {
              throw new Error(`penpot_batch: op ${index} (update): shape ${op.patch.shapeId} not found`)
            }
            const change = buildUpdateChange(pageId, op.patch, existing, tokens, 'penpot_batch')
            changes.push(change)
            objects[change.id] = change.obj as ShapeNode
            results.push({ op: 'update', shapeId: change.id })
            break
          }
          case 'delete': {
            if (!objects[op.shapeId]) {
              throw new Error(`penpot_batch: op ${index} (delete): shape ${op.shapeId} not found`)
            }
            changes.push(delObj(pageId, op.shapeId))
            const parentId =
              (objects[op.shapeId]!.parentId as string | undefined) ??
              (objects[op.shapeId]!['parent-id'] as string | undefined)
            const parent = parentId ? objects[parentId] : undefined
            if (parent) parent.shapes = (parent.shapes ?? []).filter((id) => id !== op.shapeId)
            delete objects[op.shapeId]
            results.push({ op: 'delete', shapeId: op.shapeId })
            break
          }
          case 'reorder': {
            if ((op.action === 'before' || op.action === 'after') && !op.targetId) {
              throw new Error(`penpot_batch: op ${index} (reorder): action "${op.action}" requires targetId`)
            }
            const reorderAction = { type: op.action, targetId: op.targetId } as ReorderAction
            const { change, parentId, order } = buildReorderChange(pageId, objects, op.shapeId, reorderAction, 'penpot_batch')
            changes.push(change)
            objects[change.id] = change.obj as ShapeNode
            results.push({ op: 'reorder', shapeId: op.shapeId, parentId, order })
            break
          }
        }
      })

      const result = await client.updateFile(fileId, file.revn, file.vern, changes)
      return { results, revn: result.revn }
    },
  }
}

const checkpointInput = z.object({
  fileId: z.string().min(1),
  /**
   * When supplied, only this page is snapshotted (single-page checkpoint).
   * When omitted, every page in the file is snapshotted (whole-file checkpoint).
   */
  pageId: z.string().min(1).optional(),
})

const checkpointTool: ToolDefinition<z.infer<typeof checkpointInput>> = {
  name: 'penpot_checkpoint',
  description:
    'Snapshot shapes so a subsequent penpot_restore_checkpoint call can undo whatever ' +
    'happens between now and then — including a wrong penpot_delete_shapes call, which otherwise has no undo ' +
    'path short of Penpot\'s own UI. When pageId is supplied only that page is snapshotted; omit pageId to ' +
    'snapshot every page in the file (whole-file checkpoint). Reusable across multiple restores until ' +
    'explicitly discarded via penpot_discard_checkpoint. When the server is configured with ' +
    'PENPOT_CHECKPOINTS_PATH the checkpoint is also written to disk and will survive a server restart; ' +
    'without that setting it lives only in process memory and is lost on restart. Call this immediately ' +
    'before a risky multi-step edit; pass the returned checkpointId to penpot_restore_checkpoint to undo ' +
    'everything since.',
  inputSchema: checkpointInput,
  handler: async (client, { fileId, pageId }) => {
    const file = await client.getFile(fileId)
    const pageIdsToSnap = pageId ? [pageId] : file.data.pages
    const pages: Record<string, Record<string, ShapeNode>> = {}
    for (const pid of pageIdsToSnap) {
      const page = file.data.pagesIndex[pid]
      if (!page) throw new Error(`penpot_checkpoint: page ${pid} not found in file ${fileId}`)
      pages[pid] = page.objects as Record<string, ShapeNode>
    }
    const checkpoint = await saveCheckpoint(fileId, pages, pageId)
    const totalShapes = Object.values(pages).reduce((sum, objs) => sum + Object.keys(objs).length, 0)
    return {
      checkpointId: checkpoint.id,
      fileId,
      pageIds: Object.keys(pages),
      pageCount: Object.keys(pages).length,
      shapeCount: totalShapes,
    }
  },
}

const restoreCheckpointInput = z.object({
  checkpointId: z.string().min(1),
})

const restoreCheckpointTool: ToolDefinition<z.infer<typeof restoreCheckpointInput>> = {
  name: 'penpot_restore_checkpoint',
  description:
    'Undo every shape change made since a penpot_checkpoint call, by diffing the page\'s current state against ' +
    'the snapshot and replaying corrective changes as a single update-file call: shapes the snapshot has but ' +
    'the page no longer does are recreated verbatim, shapes the page has that the snapshot didn\'t are ' +
    'deleted, and shapes present in both are overwritten back to their snapshotted fields (geometry, fills, ' +
    'children, layout — everything). When the checkpoint was taken without a pageId (whole-file checkpoint), ' +
    'all snapshotted pages are restored in a single update-file call. The checkpoint itself is NOT consumed — ' +
    'it can be restored to again, or discarded explicitly via penpot_discard_checkpoint. Throws if the ' +
    'checkpoint id is unknown (already discarded, or the server restarted since it was taken).',
  inputSchema: restoreCheckpointInput,
  handler: async (client, { checkpointId }) => {
    const checkpoint = getCheckpoint(checkpointId)
    if (!checkpoint) throw new Error(`penpot_restore_checkpoint: no checkpoint ${checkpointId} found`)

    const { fileId } = checkpoint
    const file = await client.getFile(fileId)
    const changes: Change[] = []
    let totalRestored = 0
    let totalDeleted = 0

    for (const [pageId, snapshotObjects] of Object.entries(checkpoint.pages)) {
      const page = file.data.pagesIndex[pageId]
      if (!page) throw new Error(`penpot_restore_checkpoint: page ${pageId} not found in file ${fileId}`)

      const currentObjects = page.objects as Record<string, ShapeNode>

      // Recreate/overwrite every shape the snapshot knows about, in the snapshot's own
      // iteration order — a child can be re-added before or after its parent, since
      // add-obj only needs the parent id to already exist as of when Penpot applies the
      // change, and the root frame (always present) satisfies that for any top-level shape.
      for (const shape of Object.values(snapshotObjects)) {
        changes.push(restoreShapeAsAddObj(pageId, shape))
      }
      // Delete anything present now that the snapshot never had.
      for (const shapeId of Object.keys(currentObjects)) {
        if (!snapshotObjects[shapeId]) {
          changes.push(delObj(pageId, shapeId))
          totalDeleted++
        }
      }
      totalRestored += Object.keys(snapshotObjects).length
    }

    if (changes.length === 0) return { checkpointId, restoredShapeCount: 0, deletedShapeCount: 0, revn: file.revn }

    const result = await client.updateFile(fileId, file.revn, file.vern, changes)
    return {
      checkpointId,
      restoredShapeCount: totalRestored,
      deletedShapeCount: totalDeleted,
      revn: result.revn,
    }
  },
}

const discardCheckpointInput = z.object({
  checkpointId: z.string().min(1),
})

const discardCheckpointTool: ToolDefinition<z.infer<typeof discardCheckpointInput>> = {
  name: 'penpot_discard_checkpoint',
  description:
    'Free a checkpoint taken via penpot_checkpoint without restoring it, once it is no longer needed. ' +
    'Removes both the in-memory entry and, when disk persistence is enabled (PENPOT_CHECKPOINTS_PATH), ' +
    'the corresponding file on disk.',
  inputSchema: discardCheckpointInput,
  handler: async (_client, { checkpointId }) => {
    const existed = await deleteCheckpoint(checkpointId)
    return { checkpointId, discarded: existed }
  },
}

// ── Component-instance drift detection ────────────────────────────────────────

/**
 * Shape fields that are compared to detect drift between a component instance's
 * root and its main component's root. Position (x/y) is intentionally excluded
 * because every placed instance is at a different canvas location by design.
 */
const DRIFT_FIELDS = [
  'name',
  'fills',
  'strokes',
  'shadows',
  'opacity',
  'hidden',
  'blendMode',
  'width',
  'height',
  'constraintsH',
  'constraintsV',
  'content', // text shapes: paragraph/run content
] as const

export type ComponentLinkState = 'linked' | 'detached' | 'not-an-instance' | 'main-component-root'

export type ComponentInfo = {
  /** Whether this shape is a component instance root, a main-component root, orphaned, or a plain shape. */
  linkState: ComponentLinkState
  /** The component UUID, when the shape is any form of component root. */
  componentId?: string
  /** The file that owns the component definition (may differ from the current file for library components). */
  componentFileId?: string
  /** For `linked` instances in the same file: the id of the main-instance shape. */
  mainInstanceId?: string
  /** For `linked` instances in the same file: the page id where the main-instance lives. */
  mainInstancePage?: string
  /**
   * For `linked` instances in the same file: the list of field names (camelCase) whose
   * value on this instance differs from the main component's current definition.
   * An empty array means no drift — the instance is in sync with its component.
   * Omitted for library components (cross-file drift requires an extra network call)
   * and for `main-component-root` / `detached` / `not-an-instance` shapes.
   */
  driftedFields?: string[]
}

/**
 * Computes component link state and drift info for a single shape node.
 *
 * `components` comes from `file.data.components` (camelCase keys, `FileComponent` values).
 * `pagesIndex` comes from `file.data.pagesIndex` (used to look up the main-instance shape
 * for drift comparison). Both are already in memory — no extra network calls.
 *
 * The returned `driftedFields` array lists the camelCase field names that differ
 * between this instance root and the main component root. An empty array means the
 * instance is fully in sync. For library components (`componentFileId !== fileId`)
 * drift is not computed because the library file's pages are not fetched.
 */
export function computeComponentInfo(
  shape: ShapeNode,
  fileId: string,
  components: Record<string, { id: string; mainInstanceId: string; mainInstancePage: string }>,
  pagesIndex: Record<string, { objects: Record<string, ShapeNode> }>,
): ComponentInfo {
  // get-file returns camelCase; guard against kebab-case keys in mocks / older responses
  const componentId = (shape.componentId ?? shape['component-id']) as string | undefined
  const componentFile = (shape.componentFile ?? shape['component-file']) as string | undefined
  const isMainInstance = Boolean(shape.mainInstance ?? shape['main-instance'])
  const isComponentRoot = Boolean(shape.componentRoot ?? shape['component-root'])

  if (!componentId) {
    return { linkState: 'not-an-instance' }
  }

  // The main-instance root of a component definition (not a placed copy)
  if (isMainInstance && isComponentRoot) {
    return {
      linkState: 'main-component-root',
      componentId,
      ...(componentFile ? { componentFileId: componentFile } : {}),
    }
  }

  // Check whether the component lives in the current file's components map
  const component = components[componentId]

  if (!component) {
    // Component not in this file's map — either a library component or orphaned
    if (componentFile && componentFile !== fileId) {
      // Known external library component: linked but drift not computable without fetching the library
      return {
        linkState: 'linked',
        componentId,
        componentFileId: componentFile,
      }
    }
    // Component was deleted from this file — instance is detached/orphaned
    return {
      linkState: 'detached',
      componentId,
      ...(componentFile ? { componentFileId: componentFile } : {}),
    }
  }

  // Linked instance whose main component is in this same file
  const info: ComponentInfo = {
    linkState: 'linked',
    componentId,
    componentFileId: componentFile ?? fileId,
    mainInstanceId: component.mainInstanceId,
    mainInstancePage: component.mainInstancePage,
  }

  // Drift: compare each driftable field against the main-instance shape
  const mainPage = pagesIndex[component.mainInstancePage]
  const mainShape = mainPage?.objects[component.mainInstanceId]

  if (mainShape) {
    const driftedFields: string[] = []
    for (const field of DRIFT_FIELDS) {
      const instanceVal = shape[field]
      const mainVal = mainShape[field]
      if (JSON.stringify(instanceVal) !== JSON.stringify(mainVal)) {
        driftedFields.push(field)
      }
    }
    info.driftedFields = driftedFields
  }

  return info
}

// ── penpot_get_shape ───────────────────────────────────────────────────────────

const getShapeInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  shapeId: z.string().min(1),
  /** Whether to nest descendant shapes (recursively) under `shapes` instead of leaving them as bare ids. */
  includeDescendants: z.boolean().default(true),
  /** Caps how many levels of descendants are nested when `includeDescendants` is true. Unlimited if omitted. */
  maxDepth: z.number().int().positive().optional(),
})

/** Builds the nested-descendants tree for `penpot_get_shape`, capped at `maxDepth` levels below the root (undefined = unlimited). */
function buildShapeTree(
  shapeId: string,
  objects: Record<string, ShapeNode>,
  depth: number,
  maxDepth: number | undefined,
): Record<string, unknown> {
  const shape = objects[shapeId]
  if (!shape) throw new Error(`penpot_get_shape: shape ${shapeId} not found`)

  const childIds = shape.shapes ?? []
  if (childIds.length === 0 || (maxDepth !== undefined && depth >= maxDepth)) {
    return { ...shape }
  }

  return {
    ...shape,
    shapes: childIds.map((childId) => buildShapeTree(childId, objects, depth + 1, maxDepth)),
  }
}

const getShape: ToolDefinition<z.infer<typeof getShapeInput>> = {
  name: 'penpot_get_shape',
  description:
    'Look up a single shape by id on a page, without pulling the whole page via penpot_get_file_snapshot. ' +
    'By default, nests the shape\'s full descendant subtree (frames/groups\' children) under its "shapes" ' +
    'field instead of leaving them as bare ids; set includeDescendants to false for just the shape itself, or ' +
    'maxDepth to cap how many levels deep the nesting goes. ' +
    'Always includes a "componentInfo" field reporting the shape\'s component link state: ' +
    '"not-an-instance" (plain shape), "main-component-root" (the component\'s own main instance), ' +
    '"linked" (a placed copy linked to a component — also includes driftedFields listing any field names ' +
    'whose value on this instance differs from the main component\'s current definition), or ' +
    '"detached" (componentId present but the component no longer exists in this file).',
  inputSchema: getShapeInput,
  handler: async (client, { fileId, pageId, shapeId, includeDescendants, maxDepth }) => {
    const file = await client.getFile(fileId)
    const page = file.data.pagesIndex[pageId]
    if (!page) throw new Error(`penpot_get_shape: page ${pageId} not found in file ${fileId}`)
    if (!page.objects[shapeId]) {
      throw new Error(`penpot_get_shape: shape ${shapeId} not found on page ${pageId}`)
    }

    const objects = page.objects as Record<string, ShapeNode>
    const shapeResult = includeDescendants
      ? buildShapeTree(shapeId, objects, 0, maxDepth)
      : { ...objects[shapeId] }

    const componentInfo = computeComponentInfo(
      objects[shapeId]!,
      fileId,
      (file.data.components ?? {}) as Record<string, { id: string; mainInstanceId: string; mainInstancePage: string }>,
      file.data.pagesIndex as Record<string, { objects: Record<string, ShapeNode> }>,
    )

    return { ...shapeResult, componentInfo }
  },
}

const findShapesInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  /** Restrict to shapes of this type (rect/frame/text/group/circle/path/svg-raw/image/bool). */
  type: z.string().optional(),
  /** Exact (case-sensitive) name match. */
  name: z.string().optional(),
  /** Case-insensitive substring match against the shape's name. */
  nameContains: z.string().optional(),
  /** Case-insensitive substring match against a text shape's rendered characters. Non-text shapes never match this filter. */
  textContains: z.string().optional(),
  /** Only shapes that are a component instance (have a component-id) when true, or that aren't when false. */
  isComponentInstance: z.boolean().optional(),
  /** Only shapes at the top level of the page (no parent other than the root frame) when true. */
  isRoot: z.boolean().optional(),
  /** Caps the number of matches returned. Omit for unlimited. */
  limit: z.number().int().positive().optional(),
})

function shapeText(shape: ShapeNode): string | undefined {
  const content = shape.content as
    | { children?: Array<{ children?: Array<{ children?: Array<{ text?: string }> }> }> }
    | undefined
  const paragraph = content?.children?.[0]?.children?.[0]
  const leaf = paragraph?.children?.[0]
  return leaf?.text
}

const findShapes: ToolDefinition<z.infer<typeof findShapesInput>> = {
  name: 'penpot_find_shapes',
  description:
    'Search a page for shapes matching one or more predicates, instead of walking the tree returned by ' +
    'penpot_get_file_snapshot by hand. Combine "type", "name" (exact match), "nameContains" (case-insensitive ' +
    'substring), "textContains" (case-insensitive substring against text shapes\' rendered characters), ' +
    '"isComponentInstance", and/or "isRoot" — all given filters must match (AND). Omit every filter to list ' +
    'every shape on the page. Returns each match\'s id, type, name, position/size, and component link state ' +
    '("linkState": "not-an-instance" | "linked" | "detached" | "main-component-root"), without descendants ' +
    '(use penpot_get_shape on a match\'s id for its full subtree including detailed componentInfo with driftedFields).',
  inputSchema: findShapesInput,
  handler: async (client, { fileId, pageId, type, name, nameContains, textContains, isComponentInstance, isRoot, limit }) => {
    const file = await client.getFile(fileId)
    const page = file.data.pagesIndex[pageId]
    if (!page) throw new Error(`penpot_find_shapes: page ${pageId} not found in file ${fileId}`)

    const objects = page.objects as Record<string, ShapeNode>
    const nameContainsLower = nameContains?.toLowerCase()
    const textContainsLower = textContains?.toLowerCase()
    const components = (file.data.components ?? {}) as Record<string, { id: string; mainInstanceId: string; mainInstancePage: string }>
    const pagesIndex = file.data.pagesIndex as Record<string, { objects: Record<string, ShapeNode> }>

    const matches: ShapeNode[] = []
    for (const shape of Object.values(objects)) {
      if (type !== undefined && shape.type !== type) continue
      if (name !== undefined && shape.name !== name) continue
      if (nameContainsLower !== undefined && !(shape.name as string | undefined)?.toLowerCase().includes(nameContainsLower))
        continue
      if (textContainsLower !== undefined) {
        const text = shapeText(shape)
        if (!text?.toLowerCase().includes(textContainsLower)) continue
      }
      if (isComponentInstance !== undefined) {
        const hasComponentId = shape['component-id'] !== undefined || shape.componentId !== undefined
        if (hasComponentId !== isComponentInstance) continue
      }
      if (isRoot !== undefined) {
        const parentId = (shape.parentId as string | undefined) ?? (shape['parent-id'] as string | undefined)
        const shapeIsRoot = shape.id !== ROOT_FRAME_ID && parentId === ROOT_FRAME_ID
        if (shapeIsRoot !== isRoot) continue
      }
      matches.push(shape)
      if (limit !== undefined && matches.length >= limit) break
    }

    return {
      shapes: matches.map((shape) => {
        const info = computeComponentInfo(shape, fileId, components, pagesIndex)
        return {
          id: shape.id,
          type: shape.type,
          name: shape.name,
          x: shape.x,
          y: shape.y,
          width: shape.width,
          height: shape.height,
          linkState: info.linkState,
          ...(info.componentId !== undefined ? { componentId: info.componentId } : {}),
          ...(info.driftedFields !== undefined ? { driftedFields: info.driftedFields } : {}),
        }
      }),
      count: matches.length,
    }
  },
}

// ── Text search-and-replace ───────────────────────────────────────────────────

/**
 * Builds a fresh RegExp for `search`, escaping any regex metacharacters so the string
 * is matched literally. Always uses the global flag; adds the case-insensitive flag when
 * `caseSensitive` is false. A new instance is created on every call so callers never
 * share regex lastIndex state.
 */
function makeSearchRegex(search: string, caseSensitive: boolean): RegExp {
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped, caseSensitive ? 'g' : 'gi')
}

const replaceTextInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  /** The literal string to search for. Must be non-empty. */
  search: z.string().min(1),
  /** Replacement string. May be empty to delete all occurrences. */
  replacement: z.string(),
  /** When true, the search is case-sensitive. Defaults to false. */
  caseSensitive: z.boolean().default(false),
  /**
   * Cap on the number of text shapes to modify. Shapes are visited in storage order
   * (the same traversal order as penpot_find_shapes). Omit for no limit.
   */
  limit: z.number().int().positive().optional(),
})

const replaceText: ToolDefinition<z.infer<typeof replaceTextInput>> = {
  name: 'penpot_replace_text',
  description:
    'Find and replace text across all text shapes on a page in a single update-file call. ' +
    'Searches each text run (leaf node) of every text shape for the literal "search" string and ' +
    'replaces every occurrence with "replacement". Matching is case-insensitive by default ' +
    '(set caseSensitive: true to override). Replacement is per text-run: a search string that ' +
    'spans two adjacent runs in the same paragraph will not be matched. Returns the ids and ' +
    'names of every shape that was modified and the total number of occurrences replaced.',
  inputSchema: replaceTextInput,
  handler: async (client, { fileId, pageId, search, replacement, caseSensitive, limit }) => {
    const file = await client.getFile(fileId)
    const page = file.data.pagesIndex[pageId]
    if (!page) throw new Error(`penpot_replace_text: page ${pageId} not found in file ${fileId}`)

    const objects = page.objects as Record<string, ShapeNode>
    const changes: ReturnType<typeof addObj>[] = []
    const replacedShapes: Array<{ shapeId: string; name: string; occurrences: number }> = []

    for (const existing of Object.values(objects)) {
      if (existing.type !== 'text') continue

      const current = extractEditableFields(existing)
      if (!current.paragraphs || current.paragraphs.length === 0) continue

      // Replace within every text run; count total occurrences.
      let totalCount = 0
      const modifiedParagraphs: TextParagraph[] = current.paragraphs.map((para) => ({
        ...para,
        ranges: para.ranges.map((range) => {
          const hits = range.text.match(makeSearchRegex(search, caseSensitive))?.length ?? 0
          totalCount += hits
          if (hits === 0) return range
          return { ...range, text: range.text.replace(makeSearchRegex(search, caseSensitive), replacement) }
        }),
      }))

      if (totalCount === 0) continue

      const parentId = (existing.parentId as string | undefined) ?? (existing['parent-id'] as string)
      const frameId = (existing.frameId as string | undefined) ?? (existing['frame-id'] as string)

      const obj = text({
        id: existing.id as string,
        name: current.name,
        x: current.x,
        y: current.y,
        width: current.width,
        height: current.height,
        rotation: current.rotation,
        parentId,
        frameId,
        opacity: current.opacity,
        hidden: current.hidden,
        blocked: current.blocked,
        blendMode: current.blendMode,
        constraintsH: current.constraintsH as 'left' | 'right' | 'leftright' | 'center' | 'scale' | undefined,
        constraintsV: current.constraintsV as 'top' | 'bottom' | 'topbottom' | 'center' | 'scale' | undefined,
        paragraphs: modifiedParagraphs,
        growType: current.growType as 'auto-width' | 'auto-height' | 'fixed' | undefined,
        verticalAlign: current.verticalAlign as 'top' | 'center' | 'bottom' | undefined,
        shadows: current.shadows,
      })

      // Preserve camelCase attributes from get-file that this builder doesn't know about
      // (component/variant tags, layout-item attrs, etc.) by merging existing on top then
      // overlaying the freshly built kebab-case keys — same pattern as buildUpdateChange.
      const merged: Record<string, unknown> = { ...existing, ...obj }
      delete merged.parentId
      delete merged.frameId
      delete merged.transformInverse
      delete merged.hideFillOnExport
      delete merged.growType

      changes.push(addObj(pageId, merged))
      replacedShapes.push({ shapeId: existing.id as string, name: current.name, occurrences: totalCount })

      if (limit !== undefined && replacedShapes.length >= limit) break
    }

    if (changes.length === 0) {
      return { replacedShapes: [], totalReplacedShapes: 0, totalOccurrences: 0 }
    }

    const result = await client.updateFile(fileId, file.revn, file.vern, changes)
    const totalOccurrences = replacedShapes.reduce((sum, s) => sum + s.occurrences, 0)
    return { replacedShapes, totalReplacedShapes: replacedShapes.length, totalOccurrences, revn: result.revn }
  },
}

// ── Media upload ──────────────────────────────────────────────────────────────

/** Infers a MIME type from a filename extension. Falls back to "application/octet-stream". */
function mtypeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':  return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif':  return 'image/gif'
    case '.webp': return 'image/webp'
    case '.svg':  return 'image/svg+xml'
    case '.avif': return 'image/avif'
    default:      return 'application/octet-stream'
  }
}

const uploadMediaInput = z.object({
  /** Id of the Penpot file the media object will be attached to. */
  fileId: z.string().min(1),
  /** Display name for the media object (visible in Penpot's Assets panel). */
  name: z.string().min(1),
  /**
   * Absolute path to a local image file. The MCP server reads the file and uploads
   * its bytes. Mutually exclusive with `url` and `dataBase64`.
   */
  filePath: z.string().optional(),
  /**
   * Remote HTTPS URL. Penpot's server fetches the image directly (no bytes pass
   * through the MCP server). Mutually exclusive with `filePath` and `dataBase64`.
   */
  url: z.string().url().optional(),
  /**
   * Base64-encoded image bytes. Requires `mtype`. Mutually exclusive with `filePath`
   * and `url`. Useful when the caller already has the image in memory (e.g. from
   * a previous tool's output).
   */
  dataBase64: z.string().optional(),
  /**
   * MIME type (e.g. `"image/png"`). Required when `dataBase64` is given; auto-detected
   * from the file extension when `filePath` is given; ignored when `url` is given.
   */
  mtype: z.string().optional(),
  /**
   * When `false`, the media object is shared across all files in the team (global).
   * Defaults to `true` (local to the specified file). Use `true` for images you only
   * need in one file; use `false` if you plan to reference the media from multiple files.
   */
  isLocal: z.boolean().default(true),
})

const uploadMediaTool: ToolDefinition<z.infer<typeof uploadMediaInput>> = {
  name: 'penpot_upload_media',
  description:
    'Upload an image or other media asset to a Penpot file and return the media object metadata ' +
    '(id, width, height, mtype). The returned id is used as "mediaId" when creating an image shape ' +
    'via penpot_add_shapes (type: "image"). Supply exactly one of: "filePath" (a local filesystem ' +
    'path the MCP server can read), "url" (an HTTPS URL Penpot\'s server will fetch directly — ' +
    'nothing passes through the MCP server), or "dataBase64" (base64-encoded bytes, requires "mtype"). ' +
    'The media object is attached to the given Penpot file (isLocal: true by default). After ' +
    'uploading, pass the returned id/width/height/mtype directly into penpot_add_shapes as ' +
    'mediaId/mediaWidth/mediaHeight/mtype for the image shape.',
  inputSchema: uploadMediaInput,
  handler: async (client, { fileId, name, filePath, url, dataBase64, mtype, isLocal }) => {
    const sourcesGiven = [filePath, url, dataBase64].filter(Boolean).length
    if (sourcesGiven === 0) {
      throw new Error('penpot_upload_media: provide exactly one of filePath, url, or dataBase64')
    }
    if (sourcesGiven > 1) {
      throw new Error('penpot_upload_media: filePath, url, and dataBase64 are mutually exclusive')
    }

    let result: MediaObject

    if (url) {
      // Let Penpot's server fetch the URL — most efficient path, no buffering.
      result = await client.createFileMediaObjectFromUrl(fileId, url, name, isLocal)
    } else if (filePath) {
      const resolvedMtype = mtype ?? mtypeFromPath(filePath)
      const buffer = await readFile(filePath)
      result = await client.uploadFileMediaObject(fileId, name, buffer, resolvedMtype, isLocal)
    } else {
      // dataBase64
      if (!mtype) throw new Error('penpot_upload_media: mtype is required when uploading via dataBase64')
      const buffer = Buffer.from(dataBase64!, 'base64')
      result = await client.uploadFileMediaObject(fileId, name, buffer, mtype, isLocal)
    }

    return {
      id: result.id,
      name: result.name,
      width: result.width,
      height: result.height,
      mtype: result.mtype,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────

const measureTextInput = z.object({
  characters: z.string(),
  fontFamily: z.string().default('Inter'),
  fontSize: z.number().positive().default(14),
  fontWeight: z.string().default('400'),
  /** If given, greedily word-wraps each line so no line's measured width exceeds this, like a fixed-width text shape. Omit to measure natural (unwrapped) width. */
  maxWidth: z.number().positive().optional(),
})

const measureTextTool: ToolDefinition<z.infer<typeof measureTextInput>> = {
  name: 'penpot_measure_text',
  description:
    'Measure the real rendered width/height of a text string for a given font, without creating or touching ' +
    'any shape. Tries Google Fonts first (by family name, no API key needed); if the family is not on Google ' +
    'Fonts, searches all Penpot teams accessible to the configured token for a matching custom/team font. ' +
    'Computes glyph advance widths so the numbers match what Penpot would actually render — removing the ' +
    'guesswork around width/height when calling penpot_add_shapes or penpot_update_shapes for a text shape. ' +
    'Splits on explicit "\\n" for multi-line text; pass maxWidth to also get word-wrapped line breaks for a ' +
    'fixed-width box. Returns { width, height, lineHeight, lines }, where width/height are the natural (or ' +
    'wrapped) bounding box and lines is a per-line breakdown of text/width.',
  inputSchema: measureTextInput,
  handler: async (client, { characters, fontFamily, fontSize, fontWeight, maxWidth }) => {
    let font
    try {
      font = await loadFont(fontFamily, fontWeight, client)
    } catch (err) {
      if (err instanceof FontFetchError) throw new Error(`penpot_measure_text: ${err.message}`)
      throw err
    }
    return measureText(font, characters, fontSize, maxWidth)
  },
}

const loadTokenConfigInput = z.object({ tokensPath: z.string() })

function makeLoadTokenConfig(defaultTokensPath: string): ToolDefinition<z.infer<typeof loadTokenConfigInput>> {
  return {
    name: 'penpot_load_token_config',
    description:
      'Read and validate the project design-token file, returning the resolved colors/fonts/spacing/radii/shadows tables.',
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
        layout: resolveLayout(layout, tokens),
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

function makeAddVariantInput(tokensPath: string) {
  return z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    /** The id of the existing variant group container frame (returned as `containerId` by penpot_create_variant_group, same value as its variantId). */
    containerId: z.string().min(1),
    /** Name of the variant group (e.g. "Button"), used when registering the new component. */
    groupName: z.string().min(1),
    /** The new variant to add. Same rules as one entry in penpot_create_variant_group's variants array. */
    variant: z.object({
      /** Display label for this variant, e.g. "Tertiary". */
      name: z.string().min(1),
      /** Structured property/value pairs distinguishing this variant, e.g. [{ name: "Type", value: "Tertiary" }]. */
      properties: z.array(variantPropertySchema).min(1),
      /** This variant's shape tree — same rules as penpot_create_component's shapes (explicit ids to nest;
       * the one shape not parented to a sibling becomes this variant's main-instance root). Root shapes'
       * parentId/frameId are ignored and forced to the container. */
      shapes: z.array(shapeSpecSchema).min(1),
    }),
    tokensPath: z.string().default(tokensPath),
  })
}

function makeAddVariant(defaultTokensPath: string): ToolDefinition<z.infer<ReturnType<typeof makeAddVariantInput>>> {
  return {
    name: 'penpot_add_variant',
    description:
      'Add a new variant to an already-existing variant group container (created via penpot_create_variant_group). ' +
      'Accepts the same shape specs as one entry in penpot_create_variant_group\'s "variants" array. ' +
      'The containerId must be the id of the variant group\'s container frame (returned as "containerId" by ' +
      'penpot_create_variant_group, or found via penpot_find_shapes/penpot_list_components). Returns the new ' +
      'componentId and mainInstanceId, usable with penpot_add_component_instance.',
    inputSchema: makeAddVariantInput(defaultTokensPath),
    handler: async (client, { fileId, pageId, containerId, groupName, variant, tokensPath }) => {
      const tokens = await loadTokenFile(tokensPath)
      const file = await client.getFile(fileId)

      const page = file.data.pagesIndex[pageId]
      if (!page) throw new Error(`penpot_add_variant: page ${pageId} not found in file ${fileId}`)

      const objects = page.objects as Record<string, ShapeNode>
      const container = objects[containerId]
      if (!container) throw new Error(`penpot_add_variant: container ${containerId} not found on page ${pageId}`)

      // Validate it is actually a variant container
      const isVariantContainer = container.isVariantContainer ?? container['is-variant-container']
      if (!isVariantContainer) {
        throw new Error(
          `penpot_add_variant: shape ${containerId} is not a variant container (missing is-variant-container flag)`,
        )
      }

      // variantId is always the container's own id (verified live — see note on variantContainerAttrs)
      const variantId = containerId

      // Build the new variant's shapes
      const specsWithIds = variant.shapes.map((spec) => ({ ...spec, id: spec.id ?? randomUUID() }))
      const idsInBatch = new Set(specsWithIds.map((s) => s.id))
      const rootCandidates = specsWithIds.filter((s) => !idsInBatch.has(s.parentId))
      const rootCandidate = rootCandidates[0]
      if (rootCandidates.length !== 1 || !rootCandidate) {
        throw new Error(
          `penpot_add_variant: expected exactly one root shape (not parented to a sibling within its own shapes list), found ${rootCandidates.length}`,
        )
      }
      const rootId = rootCandidate.id!

      // Force the root's parent/frame to the container — reparenting via mov-objects is a silent
      // no-op on this RPC surface (verified), so the parent-id/frame-id must be set here at add-obj time.
      const specsForContainer = specsWithIds.map((spec) =>
        spec.id === rootId ? { ...spec, parentId: containerId, frameId: containerId } : spec,
      )

      const componentId = randomUUID()
      const newObjs = specsForContainer.map((spec) => buildShapeObject(spec, tokens))
      for (const obj of newObjs) {
        if (obj.id === rootId) {
          Object.assign(obj, componentRootAttrs(componentId, fileId, { variantId, name: variant.name }))
        }
      }

      // Re-add the container with the new root appended to its shapes array.
      // Uses the same camelCase-in/kebab-case-out round-trip pattern as buildReorderChange: spread the
      // whole shape, explicitly set the kebab-case fields Penpot requires (transform-inverse,
      // hide-fill-on-export, parent-id, frame-id, is-variant-container, variant-id), then delete their
      // camelCase duplicates so add-obj doesn't receive both forms.
      const currentShapes = (container.shapes ?? []) as string[]
      const parentOfContainerId =
        (container.parentId as string | undefined) ?? (container['parent-id'] as string | undefined) ?? ROOT_FRAME_ID
      const containerFrameId =
        (container.frameId as string | undefined) ?? (container['frame-id'] as string | undefined) ?? ROOT_FRAME_ID

      const mergedContainer: Record<string, unknown> = {
        ...container,
        shapes: [...currentShapes, rootId],
        'parent-id': parentOfContainerId,
        'frame-id': containerFrameId,
        'transform-inverse': container.transformInverse ?? container['transform-inverse'],
        'hide-fill-on-export': container.hideFillOnExport ?? container['hide-fill-on-export'] ?? false,
        'is-variant-container': true,
        'variant-id': container.variantId ?? container['variant-id'] ?? variantId,
      }
      delete mergedContainer.parentId
      delete mergedContainer.frameId
      delete mergedContainer.transformInverse
      delete mergedContainer.hideFillOnExport
      delete mergedContainer.isVariantContainer
      delete mergedContainer.growType

      const registerChange = addComponent(componentId, groupName, rootId, pageId, '', {
        variantId,
        properties: variant.properties,
      })
      const allChanges = [
        addObj(pageId, mergedContainer),
        ...newObjs.map((obj) => addObj(pageId, obj)),
        registerChange,
      ]
      const result = await client.updateFile(fileId, file.revn, file.vern, allChanges)
      return {
        componentId,
        mainInstanceId: rootId,
        shapeIds: newObjs.map((o) => o.id as string),
        revn: result.revn,
      }
    },
  }
}

const listComponentsInput = z.object({
  fileId: z.string().min(1),
  includeLibraries: z
    .boolean()
    .default(false)
    .describe(
      'When true, also list components from all shared-library files that are linked to this file. ' +
        'Each library component entry will include a libraryFileId and libraryFileName field. ' +
        'Pass the libraryFileId to penpot_add_component_instance to place an instance of that component.',
    ),
})

const listComponents: ToolDefinition<z.infer<typeof listComponentsInput>> = {
  name: 'penpot_list_components',
  description:
    "List a file's existing components (from its components map), instead of requiring the caller to have " +
    "created them itself in the same session or parse penpot_get_file_snapshot's data.components by hand. " +
    'Each entry includes the componentId (usable with penpot_add_component_instance), name, mainInstanceId/' +
    'mainInstancePage, and — for variant components — variantId/variantProperties. ' +
    'Set includeLibraries: true to also include components from connected shared-library files ' +
    '(each library component entry will carry a libraryFileId field for use with penpot_add_component_instance).',
  inputSchema: listComponentsInput,
  handler: async (client, { fileId, includeLibraries }) => {
    const file = await client.getFile(fileId)
    const ownComponents = Object.values(file.data.components ?? {}).map((c) => ({
      componentId: c.id,
      name: c.name,
      path: c.path,
      mainInstanceId: c.mainInstanceId,
      mainInstancePage: c.mainInstancePage,
      variantId: c.variantId,
      variantProperties: c.variantProperties,
    }))

    if (!includeLibraries) {
      return { components: ownComponents }
    }

    // Fetch library file metadata, then fetch each library's full data to access its components.
    const libraryEntries = await client.getFileLibraries(fileId)
    const libraryComponents = (
      await Promise.all(
        libraryEntries.map(async (entry) => {
          const libFile = await client.getFile(entry.id)
          return Object.values(libFile.data.components ?? {}).map((c) => ({
            componentId: c.id,
            name: c.name,
            path: c.path,
            mainInstanceId: c.mainInstanceId,
            mainInstancePage: c.mainInstancePage,
            variantId: c.variantId,
            variantProperties: c.variantProperties,
            libraryFileId: entry.id,
            libraryFileName: entry.name,
          }))
        }),
      )
    ).flat()

    return { components: [...ownComponents, ...libraryComponents] }
  },
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
    /**
     * When the component belongs to a connected shared-library file (not the current file),
     * supply that library file's id here. Obtain it from penpot_list_components with
     * includeLibraries: true — each library component entry carries a `libraryFileId` field.
     * Omit (or pass the same value as fileId) to use a component defined in the current file.
     */
    libraryFileId: z
      .string()
      .optional()
      .describe(
        "The id of the shared-library file that owns this component. " +
          "Returned as libraryFileId by penpot_list_components when includeLibraries is true. " +
          "Omit when the component belongs to the current file.",
      ),
  })
}

function makeAddComponentInstance(): ToolDefinition<z.infer<ReturnType<typeof makeAddComponentInstanceInput>>> {
  return {
    name: 'penpot_add_component_instance',
    description:
      'Place a copy (instance) of an existing component at a new position on a page. ' +
      'Clones the component\'s full main-instance shape tree with fresh ids, linked back to the main ' +
      'via shape-ref so Penpot recognizes it as a component copy. ' +
      'For components from a connected shared-library file, pass the library file\'s id as libraryFileId ' +
      '(returned by penpot_list_components with includeLibraries: true).',
    inputSchema: makeAddComponentInstanceInput(),
    handler: async (client, { fileId, pageId, componentId, x, y, parentId, frameId, libraryFileId }) => {
      // Always fetch the target file for its revn/vern (needed for update-file).
      const file = await client.getFile(fileId)

      // Resolve the file that actually owns the component.
      const effectiveLibraryFileId = libraryFileId && libraryFileId !== fileId ? libraryFileId : fileId
      const componentSource = effectiveLibraryFileId === fileId ? file : await client.getFile(effectiveLibraryFileId)

      const component = componentSource.data.components?.[componentId]
      if (!component) {
        const location =
          effectiveLibraryFileId === fileId
            ? `file ${fileId}`
            : `library file ${effectiveLibraryFileId}`
        throw new Error(`penpot_add_component_instance: no component ${componentId} found in ${location}`)
      }
      const mainPage = componentSource.data.pagesIndex[component.mainInstancePage]
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
        componentFileId: effectiveLibraryFileId,
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

/**
 * Builds an `add-obj` change that reparents an existing shape by updating its `parent-id`
 * while carrying forward all other fields verbatim — the same `restoreShapeAsAddObj` pattern
 * used for checkpoint restore and group/ungroup reparenting.
 */
function buildReparentChange(
  pageId: string,
  child: ShapeNode,
  newParentId: string,
  newFrameId: string,
): ReturnType<typeof addObj> {
  const merged: Record<string, unknown> = {
    ...child,
    'parent-id': newParentId,
    'frame-id': newFrameId,
    'transform-inverse': child.transformInverse ?? child['transform-inverse'],
    'hide-fill-on-export': child.hideFillOnExport ?? child['hide-fill-on-export'] ?? false,
  }
  delete merged.parentId
  delete merged.frameId
  delete merged.transformInverse
  delete merged.hideFillOnExport
  delete merged.growType
  return addObj(pageId, merged)
}

/**
 * Builds an `add-obj` change that updates a parent shape's `shapes` array, carrying forward
 * all other fields — the same pattern used by `buildReorderChange`.
 */
function buildUpdateParentShapesChange(
  pageId: string,
  parent: ShapeNode,
  newShapes: string[],
): ReturnType<typeof addObj> {
  const parentOfParentId =
    (parent.parentId as string | undefined) ?? (parent['parent-id'] as string | undefined) ?? ROOT_FRAME_ID
  const parentFrameId =
    (parent.frameId as string | undefined) ?? (parent['frame-id'] as string | undefined) ?? ROOT_FRAME_ID
  const merged: Record<string, unknown> = {
    ...parent,
    shapes: newShapes,
    'parent-id': parentOfParentId,
    'frame-id': parentFrameId,
    'transform-inverse': parent.transformInverse ?? parent['transform-inverse'],
    'hide-fill-on-export': parent.hideFillOnExport ?? parent['hide-fill-on-export'] ?? false,
  }
  delete merged.parentId
  delete merged.frameId
  delete merged.transformInverse
  delete merged.hideFillOnExport
  delete merged.growType
  return addObj(pageId, merged)
}

const groupShapesInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  /** Ids of the shapes to group. All must be siblings (share the same parent) on the page. */
  shapeIds: z.array(z.string().min(1)).min(1),
  /** Name for the new group. Defaults to "Group". */
  name: z.string().min(1).default('Group'),
  /** Optional caller-chosen UUID for the new group. A random UUID is used if omitted. */
  groupId: z.string().uuid().optional(),
})

const groupShapes: ToolDefinition<z.infer<typeof groupShapesInput>> = {
  name: 'penpot_group_shapes',
  description:
    'Group one or more existing sibling shapes into a new group, matching Penpot\'s own Ctrl+G behavior. ' +
    'All supplied shapeIds must share the same parent on the page. The new group is inserted into the parent ' +
    'at the z-order position of the topmost selected shape; the grouped shapes become the group\'s children ' +
    'and keep their existing absolute canvas positions. Returns the new groupId and the parent\'s updated ' +
    'shapes order. Use penpot_ungroup_shapes to reverse this operation.',
  inputSchema: groupShapesInput,
  handler: async (client, { fileId, pageId, shapeIds, name, groupId: suppliedGroupId }) => {
    const file = await client.getFile(fileId)
    const page = file.data.pagesIndex[pageId]
    if (!page) throw new Error(`penpot_group_shapes: page ${pageId} not found in file ${fileId}`)

    const objects = page.objects as Record<string, ShapeNode>

    for (const shapeId of shapeIds) {
      if (!objects[shapeId]) {
        throw new Error(`penpot_group_shapes: shape ${shapeId} not found on page ${pageId}`)
      }
    }

    const firstShape = objects[shapeIds[0]!]!
    const sharedParentId = (firstShape.parentId as string | undefined) ?? (firstShape['parent-id'] as string)
    const sharedFrameId = (firstShape.frameId as string | undefined) ?? (firstShape['frame-id'] as string)

    for (const shapeId of shapeIds.slice(1)) {
      const shape = objects[shapeId]!
      const parentId = (shape.parentId as string | undefined) ?? (shape['parent-id'] as string)
      if (parentId !== sharedParentId) {
        throw new Error(
          `penpot_group_shapes: all shapes must share the same parent; shape ${shapeId} has parent ${parentId}, expected ${sharedParentId}`,
        )
      }
    }

    const parent = objects[sharedParentId]
    if (!parent) throw new Error(`penpot_group_shapes: parent ${sharedParentId} not found`)

    // Compute the union bounding box of all selected shapes from their selrects.
    const boxes = shapeIds.map((id) => {
      const shape = objects[id]!
      const selrect = shape.selrect as { x1?: number; y1?: number; x2?: number; y2?: number } | undefined
      if (
        selrect?.x1 !== undefined &&
        selrect.y1 !== undefined &&
        selrect.x2 !== undefined &&
        selrect.y2 !== undefined
      ) {
        return { x1: selrect.x1, y1: selrect.y1, x2: selrect.x2, y2: selrect.y2 }
      }
      const x = shape.x as number
      const y = shape.y as number
      const w = shape.width as number
      const h = shape.height as number
      return { x1: x, y1: y, x2: x + w, y2: y + h }
    })
    const gx1 = Math.min(...boxes.map((b) => b.x1))
    const gy1 = Math.min(...boxes.map((b) => b.y1))
    const gx2 = Math.max(...boxes.map((b) => b.x2))
    const gy2 = Math.max(...boxes.map((b) => b.y2))

    const groupId = suppliedGroupId ?? randomUUID()

    // Preserve the children's existing z-order from the parent's shapes list.
    const parentShapes = parent.shapes ?? []
    const childrenInZOrder = parentShapes.filter((id) => shapeIds.includes(id))

    // Build the group object.
    const groupObj = group({
      id: groupId,
      name,
      x: gx1,
      y: gy1,
      width: gx2 - gx1,
      height: gy2 - gy1,
      parentId: sharedParentId,
      frameId: sharedFrameId,
      shapes: childrenInZOrder,
    })

    // Insert the group at the position of the lowest-indexed selected shape in the parent.
    const firstChildIndex = Math.min(
      ...shapeIds.map((id) => parentShapes.indexOf(id)).filter((i) => i !== -1),
    )
    const newParentShapes = parentShapes.filter((id) => !shapeIds.includes(id))
    newParentShapes.splice(firstChildIndex, 0, groupId)

    const changes: Change[] = [
      addObj(pageId, groupObj),
      ...childrenInZOrder.map((childId) =>
        buildReparentChange(pageId, objects[childId]!, groupId, sharedFrameId),
      ),
      buildUpdateParentShapesChange(pageId, parent, newParentShapes),
    ]

    const result = await client.updateFile(fileId, file.revn, file.vern, changes)
    return { groupId, childIds: childrenInZOrder, parentId: sharedParentId, revn: result.revn }
  },
}

const ungroupShapesInput = z.object({
  fileId: z.string().min(1),
  pageId: z.string().min(1),
  /** Id of the group shape to dissolve. Must be a shape of type "group". */
  groupId: z.string().min(1),
})

const ungroupShapes: ToolDefinition<z.infer<typeof ungroupShapesInput>> = {
  name: 'penpot_ungroup_shapes',
  description:
    'Dissolve a group, returning its children to the group\'s parent at the group\'s z-order position — ' +
    'matching Penpot\'s own Ctrl+Shift+G / "Ungroup" behavior. The supplied groupId must refer to a shape of ' +
    'type "group". After ungrouping, each former child keeps its absolute canvas position and gets the ' +
    'group\'s parent and frame as its new parent. The group shape itself is deleted. Returns the ids of ' +
    'the released children and the parent\'s updated shapes order.',
  inputSchema: ungroupShapesInput,
  handler: async (client, { fileId, pageId, groupId }) => {
    const file = await client.getFile(fileId)
    const page = file.data.pagesIndex[pageId]
    if (!page) throw new Error(`penpot_ungroup_shapes: page ${pageId} not found in file ${fileId}`)

    const objects = page.objects as Record<string, ShapeNode>
    const groupShape = objects[groupId] as ShapeNode | undefined
    if (!groupShape) throw new Error(`penpot_ungroup_shapes: shape ${groupId} not found on page ${pageId}`)
    if (groupShape.type !== 'group') {
      throw new Error(`penpot_ungroup_shapes: shape ${groupId} is not a group (type: ${groupShape.type})`)
    }

    const newParentId = (groupShape.parentId as string | undefined) ?? (groupShape['parent-id'] as string)
    const newFrameId = (groupShape.frameId as string | undefined) ?? (groupShape['frame-id'] as string)

    const parent = objects[newParentId]
    if (!parent) throw new Error(`penpot_ungroup_shapes: parent ${newParentId} not found`)

    const childIds = groupShape.shapes ?? []

    // Replace the group id in the parent's shapes list with the group's children (preserving their z-order).
    const parentShapes = parent.shapes ?? []
    const groupIndex = parentShapes.indexOf(groupId)
    const newParentShapes = [
      ...parentShapes.slice(0, groupIndex),
      ...childIds,
      ...parentShapes.slice(groupIndex + 1),
    ]

    const changes: Change[] = [
      ...childIds.map((childId) => {
        const child = objects[childId] as ShapeNode | undefined
        if (!child) throw new Error(`penpot_ungroup_shapes: child ${childId} not found on page`)
        return buildReparentChange(pageId, child, newParentId, newFrameId)
      }),
      buildUpdateParentShapesChange(pageId, parent, newParentShapes),
      delObj(pageId, groupId),
    ]

    const result = await client.updateFile(fileId, file.revn, file.vern, changes)
    return { ungroupedShapeIds: childIds, parentId: newParentId, revn: result.revn }
  },
}

export function contentTools(defaultTokensPath: string) {
  return [
    createPage,
    listPages,
    renamePageTool,
    deletePageTool,
    makeAddShapes(defaultTokensPath),
    makeUpdateShapes(defaultTokensPath),
    deleteShapes,
    cloneShapes,
    groupShapes,
    ungroupShapes,
    reorderShapes,
    makeAlignShapes(defaultTokensPath),
    makeDistributeShapes(defaultTokensPath),
    makeBatch(defaultTokensPath),
    checkpointTool,
    restoreCheckpointTool,
    discardCheckpointTool,
    getShape,
    findShapes,
    replaceText,
    uploadMediaTool,
    measureTextTool,
    makeLoadTokenConfig(defaultTokensPath),
    makeCreateComponent(defaultTokensPath),
    makeAddComponentInstance(),
    makeCreateVariantGroup(defaultTokensPath),
    makeAddVariant(defaultTokensPath),
    listComponents,
  ]
}
