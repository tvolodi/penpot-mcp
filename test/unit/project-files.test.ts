import { describe, it, expect, vi } from 'vitest'
import { projectFileTools } from '../../src/tools/project-files.js'
import type { PenpotRpcClient } from '../../src/rpc-client.js'
import type { ZodType } from 'zod'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Erased type for a single tool entry so handler/inputSchema calls in tests
 * don't hit the TypeScript intersection-of-all-inputs problem that arises when
 * the array's union type is used directly.
 */
type AnyTool = {
  name: string
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: ZodType<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (client: PenpotRpcClient, input: any) => Promise<unknown>
}

/** Build a mock PenpotRpcClient with all methods stubbed as vi.fn(). */
function makeMockClient(): PenpotRpcClient {
  return {
    getTeams: vi.fn().mockResolvedValue([{ id: 'team1' }]),
    getProjects: vi.fn().mockResolvedValue([{ id: 'proj1' }]),
    getProjectFiles: vi.fn().mockResolvedValue([{ id: 'file1' }]),
    createProject: vi.fn().mockResolvedValue({ id: 'proj-new' }),
    renameProject: vi.fn().mockResolvedValue({ id: 'proj1', name: 'Renamed' }),
    deleteProject: vi.fn().mockResolvedValue({ deleted: 'proj1' }),
    createFile: vi.fn().mockResolvedValue({ id: 'file-new' }),
    renameFile: vi.fn().mockResolvedValue({ id: 'file1', name: 'Renamed' }),
    deleteFile: vi.fn().mockResolvedValue({ deleted: 'file1' }),
    getFile: vi.fn().mockResolvedValue({ id: 'file1', revn: 0, data: {} }),
  } as unknown as PenpotRpcClient
}

