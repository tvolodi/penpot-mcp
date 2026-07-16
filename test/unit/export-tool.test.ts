/**
 * Unit tests for the penpot_export_batch input schema and spec-building logic.
 *
 * These tests do not require a live Penpot instance or any network call —
 * they exercise the Zod validation and the mapping from validated input to
 * BatchExportSpec[] entirely in process.
 */

import { describe, it, expect } from 'vitest'
import { exportBatchInput, exportBatchBaseSchema } from '../../src/tools/export.js'
import type { BatchExportSpec } from '../../src/exporter-client.js'

const FILE_ID = 'aaaaaaaa-0000-0000-0000-000000000000'
const PAGE_ID_1 = 'bbbbbbbb-0000-0000-0000-000000000000'
const PAGE_ID_2 = 'cccccccc-0000-0000-0000-000000000000'
const SHAPE_1 = 'dddddddd-0000-0000-0000-000000000001'
const SHAPE_2 = 'dddddddd-0000-0000-0000-000000000002'

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('exportBatchInput schema validation', () => {
  it('accepts shapeIds with a top-level pageId', () => {
    const result = exportBatchInput.safeParse({
      fileId: FILE_ID,
      pageId: PAGE_ID_1,
      shapeIds: [SHAPE_1, SHAPE_2],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a shapes array with per-shape pageIds', () => {
    const result = exportBatchInput.safeParse({
      fileId: FILE_ID,
      shapes: [
        { shapeId: SHAPE_1, pageId: PAGE_ID_1 },
        { shapeId: SHAPE_2, pageId: PAGE_ID_2 },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a shapes array using a top-level pageId as fallback', () => {
    const result = exportBatchInput.safeParse({
      fileId: FILE_ID,
      pageId: PAGE_ID_1,
      shapes: [
        { shapeId: SHAPE_1 },
        { shapeId: SHAPE_2, pageId: PAGE_ID_2 },  // overrides top-level
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects when neither shapeIds nor shapes is provided', () => {
    const result = exportBatchInput.safeParse({ fileId: FILE_ID, pageId: PAGE_ID_1 })
    expect(result.success).toBe(false)
  })

  it('rejects when both shapeIds and shapes are provided', () => {
    const result = exportBatchInput.safeParse({
      fileId: FILE_ID,
      pageId: PAGE_ID_1,
      shapeIds: [SHAPE_1],
      shapes: [{ shapeId: SHAPE_2, pageId: PAGE_ID_2 }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects shapeIds without a top-level pageId', () => {
    const result = exportBatchInput.safeParse({
      fileId: FILE_ID,
      shapeIds: [SHAPE_1],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a shapes entry with no pageId when no top-level pageId is set', () => {
    const result = exportBatchInput.safeParse({
      fileId: FILE_ID,
      shapes: [
        { shapeId: SHAPE_1 },  // no pageId, no top-level pageId
      ],
    })
    expect(result.success).toBe(false)
  })

  it('applies format and scale defaults', () => {
    const result = exportBatchInput.safeParse({
      fileId: FILE_ID,
      pageId: PAGE_ID_1,
      shapeIds: [SHAPE_1],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.format).toBe('png')
      expect(result.data.scale).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Spec-building helpers (tested via the parsed output, mirroring the handler)
// ---------------------------------------------------------------------------

/**
 * Reproduces the spec-building logic in the penpot_export_batch handler,
 * so it can be exercised as a pure unit test without spinning up an MCP server.
 */
function buildSpecs(input: ReturnType<typeof exportBatchInput.parse>): BatchExportSpec[] {
  const { pageId, shapeIds, shapes, format, scale } = input
  if (shapeIds !== undefined) {
    return shapeIds.map((shapeId, i) => ({
      shapeId,
      pageId: pageId!,
      format,
      scale,
      name: `export-${i + 1}`,
    }))
  }
  return shapes!.map((s, i) => ({
    shapeId: s.shapeId,
    pageId: s.pageId ?? pageId!,
    format: s.format ?? format,
    scale: s.scale ?? scale,
    name: s.name ?? `export-${i + 1}`,
  }))
}

describe('penpot_export_batch spec building', () => {
  it('shapeIds path: all specs share the top-level pageId, format, and scale', () => {
    const parsed = exportBatchInput.parse({
      fileId: FILE_ID,
      pageId: PAGE_ID_1,
      shapeIds: [SHAPE_1, SHAPE_2],
      format: 'svg',
      scale: 2,
    })
    const specs = buildSpecs(parsed)
    expect(specs).toHaveLength(2)
    expect(specs[0]).toMatchObject({ shapeId: SHAPE_1, pageId: PAGE_ID_1, format: 'svg', scale: 2, name: 'export-1' })
    expect(specs[1]).toMatchObject({ shapeId: SHAPE_2, pageId: PAGE_ID_1, format: 'svg', scale: 2, name: 'export-2' })
  })

  it('shapes path: each spec gets its own pageId', () => {
    const parsed = exportBatchInput.parse({
      fileId: FILE_ID,
      shapes: [
        { shapeId: SHAPE_1, pageId: PAGE_ID_1 },
        { shapeId: SHAPE_2, pageId: PAGE_ID_2 },
      ],
    })
    const specs = buildSpecs(parsed)
    expect(specs).toHaveLength(2)
    expect(specs[0]!.pageId).toBe(PAGE_ID_1)
    expect(specs[1]!.pageId).toBe(PAGE_ID_2)
  })

  it('shapes path: per-shape pageId overrides the top-level pageId', () => {
    const parsed = exportBatchInput.parse({
      fileId: FILE_ID,
      pageId: PAGE_ID_1,
      shapes: [
        { shapeId: SHAPE_1 },              // falls back to top-level
        { shapeId: SHAPE_2, pageId: PAGE_ID_2 },  // overrides
      ],
    })
    const specs = buildSpecs(parsed)
    expect(specs[0]!.pageId).toBe(PAGE_ID_1)
    expect(specs[1]!.pageId).toBe(PAGE_ID_2)
  })

  it('shapes path: per-shape format and scale override the defaults', () => {
    const parsed = exportBatchInput.parse({
      fileId: FILE_ID,
      pageId: PAGE_ID_1,
      format: 'png',
      scale: 1,
      shapes: [
        { shapeId: SHAPE_1 },                         // uses defaults
        { shapeId: SHAPE_2, format: 'pdf', scale: 3 }, // overrides
      ],
    })
    const specs = buildSpecs(parsed)
    expect(specs[0]).toMatchObject({ format: 'png', scale: 1 })
    expect(specs[1]).toMatchObject({ format: 'pdf', scale: 3 })
  })

  it('shapes path: per-shape name is used when provided', () => {
    const parsed = exportBatchInput.parse({
      fileId: FILE_ID,
      pageId: PAGE_ID_1,
      shapes: [
        { shapeId: SHAPE_1, name: 'hero-banner' },
        { shapeId: SHAPE_2 },
      ],
    })
    const specs = buildSpecs(parsed)
    expect(specs[0]!.name).toBe('hero-banner')
    expect(specs[1]!.name).toBe('export-2')
  })

  it('shapes path: a single-page batch with no top-level pageId still works', () => {
    const parsed = exportBatchInput.parse({
      fileId: FILE_ID,
      shapes: [
        { shapeId: SHAPE_1, pageId: PAGE_ID_1 },
        { shapeId: SHAPE_2, pageId: PAGE_ID_1 },
      ],
    })
    const specs = buildSpecs(parsed)
    expect(specs.every((s) => s.pageId === PAGE_ID_1)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// exportBatchBaseSchema (used for MCP inputSchema registration)
// ---------------------------------------------------------------------------

describe('exportBatchBaseSchema', () => {
  it('has a .shape property (ZodObject, required by MCP SDK registration)', () => {
    expect(typeof exportBatchBaseSchema.shape).toBe('object')
    expect(exportBatchBaseSchema.shape).toHaveProperty('fileId')
    expect(exportBatchBaseSchema.shape).toHaveProperty('pageId')
    expect(exportBatchBaseSchema.shape).toHaveProperty('shapeIds')
    expect(exportBatchBaseSchema.shape).toHaveProperty('shapes')
    expect(exportBatchBaseSchema.shape).toHaveProperty('format')
    expect(exportBatchBaseSchema.shape).toHaveProperty('scale')
  })
})
