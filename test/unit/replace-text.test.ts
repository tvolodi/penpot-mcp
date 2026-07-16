/**
 * Unit tests for penpot_replace_text.
 *
 * These tests exercise the pure handler logic — search matching, per-run
 * replacement, case-sensitivity, limit capping, skip of non-text shapes,
 * and the no-match early-exit path — without any network calls.
 * PenpotRpcClient is fully mocked.
 */

import { describe, it, expect, vi } from 'vitest'
import { contentTools } from '../../src/tools/content.js'
import { ROOT_FRAME_ID } from '../../src/shape-builders.js'
import type { PenpotRpcClient } from '../../src/rpc-client.js'
import type { ZodType } from 'zod'

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** Parse through the tool's schema (applying defaults) then call the handler. */
async function callTool(
  tool: AnyTool,
  client: PenpotRpcClient,
  input: Record<string, unknown>,
): Promise<unknown> {
  const parsed = tool.inputSchema.parse(input)
  return tool.handler(client, parsed)
}

/** Minimal bare-metal text content node as returned by get-file (camelCase). */
function makeTextContent(paragraphs: Array<{ text: string }[]>): Record<string, unknown> {
  return {
    type: 'root',
    children: [
      {
        type: 'paragraph-set',
        children: paragraphs.map((ranges) => ({
          type: 'paragraph',
          textAlign: 'left',
          children: ranges.map((r) => ({
            text: r.text,
            fontFamily: 'Inter',
            fontSize: '14',
            fontWeight: '400',
            fills: [{ fillColor: '#000000', fillOpacity: 1 }],
          })),
        })),
      },
    ],
  }
}

/**
 * Build a minimal text shape as returned by get-file (camelCase outer, kebab-case
 * duplicates for the fields extractEditableFields reads by kebab-case key).
 */
function makeTextShape(
  id: string,
  name: string,
  paragraphs: Array<{ text: string }[]>,
  parentId: string = ROOT_FRAME_ID,
  frameId: string = ROOT_FRAME_ID,
): Record<string, unknown> {
  return {
    id,
    type: 'text',
    name,
    x: 10,
    y: 20,
    width: 200,
    height: 40,
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
    selrect: { x: 10, y: 20, width: 200, height: 40, x1: 10, y1: 20, x2: 210, y2: 60 },
    fills: [{ fillColor: '#000000', fillOpacity: 1 }],
    strokes: [],
    shadows: [],
    'grow-type': 'auto-width',
    content: makeTextContent(paragraphs),
  }
}

/** Minimal rect shape (non-text, must be ignored by replace_text). */
function makeRectShape(id: string): Record<string, unknown> {
  return {
    id,
    type: 'rect',
    name: 'Rect',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    parentId: ROOT_FRAME_ID,
    frameId: ROOT_FRAME_ID,
    'parent-id': ROOT_FRAME_ID,
    'frame-id': ROOT_FRAME_ID,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    hideFillOnExport: false,
    'hide-fill-on-export': false,
    selrect: { x: 0, y: 0, width: 100, height: 50, x1: 0, y1: 0, x2: 100, y2: 50 },
    fills: [],
    strokes: [],
    shadows: [],
    shapes: [],
  }
}

/** Minimal root frame. */
function makeRootFrame(childIds: string[] = []): Record<string, unknown> {
  return {
    id: ROOT_FRAME_ID,
    type: 'frame',
    name: 'root',
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    parentId: ROOT_FRAME_ID,
    frameId: ROOT_FRAME_ID,
    'parent-id': ROOT_FRAME_ID,
    'frame-id': ROOT_FRAME_ID,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    hideFillOnExport: false,
    'hide-fill-on-export': false,
    selrect: { x: 0, y: 0, width: 1920, height: 1080, x1: 0, y1: 0, x2: 1920, y2: 1080 },
    shapes: childIds,
    fills: [],
    strokes: [],
    shadows: [],
  }
}

/**
 * Build a mock client whose getFile returns a page with the given objects,
 * and whose updateFile resolves to `{ revn: 1 }`.
 */
function makeClient(objects: Record<string, Record<string, unknown>>): PenpotRpcClient {
  return {
    getFile: vi.fn().mockResolvedValue({
      id: 'file-1',
      revn: 0,
      vern: 0,
      data: {
        pages: ['page-1'],
        pagesIndex: {
          'page-1': { name: 'Page 1', objects },
        },
      },
    }),
    updateFile: vi.fn().mockResolvedValue({ revn: 1 }),
  } as unknown as PenpotRpcClient
}

