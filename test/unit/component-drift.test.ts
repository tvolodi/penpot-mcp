/**
 * Unit tests for component-instance drift/override visibility.
 *
 * Tests cover:
 *   - computeComponentInfo: all four link states
 *   - Drift field detection (same-file linked instances)
 *   - Library component handling (no drift computed)
 *   - Detached/orphaned instance detection
 *   - penpot_get_shape: includes componentInfo in output
 *   - penpot_find_shapes: includes linkState + driftedFields in each result
 *
 * No network calls — PenpotRpcClient is fully mocked.
 */

import { describe, it, expect, vi } from 'vitest'
import { computeComponentInfo } from '../../src/tools/content.js'
import { contentTools } from '../../src/tools/content.js'
import { ROOT_FRAME_ID } from '../../src/shape-builders.js'
import type { PenpotRpcClient } from '../../src/rpc-client.js'
import type { ZodType } from 'zod'
import type { ShapeNode } from '../../src/shape-builders.js'

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

function callTool(tool: AnyTool, client: PenpotRpcClient, input: Record<string, unknown>): Promise<unknown> {
  const parsed = tool.inputSchema.parse(input)
  return tool.handler(client, parsed)
}

const FILE_ID = 'file-abc'
const LIB_FILE_ID = 'lib-file-xyz'
const PAGE_ID = 'page-1'
const COMP_ID = 'comp-1'
const MAIN_INSTANCE_ID = 'shape-main-1'
const PLACED_INSTANCE_ID = 'shape-placed-1'

/** Minimal shape factory — only the fields needed for component-drift tests. */
function makeShape(id: string, overrides: Record<string, unknown> = {}): ShapeNode {
  return {
    id,
    type: 'frame',
    name: 'Button',
    x: 100,
    y: 200,
    width: 120,
    height: 40,
    rotation: 0,
    parentId: ROOT_FRAME_ID,
    'parent-id': ROOT_FRAME_ID,
    frameId: ROOT_FRAME_ID,
    'frame-id': ROOT_FRAME_ID,
    fills: [],
    strokes: [],
    shadows: [],
    opacity: 1,
    hidden: false,
    blendMode: 'normal',
    shapes: [],
    ...overrides,
  }
}

/** Minimal component map entry. */
function makeComponent(id: string, mainInstanceId: string, mainInstancePage: string) {
  return { id, mainInstanceId, mainInstancePage }
}

// ── computeComponentInfo — direct unit tests ──────────────────────────────────

