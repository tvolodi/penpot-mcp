/**
 * Unit tests for page-management tools and penpot_add_variant.
 *
 * These exercise pure handler logic (page listing/rename/delete guards, variant
 * container validation, argument exclusivity for upload_media) without any network
 * calls — the PenpotRpcClient is fully mocked.
 */

import { resolve } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { contentTools } from '../../src/tools/content.js'
import { ROOT_FRAME_ID } from '../../src/shape-builders.js'
import type { PenpotRpcClient } from '../../src/rpc-client.js'
import type { ZodType } from 'zod'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Path to the shared token fixture used by the integration suite. */
const TEST_TOKENS_PATH = resolve(import.meta.dirname, '../integration/fixtures/tokens.json')

type AnyTool = {
  name: string
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: ZodType<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (client: PenpotRpcClient, input: any) => Promise<unknown>
}

const TOOLS = contentTools(TEST_TOKENS_PATH) as unknown as AnyTool[]

function getTool(name: string): AnyTool {
  const t = TOOLS.find((t) => t.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return t
}

/** Parse input through the tool's Zod schema (applying defaults) then call the handler. */
function callTool(tool: AnyTool, client: PenpotRpcClient, input: Record<string, unknown>): Promise<unknown> {
  const parsed = tool.inputSchema.parse(input)
  return tool.handler(client, parsed)
}

const PAGE_ID = 'page-1'
const FILE_ID = 'file-1'

/** Build a minimal mock client whose getFile returns two pages. */
function makeClient(overrides: Partial<PenpotRpcClient> = {}): PenpotRpcClient {
  const rootFrame = {
    id: ROOT_FRAME_ID,
    type: 'frame',
    name: 'root',
    parentId: ROOT_FRAME_ID,
    frameId: ROOT_FRAME_ID,
    'parent-id': ROOT_FRAME_ID,
    'frame-id': ROOT_FRAME_ID,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    hideFillOnExport: false,
    'hide-fill-on-export': false,
    x: 0, y: 0, width: 1920, height: 1080, rotation: 0,
    shapes: [],
    fills: [], strokes: [], shadows: [],
    selrect: { x: 0, y: 0, width: 1920, height: 1080, x1: 0, y1: 0, x2: 1920, y2: 1080 },
  }

  return {
    getFile: vi.fn().mockResolvedValue({
      id: FILE_ID,
      revn: 0,
      vern: 0,
      data: {
        pages: [PAGE_ID, 'page-2'],
        pagesIndex: {
          [PAGE_ID]: { name: 'Page 1', objects: { [ROOT_FRAME_ID]: rootFrame } },
          'page-2': { name: 'Page 2', objects: { [ROOT_FRAME_ID]: { ...rootFrame } } },
        },
      },
    }),
    updateFile: vi.fn().mockResolvedValue({ revn: 1 }),
    ...overrides,
  } as unknown as PenpotRpcClient
}

// ── penpot_create_page ───────────────────────────────────────────────────────

describe('penpot_create_page', () => {
  it('calls updateFile with an add-page change and returns the new pageId', async () => {
    const client = makeClient()
    const tool = getTool('penpot_create_page')

    const result = (await tool.handler(client, { fileId: FILE_ID, name: 'Design' })) as {
      pageId: string
      pageName: string
      revn: number
    }

    expect(result.pageName).toBe('Design')
    expect(typeof result.pageId).toBe('string')
    expect(result.pageId.length).toBeGreaterThan(0)
    expect(result.revn).toBe(1)

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string, number, number, Array<{ type: string; name?: string }>,
    ]
    expect(changes).toHaveLength(1)
    expect(changes[0]!.type).toBe('add-page')
    expect(changes[0]!.name).toBe('Design')
  })

  it('input schema rejects an empty name', () => {
    const tool = getTool('penpot_create_page')
    expect(() => tool.inputSchema.parse({ fileId: FILE_ID, name: '' })).toThrow()
  })
})

// ── penpot_list_pages ────────────────────────────────────────────────────────

