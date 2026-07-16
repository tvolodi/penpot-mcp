/**
 * Unit tests for shared-library support in penpot_list_components and
 * penpot_add_component_instance.
 *
 * Tests cover:
 *   - penpot_list_components with includeLibraries: false (default, backward compat)
 *   - penpot_list_components with includeLibraries: true (fetches library files)
 *   - penpot_add_component_instance without libraryFileId (own-file component, backward compat)
 *   - penpot_add_component_instance with libraryFileId (library component)
 *   - Error paths: component not found in library file
 *
 * No network calls — PenpotRpcClient is fully mocked.
 */

import { describe, it, expect, vi } from 'vitest'
import { contentTools } from '../../src/tools/content.js'
import { ROOT_FRAME_ID } from '../../src/shape-builders.js'
import type { PenpotRpcClient } from '../../src/rpc-client.js'
import type { ZodType } from 'zod'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Parse input through the tool's Zod schema (applying defaults) then call the handler. */
function callTool(tool: AnyTool, client: PenpotRpcClient, input: Record<string, unknown>): Promise<unknown> {
  const parsed = tool.inputSchema.parse(input)
  return tool.handler(client, parsed)
}

const FILE_ID = 'file-abc'
const PAGE_ID = 'page-xyz'
const LIBRARY_FILE_ID = 'lib-file-111'
const COMPONENT_ID_OWN = 'comp-own-1'
const COMPONENT_ID_LIB = 'comp-lib-1'
const MAIN_INSTANCE_ID_OWN = 'shape-main-own'
const MAIN_INSTANCE_ID_LIB = 'shape-main-lib'

/** A minimal component main-instance shape node (camelCase, as get-file returns). */
function makeMainShape(id: string, x: number, y: number): Record<string, unknown> {
  return {
    id,
    type: 'frame',
    name: 'ComponentRoot',
    x,
    y,
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
    shapes: [],
    fills: [],
    strokes: [],
    shadows: [],
    selrect: { x, y, width: 100, height: 50, x1: x, y1: y, x2: x + 100, y2: y + 50 },
    points: [{ x, y }, { x: x + 100, y }, { x: x + 100, y: y + 50 }, { x, y: y + 50 }],
    'component-id': 'some-comp',
    'component-file': FILE_ID,
    'component-root': true,
    'main-instance': true,
  }
}

/** Build a mock client whose getFile resolves correctly for own-file and library file. */
function makeClient(overrides: Partial<PenpotRpcClient> = {}): PenpotRpcClient {
  const ownFileData = {
    id: FILE_ID,
    revn: 5,
    vern: 5,
    name: 'My Design File',
    data: {
      pages: [PAGE_ID],
      pagesIndex: {
        [PAGE_ID]: {
          id: PAGE_ID,
          name: 'Page 1',
          objects: {
            [ROOT_FRAME_ID]: {
              id: ROOT_FRAME_ID, type: 'frame', name: 'root',
              parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID,
              'parent-id': ROOT_FRAME_ID, 'frame-id': ROOT_FRAME_ID,
              x: 0, y: 0, width: 1920, height: 1080, rotation: 0,
              shapes: [MAIN_INSTANCE_ID_OWN],
              transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              'hide-fill-on-export': false,
              fills: [], strokes: [], shadows: [],
              selrect: { x: 0, y: 0, width: 1920, height: 1080, x1: 0, y1: 0, x2: 1920, y2: 1080 },
              points: [{ x: 0, y: 0 }],
            },
            [MAIN_INSTANCE_ID_OWN]: makeMainShape(MAIN_INSTANCE_ID_OWN, 10, 20),
          },
        },
      },
      components: {
        [COMPONENT_ID_OWN]: {
          id: COMPONENT_ID_OWN,
          name: 'OwnButton',
          path: 'Buttons',
          mainInstanceId: MAIN_INSTANCE_ID_OWN,
          mainInstancePage: PAGE_ID,
        },
      },
    },
  }

  const libraryPage = 'lib-page-1'
  const libraryFileData = {
    id: LIBRARY_FILE_ID,
    revn: 3,
    vern: 3,
    name: 'Design System Library',
    data: {
      pages: [libraryPage],
      pagesIndex: {
        [libraryPage]: {
          id: libraryPage,
          name: 'Components',
          objects: {
            [ROOT_FRAME_ID]: {
              id: ROOT_FRAME_ID, type: 'frame', name: 'root',
              parentId: ROOT_FRAME_ID, frameId: ROOT_FRAME_ID,
              'parent-id': ROOT_FRAME_ID, 'frame-id': ROOT_FRAME_ID,
              x: 0, y: 0, width: 1920, height: 1080, rotation: 0,
              shapes: [MAIN_INSTANCE_ID_LIB],
              transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
              'hide-fill-on-export': false,
              fills: [], strokes: [], shadows: [],
              selrect: { x: 0, y: 0, width: 1920, height: 1080, x1: 0, y1: 0, x2: 1920, y2: 1080 },
              points: [{ x: 0, y: 0 }],
            },
            [MAIN_INSTANCE_ID_LIB]: makeMainShape(MAIN_INSTANCE_ID_LIB, 50, 60),
          },
        },
      },
      components: {
        [COMPONENT_ID_LIB]: {
          id: COMPONENT_ID_LIB,
          name: 'LibButton',
          path: 'Buttons/Primary',
          mainInstanceId: MAIN_INSTANCE_ID_LIB,
          mainInstancePage: libraryPage,
        },
      },
    },
  }

  return {
    getFile: vi.fn().mockImplementation((id: string) => {
      if (id === LIBRARY_FILE_ID) return Promise.resolve(libraryFileData)
      return Promise.resolve(ownFileData)
    }),
    getFileLibraries: vi.fn().mockResolvedValue([
      { id: LIBRARY_FILE_ID, name: 'Design System Library', revn: 3, vern: 3, isShared: true, isIndirect: false },
    ]),
    updateFile: vi.fn().mockResolvedValue({ revn: 6, lagged: [] }),
    ...overrides,
  } as unknown as PenpotRpcClient
}

