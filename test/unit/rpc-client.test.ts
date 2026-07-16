import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PenpotRpcClient, PenpotRpcError, PenpotStaleWriteError } from '../../src/rpc-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object for the `call()` path (uses .text() and .status). */
function mockResponse(
  status: number,
  body: string,
  contentType?: string,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: vi.fn().mockResolvedValue(body),
    // Lazy parse so mock construction doesn't throw for non-JSON bodies;
    // rpc-client's call() path only uses .text() anyway.
    json: vi.fn().mockImplementation(async () => JSON.parse(body) as unknown),
    arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode(body).buffer),
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? (contentType ?? null) : null),
    },
  } as unknown as Response
}

/** Build a binary-capable mock response for downloadFontVariantBytes. */
function mockBinaryResponse(bytes: Uint8Array, contentType = 'font/truetype'): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (_: string) => contentType },
    arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
    json: vi.fn(),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// PenpotRpcError
// ---------------------------------------------------------------------------

describe('PenpotRpcError', () => {
  it('stores method, status, and body on the error instance', () => {
    const err = new PenpotRpcError('get-teams', 403, { error: 'forbidden' })
    expect(err.method).toBe('get-teams')
    expect(err.status).toBe(403)
    expect(err.body).toEqual({ error: 'forbidden' })
  })

  it('formats a human-readable message', () => {
    const err = new PenpotRpcError('update-file', 500, null)
    expect(err.message).toBe('update-file failed: HTTP 500')
  })

  it('is an instance of Error', () => {
    expect(new PenpotRpcError('x', 400, null)).toBeInstanceOf(Error)
  })

  it('accepts any value as body (null, string, object)', () => {
    expect(new PenpotRpcError('x', 400, null).body).toBeNull()
    expect(new PenpotRpcError('x', 400, 'plain text').body).toBe('plain text')
    expect(new PenpotRpcError('x', 400, { code: 42 }).body).toEqual({ code: 42 })
  })
})

// ---------------------------------------------------------------------------
// PenpotStaleWriteError
// ---------------------------------------------------------------------------

describe('PenpotStaleWriteError', () => {
  const fakeResult = { revn: 42, lagged: [{ id: 'c1', revn: 41, fileId: 'f', sessionId: 's', changes: [] }] }

  it('is an instance of Error', () => {
    expect(new PenpotStaleWriteError(1, fakeResult)).toBeInstanceOf(Error)
  })

  it('exposes laggedCount and result', () => {
    const err = new PenpotStaleWriteError(3, fakeResult)
    expect(err.laggedCount).toBe(3)
    expect(err.result).toBe(fakeResult)
  })

  it('includes laggedCount and new revn in the message', () => {
    const err = new PenpotStaleWriteError(2, fakeResult)
    expect(err.message).toContain('2 concurrent change-set(s)')
    expect(err.message).toContain('revn: 42')
  })

  it('mentions re-fetching in the message', () => {
    const err = new PenpotStaleWriteError(1, fakeResult)
    expect(err.message).toContain('penpot_get_file_snapshot')
  })
})

// ---------------------------------------------------------------------------
// PenpotRpcClient — call() path (exercised through public methods)
// ---------------------------------------------------------------------------