describe('penpot_list_pages', () => {
  it('returns each page id and name in order', async () => {
    const client = makeClient()
    const tool = getTool('penpot_list_pages')

    const result = (await tool.handler(client, { fileId: FILE_ID })) as {
      pages: Array<{ id: string; name: string }>
    }

    expect(result.pages).toHaveLength(2)
    expect(result.pages[0]).toEqual({ id: PAGE_ID, name: 'Page 1' })
    expect(result.pages[1]).toEqual({ id: 'page-2', name: 'Page 2' })
  })

  it('calls getFile with the given fileId', async () => {
    const client = makeClient()
    const tool = getTool('penpot_list_pages')

    await tool.handler(client, { fileId: FILE_ID })

    expect(client.getFile).toHaveBeenCalledWith(FILE_ID)
    expect(client.getFile).toHaveBeenCalledTimes(1)
    // list is read-only — no mutations
    expect(client.updateFile).not.toHaveBeenCalled()
  })

  it('input schema rejects a missing fileId', () => {
    const tool = getTool('penpot_list_pages')
    expect(() => tool.inputSchema.parse({})).toThrow()
  })
})

// ── penpot_rename_page ───────────────────────────────────────────────────────

describe('penpot_rename_page', () => {
  it('calls updateFile with a rename-page change', async () => {
    const client = makeClient()
    const tool = getTool('penpot_rename_page')

    const result = (await tool.handler(client, { fileId: FILE_ID, pageId: PAGE_ID, name: 'Flows' })) as {
      pageId: string
      name: string
      revn: number
    }

    expect(result.pageId).toBe(PAGE_ID)
    expect(result.name).toBe('Flows')
    expect(result.revn).toBe(1)

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string, number, number, Array<{ type: string; id?: string; name?: string }>,
    ]
    expect(changes).toHaveLength(1)
    expect(changes[0]!.type).toBe('rename-page')
    expect(changes[0]!.id).toBe(PAGE_ID)
    expect(changes[0]!.name).toBe('Flows')
  })

  it('throws when the pageId does not exist in the file', async () => {
    const client = makeClient()
    const tool = getTool('penpot_rename_page')

    await expect(
      tool.handler(client, { fileId: FILE_ID, pageId: 'nonexistent', name: 'X' }),
    ).rejects.toThrow(/not found/)
  })

  it('input schema rejects an empty name', () => {
    const tool = getTool('penpot_rename_page')
    expect(() => tool.inputSchema.parse({ fileId: FILE_ID, pageId: PAGE_ID, name: '' })).toThrow()
  })
})

// ── penpot_delete_page ───────────────────────────────────────────────────────

describe('penpot_delete_page', () => {
  it('calls updateFile with a del-page change', async () => {
    const client = makeClient()
    const tool = getTool('penpot_delete_page')

    const result = (await tool.handler(client, { fileId: FILE_ID, pageId: PAGE_ID })) as {
      deleted: string
      revn: number
    }

    expect(result.deleted).toBe(PAGE_ID)
    expect(result.revn).toBe(1)

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string, number, number, Array<{ type: string; id?: string }>,
    ]
    expect(changes).toHaveLength(1)
    expect(changes[0]!.type).toBe('del-page')
    expect(changes[0]!.id).toBe(PAGE_ID)
  })

  it('throws when the pageId does not exist in the file', async () => {
    const client = makeClient()
    const tool = getTool('penpot_delete_page')

    await expect(
      tool.handler(client, { fileId: FILE_ID, pageId: 'nonexistent' }),
    ).rejects.toThrow(/not found/)
  })

  it('throws when trying to delete the last page of a file', async () => {
    // Override getFile to return a file with only one page
    const client = makeClient({
      getFile: vi.fn().mockResolvedValue({
        id: FILE_ID,
        revn: 0,
        vern: 0,
        data: {
          pages: [PAGE_ID],
          pagesIndex: {
            [PAGE_ID]: { name: 'Only Page', objects: {} },
          },
        },
      }),
    })
    const tool = getTool('penpot_delete_page')

    await expect(
      tool.handler(client, { fileId: FILE_ID, pageId: PAGE_ID }),
    ).rejects.toThrow(/last page/)
  })

  it('input schema rejects a missing pageId', () => {
    const tool = getTool('penpot_delete_page')
    expect(() => tool.inputSchema.parse({ fileId: FILE_ID })).toThrow()
  })
})