// ── penpot_list_components ────────────────────────────────────────────────────

describe('penpot_list_components', () => {
  const tool = getTool('penpot_list_components')

  it('without includeLibraries returns only own-file components (backward compat)', async () => {
    const client = makeClient()
    const result = (await callTool(tool, client, { fileId: FILE_ID })) as {
      components: Array<{ componentId: string; name: string; libraryFileId?: string }>
    }

    expect(result.components).toHaveLength(1)
    expect(result.components[0]!.componentId).toBe(COMPONENT_ID_OWN)
    expect(result.components[0]!.name).toBe('OwnButton')
    expect(result.components[0]!.libraryFileId).toBeUndefined()

    // getFileLibraries must NOT be called when includeLibraries is false (default)
    expect((client.getFileLibraries as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('with includeLibraries: false also skips library fetch', async () => {
    const client = makeClient()
    await callTool(tool, client, { fileId: FILE_ID, includeLibraries: false })
    expect((client.getFileLibraries as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('with includeLibraries: true returns own + library components', async () => {
    const client = makeClient()
    const result = (await callTool(tool, client, { fileId: FILE_ID, includeLibraries: true })) as {
      components: Array<{
        componentId: string
        name: string
        path: string
        libraryFileId?: string
        libraryFileName?: string
      }>
    }

    expect(result.components).toHaveLength(2)

    const own = result.components.find((c) => c.componentId === COMPONENT_ID_OWN)!
    expect(own).toBeDefined()
    expect(own.name).toBe('OwnButton')
    expect(own.libraryFileId).toBeUndefined()

    const lib = result.components.find((c) => c.componentId === COMPONENT_ID_LIB)!
    expect(lib).toBeDefined()
    expect(lib.name).toBe('LibButton')
    expect(lib.path).toBe('Buttons/Primary')
    expect(lib.libraryFileId).toBe(LIBRARY_FILE_ID)
    expect(lib.libraryFileName).toBe('Design System Library')
  })

  it('calls getFileLibraries with the correct fileId', async () => {
    const client = makeClient()
    await callTool(tool, client, { fileId: FILE_ID, includeLibraries: true })

    const calls = (client.getFileLibraries as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe(FILE_ID)
  })

  it('calls getFile for each library entry returned by getFileLibraries', async () => {
    const client = makeClient()
    await callTool(tool, client, { fileId: FILE_ID, includeLibraries: true })

    const fileCalls = (client.getFile as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    // Should have called getFile for the own file and for the library file
    expect(fileCalls).toContain(FILE_ID)
    expect(fileCalls).toContain(LIBRARY_FILE_ID)
  })

  it('returns empty library components when file has no linked libraries', async () => {
    const client = makeClient({
      getFileLibraries: vi.fn().mockResolvedValue([]),
    } as unknown as Partial<PenpotRpcClient>)
    const result = (await callTool(tool, client, { fileId: FILE_ID, includeLibraries: true })) as {
      components: unknown[]
    }
    // Only own-file component
    expect(result.components).toHaveLength(1)
  })
})

// ── penpot_add_component_instance ─────────────────────────────────────────────

describe('penpot_add_component_instance', () => {
  const tool = getTool('penpot_add_component_instance')

  it('without libraryFileId uses component from own file (backward compat)', async () => {
    const client = makeClient()
    const result = (await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      componentId: COMPONENT_ID_OWN,
      x: 200,
      y: 300,
    })) as { instanceRootId: string; shapeIds: string[]; revn: number }

    expect(typeof result.instanceRootId).toBe('string')
    expect(result.shapeIds.length).toBeGreaterThan(0)
    expect(result.revn).toBe(6)

    // getFile called for own file only
    const fileCalls = (client.getFile as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(fileCalls).not.toContain(LIBRARY_FILE_ID)
  })

  it('without libraryFileId emits an add-obj change with component-file = own fileId', async () => {
    const client = makeClient()
    await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      componentId: COMPONENT_ID_OWN,
      x: 10,
      y: 20,
    })

    const [, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string, number, number, Array<{ obj?: Record<string, unknown> }>,
    ]
    const rootChange = changes[0]!
    expect(rootChange.obj?.['component-file']).toBe(FILE_ID)
  })

  it('with libraryFileId fetches component from the library file', async () => {
    const client = makeClient()
    const result = (await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      componentId: COMPONENT_ID_LIB,
      x: 100,
      y: 200,
      libraryFileId: LIBRARY_FILE_ID,
    })) as { instanceRootId: string; shapeIds: string[]; revn: number }

    expect(typeof result.instanceRootId).toBe('string')
    expect(result.shapeIds.length).toBeGreaterThan(0)

    // getFile must have been called for both the own file and the library file
    const fileCalls = (client.getFile as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(fileCalls).toContain(FILE_ID)
    expect(fileCalls).toContain(LIBRARY_FILE_ID)
  })

  it('with libraryFileId emits an add-obj change with component-file = libraryFileId', async () => {
    const client = makeClient()
    await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      componentId: COMPONENT_ID_LIB,
      x: 100,
      y: 200,
      libraryFileId: LIBRARY_FILE_ID,
    })

    const [calledFileId, , , changes] = (client.updateFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string, number, number, Array<{ obj?: Record<string, unknown> }>,
    ]
    // updateFile must target the OWN file, not the library
    expect(calledFileId).toBe(FILE_ID)
    // But the cloned shape's component-file points to the library
    const rootChange = changes[0]!
    expect(rootChange.obj?.['component-file']).toBe(LIBRARY_FILE_ID)
  })

  it('treats libraryFileId === fileId the same as no libraryFileId', async () => {
    const client = makeClient()
    await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      componentId: COMPONENT_ID_OWN,
      x: 10,
      y: 20,
      libraryFileId: FILE_ID,   // same as fileId — should NOT call getFile a second time
    })

    const fileCalls = (client.getFile as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    // Only one getFile call, for the own file
    expect(fileCalls.filter((id: string) => id === FILE_ID)).toHaveLength(1)
    expect(fileCalls).not.toContain(LIBRARY_FILE_ID)
  })

  it('throws when component not found in own file', async () => {
    const client = makeClient()
    await expect(
      callTool(tool, client, {
        fileId: FILE_ID,
        pageId: PAGE_ID,
        componentId: 'nonexistent-comp',
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow(/no component nonexistent-comp found/)
  })

  it('throws when component not found in library file', async () => {
    const client = makeClient()
    await expect(
      callTool(tool, client, {
        fileId: FILE_ID,
        pageId: PAGE_ID,
        componentId: 'nonexistent-lib-comp',
        x: 0,
        y: 0,
        libraryFileId: LIBRARY_FILE_ID,
      }),
    ).rejects.toThrow(/no component nonexistent-lib-comp found in library file/)
  })
})