/** Find a tool definition by its registered MCP tool name. Throws if missing. */
function getTool(name: string): AnyTool {
  const tool = projectFileTools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found in projectFileTools: ${name}`)
  return tool as unknown as AnyTool
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('projectFileTools', () => {
  it('exports exactly the expected set of tool names', () => {
    const names = projectFileTools.map((t) => t.name).sort()
    expect(names).toEqual([
      'penpot_create_file',
      'penpot_create_project',
      'penpot_delete_file',
      'penpot_delete_project',
      'penpot_get_file_snapshot',
      'penpot_list_files',
      'penpot_list_projects',
      'penpot_list_teams',
      'penpot_rename_file',
      'penpot_rename_project',
    ])
  })

  it('every tool has a non-empty description', () => {
    for (const tool of projectFileTools) {
      expect(tool.description.trim().length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// penpot_list_teams
// ---------------------------------------------------------------------------

describe('penpot_list_teams', () => {
  const tool = getTool('penpot_list_teams')

  it('handler calls client.getTeams()', async () => {
    const client = makeMockClient()
    await tool.handler(client, {})
    expect(client.getTeams).toHaveBeenCalledOnce()
    expect(client.getTeams).toHaveBeenCalledWith()
  })

  it('handler returns the value from client.getTeams()', async () => {
    const client = makeMockClient()
    const result = await tool.handler(client, {})
    expect(result).toEqual([{ id: 'team1' }])
  })

  it('input schema accepts an empty object', () => {
    expect(() => tool.inputSchema.parse({})).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// penpot_list_projects
// ---------------------------------------------------------------------------

describe('penpot_list_projects', () => {
  const tool = getTool('penpot_list_projects')

  it('handler calls client.getProjects with the given teamId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { teamId: 'team-abc' })
    expect(client.getProjects).toHaveBeenCalledWith('team-abc')
  })

  it('input schema rejects a missing teamId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('input schema rejects an empty teamId', () => {
    expect(() => tool.inputSchema.parse({ teamId: '' })).toThrow()
  })

  it('input schema accepts a non-empty teamId', () => {
    expect(() => tool.inputSchema.parse({ teamId: 'team-abc' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// penpot_list_files
// ---------------------------------------------------------------------------

describe('penpot_list_files', () => {
  const tool = getTool('penpot_list_files')

  it('handler calls client.getProjectFiles with the given projectId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { projectId: 'proj-abc' })
    expect(client.getProjectFiles).toHaveBeenCalledWith('proj-abc')
  })

  it('input schema rejects a missing projectId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('input schema rejects an empty projectId', () => {
    expect(() => tool.inputSchema.parse({ projectId: '' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// penpot_create_project
// ---------------------------------------------------------------------------

describe('penpot_create_project', () => {
  const tool = getTool('penpot_create_project')

  it('handler calls client.createProject with teamId and name', async () => {
    const client = makeMockClient()
    await tool.handler(client, { teamId: 'team-abc', name: 'My Project' })
    expect(client.createProject).toHaveBeenCalledWith('team-abc', 'My Project')
  })

  it('input schema requires both teamId and name', () => {
    expect(() => tool.inputSchema.parse({ teamId: 'tid' })).toThrow()
    expect(() => tool.inputSchema.parse({ name: 'n' })).toThrow()
    expect(() => tool.inputSchema.parse({ teamId: 'tid', name: 'n' })).not.toThrow()
  })

  it('input schema rejects empty strings', () => {
    expect(() => tool.inputSchema.parse({ teamId: '', name: 'n' })).toThrow()
    expect(() => tool.inputSchema.parse({ teamId: 'tid', name: '' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// penpot_rename_project
// ---------------------------------------------------------------------------

describe('penpot_rename_project', () => {
  const tool = getTool('penpot_rename_project')

  it('handler calls client.renameProject with projectId and name', async () => {
    const client = makeMockClient()
    await tool.handler(client, { projectId: 'proj-abc', name: 'New Name' })
    expect(client.renameProject).toHaveBeenCalledWith('proj-abc', 'New Name')
  })

  it('input schema requires both projectId and name', () => {
    expect(() => tool.inputSchema.parse({ projectId: 'pid' })).toThrow()
    expect(() => tool.inputSchema.parse({ name: 'n' })).toThrow()
  })

  it('input schema rejects empty strings', () => {
    expect(() => tool.inputSchema.parse({ projectId: '', name: 'n' })).toThrow()
    expect(() => tool.inputSchema.parse({ projectId: 'pid', name: '' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// penpot_delete_project
// ---------------------------------------------------------------------------

describe('penpot_delete_project', () => {
  const tool = getTool('penpot_delete_project')

  it('handler calls client.deleteProject with projectId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { projectId: 'proj-abc' })
    expect(client.deleteProject).toHaveBeenCalledWith('proj-abc')
  })

  it('input schema rejects a missing or empty projectId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
    expect(() => tool.inputSchema.parse({ projectId: '' })).toThrow()
  })

  it('input schema accepts a valid projectId', () => {
    expect(() => tool.inputSchema.parse({ projectId: 'proj-abc' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// penpot_create_file
// ---------------------------------------------------------------------------

describe('penpot_create_file', () => {
  const tool = getTool('penpot_create_file')

  it('handler calls client.createFile with projectId and name', async () => {
    const client = makeMockClient()
    await tool.handler(client, { projectId: 'proj-abc', name: 'My File' })
    expect(client.createFile).toHaveBeenCalledWith('proj-abc', 'My File')
  })

  it('input schema requires both projectId and name', () => {
    expect(() => tool.inputSchema.parse({ projectId: 'pid' })).toThrow()
    expect(() => tool.inputSchema.parse({ name: 'n' })).toThrow()
  })

  it('input schema rejects empty strings', () => {
    expect(() => tool.inputSchema.parse({ projectId: '', name: 'n' })).toThrow()
    expect(() => tool.inputSchema.parse({ projectId: 'pid', name: '' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// penpot_rename_file
// ---------------------------------------------------------------------------

describe('penpot_rename_file', () => {
  const tool = getTool('penpot_rename_file')

  it('handler calls client.renameFile with fileId and name', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'file-abc', name: 'Renamed' })
    expect(client.renameFile).toHaveBeenCalledWith('file-abc', 'Renamed')
  })

  it('input schema requires both fileId and name', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'fid' })).toThrow()
    expect(() => tool.inputSchema.parse({ name: 'n' })).toThrow()
  })

  it('input schema rejects empty strings', () => {
    expect(() => tool.inputSchema.parse({ fileId: '', name: 'n' })).toThrow()
    expect(() => tool.inputSchema.parse({ fileId: 'fid', name: '' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// penpot_delete_file
// ---------------------------------------------------------------------------

describe('penpot_delete_file', () => {
  const tool = getTool('penpot_delete_file')

  it('handler calls client.deleteFile with fileId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'file-abc' })
    expect(client.deleteFile).toHaveBeenCalledWith('file-abc')
  })

  it('input schema rejects a missing or empty fileId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
    expect(() => tool.inputSchema.parse({ fileId: '' })).toThrow()
  })

  it('input schema accepts a valid fileId', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// penpot_get_file_snapshot
// ---------------------------------------------------------------------------

describe('penpot_get_file_snapshot', () => {
  const tool = getTool('penpot_get_file_snapshot')

  it('handler calls client.getFile with fileId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'file-abc' })
    expect(client.getFile).toHaveBeenCalledWith('file-abc')
  })

  it('handler returns the value from client.getFile()', async () => {
    const client = makeMockClient()
    const result = await tool.handler(client, { fileId: 'file-abc' })
    expect(result).toEqual({ id: 'file1', revn: 0, data: {} })
  })

  it('input schema rejects a missing or empty fileId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
    expect(() => tool.inputSchema.parse({ fileId: '' })).toThrow()
  })

  it('input schema accepts a valid fileId', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc' })).not.toThrow()
  })
})