// ── penpot_upload_media (schema validation only) ─────────────────────────────

describe('penpot_upload_media', () => {
  it('is registered as a tool', () => {
    const tool = getTool('penpot_upload_media')
    expect(tool.name).toBe('penpot_upload_media')
    expect(tool.description.length).toBeGreaterThan(0)
  })

  it('input schema accepts a filePath source', () => {
    const tool = getTool('penpot_upload_media')
    expect(() =>
      tool.inputSchema.parse({ fileId: FILE_ID, name: 'icon.png', filePath: '/tmp/icon.png' }),
    ).not.toThrow()
  })

  it('input schema accepts a url source', () => {
    const tool = getTool('penpot_upload_media')
    expect(() =>
      tool.inputSchema.parse({ fileId: FILE_ID, name: 'logo', url: 'https://example.com/logo.png' }),
    ).not.toThrow()
  })

  it('input schema accepts a dataBase64 + mtype source', () => {
    const tool = getTool('penpot_upload_media')
    expect(() =>
      tool.inputSchema.parse({ fileId: FILE_ID, name: 'pixel', dataBase64: 'AAAA', mtype: 'image/png' }),
    ).not.toThrow()
  })

  it('input schema rejects a non-URL string for url', () => {
    const tool = getTool('penpot_upload_media')
    expect(() =>
      tool.inputSchema.parse({ fileId: FILE_ID, name: 'bad', url: 'not-a-url' }),
    ).toThrow()
  })

  it('handler throws when more than one source is provided (mutually exclusive)', async () => {
    const client = makeClient()
    const tool = getTool('penpot_upload_media')

    await expect(
      tool.handler(client, {
        fileId: FILE_ID,
        name: 'conflict',
        filePath: '/tmp/a.png',
        url: 'https://example.com/b.png',
      }),
    ).rejects.toThrow(/mutually exclusive/)
  })

  it('handler throws when no source is provided', async () => {
    const client = makeClient()
    const tool = getTool('penpot_upload_media')

    await expect(
      tool.handler(client, { fileId: FILE_ID, name: 'nosource' }),
    ).rejects.toThrow(/exactly one/)
  })

  it('handler throws when dataBase64 is given without mtype', async () => {
    const client = makeClient()
    const tool = getTool('penpot_upload_media')

    await expect(
      tool.handler(client, { fileId: FILE_ID, name: 'b64', dataBase64: 'AAAA' }),
    ).rejects.toThrow(/mtype/)
  })
})

// ── penpot_add_variant (handler validation) ───────────────────────────────────

