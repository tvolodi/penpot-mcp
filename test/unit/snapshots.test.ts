/**
 * test/unit/snapshots.test.ts
 *
 * Unit tests for the snapshot (version history) tools (`src/tools/snapshots.ts`)
 * and the snapshot-related methods on PenpotRpcClient (`src/rpc-client.ts`).
 * No network calls are made — fetch is fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PenpotRpcClient, PenpotRpcError } from '../../src/rpc-client.js'
import { snapshotTools } from '../../src/tools/snapshots.js'
import type { ZodType } from 'zod'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(status: number, body: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockImplementation(async () => JSON.parse(body) as unknown),
    arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode(body).buffer),
    headers: { get: (_: string) => null },
  } as unknown as Response
}

type AnyTool = {
  name: string
  description: string
  inputSchema: ZodType<unknown>
  handler: (client: PenpotRpcClient, input: unknown) => Promise<unknown>
}

function makeMockClient(): PenpotRpcClient {
  return {
    listFileSnapshots: vi.fn().mockResolvedValue([]),
    getFileSnapshotData: vi.fn().mockResolvedValue({}),
    createFileSnapshot: vi.fn().mockResolvedValue({ id: 'snap-1', label: 'v1' }),
    restoreFileSnapshot: vi.fn().mockResolvedValue({ restored: 'snap-1' }),
    renameFileSnapshot: vi.fn().mockResolvedValue({ updated: 'snap-1' }),
    deleteFileSnapshot: vi.fn().mockResolvedValue({ deleted: 'snap-1' }),
    lockFileSnapshot: vi.fn().mockResolvedValue({ locked: 'snap-1' }),
    unlockFileSnapshot: vi.fn().mockResolvedValue({ unlocked: 'snap-1' }),
  } as unknown as PenpotRpcClient
}

function getTool(name: string): AnyTool {
  const tool = snapshotTools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool as unknown as AnyTool
}

const BASE = 'https://penpot.example.com'
const TOKEN = 'test-token'

// ---------------------------------------------------------------------------
// snapshotTools registry
// ---------------------------------------------------------------------------

describe('snapshotTools', () => {
  it('exports exactly the expected tool names', () => {
    const names = snapshotTools.map((t) => t.name).sort()
    expect(names).toEqual([
      'penpot_create_file_snapshot',
      'penpot_delete_file_snapshot',
      'penpot_get_file_snapshot_data',
      'penpot_list_file_snapshots',
      'penpot_lock_file_snapshot',
      'penpot_rename_file_snapshot',
      'penpot_restore_file_snapshot',
      'penpot_unlock_file_snapshot',
    ])
  })

  it('every tool has a non-empty description', () => {
    for (const tool of snapshotTools) {
      expect(tool.description.trim().length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// penpot_list_file_snapshots
// ---------------------------------------------------------------------------

describe('penpot_list_file_snapshots', () => {
  const tool = getTool('penpot_list_file_snapshots')

  it('input schema accepts a fileId string', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc' })).not.toThrow()
  })

  it('input schema rejects missing fileId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('input schema rejects empty fileId', () => {
    expect(() => tool.inputSchema.parse({ fileId: '' })).toThrow()
  })

  it('handler calls client.listFileSnapshots with fileId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'file-abc' })
    expect(client.listFileSnapshots).toHaveBeenCalledOnce()
    expect(client.listFileSnapshots).toHaveBeenCalledWith('file-abc')
  })

  it('handler returns the result from client.listFileSnapshots', async () => {
    const client = makeMockClient()
    const snapshots = [{ id: 'snap-1', label: 'Before redesign' }]
    vi.mocked(client.listFileSnapshots).mockResolvedValueOnce(snapshots as never)
    const result = await tool.handler(client, { fileId: 'file-abc' })
    expect(result).toEqual(snapshots)
  })
})

// ---------------------------------------------------------------------------
// penpot_create_file_snapshot
// ---------------------------------------------------------------------------

describe('penpot_create_file_snapshot', () => {
  const tool = getTool('penpot_create_file_snapshot')

  it('input schema accepts fileId only (no label)', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc' })).not.toThrow()
  })

  it('input schema accepts fileId with label', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc', label: 'v1.0' })).not.toThrow()
  })

  it('input schema rejects missing fileId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('input schema rejects empty fileId', () => {
    expect(() => tool.inputSchema.parse({ fileId: '' })).toThrow()
  })

  it('input schema rejects empty label', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc', label: '' })).toThrow()
  })

  it('handler calls client.createFileSnapshot with fileId and no label', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'file-abc' })
    expect(client.createFileSnapshot).toHaveBeenCalledOnce()
    expect(client.createFileSnapshot).toHaveBeenCalledWith('file-abc', undefined)
  })

  it('handler calls client.createFileSnapshot with fileId and label', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'file-abc', label: 'v1.0' })
    expect(client.createFileSnapshot).toHaveBeenCalledWith('file-abc', 'v1.0')
  })

  it('handler returns the created snapshot metadata', async () => {
    const client = makeMockClient()
    const snap = { id: 'snap-new', label: 'v1.0', revn: 42 }
    vi.mocked(client.createFileSnapshot).mockResolvedValueOnce(snap as never)
    const result = await tool.handler(client, { fileId: 'file-abc', label: 'v1.0' })
    expect(result).toEqual(snap)
  })
})

// ---------------------------------------------------------------------------
// penpot_restore_file_snapshot
// ---------------------------------------------------------------------------

describe('penpot_restore_file_snapshot', () => {
  const tool = getTool('penpot_restore_file_snapshot')

  it('input schema accepts fileId and snapshotId', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc', snapshotId: 'snap-1' })).not.toThrow()
  })

  it('input schema rejects missing snapshotId', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc' })).toThrow()
  })

  it('input schema rejects missing fileId', () => {
    expect(() => tool.inputSchema.parse({ snapshotId: 'snap-1' })).toThrow()
  })

  it('input schema rejects empty fileId', () => {
    expect(() => tool.inputSchema.parse({ fileId: '', snapshotId: 'snap-1' })).toThrow()
  })

  it('input schema rejects empty snapshotId', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc', snapshotId: '' })).toThrow()
  })

  it('handler calls client.restoreFileSnapshot with fileId and snapshotId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'file-abc', snapshotId: 'snap-1' })
    expect(client.restoreFileSnapshot).toHaveBeenCalledOnce()
    expect(client.restoreFileSnapshot).toHaveBeenCalledWith('file-abc', 'snap-1')
  })

  it('handler returns the restore result', async () => {
    const client = makeMockClient()
    vi.mocked(client.restoreFileSnapshot).mockResolvedValueOnce({ restored: 'snap-1' })
    const result = await tool.handler(client, { fileId: 'file-abc', snapshotId: 'snap-1' })
    expect(result).toEqual({ restored: 'snap-1' })
  })
})

// ---------------------------------------------------------------------------
// penpot_rename_file_snapshot
// ---------------------------------------------------------------------------

describe('penpot_rename_file_snapshot', () => {
  const tool = getTool('penpot_rename_file_snapshot')

  it('input schema accepts snapshotId and label', () => {
    expect(() => tool.inputSchema.parse({ snapshotId: 'snap-1', label: 'Final design' })).not.toThrow()
  })

  it('input schema rejects missing label', () => {
    expect(() => tool.inputSchema.parse({ snapshotId: 'snap-1' })).toThrow()
  })

  it('input schema rejects empty label', () => {
    expect(() => tool.inputSchema.parse({ snapshotId: 'snap-1', label: '' })).toThrow()
  })

  it('handler calls client.renameFileSnapshot with snapshotId and label', async () => {
    const client = makeMockClient()
    await tool.handler(client, { snapshotId: 'snap-1', label: 'Final design' })
    expect(client.renameFileSnapshot).toHaveBeenCalledOnce()
    expect(client.renameFileSnapshot).toHaveBeenCalledWith('snap-1', 'Final design')
  })

  it('handler returns the update result', async () => {
    const client = makeMockClient()
    vi.mocked(client.renameFileSnapshot).mockResolvedValueOnce({ updated: 'snap-1' })
    const result = await tool.handler(client, { snapshotId: 'snap-1', label: 'Final design' })
    expect(result).toEqual({ updated: 'snap-1' })
  })
})

// ---------------------------------------------------------------------------
// penpot_delete_file_snapshot
// ---------------------------------------------------------------------------

describe('penpot_delete_file_snapshot', () => {
  const tool = getTool('penpot_delete_file_snapshot')

  it('input schema accepts a snapshotId string', () => {
    expect(() => tool.inputSchema.parse({ snapshotId: 'snap-1' })).not.toThrow()
  })

  it('input schema rejects missing snapshotId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('input schema rejects empty snapshotId', () => {
    expect(() => tool.inputSchema.parse({ snapshotId: '' })).toThrow()
  })

  it('handler calls client.deleteFileSnapshot with snapshotId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { snapshotId: 'snap-1' })
    expect(client.deleteFileSnapshot).toHaveBeenCalledOnce()
    expect(client.deleteFileSnapshot).toHaveBeenCalledWith('snap-1')
  })

  it('handler returns the deletion result', async () => {
    const client = makeMockClient()
    vi.mocked(client.deleteFileSnapshot).mockResolvedValueOnce({ deleted: 'snap-1' })
    const result = await tool.handler(client, { snapshotId: 'snap-1' })
    expect(result).toEqual({ deleted: 'snap-1' })
  })
})

// ---------------------------------------------------------------------------
// penpot_get_file_snapshot_data
// ---------------------------------------------------------------------------

describe('penpot_get_file_snapshot_data', () => {
  const tool = getTool('penpot_get_file_snapshot_data')

  it('input schema accepts fileId and snapshotId', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc', snapshotId: 'snap-1' })).not.toThrow()
  })

  it('input schema rejects missing snapshotId', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc' })).toThrow()
  })

  it('handler calls client.getFileSnapshotData with fileId and snapshotId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'file-abc', snapshotId: 'snap-1' })
    expect(client.getFileSnapshotData).toHaveBeenCalledOnce()
    expect(client.getFileSnapshotData).toHaveBeenCalledWith('file-abc', 'snap-1')
  })

  it('handler returns the snapshot data', async () => {
    const client = makeMockClient()
    const data = { id: 'file-abc', revn: 5, data: { pages: [] } }
    vi.mocked(client.getFileSnapshotData).mockResolvedValueOnce(data)
    const result = await tool.handler(client, { fileId: 'file-abc', snapshotId: 'snap-1' })
    expect(result).toEqual(data)
  })
})

// ---------------------------------------------------------------------------
// penpot_lock_file_snapshot
// ---------------------------------------------------------------------------

describe('penpot_lock_file_snapshot', () => {
  const tool = getTool('penpot_lock_file_snapshot')

  it('input schema accepts a snapshotId string', () => {
    expect(() => tool.inputSchema.parse({ snapshotId: 'snap-1' })).not.toThrow()
  })

  it('input schema rejects missing snapshotId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('handler calls client.lockFileSnapshot with snapshotId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { snapshotId: 'snap-1' })
    expect(client.lockFileSnapshot).toHaveBeenCalledOnce()
    expect(client.lockFileSnapshot).toHaveBeenCalledWith('snap-1')
  })
})

// ---------------------------------------------------------------------------
// penpot_unlock_file_snapshot
// ---------------------------------------------------------------------------

describe('penpot_unlock_file_snapshot', () => {
  const tool = getTool('penpot_unlock_file_snapshot')

  it('input schema accepts a snapshotId string', () => {
    expect(() => tool.inputSchema.parse({ snapshotId: 'snap-1' })).not.toThrow()
  })

  it('input schema rejects missing snapshotId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('handler calls client.unlockFileSnapshot with snapshotId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { snapshotId: 'snap-1' })
    expect(client.unlockFileSnapshot).toHaveBeenCalledOnce()
    expect(client.unlockFileSnapshot).toHaveBeenCalledWith('snap-1')
  })
})

// ---------------------------------------------------------------------------
// PenpotRpcClient snapshot methods — fetch-level tests
// ---------------------------------------------------------------------------

describe('PenpotRpcClient snapshot methods', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('listFileSnapshots sends GET to get-file-snapshots with file-id param', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '[]'))
    const client = new PenpotRpcClient(BASE, TOKEN)
    await client.listFileSnapshots('file-abc')
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/rpc/command/get-file-snapshots')
    expect(url).toContain('file-id=file-abc')
    expect(opts.method).toBe('GET')
  })

  it('getFileSnapshotData sends GET to get-file-snapshot with file-id and id params', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{"id":"snap-1"}'))
    const client = new PenpotRpcClient(BASE, TOKEN)
    await client.getFileSnapshotData('file-abc', 'snap-1')
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/rpc/command/get-file-snapshot')
    expect(url).toContain('file-id=file-abc')
    expect(url).toContain('id=snap-1')
    expect(opts.method).toBe('GET')
  })

  it('createFileSnapshot sends POST to create-file-snapshot with file-id', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{"id":"snap-new","label":"v1"}'))
    const client = new PenpotRpcClient(BASE, TOKEN)
    await client.createFileSnapshot('file-abc', 'v1')
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/rpc/command/create-file-snapshot')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(body['file-id']).toBe('file-abc')
    expect(body['label']).toBe('v1')
  })

  it('createFileSnapshot omits label key when not provided', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{"id":"snap-new","label":"snapshot-auto"}'))
    const client = new PenpotRpcClient(BASE, TOKEN)
    await client.createFileSnapshot('file-abc')
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(Object.keys(body)).not.toContain('label')
  })

  it('restoreFileSnapshot sends POST to restore-file-snapshot', async () => {
    fetchMock.mockResolvedValue(mockResponse(204, ''))
    const client = new PenpotRpcClient(BASE, TOKEN)
    const result = await client.restoreFileSnapshot('file-abc', 'snap-1')
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/rpc/command/restore-file-snapshot')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(body['file-id']).toBe('file-abc')
    expect(body['id']).toBe('snap-1')
    expect(result).toEqual({ restored: 'snap-1' })
  })

  it('renameFileSnapshot sends POST to update-file-snapshot', async () => {
    fetchMock.mockResolvedValue(mockResponse(204, ''))
    const client = new PenpotRpcClient(BASE, TOKEN)
    const result = await client.renameFileSnapshot('snap-1', 'New name')
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/rpc/command/update-file-snapshot')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(body['id']).toBe('snap-1')
    expect(body['label']).toBe('New name')
    expect(result).toEqual({ updated: 'snap-1' })
  })

  it('deleteFileSnapshot sends POST to delete-file-snapshot', async () => {
    fetchMock.mockResolvedValue(mockResponse(204, ''))
    const client = new PenpotRpcClient(BASE, TOKEN)
    const result = await client.deleteFileSnapshot('snap-1')
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/rpc/command/delete-file-snapshot')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(body['id']).toBe('snap-1')
    expect(result).toEqual({ deleted: 'snap-1' })
  })

  it('lockFileSnapshot sends POST to lock-file-snapshot', async () => {
    fetchMock.mockResolvedValue(mockResponse(204, ''))
    const client = new PenpotRpcClient(BASE, TOKEN)
    const result = await client.lockFileSnapshot('snap-1')
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/rpc/command/lock-file-snapshot')
    expect(opts.method).toBe('POST')
    expect(result).toEqual({ locked: 'snap-1' })
  })

  it('unlockFileSnapshot sends POST to unlock-file-snapshot', async () => {
    fetchMock.mockResolvedValue(mockResponse(204, ''))
    const client = new PenpotRpcClient(BASE, TOKEN)
    const result = await client.unlockFileSnapshot('snap-1')
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/rpc/command/unlock-file-snapshot')
    expect(opts.method).toBe('POST')
    expect(result).toEqual({ unlocked: 'snap-1' })
  })

  it('listFileSnapshots throws PenpotRpcError on non-2xx response', async () => {
    fetchMock.mockResolvedValue(mockResponse(403, '{"error":"forbidden"}'))
    const client = new PenpotRpcClient(BASE, TOKEN)
    await expect(client.listFileSnapshots('file-abc')).rejects.toBeInstanceOf(PenpotRpcError)
  })

  it('PenpotRpcError carries method name and status', async () => {
    fetchMock.mockResolvedValue(mockResponse(404, '{"error":"not found"}'))
    const client = new PenpotRpcClient(BASE, TOKEN)
    try {
      await client.listFileSnapshots('file-abc')
      expect.fail('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PenpotRpcError)
      const rpcErr = err as PenpotRpcError
      expect(rpcErr.status).toBe(404)
      expect(rpcErr.method).toBe('get-file-snapshots')
    }
  })
})