describe('computeComponentInfo', () => {
  const emptyComponents = {}
  const emptyPages: Record<string, { objects: Record<string, ShapeNode> }> = {}

  describe('not-an-instance', () => {
    it('plain shape with no componentId returns not-an-instance', () => {
      const shape = makeShape('shape-plain')
      const info = computeComponentInfo(shape, FILE_ID, emptyComponents, emptyPages)
      expect(info.linkState).toBe('not-an-instance')
      expect(info.componentId).toBeUndefined()
    })

    it('shape with only shapeRef (component child, no componentId) returns not-an-instance', () => {
      const shape = makeShape('shape-child', { shapeRef: MAIN_INSTANCE_ID })
      const info = computeComponentInfo(shape, FILE_ID, emptyComponents, emptyPages)
      expect(info.linkState).toBe('not-an-instance')
    })
  })

  describe('main-component-root', () => {
    it('shape with componentId + mainInstance + componentRoot returns main-component-root', () => {
      const shape = makeShape(MAIN_INSTANCE_ID, {
        componentId: COMP_ID,
        'component-id': COMP_ID,
        componentFile: FILE_ID,
        'component-file': FILE_ID,
        mainInstance: true,
        'main-instance': true,
        componentRoot: true,
        'component-root': true,
      })
      const info = computeComponentInfo(shape, FILE_ID, emptyComponents, emptyPages)
      expect(info.linkState).toBe('main-component-root')
      expect(info.componentId).toBe(COMP_ID)
      expect(info.componentFileId).toBe(FILE_ID)
    })

    it('supports kebab-case field names from older Penpot responses', () => {
      const shape = makeShape(MAIN_INSTANCE_ID, {
        'component-id': COMP_ID,
        'component-file': FILE_ID,
        'main-instance': true,
        'component-root': true,
      })
      const info = computeComponentInfo(shape, FILE_ID, emptyComponents, emptyPages)
      expect(info.linkState).toBe('main-component-root')
    })
  })

  describe('linked (same-file component)', () => {
    it('returns linked when component exists in the file', () => {
      const mainShape = makeShape(MAIN_INSTANCE_ID, { x: 0, y: 0 })
      const components = { [COMP_ID]: makeComponent(COMP_ID, MAIN_INSTANCE_ID, PAGE_ID) }
      const pagesIndex = { [PAGE_ID]: { objects: { [MAIN_INSTANCE_ID]: mainShape } } }

      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        componentId: COMP_ID,
        componentFile: FILE_ID,
      })
      const info = computeComponentInfo(instanceShape, FILE_ID, components, pagesIndex)

      expect(info.linkState).toBe('linked')
      expect(info.componentId).toBe(COMP_ID)
      expect(info.componentFileId).toBe(FILE_ID)
      expect(info.mainInstanceId).toBe(MAIN_INSTANCE_ID)
      expect(info.mainInstancePage).toBe(PAGE_ID)
    })

    it('driftedFields is an empty array when instance matches main component', () => {
      // Both shapes have identical visual fields
      const sharedFields = {
        fills: [{ 'fill-color': '#ff0000', 'fill-opacity': 1 }],
        strokes: [],
        shadows: [],
        opacity: 1,
        hidden: false,
        blendMode: 'normal',
        width: 120,
        height: 40,
        name: 'Button',
        constraintsH: 'left',
        constraintsV: 'top',
      }
      const mainShape = makeShape(MAIN_INSTANCE_ID, { x: 0, y: 0, ...sharedFields })
      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        x: 500,
        y: 300,
        componentId: COMP_ID,
        componentFile: FILE_ID,
        ...sharedFields,
      })

      const components = { [COMP_ID]: makeComponent(COMP_ID, MAIN_INSTANCE_ID, PAGE_ID) }
      const pagesIndex = { [PAGE_ID]: { objects: { [MAIN_INSTANCE_ID]: mainShape } } }

      const info = computeComponentInfo(instanceShape, FILE_ID, components, pagesIndex)

      expect(info.linkState).toBe('linked')
      expect(info.driftedFields).toEqual([])
    })

    it('driftedFields lists fills when fills differ', () => {
      const mainShape = makeShape(MAIN_INSTANCE_ID, {
        fills: [{ 'fill-color': '#ff0000', 'fill-opacity': 1 }],
      })
      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        componentId: COMP_ID,
        componentFile: FILE_ID,
        fills: [{ 'fill-color': '#0000ff', 'fill-opacity': 1 }], // different fill
      })

      const components = { [COMP_ID]: makeComponent(COMP_ID, MAIN_INSTANCE_ID, PAGE_ID) }
      const pagesIndex = { [PAGE_ID]: { objects: { [MAIN_INSTANCE_ID]: mainShape } } }

      const info = computeComponentInfo(instanceShape, FILE_ID, components, pagesIndex)

      expect(info.linkState).toBe('linked')
      expect(info.driftedFields).toContain('fills')
    })

    it('driftedFields lists name when name differs', () => {
      const mainShape = makeShape(MAIN_INSTANCE_ID, { name: 'Button' })
      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        componentId: COMP_ID,
        componentFile: FILE_ID,
        name: 'Submit Button', // renamed instance
      })

      const components = { [COMP_ID]: makeComponent(COMP_ID, MAIN_INSTANCE_ID, PAGE_ID) }
      const pagesIndex = { [PAGE_ID]: { objects: { [MAIN_INSTANCE_ID]: mainShape } } }

      const info = computeComponentInfo(instanceShape, FILE_ID, components, pagesIndex)

      expect(info.driftedFields).toContain('name')
    })

    it('driftedFields lists multiple fields when multiple differ', () => {
      const mainShape = makeShape(MAIN_INSTANCE_ID, {
        opacity: 1,
        hidden: false,
        fills: [],
      })
      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        componentId: COMP_ID,
        componentFile: FILE_ID,
        opacity: 0.5, // different opacity
        hidden: true, // different hidden
        fills: [{ 'fill-color': '#000000', 'fill-opacity': 1 }], // different fills
      })

      const components = { [COMP_ID]: makeComponent(COMP_ID, MAIN_INSTANCE_ID, PAGE_ID) }
      const pagesIndex = { [PAGE_ID]: { objects: { [MAIN_INSTANCE_ID]: mainShape } } }

      const info = computeComponentInfo(instanceShape, FILE_ID, components, pagesIndex)

      expect(info.driftedFields).toContain('opacity')
      expect(info.driftedFields).toContain('hidden')
      expect(info.driftedFields).toContain('fills')
    })

    it('does not include x/y position in driftedFields (position always differs)', () => {
      const mainShape = makeShape(MAIN_INSTANCE_ID, { x: 0, y: 0 })
      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        componentId: COMP_ID,
        componentFile: FILE_ID,
        x: 500, // different x
        y: 300, // different y
      })

      const components = { [COMP_ID]: makeComponent(COMP_ID, MAIN_INSTANCE_ID, PAGE_ID) }
      const pagesIndex = { [PAGE_ID]: { objects: { [MAIN_INSTANCE_ID]: mainShape } } }

      const info = computeComponentInfo(instanceShape, FILE_ID, components, pagesIndex)

      expect(info.driftedFields).not.toContain('x')
      expect(info.driftedFields).not.toContain('y')
    })

    it('driftedFields includes width/height when size differs', () => {
      const mainShape = makeShape(MAIN_INSTANCE_ID, { width: 120, height: 40 })
      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        componentId: COMP_ID,
        componentFile: FILE_ID,
        width: 200, // resized instance
        height: 60,
      })

      const components = { [COMP_ID]: makeComponent(COMP_ID, MAIN_INSTANCE_ID, PAGE_ID) }
      const pagesIndex = { [PAGE_ID]: { objects: { [MAIN_INSTANCE_ID]: mainShape } } }

      const info = computeComponentInfo(instanceShape, FILE_ID, components, pagesIndex)

      expect(info.driftedFields).toContain('width')
      expect(info.driftedFields).toContain('height')
    })
  })

  describe('linked (library component)', () => {
    it('returns linked without driftedFields for library components', () => {
      // Library component: componentFile !== FILE_ID, not in local components map
      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        componentId: COMP_ID,
        componentFile: LIB_FILE_ID,
      })

      const info = computeComponentInfo(instanceShape, FILE_ID, emptyComponents, emptyPages)

      expect(info.linkState).toBe('linked')
      expect(info.componentId).toBe(COMP_ID)
      expect(info.componentFileId).toBe(LIB_FILE_ID)
      expect(info.driftedFields).toBeUndefined() // not computed for library components
    })
  })

  describe('detached', () => {
    it('returns detached when component not found in same-file components map', () => {
      // componentFile equals FILE_ID but component not in components map → orphaned
      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        componentId: COMP_ID,
        componentFile: FILE_ID,
      })

      const info = computeComponentInfo(instanceShape, FILE_ID, emptyComponents, emptyPages)

      expect(info.linkState).toBe('detached')
      expect(info.componentId).toBe(COMP_ID)
    })

    it('returns detached when componentFile is unset and component not found', () => {
      // No componentFile, no matching component in file
      const instanceShape = makeShape(PLACED_INSTANCE_ID, {
        componentId: COMP_ID,
        // no componentFile
      })

      const info = computeComponentInfo(instanceShape, FILE_ID, emptyComponents, emptyPages)

      expect(info.linkState).toBe('detached')
    })
  })
})