describe('penpot_add_variant', () => {
  const CONTAINER_ID = 'container-1'
  const VARIANT_ROOT_ID = 'variant-root-1'

  /** Build a mock client with a variant container already on the page. */
  function makeVariantClient(containerAttrs: Record<string, unknown> = {}): PenpotRpcClient {
    const rootFrame = {
      id: ROOT_FRAME_ID,
      type: 'frame',
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      'parent-id': ROOT_FRAME_ID,
      'frame-id': ROOT_FRAME_ID,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      hideFillOnExport: false,
      'hide-fill-on-export': false,
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0,
      shapes: [CONTAINER_ID],
      fills: [], strokes: [], shadows: [],
      selrect: { x: 0, y: 0, width: 1920, height: 1080, x1: 0, y1: 0, x2: 1920, y2: 1080 },
    }

    const container = {
      id: CONTAINER_ID,
      type: 'frame',
      name: 'Button',
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      'parent-id': ROOT_FRAME_ID,
      'frame-id': ROOT_FRAME_ID,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      hideFillOnExport: false,
      'hide-fill-on-export': false,
      x: 0, y: 0, width: 120, height: 40, rotation: 0,
      shapes: [VARIANT_ROOT_ID],
      fills: [], strokes: [], shadows: [],
      selrect: { x: 0, y: 0, width: 120, height: 40, x1: 0, y1: 0, x2: 120, y2: 40 },
      isVariantContainer: true,
      'is-variant-container': true,
      variantId: CONTAINER_ID,
      'variant-id': CONTAINER_ID,
      ...containerAttrs,
    }

    const existingVariant = {
      id: VARIANT_ROOT_ID,
      type: 'frame',
      name: 'Primary',
      parentId: CONTAINER_ID,
      frameId: CONTAINER_ID,
      'parent-id': CONTAINER_ID,
      'frame-id': CONTAINER_ID,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      hideFillOnExport: false,
      'hide-fill-on-export': false,
      x: 0, y: 0, width: 120, height: 40, rotation: 0,
      shapes: [],
      fills: [], strokes: [], shadows: [],
      selrect: { x: 0, y: 0, width: 120, height: 40, x1: 0, y1: 0, x2: 120, y2: 40 },
    }

    return {
      getFile: vi.fn().mockResolvedValue({
        id: FILE_ID,
        revn: 0,
        vern: 0,
        data: {
          pages: [PAGE_ID],
          pagesIndex: {
            [PAGE_ID]: {
              name: 'Page 1',
              objects: {
                [ROOT_FRAME_ID]: rootFrame,
                [CONTAINER_ID]: container,
                [VARIANT_ROOT_ID]: existingVariant,
              },
            },
          },
        },
      }),
      updateFile: vi.fn().mockResolvedValue({ revn: 1 }),
    } as unknown as PenpotRpcClient
  }

  it('throws when the page is not found', async () => {
    const client = makeVariantClient()
    const tool = getTool('penpot_add_variant')

    await expect(
      callTool(tool, client, {
        fileId: FILE_ID,
        pageId: 'nonexistent',
        containerId: CONTAINER_ID,
        groupName: 'Button',
        variant: { name: 'Secondary', properties: [{ name: 'Type', value: 'Secondary' }], shapes: [{ type: 'rect', name: 'BG', x: 0, y: 0, width: 120, height: 40 }] },
      }),
    ).rejects.toThrow(/not found/)
  })

  it('throws when the container is not found on the page', async () => {
    const client = makeVariantClient()
    const tool = getTool('penpot_add_variant')

    await expect(
      callTool(tool, client, {
        fileId: FILE_ID,
        pageId: PAGE_ID,
        containerId: 'missing-container',
        groupName: 'Button',
        variant: { name: 'Secondary', properties: [{ name: 'Type', value: 'Secondary' }], shapes: [{ type: 'rect', name: 'BG', x: 0, y: 0, width: 120, height: 40 }] },
      }),
    ).rejects.toThrow(/not found/)
  })

  it('throws when the container shape is not a variant container', async () => {
    // Container without the is-variant-container flag
    const client = makeVariantClient({
      isVariantContainer: false,
      'is-variant-container': false,
    })
    const tool = getTool('penpot_add_variant')

    await expect(
      callTool(tool, client, {
        fileId: FILE_ID,
        pageId: PAGE_ID,
        containerId: CONTAINER_ID,
        groupName: 'Button',
        variant: { name: 'Secondary', properties: [{ name: 'Type', value: 'Secondary' }], shapes: [{ type: 'rect', name: 'BG', x: 0, y: 0, width: 120, height: 40 }] },
      }),
    ).rejects.toThrow(/not a variant container/)
  })

  it('throws when the variant spec has more than one root shape', async () => {
    const client = makeVariantClient()
    const tool = getTool('penpot_add_variant')

    // Two shapes with no parentId means two root candidates
    await expect(
      callTool(tool, client, {
        fileId: FILE_ID,
        pageId: PAGE_ID,
        containerId: CONTAINER_ID,
        groupName: 'Button',
        variant: {
          name: 'Secondary',
          properties: [{ name: 'Type', value: 'Secondary' }],
          shapes: [
            { type: 'rect', name: 'Root1', x: 0, y: 0, width: 60, height: 40 },
            { type: 'rect', name: 'Root2', x: 60, y: 0, width: 60, height: 40 },
          ],
        },
      }),
    ).rejects.toThrow(/expected exactly one root/)
  })

  it('calls updateFile and returns componentId + mainInstanceId on success', async () => {
    const client = makeVariantClient()
    const tool = getTool('penpot_add_variant')

    const result = (await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      containerId: CONTAINER_ID,
      groupName: 'Button',
      variant: {
        name: 'Secondary',
        properties: [{ name: 'Type', value: 'Secondary' }],
        shapes: [{ type: 'rect', name: 'SecondaryBG', x: 0, y: 0, width: 120, height: 40 }],
      },
    })) as { componentId: string; mainInstanceId: string; revn: number }

    expect(typeof result.componentId).toBe('string')
    expect(result.componentId.length).toBeGreaterThan(0)
    expect(typeof result.mainInstanceId).toBe('string')
    expect(result.mainInstanceId.length).toBeGreaterThan(0)
    expect(result.revn).toBe(1)
    expect(client.updateFile).toHaveBeenCalledTimes(1)
  })

  it('appends the new root id to the container\'s shapes array in the updateFile changes', async () => {
    const client = makeVariantClient()
    const tool = getTool('penpot_add_variant')

    await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      containerId: CONTAINER_ID,
      groupName: 'Button',
      variant: {
        name: 'Secondary',
        properties: [{ name: 'Type', value: 'Secondary' }],
        shapes: [{ type: 'rect', name: 'SecondaryBG', x: 0, y: 0, width: 120, height: 40 }],
      },
    })

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string, number, number, Array<{ type: string; obj?: Record<string, unknown> }>,
    ]
    // First change is the container re-add with the new root appended
    const containerChange = changes.find((c) => c.obj?.id === CONTAINER_ID)
    expect(containerChange).toBeDefined()
    const containerShapes = containerChange!.obj!.shapes as string[]
    expect(containerShapes).toContain(VARIANT_ROOT_ID) // original variant still there
    expect(containerShapes.length).toBe(2)             // plus the new one
  })

  it('input schema rejects variant with zero shapes', () => {
    const tool = getTool('penpot_add_variant')
    expect(() =>
      tool.inputSchema.parse({
        fileId: FILE_ID,
        pageId: PAGE_ID,
        containerId: CONTAINER_ID,
        groupName: 'Button',
        variant: { name: 'Secondary', properties: [{ name: 'Type', value: 'Secondary' }], shapes: [] },
      }),
    ).toThrow()
  })
})