/** Return the text content embedded in the first add-obj change's obj.content. */
function getChangedContent(
  client: PenpotRpcClient,
  changeIndex = 0,
): Record<string, unknown> {
  const call = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]
  const changes = call[3] as Array<{ obj: { content: Record<string, unknown> } }>
  return changes[changeIndex].obj.content
}

/** Collect all leaf texts from a content tree (the get-file or add-obj format). */
function allLeafTexts(content: Record<string, unknown>): string[] {
  const paragraphSet = (content.children as Array<{ children: Array<{ children: Array<{ text: string }> }> }>)?.[0]
  const paragraphs = paragraphSet?.children ?? []
  return paragraphs.flatMap((p) => p.children.map((leaf) => leaf.text))
}

const FILE_ID = 'file-1'
const PAGE_ID = 'page-1'

const replaceTextTool = getTool('penpot_replace_text')

// ── Tests ────────────────────────────────────────────────────────────────────

describe('penpot_replace_text', () => {
  it('is registered in contentTools', () => {
    expect(replaceTextTool).toBeDefined()
  })

  it('has a non-empty description mentioning search and replace', () => {
    const desc = replaceTextTool.description.toLowerCase()
    expect(desc).toContain('search')
    expect(desc).toContain('replace')
  })

  it('returns empty result and skips updateFile when no text shape matches', async () => {
    const shape = makeTextShape('s1', 'Label', [[{ text: 'Hello World' }]])
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame(['s1']), s1: shape })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'Goodbye',
      replacement: 'Hi',
    })) as { replacedShapes: unknown[]; totalReplacedShapes: number; totalOccurrences: number }

    expect(result.replacedShapes).toHaveLength(0)
    expect(result.totalReplacedShapes).toBe(0)
    expect(result.totalOccurrences).toBe(0)
    expect((client.updateFile as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('replaces matching text and calls updateFile once with the updated content', async () => {
    const shape = makeTextShape('s1', 'Greeting', [[{ text: 'Hello World' }]])
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame(['s1']), s1: shape })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'Hello',
      replacement: 'Hi',
    })) as { replacedShapes: Array<{ shapeId: string; name: string; occurrences: number }>; totalOccurrences: number; revn: number }

    expect(result.replacedShapes).toHaveLength(1)
    expect(result.replacedShapes[0].shapeId).toBe('s1')
    expect(result.replacedShapes[0].name).toBe('Greeting')
    expect(result.replacedShapes[0].occurrences).toBe(1)
    expect(result.totalOccurrences).toBe(1)
    expect(result.revn).toBe(1)

    // Verify updateFile was called once.
    expect((client.updateFile as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)

    // Verify the content was updated correctly.
    const leafTexts = allLeafTexts(getChangedContent(client))
    expect(leafTexts).toEqual(['Hi World'])
  })

  it('is case-insensitive by default', async () => {
    const shape = makeTextShape('s1', 'Label', [[{ text: 'HELLO hello HeLLo' }]])
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame(['s1']), s1: shape })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'hello',
      replacement: 'hi',
    })) as { totalOccurrences: number }

    expect(result.totalOccurrences).toBe(3)
    const leafTexts = allLeafTexts(getChangedContent(client))
    expect(leafTexts).toEqual(['hi hi hi'])
  })

  it('respects caseSensitive: true', async () => {
    const shape = makeTextShape('s1', 'Label', [[{ text: 'Hello HELLO hello' }]])
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame(['s1']), s1: shape })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'Hello',
      replacement: 'Hi',
      caseSensitive: true,
    })) as { totalOccurrences: number }

    // Only the exact-case "Hello" at the start matches.
    expect(result.totalOccurrences).toBe(1)
    const leafTexts = allLeafTexts(getChangedContent(client))
    expect(leafTexts).toEqual(['Hi HELLO hello'])
  })

  it('replaces across multiple text runs in a single paragraph', async () => {
    // Two runs in one paragraph: "foo bar" and "foo baz"
    const shape = makeTextShape('s1', 'Multi', [[{ text: 'foo bar' }, { text: 'foo baz' }]])
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame(['s1']), s1: shape })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'foo',
      replacement: 'qux',
    })) as { totalOccurrences: number }

    expect(result.totalOccurrences).toBe(2)
    const leafTexts = allLeafTexts(getChangedContent(client))
    expect(leafTexts).toEqual(['qux bar', 'qux baz'])
  })

  it('replaces across multiple paragraphs in one shape', async () => {
    // Two paragraphs, each with one run.
    const shape = makeTextShape('s1', 'Multi-para', [[{ text: 'line one' }], [{ text: 'line one too' }]])
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame(['s1']), s1: shape })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'one',
      replacement: 'two',
    })) as { totalOccurrences: number }

    expect(result.totalOccurrences).toBe(2)
    const leafTexts = allLeafTexts(getChangedContent(client))
    expect(leafTexts).toEqual(['line two', 'line two too'])
  })

  it('replaces multiple occurrences within a single run', async () => {
    const shape = makeTextShape('s1', 'Repeat', [[{ text: 'aaa' }]])
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame(['s1']), s1: shape })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'a',
      replacement: 'b',
    })) as { totalOccurrences: number }

    expect(result.totalOccurrences).toBe(3)
    const leafTexts = allLeafTexts(getChangedContent(client))
    expect(leafTexts).toEqual(['bbb'])
  })

  it('updates multiple matching shapes in one updateFile call', async () => {
    const s1 = makeTextShape('s1', 'Shape1', [[{ text: 'click here' }]])
    const s2 = makeTextShape('s2', 'Shape2', [[{ text: 'click there' }]])
    const client = makeClient({
      [ROOT_FRAME_ID]: makeRootFrame(['s1', 's2']),
      s1,
      s2,
    })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'click',
      replacement: 'tap',
    })) as { totalReplacedShapes: number; totalOccurrences: number }

    expect(result.totalReplacedShapes).toBe(2)
    expect(result.totalOccurrences).toBe(2)
    // Single updateFile call with two changes.
    expect((client.updateFile as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    const call = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((call[3] as unknown[]).length).toBe(2)
  })

  it('skips non-text shapes', async () => {
    const rect = makeRectShape('r1')
    const text = makeTextShape('s1', 'Label', [[{ text: 'Hello' }]])
    const client = makeClient({
      [ROOT_FRAME_ID]: makeRootFrame(['r1', 's1']),
      r1: rect,
      s1: text,
    })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'Hello',
      replacement: 'Hi',
    })) as { totalReplacedShapes: number }

    // Only the text shape is updated.
    expect(result.totalReplacedShapes).toBe(1)
    const call = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((call[3] as unknown[]).length).toBe(1)
  })

  it('respects the limit option', async () => {
    const s1 = makeTextShape('s1', 'A', [[{ text: 'match' }]])
    const s2 = makeTextShape('s2', 'B', [[{ text: 'match' }]])
    const s3 = makeTextShape('s3', 'C', [[{ text: 'match' }]])
    const client = makeClient({
      [ROOT_FRAME_ID]: makeRootFrame(['s1', 's2', 's3']),
      s1,
      s2,
      s3,
    })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'match',
      replacement: 'done',
      limit: 2,
    })) as { totalReplacedShapes: number }

    expect(result.totalReplacedShapes).toBe(2)
    const call = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((call[3] as unknown[]).length).toBe(2)
  })

  it('supports replacing with an empty string (deletion)', async () => {
    const shape = makeTextShape('s1', 'Label', [[{ text: 'Hello World' }]])
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame(['s1']), s1: shape })

    await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: ' World',
      replacement: '',
    })

    const leafTexts = allLeafTexts(getChangedContent(client))
    expect(leafTexts).toEqual(['Hello'])
  })

  it('throws when the page is not found', async () => {
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame() })

    await expect(
      callTool(replaceTextTool, client, {
        fileId: FILE_ID,
        pageId: 'nonexistent-page',
        search: 'x',
        replacement: 'y',
      }),
    ).rejects.toThrow('not found')
  })

  it('escapes regex metacharacters in the search string', async () => {
    // "." is a common regex metacharacter — it should match a literal dot.
    const shape = makeTextShape('s1', 'Version', [[{ text: 'v1.0 and v2.0' }]])
    const client = makeClient({ [ROOT_FRAME_ID]: makeRootFrame(['s1']), s1: shape })

    const result = (await callTool(replaceTextTool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: '.',
      replacement: '_',
    })) as { totalOccurrences: number }

    // Should match exactly 2 literal dots, not every character.
    expect(result.totalOccurrences).toBe(2)
    const leafTexts = allLeafTexts(getChangedContent(client))
    expect(leafTexts).toEqual(['v1_0 and v2_0'])
  })
})