// ── penpot_get_shape — includes componentInfo ─────────────────────────────────

describe('penpot_get_shape componentInfo', () => {
  const tool = getTool('penpot_get_shape')

  function makeFileData(shapeId: string, shapeOverrides: Record<string, unknown> = {}, components = {}) {
    const shape = makeShape(shapeId, shapeOverrides)
    return {
      id: FILE_ID,
      revn: 0,
      vern: 0,
      name: 'Test File',
      data: {
        pages: [PAGE_ID],
        pagesIndex: {
          [PAGE_ID]: {
            id: PAGE_ID,
            name: 'Page 1',
            objects: {
              [ROOT_FRAME_ID]: makeShape(ROOT_FRAME_ID, {
                type: 'frame',
                name: 'root',
                parentId: ROOT_FRAME_ID,
                'parent-id': ROOT_FRAME_ID,
                shapes: [shapeId],
              }),
              [shapeId]: shape,
            },
          },
        },
        components,
      },
    }
  }

  it('returns linkState not-an-instance for a plain shape', async () => {
    const client = {
      getFile: vi.fn().mockResolvedValue(makeFileData('plain-shape')),
    } as unknown as PenpotRpcClient

    const result = (await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      shapeId: 'plain-shape',
    })) as { componentInfo: { linkState: string } }

    expect(result.componentInfo.linkState).toBe('not-an-instance')
  })

  it('returns linkState main-component-root for a main instance shape', async () => {
    const client = {
      getFile: vi.fn().mockResolvedValue(
        makeFileData(MAIN_INSTANCE_ID, {
          componentId: COMP_ID,
          componentFile: FILE_ID,
          mainInstance: true,
          componentRoot: true,
        }),
      ),
    } as unknown as PenpotRpcClient

    const result = (await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      shapeId: MAIN_INSTANCE_ID,
    })) as { componentInfo: { linkState: string; componentId: string } }

    expect(result.componentInfo.linkState).toBe('main-component-root')
    expect(result.componentInfo.componentId).toBe(COMP_ID)
  })

  it('returns linked with empty driftedFields when instance matches component', async () => {
    const sharedFills = [{ 'fill-color': '#ff0000', 'fill-opacity': 1 }]
    const components = {
      [COMP_ID]: { id: COMP_ID, mainInstanceId: MAIN_INSTANCE_ID, mainInstancePage: PAGE_ID },
    }

    const fileData = {
      id: FILE_ID,
      revn: 0,
      vern: 0,
      name: 'Test File',
      data: {
        pages: [PAGE_ID],
        pagesIndex: {
          [PAGE_ID]: {
            id: PAGE_ID,
            name: 'Page 1',
            objects: {
              [ROOT_FRAME_ID]: makeShape(ROOT_FRAME_ID, { type: 'frame', name: 'root', parentId: ROOT_FRAME_ID, 'parent-id': ROOT_FRAME_ID, shapes: [MAIN_INSTANCE_ID, PLACED_INSTANCE_ID] }),
              [MAIN_INSTANCE_ID]: makeShape(MAIN_INSTANCE_ID, {
                componentId: COMP_ID,
                componentFile: FILE_ID,
                mainInstance: true,
                componentRoot: true,
                fills: sharedFills,
              }),
              [PLACED_INSTANCE_ID]: makeShape(PLACED_INSTANCE_ID, {
                componentId: COMP_ID,
                componentFile: FILE_ID,
                shapeRef: MAIN_INSTANCE_ID,
                fills: sharedFills, // same fills as main
              }),
            },
          },
        },
        components,
      },
    }

    const client = { getFile: vi.fn().mockResolvedValue(fileData) } as unknown as PenpotRpcClient

    const result = (await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      shapeId: PLACED_INSTANCE_ID,
    })) as {
      componentInfo: {
        linkState: string
        componentId: string
        driftedFields: string[]
      }
    }

    expect(result.componentInfo.linkState).toBe('linked')
    expect(result.componentInfo.componentId).toBe(COMP_ID)
    expect(result.componentInfo.driftedFields).toEqual([])
  })

  it('returns linked with driftedFields including fills when fill differs', async () => {
    const components = {
      [COMP_ID]: { id: COMP_ID, mainInstanceId: MAIN_INSTANCE_ID, mainInstancePage: PAGE_ID },
    }

    const fileData = {
      id: FILE_ID,
      revn: 0,
      vern: 0,
      name: 'Test File',
      data: {
        pages: [PAGE_ID],
        pagesIndex: {
          [PAGE_ID]: {
            id: PAGE_ID,
            name: 'Page 1',
            objects: {
              [ROOT_FRAME_ID]: makeShape(ROOT_FRAME_ID, { type: 'frame', name: 'root', parentId: ROOT_FRAME_ID, 'parent-id': ROOT_FRAME_ID, shapes: [MAIN_INSTANCE_ID, PLACED_INSTANCE_ID] }),
              [MAIN_INSTANCE_ID]: makeShape(MAIN_INSTANCE_ID, {
                componentId: COMP_ID,
                componentFile: FILE_ID,
                mainInstance: true,
                componentRoot: true,
                fills: [{ 'fill-color': '#ff0000', 'fill-opacity': 1 }],
              }),
              [PLACED_INSTANCE_ID]: makeShape(PLACED_INSTANCE_ID, {
                componentId: COMP_ID,
                componentFile: FILE_ID,
                shapeRef: MAIN_INSTANCE_ID,
                fills: [{ 'fill-color': '#0000ff', 'fill-opacity': 1 }], // overridden fill
              }),
            },
          },
        },
        components,
      },
    }

    const client = { getFile: vi.fn().mockResolvedValue(fileData) } as unknown as PenpotRpcClient

    const result = (await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      shapeId: PLACED_INSTANCE_ID,
    })) as {
      componentInfo: {
        linkState: string
        driftedFields: string[]
      }
    }

    expect(result.componentInfo.linkState).toBe('linked')
    expect(result.componentInfo.driftedFields).toContain('fills')
  })

  it('returns detached for orphaned instance', async () => {
    // componentId present, componentFile === fileId, but component not in components map
    const client = {
      getFile: vi.fn().mockResolvedValue(
        makeFileData(PLACED_INSTANCE_ID, {
          componentId: COMP_ID,
          componentFile: FILE_ID,
          shapeRef: MAIN_INSTANCE_ID,
        }),
      ),
    } as unknown as PenpotRpcClient

    const result = (await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      shapeId: PLACED_INSTANCE_ID,
    })) as { componentInfo: { linkState: string; componentId: string } }

    expect(result.componentInfo.linkState).toBe('detached')
    expect(result.componentInfo.componentId).toBe(COMP_ID)
  })
})