// ── Tool registration smoke tests ─────────────────────────────────────────────

describe('page and media tool registration', () => {
  const toolNames = [
    'penpot_create_page',
    'penpot_list_pages',
    'penpot_rename_page',
    'penpot_delete_page',
    'penpot_upload_media',
    'penpot_add_variant',
  ]

  for (const name of toolNames) {
    it(`${name} is registered and has a non-empty description`, () => {
      const tool = getTool(name)
      expect(tool.name).toBe(name)
      expect(tool.description.length).toBeGreaterThan(0)
    })
  }
})

// ── penpot_checkpoint (whole-file / cross-page mode) ─────────────────────────

describe('penpot_checkpoint whole-file mode', () => {
  it('omitting pageId snapshots all pages and returns pageCount > 1', async () => {
    const client = makeClient()
    const tool = getTool('penpot_checkpoint')

    const result = (await callTool(tool, client, { fileId: FILE_ID })) as {
      checkpointId: string
      pageIds: string[]
      pageCount: number
      shapeCount: number
    }

    expect(typeof result.checkpointId).toBe('string')
    expect(result.pageCount).toBe(2)
    expect(result.pageIds).toContain(PAGE_ID)
    expect(result.pageIds).toContain('page-2')
    // Each page has at least the root frame shape
    expect(result.shapeCount).toBeGreaterThanOrEqual(2)
  })

  it('supplying a pageId still snapshots only that one page', async () => {
    const client = makeClient()
    const tool = getTool('penpot_checkpoint')

    const result = (await callTool(tool, client, { fileId: FILE_ID, pageId: PAGE_ID })) as {
      pageIds: string[]
      pageCount: number
    }

    expect(result.pageCount).toBe(1)
    expect(result.pageIds).toEqual([PAGE_ID])
  })

  it('schema treats pageId as optional (no throw when omitted)', () => {
    const tool = getTool('penpot_checkpoint')
    expect(() => tool.inputSchema.parse({ fileId: FILE_ID })).not.toThrow()
  })

  it('schema still accepts pageId when supplied', () => {
    const tool = getTool('penpot_checkpoint')
    expect(() => tool.inputSchema.parse({ fileId: FILE_ID, pageId: PAGE_ID })).not.toThrow()
  })
})