describe('PenpotRpcClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const BASE = 'https://penpot.example.com'
  const TOKEN = 'test-token'
  const client = new PenpotRpcClient(BASE, TOKEN)

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // --- GET requests ---

  describe('GET requests', () => {
    it('uses the correct URL and sets Authorization / Accept headers', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, '[]'))
      await client.getTeams()

      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/api/rpc/command/get-teams`)
      expect(init.method).toBe('GET')
      const headers = init.headers as Record<string, string>
      expect(headers['Authorization']).toBe(`Token ${TOKEN}`)
      expect(headers['Accept']).toBe('application/json')
    })

    it('serialises params as a query string, not a request body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, '[]'))
      await client.getProjects('team-abc')

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('team-id=team-abc')
      expect(init.body).toBeUndefined()
    })

    it('sends no Content-Type header for GET', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, '[]'))
      await client.getTeams()

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    })
  })

  // --- POST requests ---

  describe('POST requests', () => {
    it('uses POST method and sends Content-Type: application/json', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify({ id: 'proj1' })))
      await client.createProject('team-abc', 'My Project')

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BASE}/api/rpc/command/create-project`)
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    })

    it('encodes params as kebab-case JSON body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify({ id: 'proj1' })))
      await client.createProject('team-abc', 'My Project')

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['team-id']).toBe('team-abc')
      expect(body['name']).toBe('My Project')
    })

    it('sends no query string for POST', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify({ id: 'p' })))
      await client.createProject('t', 'p')

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).not.toContain('?')
    })
  })

  // --- Status-code handling ---

  describe('status-code handling', () => {
    it('returns null immediately for 204 No Content without reading the body', async () => {
      const res = mockResponse(204, '')
      fetchMock.mockResolvedValueOnce(res)

      const result = await client.getTeams()
      expect(result).toBeNull()
      // .text() should NOT have been called — 204 short-circuits before it
      expect((res.text as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    })

    it('parses a JSON response body and returns the value', async () => {
      const payload = [{ id: 't1', name: 'Team 1' }]
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify(payload)))

      const result = await client.getTeams()
      expect(result).toEqual(payload)
    })

    it('returns null when a 2xx response has an empty body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, ''))

      const result = await client.getTeams()
      expect(result).toBeNull()
    })

    it('returns raw text when a 2xx body is not valid JSON', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, 'plain text response'))

      const result = await client.getTeams()
      expect(result).toBe('plain text response')
    })

    it('throws PenpotRpcError for 401 Unauthorized', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(401, JSON.stringify({ error: 'unauthorized' })),
      )

      const err = await client.getTeams().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PenpotRpcError)
      expect((err as PenpotRpcError).method).toBe('get-teams')
      expect((err as PenpotRpcError).status).toBe(401)
      expect((err as PenpotRpcError).body).toEqual({ error: 'unauthorized' })
    })

    it('throws PenpotRpcError for 403 Forbidden', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(403, JSON.stringify({ error: 'forbidden' })),
      )

      const err = await client.getTeams().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PenpotRpcError)
      expect((err as PenpotRpcError).status).toBe(403)
    })

    it('throws PenpotRpcError for 500 Internal Server Error', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(500, 'Internal Server Error'))

      const err = await client.getTeams().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PenpotRpcError)
      expect((err as PenpotRpcError).status).toBe(500)
      // Non-JSON body is stored as raw text
      expect((err as PenpotRpcError).body).toBe('Internal Server Error')
    })

    it('throws PenpotRpcError for 404 and stores parsed JSON body', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(404, JSON.stringify({ type: 'not-found' })),
      )

      const err = await client.getTeams().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PenpotRpcError)
      expect((err as PenpotRpcError).status).toBe(404)
      expect((err as PenpotRpcError).body).toEqual({ type: 'not-found' })
    })

    it('includes the RPC method name in the PenpotRpcError for POST commands', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(422, JSON.stringify({ error: 'validation' })))

      const err = await client.createProject('t', 'p').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PenpotRpcError)
      expect((err as PenpotRpcError).method).toBe('create-project')
    })
  })

  // --- Wrapper methods ---

  describe('deleteProject / deleteFile wrappers', () => {
    it('deleteProject returns { deleted: id } even when the server responds with 204', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      const result = await client.deleteProject('proj-abc')
      expect(result).toEqual({ deleted: 'proj-abc' })
    })

    it('deleteFile returns { deleted: id } even when the server responds with 204', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(204, ''))
      const result = await client.deleteFile('file-abc')
      expect(result).toEqual({ deleted: 'file-abc' })
    })
  })

  // --- updateFile / stale-write detection ---

  describe('updateFile stale-write detection', () => {
    const cleanResult = { revn: 10, lagged: [] }
    const laggedResult = {
      revn: 12,
      lagged: [
        { id: 'cs1', revn: 11, fileId: 'file-abc', sessionId: 'other-session', changes: [] },
      ],
    }

    it('returns the result when lagged is empty (no concurrent edits)', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify(cleanResult)))
      const result = await client.updateFile('file-abc', 9, 0, [])
      expect(result).toEqual(cleanResult)
    })

    it('throws PenpotStaleWriteError when lagged is non-empty', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify(laggedResult)))
      const err = await client.updateFile('file-abc', 9, 0, []).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PenpotStaleWriteError)
    })

    it('PenpotStaleWriteError.laggedCount matches the number of lagged change-sets', async () => {
      const multiLagged = {
        revn: 15,
        lagged: [
          { id: 'cs1', revn: 11, fileId: 'f', sessionId: 's', changes: [] },
          { id: 'cs2', revn: 12, fileId: 'f', sessionId: 's', changes: [] },
          { id: 'cs3', revn: 13, fileId: 'f', sessionId: 's', changes: [] },
        ],
      }
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify(multiLagged)))
      const err = await client.updateFile('file-abc', 9, 0, []).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PenpotStaleWriteError)
      expect((err as PenpotStaleWriteError).laggedCount).toBe(3)
    })

    it('PenpotStaleWriteError.result carries the update-file response (including new revn)', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify(laggedResult)))
      const err = await client.updateFile('file-abc', 9, 0, []).catch((e: unknown) => e)
      expect((err as PenpotStaleWriteError).result.revn).toBe(12)
    })

    it('does not throw when lagged field is missing from the response', async () => {
      // Older Penpot versions may omit the lagged field entirely.
      const resultWithoutLagged = { revn: 5 }
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify(resultWithoutLagged)))
      await expect(client.updateFile('file-abc', 4, 0, [])).resolves.toEqual(resultWithoutLagged)
    })

    it('sends revn and vern in the POST body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, JSON.stringify(cleanResult)))
      await client.updateFile('file-abc', 7, 3, [])
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['revn']).toBe(7)
      expect(body['vern']).toBe(3)
    })
  })

  // --- downloadFontVariantBytes ---

  describe('downloadFontVariantBytes', () => {
    it('sends Authorization header and uses the download-font endpoint', async () => {
      const bytes = new Uint8Array([1, 2, 3])
      fetchMock.mockResolvedValueOnce(mockBinaryResponse(bytes))
      await client.downloadFontVariantBytes('variant-id')

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('/api/rpc/command/download-font')
      expect(url).toContain('id=variant-id')
      expect((init.headers as Record<string, string>)['Authorization']).toBe(`Token ${TOKEN}`)
    })

    it('URL-encodes the variant id', async () => {
      fetchMock.mockResolvedValueOnce(mockBinaryResponse(new Uint8Array([9])))
      await client.downloadFontVariantBytes('id with spaces')

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
      // encodeURIComponent uses %20 for spaces (not the form-encoded + style)
      expect(url).toContain('id=id%20with%20spaces')
    })

    it('returns a Buffer containing the raw bytes from a direct binary response', async () => {
      const bytes = new Uint8Array([10, 20, 30, 40])
      fetchMock.mockResolvedValueOnce(mockBinaryResponse(bytes))

      const result = await client.downloadFontVariantBytes('variant-id')
      expect(result).toBeInstanceOf(Buffer)
      expect(Array.from(result)).toEqual([10, 20, 30, 40])
    })

    it('follows a JSON redirect: fetches the uri field and returns those bytes', async () => {
      const fontBytes = new Uint8Array([0xaa, 0xbb, 0xcc])
      fetchMock
        // First call: returns JSON with a uri field
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (_: string) => 'application/json' },
          json: vi.fn().mockResolvedValue({
            uri: 'https://assets.example.com/font.ttf',
          }),
        } as unknown as Response)
        // Second call: returns the actual font bytes
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: vi.fn().mockResolvedValue(fontBytes.buffer),
        } as unknown as Response)

      const result = await client.downloadFontVariantBytes('variant-id')
      expect(result).toBeInstanceOf(Buffer)
      expect(Array.from(result)).toEqual([0xaa, 0xbb, 0xcc])
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [assetUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
      expect(assetUrl).toBe('https://assets.example.com/font.ttf')
    })

    it('follows a transit+json redirect (content-type contains "transit")', async () => {
      const fontBytes = new Uint8Array([0x01, 0x02])
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (_: string) => 'application/transit+json' },
          json: vi.fn().mockResolvedValue({
            uri: 'https://assets.example.com/font.woff2',
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: vi.fn().mockResolvedValue(fontBytes.buffer),
        } as unknown as Response)

      const result = await client.downloadFontVariantBytes('v')
      expect(Array.from(result)).toEqual([0x01, 0x02])
    })

    it('throws if a JSON redirect response has no uri field', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (_: string) => 'application/json' },
        json: vi.fn().mockResolvedValue({}),
      } as unknown as Response)

      await expect(client.downloadFontVariantBytes('v')).rejects.toThrow(
        'unexpected response format (no uri field)',
      )
    })

    it('throws on a non-ok initial response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: { get: (_: string) => null },
      } as unknown as Response)

      await expect(client.downloadFontVariantBytes('missing')).rejects.toThrow(
        'Font variant download failed: HTTP 404',
      )
    })

    it('throws if the font asset fetch fails after a JSON redirect', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (_: string) => 'application/json' },
          json: vi.fn().mockResolvedValue({
            uri: 'https://assets.example.com/broken.ttf',
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
        } as unknown as Response)

      await expect(client.downloadFontVariantBytes('v')).rejects.toThrow(
        'Font asset fetch failed: HTTP 403',
      )
    })
  })
})
