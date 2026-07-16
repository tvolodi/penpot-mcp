/**
 * test/unit/comments.test.ts
 *
 * Unit tests for the comments tools (`src/tools/comments.ts`) and the
 * comment-related methods on PenpotRpcClient (`src/rpc-client.ts`).
 * No network calls are made — fetch is fully mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PenpotRpcClient, PenpotRpcError } from '../../src/rpc-client.js'
import { commentTools } from '../../src/tools/comments.js'
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
    getCommentThreads: vi.fn().mockResolvedValue([]),
    getCommentThread: vi.fn().mockResolvedValue({}),
    createCommentThread: vi.fn().mockResolvedValue({ id: 'thread-1' }),
    updateCommentThread: vi.fn().mockResolvedValue({ updated: 'thread-1', isResolved: true }),
    deleteCommentThread: vi.fn().mockResolvedValue({ deleted: 'thread-1' }),
    getComments: vi.fn().mockResolvedValue([]),
    createComment: vi.fn().mockResolvedValue({ id: 'comment-1' }),
    updateComment: vi.fn().mockResolvedValue({ updated: 'comment-1' }),
    deleteComment: vi.fn().mockResolvedValue({ deleted: 'comment-1' }),
  } as unknown as PenpotRpcClient
}

function getTool(name: string): AnyTool {
  const tool = commentTools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool as unknown as AnyTool
}

const BASE = 'https://penpot.example.com'
const TOKEN = 'test-token'

// ---------------------------------------------------------------------------
// commentTools registry
// ---------------------------------------------------------------------------

describe('commentTools', () => {
  it('exports exactly the expected tool names', () => {
    const names = commentTools.map((t) => t.name).sort()
    expect(names).toEqual([
      'penpot_create_comment',
      'penpot_create_comment_thread',
      'penpot_delete_comment',
      'penpot_delete_comment_thread',
      'penpot_get_comments',
      'penpot_list_comment_threads',
      'penpot_resolve_comment_thread',
      'penpot_update_comment',
    ])
  })

  it('every tool has a non-empty description', () => {
    for (const tool of commentTools) {
      expect(tool.description.trim().length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// penpot_list_comment_threads
// ---------------------------------------------------------------------------

describe('penpot_list_comment_threads', () => {
  const tool = getTool('penpot_list_comment_threads')

  it('input schema accepts a fileId string', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'file-abc' })).not.toThrow()
  })

  it('input schema rejects missing fileId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('input schema rejects empty fileId', () => {
    expect(() => tool.inputSchema.parse({ fileId: '' })).toThrow()
  })

  it('handler calls client.getCommentThreads with fileId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'file-abc' })
    expect(client.getCommentThreads).toHaveBeenCalledOnce()
    expect(client.getCommentThreads).toHaveBeenCalledWith('file-abc')
  })

  it('handler returns the result from client.getCommentThreads', async () => {
    const client = makeMockClient()
    const threads = [{ id: 't1', content: 'Hello' }]
    vi.mocked(client.getCommentThreads).mockResolvedValueOnce(threads as never)
    const result = await tool.handler(client, { fileId: 'file-abc' })
    expect(result).toEqual(threads)
  })
})

// ---------------------------------------------------------------------------
// penpot_get_comments
// ---------------------------------------------------------------------------

describe('penpot_get_comments', () => {
  const tool = getTool('penpot_get_comments')

  it('input schema accepts a threadId string', () => {
    expect(() => tool.inputSchema.parse({ threadId: 'thread-abc' })).not.toThrow()
  })

  it('input schema rejects missing threadId', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('handler calls client.getComments with threadId', async () => {
    const client = makeMockClient()
    await tool.handler(client, { threadId: 'thread-abc' })
    expect(client.getComments).toHaveBeenCalledOnce()
    expect(client.getComments).toHaveBeenCalledWith('thread-abc')
  })
})

// ---------------------------------------------------------------------------
// penpot_create_comment_thread
// ---------------------------------------------------------------------------

describe('penpot_create_comment_thread', () => {
  const tool = getTool('penpot_create_comment_thread')

  it('input schema accepts required fields', () => {
    expect(() =>
      tool.inputSchema.parse({ fileId: 'f', pageId: 'p', x: 100, y: 200, content: 'Hello' }),
    ).not.toThrow()
  })

  it('input schema accepts optional frameId', () => {
    expect(() =>
      tool.inputSchema.parse({ fileId: 'f', pageId: 'p', x: 0, y: 0, content: 'Hi', frameId: 'frame-1' }),
    ).not.toThrow()
  })

  it('input schema rejects missing content', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'f', pageId: 'p', x: 0, y: 0 })).toThrow()
  })

  it('input schema rejects empty content', () => {
    expect(() => tool.inputSchema.parse({ fileId: 'f', pageId: 'p', x: 0, y: 0, content: '' })).toThrow()
  })

  it('handler calls client.createCommentThread with correct args (no frameId)', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'f', pageId: 'p', x: 100, y: 200, content: 'Hello' })
    expect(client.createCommentThread).toHaveBeenCalledWith('f', 'p', { x: 100, y: 200 }, 'Hello', undefined)
  })

  it('handler passes frameId to client.createCommentThread when supplied', async () => {
    const client = makeMockClient()
    await tool.handler(client, { fileId: 'f', pageId: 'p', x: 0, y: 0, content: 'Hi', frameId: 'fr-1' })
    expect(client.createCommentThread).toHaveBeenCalledWith('f', 'p', { x: 0, y: 0 }, 'Hi', 'fr-1')
  })
})

// ---------------------------------------------------------------------------
// penpot_create_comment
// ---------------------------------------------------------------------------

describe('penpot_create_comment', () => {
  const tool = getTool('penpot_create_comment')

  it('input schema accepts threadId and content', () => {
    expect(() => tool.inputSchema.parse({ threadId: 't', content: 'Reply' })).not.toThrow()
  })

  it('input schema rejects empty content', () => {
    expect(() => tool.inputSchema.parse({ threadId: 't', content: '' })).toThrow()
  })

  it('handler calls client.createComment with threadId and content', async () => {
    const client = makeMockClient()
    await tool.handler(client, { threadId: 'thread-1', content: 'Reply text' })
    expect(client.createComment).toHaveBeenCalledWith('thread-1', 'Reply text')
  })
})

// ---------------------------------------------------------------------------
// penpot_update_comment
// ---------------------------------------------------------------------------

describe('penpot_update_comment', () => {
  const tool = getTool('penpot_update_comment')

  it('input schema accepts id and content', () => {
    expect(() => tool.inputSchema.parse({ id: 'c1', content: 'Edited' })).not.toThrow()
  })

  it('input schema rejects empty content', () => {
    expect(() => tool.inputSchema.parse({ id: 'c1', content: '' })).toThrow()
  })

  it('handler calls client.updateComment with id and content', async () => {
    const client = makeMockClient()
    await tool.handler(client, { id: 'comment-1', content: 'New text' })
    expect(client.updateComment).toHaveBeenCalledWith('comment-1', 'New text')
  })
})

// ---------------------------------------------------------------------------
// penpot_resolve_comment_thread
// ---------------------------------------------------------------------------

describe('penpot_resolve_comment_thread', () => {
  const tool = getTool('penpot_resolve_comment_thread')

  it('input schema accepts id and isResolved=true', () => {
    expect(() => tool.inputSchema.parse({ id: 't1', isResolved: true })).not.toThrow()
  })

  it('input schema accepts id and isResolved=false', () => {
    expect(() => tool.inputSchema.parse({ id: 't1', isResolved: false })).not.toThrow()
  })

  it('input schema rejects missing isResolved', () => {
    expect(() => tool.inputSchema.parse({ id: 't1' })).toThrow()
  })

  it('handler calls client.updateCommentThread with id and isResolved', async () => {
    const client = makeMockClient()
    await tool.handler(client, { id: 'thread-1', isResolved: true })
    expect(client.updateCommentThread).toHaveBeenCalledWith('thread-1', true)
  })

  it('handler passes isResolved=false for reopening', async () => {
    const client = makeMockClient()
    await tool.handler(client, { id: 'thread-1', isResolved: false })
    expect(client.updateCommentThread).toHaveBeenCalledWith('thread-1', false)
  })
})

// ---------------------------------------------------------------------------
// penpot_delete_comment
// ---------------------------------------------------------------------------

describe('penpot_delete_comment', () => {
  const tool = getTool('penpot_delete_comment')

  it('input schema accepts an id string', () => {
    expect(() => tool.inputSchema.parse({ id: 'comment-1' })).not.toThrow()
  })

  it('input schema rejects missing id', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('handler calls client.deleteComment with id', async () => {
    const client = makeMockClient()
    await tool.handler(client, { id: 'comment-1' })
    expect(client.deleteComment).toHaveBeenCalledWith('comment-1')
  })
})

// ---------------------------------------------------------------------------
// penpot_delete_comment_thread
// ---------------------------------------------------------------------------

describe('penpot_delete_comment_thread', () => {
  const tool = getTool('penpot_delete_comment_thread')

  it('input schema accepts an id string', () => {
    expect(() => tool.inputSchema.parse({ id: 'thread-1' })).not.toThrow()
  })

  it('input schema rejects missing id', () => {
    expect(() => tool.inputSchema.parse({})).toThrow()
  })

  it('handler calls client.deleteCommentThread with id', async () => {
    const client = makeMockClient()
    await tool.handler(client, { id: 'thread-1' })
    expect(client.deleteCommentThread).toHaveBeenCalledWith('thread-1')
  })
})

// ---------------------------------------------------------------------------
// PenpotRpcClient — comment methods (HTTP wire format)
// ---------------------------------------------------------------------------

describe('PenpotRpcClient comment methods', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const client = new PenpotRpcClient(BASE, TOKEN)

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('getCommentThreads', () => {
    it('calls get-comment-threads with file-id as query param', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, '[]'))
      await client.getCommentThreads('file-abc')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/api/rpc/command/get-comment-threads?file-id=file-abc`)
      expect(init.method).toBe('GET')
    })
  })

  describe('getComments', () => {
    it('calls get-comments with thread-id as query param', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, '[]'))
      await client.getComments('thread-123')
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('get-comments')
      expect(url).toContain('thread-id=thread-123')
    })
  })

  describe('createCommentThread', () => {
    it('calls create-comment-thread via POST with kebab-case body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify({ id: 'th1' })))
      await client.createCommentThread('file-1', 'page-1', { x: 50, y: 75 }, 'Hello')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/api/rpc/command/create-comment-thread`)
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['file-id']).toBe('file-1')
      expect(body['page-id']).toBe('page-1')
      expect(body['position']).toEqual({ x: 50, y: 75 })
      expect(body['content']).toBe('Hello')
      expect(body['frame-id']).toBeUndefined()
    })

    it('includes frame-id in the body when frameId is supplied', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify({ id: 'th1' })))
      await client.createCommentThread('file-1', 'page-1', { x: 0, y: 0 }, 'Hi', 'frame-abc')
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['frame-id']).toBe('frame-abc')
    })
  })

  describe('updateCommentThread', () => {
    it('calls update-comment-thread with is-resolved in body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      await client.updateCommentThread('thread-1', true)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/api/rpc/command/update-comment-thread`)
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['id']).toBe('thread-1')
      expect(body['is-resolved']).toBe(true)
    })

    it('returns { updated, isResolved } after a successful call', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      const result = await client.updateCommentThread('thread-1', false)
      expect(result).toEqual({ updated: 'thread-1', isResolved: false })
    })
  })

  describe('deleteCommentThread', () => {
    it('calls delete-comment-thread via POST with id in body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      await client.deleteCommentThread('thread-1')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/api/rpc/command/delete-comment-thread`)
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['id']).toBe('thread-1')
    })

    it('returns { deleted: id } after deletion', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      const result = await client.deleteCommentThread('thread-1')
      expect(result).toEqual({ deleted: 'thread-1' })
    })
  })

  describe('createComment', () => {
    it('calls create-comment via POST with thread-id and content', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify({ id: 'c1' })))
      await client.createComment('thread-1', 'Reply')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/api/rpc/command/create-comment`)
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['thread-id']).toBe('thread-1')
      expect(body['content']).toBe('Reply')
    })
  })

  describe('updateComment', () => {
    it('calls update-comment via POST with id and content', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      await client.updateComment('comment-1', 'Edited text')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/api/rpc/command/update-comment`)
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['id']).toBe('comment-1')
      expect(body['content']).toBe('Edited text')
    })

    it('returns { updated: id } after a successful call', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      const result = await client.updateComment('comment-1', 'text')
      expect(result).toEqual({ updated: 'comment-1' })
    })
  })

  describe('deleteComment', () => {
    it('calls delete-comment via POST with id in body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      await client.deleteComment('comment-1')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/api/rpc/command/delete-comment`)
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['id']).toBe('comment-1')
    })

    it('returns { deleted: id } after deletion', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      const result = await client.deleteComment('comment-1')
      expect(result).toEqual({ deleted: 'comment-1' })
    })
  })

  describe('error propagation', () => {
    it('throws PenpotRpcError when any comment endpoint returns 403', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(403, JSON.stringify({ error: 'forbidden' })))
      const err = await client.getCommentThreads('file-1').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PenpotRpcError)
      expect((err as PenpotRpcError).status).toBe(403)
    })
  })
})