describe('penpot_restore_checkpoint whole-file mode', () => {
  const PAGE2_ID = 'page-2'

  /** Build a client where page-2 has an extra shape that was "created after the checkpoint". */
  function makeMultiPageClient(page2ExtraShape: Record<string, unknown> = {}): PenpotRpcClient {
    const rootFrame = {
      id: ROOT_FRAME_ID,
      type: 'frame',
      name: 'root',
      parentId: ROOT_FRAME_ID,
      frameId: ROOT_FRAME_ID,
      'parent-id': ROOT_FRAME_ID,
      'frame-id': ROOT_FRAME_ID,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      hideFillOnExport: false,
      'hide-fill-on-export': false,
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0,
      shapes: [],
      fills: [], strokes: [], shadows: [],
      selrect: { x: 0, y: 0, width: 1920, height: 1080, x1: 0, y1: 0, x2: 1920, y2: 1080 },
    }

    const page2Objects: Record<string, unknown> = {
      [ROOT_FRAME_ID]: { ...rootFrame },
      ...page2ExtraShape,
    }

    return {
      // First call = checkpoint (no extra shape yet); second call = restore (extra shape present)
      getFile: vi.fn()
        .mockResolvedValueOnce({
          id: FILE_ID, revn: 0, vern: 0,
          data: {
            pages: [PAGE_ID, PAGE2_ID],
            pagesIndex: {
              [PAGE_ID]: { name: 'Page 1', objects: { [ROOT_FRAME_ID]: { ...rootFrame } } },
              [PAGE2_ID]: { name: 'Page 2', objects: { [ROOT_FRAME_ID]: { ...rootFrame } } },
            },
          },
        })
        .mockResolvedValueOnce({
          id: FILE_ID, revn: 1, vern: 1,
          data: {
            pages: [PAGE_ID, PAGE2_ID],
            pagesIndex: {
              [PAGE_ID]: { name: 'Page 1', objects: { [ROOT_FRAME_ID]: { ...rootFrame } } },
              [PAGE2_ID]: { name: 'Page 2', objects: page2Objects },
            },
          },
        }),
      updateFile: vi.fn().mockResolvedValue({ revn: 2 }),
    } as unknown as PenpotRpcClient
  }

  it('restores a shape deleted from page-2 while page-1 is untouched', async () => {
    const extraShape = {
      'extra-shape': {
        id: 'extra-shape',
        type: 'rect',
        name: 'Intruder',
        parentId: ROOT_FRAME_ID,
        'parent-id': ROOT_FRAME_ID,
        frameId: ROOT_FRAME_ID,
        'frame-id': ROOT_FRAME_ID,
        transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        hideFillOnExport: false,
        'hide-fill-on-export': false,
        x: 0, y: 0, width: 10, height: 10, rotation: 0,
        shapes: [],
        fills: [], strokes: [], shadows: [],
        selrect: { x: 0, y: 0, width: 10, height: 10, x1: 0, y1: 0, x2: 10, y2: 10 },
      },
    }
    const client = makeMultiPageClient(extraShape)

    // Take whole-file checkpoint (no pageId)
    const cpTool = getTool('penpot_checkpoint')
    const cp = (await callTool(cpTool, client, { fileId: FILE_ID })) as { checkpointId: string }

    // Restore: page-2 now has an extra shape not in the checkpoint → it should be deleted
    const restoreTool = getTool('penpot_restore_checkpoint')
    const result = (await callTool(restoreTool, client, { checkpointId: cp.checkpointId })) as {
      deletedShapeCount: number
      revn: number
    }

    expect(result.deletedShapeCount).toBe(1)
    expect(result.revn).toBe(2)
    expect(client.updateFile).toHaveBeenCalledTimes(1)
  })

  it('sends changes for both pages in a single updateFile call', async () => {
    const client = makeMultiPageClient()
    const cpTool = getTool('penpot_checkpoint')
    const cp = (await callTool(cpTool, client, { fileId: FILE_ID })) as { checkpointId: string }

    const restoreTool = getTool('penpot_restore_checkpoint')
    await callTool(restoreTool, client, { checkpointId: cp.checkpointId })

    // Both pages → changes sent in one updateFile call (not two)
    expect(client.updateFile).toHaveBeenCalledTimes(1)
  })
})