// ── penpot_find_shapes — includes linkState ───────────────────────────────────

describe('penpot_find_shapes linkState', () => {
  const tool = getTool('penpot_find_shapes')

  function makeFileDataMulti(
    shapes: Array<{ id: string; overrides?: Record<string, unknown> }>,
    components: Record<string, { id: string; mainInstanceId: string; mainInstancePage: string }> = {},
  ) {
    const objects: Record<string, ShapeNode> = {
      [ROOT_FRAME_ID]: makeShape(ROOT_FRAME_ID, {
        type: 'frame',
        name: 'root',
        parentId: ROOT_FRAME_ID,
        'parent-id': ROOT_FRAME_ID,
        shapes: shapes.map((s) => s.id),
      }),
    }
    for (const { id, overrides = {} } of shapes) {
      objects[id] = makeShape(id, overrides)
    }
    return {
      id: FILE_ID,
      revn: 0,
      vern: 0,
      name: 'Test File',
      data: {
        pages: [PAGE_ID],
        pagesIndex: { [PAGE_ID]: { id: PAGE_ID, name: 'Page 1', objects } },
        components,
      },
    }
  }

  it('each shape result includes linkState', async () => {
    const fileData = makeFileDataMulti([
      { id: 'shape-plain' },
      {
        id: PLACED_INSTANCE_ID,
        overrides: { componentId: COMP_ID, componentFile: FILE_ID },
      },
    ])
    const client = { getFile: vi.fn().mockResolvedValue(fileData) } as unknown as PenpotRpcClient

    const result = (await callTool(tool, client, { fileId: FILE_ID, pageId: PAGE_ID })) as {
      shapes: Array<{ id: string; linkState: string }>
    }

    const plain = result.shapes.find((s) => s.id === 'shape-plain')
    const instance = result.shapes.find((s) => s.id === PLACED_INSTANCE_ID)

    expect(plain?.linkState).toBe('not-an-instance')
    expect(instance?.linkState).toBe('detached') // component not in components map
  })

  it('includes driftedFields in linked instances', async () => {
    const components = {
      [COMP_ID]: { id: COMP_ID, mainInstanceId: MAIN_INSTANCE_ID, mainInstancePage: PAGE_ID },
    }
    const fileData = makeFileDataMulti(
      [
        {
          id: MAIN_INSTANCE_ID,
          overrides: {
            componentId: COMP_ID,
            componentFile: FILE_ID,
            mainInstance: true,
            componentRoot: true,
            fills: [{ 'fill-color': '#ff0000', 'fill-opacity': 1 }],
          },
        },
        {
          id: PLACED_INSTANCE_ID,
          overrides: {
            componentId: COMP_ID,
            componentFile: FILE_ID,
            shapeRef: MAIN_INSTANCE_ID,
            fills: [{ 'fill-color': '#00ff00', 'fill-opacity': 1 }], // drifted fill
          },
        },
      ],
      components,
    )

    const client = { getFile: vi.fn().mockResolvedValue(fileData) } as unknown as PenpotRpcClient

    const result = (await callTool(tool, client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      isComponentInstance: true,
    })) as {
      shapes: Array<{ id: string; linkState: string; driftedFields?: string[] }>
    }

    const placed = result.shapes.find((s) => s.id === PLACED_INSTANCE_ID)
    expect(placed?.linkState).toBe('linked')
    expect(placed?.driftedFields).toContain('fills')
  })

  it('does not include driftedFields for plain shapes', async () => {
    const fileData = makeFileDataMulti([{ id: 'shape-plain' }])
    const client = { getFile: vi.fn().mockResolvedValue(fileData) } as unknown as PenpotRpcClient

    const result = (await callTool(tool, client, { fileId: FILE_ID, pageId: PAGE_ID })) as {
      shapes: Array<{ id: string; driftedFields?: string[] }>
    }

    const plain = result.shapes.find((s) => s.id === 'shape-plain')
    expect(plain?.driftedFields).toBeUndefined()
  })

  it('does not include componentId for plain shapes', async () => {
    const fileData = makeFileDataMulti([{ id: 'shape-plain' }])
    const client = { getFile: vi.fn().mockResolvedValue(fileData) } as unknown as PenpotRpcClient

    const result = (await callTool(tool, client, { fileId: FILE_ID, pageId: PAGE_ID })) as {
      shapes: Array<{ id: string; componentId?: string }>
    }

    const plain = result.shapes.find((s) => s.id === 'shape-plain')
    expect(plain?.componentId).toBeUndefined()
  })
})
