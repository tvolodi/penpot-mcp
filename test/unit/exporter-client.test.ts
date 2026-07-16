import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PenpotExporterClient, PenpotExporterError, type BatchExportSpec } from '../../src/exporter-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = 'https://penpot.example.com'
const FILE_ID = 'aaaaaaaa-0000-0000-0000-000000000000'
const PAGE_ID = 'bbbbbbbb-0000-0000-0000-000000000000'

function makeShapeId(n: number): string {
  return `cccccccc-0000-0000-0000-${String(n).padStart(12, '0')}`
}

/**
 * Build a transit+json export response string for one or more results.
 * Penpot's exporter serialises maps as plain JSON objects with "~:"-prefixed
 * keys (transit's JSON-object encoding), so the regex patterns in
 * exportShapesBatch — e.g. /"~:uri":{"~#uri":"([^"]+)"}/g — match.
 */
function makeExportResponse(
  results: Array<{ uri: string; mtype: string; filename: string }>,
): string {
  const entries = results.map(({ uri, mtype, filename }) => ({
    '~:uri': { '~#uri': uri },
    '~:mtype': mtype,
    '~:filename': filename,
  }))
  const data = entries.length === 1 ? entries[0]! : entries
  return JSON.stringify({ '~:status': '~:ok', '~:data': data })
}

/** Make a fake image Buffer of `n` bytes. */
function fakeBytes(n: number): ArrayBuffer {
  return new Uint8Array(n).fill(n).buffer
}

function mockResponse(status: number, body: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: vi.fn().mockResolvedValue(body),
    headers: { get: () => null },
  } as unknown as Response
}

function mockBinaryResponse(bytes: ArrayBuffer): Response {
  return {
    status: 200,
    ok: true,
    text: vi.fn().mockResolvedValue(''),
    headers: { get: () => null },
    arrayBuffer: vi.fn().mockResolvedValue(bytes),
  } as unknown as Response
}

// Login response: returns a set-cookie header and profile JSON
function mockLoginResponse(profileId = 'profile-id-1'): Response {
  return {
    status: 200,
    ok: true,
    text: vi.fn().mockResolvedValue(JSON.stringify({ id: profileId })),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'set-cookie' ? `auth-token=test-cookie; Path=/` : null,
    },
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// PenpotExporterError
// ---------------------------------------------------------------------------

describe('PenpotExporterError', () => {
  it('stores step, status, and body', () => {
    const err = new PenpotExporterError('export', 500, 'bad')
    expect(err.step).toBe('export')
    expect(err.status).toBe(500)
    expect(err.body).toBe('bad')
  })

  it('formats a readable message', () => {
    expect(new PenpotExporterError('login', 401, null).message).toBe(
      'penpot export login failed: HTTP 401',
    )
  })

  it('is an instance of Error', () => {
    expect(new PenpotExporterError('download', 404, null)).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// exportShapesBatch — response parsing
// ---------------------------------------------------------------------------

describe('PenpotExporterClient.exportShapesBatch', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeClient(): PenpotExporterClient {
    return new PenpotExporterClient(BASE, {
      mode: 'cookie',
      authTokenCookie: 'test-cookie',
    })
  }

  function makePasswordClient(): PenpotExporterClient {
    return new PenpotExporterClient(BASE, {
      mode: 'password',
      email: 'user@example.com',
      password: 'secret',
    })
  }

  function makeSpec(n: number, format: BatchExportSpec['format'] = 'png'): BatchExportSpec {
    return {
      shapeId: makeShapeId(n),
      pageId: PAGE_ID,
      format,
      scale: 1,
      name: `shape-${n}`,
    }
  }

  it('returns an empty array when specs is empty', async () => {
    const client = makeClient()
    const results = await client.exportShapesBatch(FILE_ID, [])
    expect(results).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches get-profile on first use in cookie mode then exports', async () => {
    const client = makeClient()
    const uri = 'https://penpot.example.com/assets/file1.png'

    // get-profile call (cookie mode lazy profile fetch)
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, JSON.stringify({ id: 'profile-id-1' })),
    )
    // export call
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, makeExportResponse([{ uri, mtype: 'image/png', filename: 'shape-1.png' }])),
    )
    // asset download
    fetchMock.mockResolvedValueOnce(mockBinaryResponse(fakeBytes(4)))

    const results = await client.exportShapesBatch(FILE_ID, [makeSpec(1)])
    expect(results).toHaveLength(1)
    expect(results[0]!.mimeType).toBe('image/png')
    expect(results[0]!.filename).toBe('shape-1.png')
    expect(results[0]!.data).toBeInstanceOf(Buffer)
  })

  it('returns results in the same order as the input specs', async () => {
    const client = makeClient()
    const uris = [
      'https://penpot.example.com/assets/a.png',
      'https://penpot.example.com/assets/b.png',
      'https://penpot.example.com/assets/c.png',
    ]

    fetchMock.mockResolvedValueOnce(
      mockResponse(200, JSON.stringify({ id: 'profile-id-1' })),
    )
    fetchMock.mockResolvedValueOnce(
      mockResponse(
        200,
        makeExportResponse([
          { uri: uris[0]!, mtype: 'image/png', filename: 'shape-1.png' },
          { uri: uris[1]!, mtype: 'image/png', filename: 'shape-2.png' },
          { uri: uris[2]!, mtype: 'image/png', filename: 'shape-3.png' },
        ]),
      ),
    )
    // Asset downloads (one per shape)
    for (let i = 0; i < 3; i++) {
      fetchMock.mockResolvedValueOnce(mockBinaryResponse(fakeBytes(i + 1)))
    }

    const specs = [makeSpec(1), makeSpec(2), makeSpec(3)]
    const results = await client.exportShapesBatch(FILE_ID, specs)

    expect(results).toHaveLength(3)
    expect(results[0]!.filename).toBe('shape-1.png')
    expect(results[1]!.filename).toBe('shape-2.png')
    expect(results[2]!.filename).toBe('shape-3.png')
    // Buffer sizes match fakeBytes(n) which creates an n-byte buffer
    expect(results[0]!.data.length).toBe(1)
    expect(results[1]!.data.length).toBe(2)
    expect(results[2]!.data.length).toBe(3)
  })

  it('accepts pdf format and passes it through to the Penpot API', async () => {
    const client = makeClient()
    const uri = 'https://penpot.example.com/assets/out.pdf'

    fetchMock.mockResolvedValueOnce(
      mockResponse(200, JSON.stringify({ id: 'profile-id-1' })),
    )
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, makeExportResponse([{ uri, mtype: 'application/pdf', filename: 'out.pdf' }])),
    )
    fetchMock.mockResolvedValueOnce(mockBinaryResponse(fakeBytes(8)))

    const results = await client.exportShapesBatch(FILE_ID, [makeSpec(1, 'pdf')])
    expect(results).toHaveLength(1)
    expect(results[0]!.mimeType).toBe('application/pdf')
    expect(results[0]!.filename).toBe('out.pdf')

    // Verify the export API call included the pdf type
    const exportCall = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(exportCall[1].body).toContain('~:pdf')
  })

  it('throws PenpotExporterError when URI count does not match spec count', async () => {
    const client = makeClient()

    fetchMock.mockResolvedValueOnce(
      mockResponse(200, JSON.stringify({ id: 'profile-id-1' })),
    )
    // Response has 1 URI but we sent 2 specs
    fetchMock.mockResolvedValueOnce(
      mockResponse(
        200,
        makeExportResponse([{ uri: 'https://example.com/a.png', mtype: 'image/png', filename: 'a.png' }]),
      ),
    )

    await expect(
      client.exportShapesBatch(FILE_ID, [makeSpec(1), makeSpec(2)]),
    ).rejects.toBeInstanceOf(PenpotExporterError)
  })

  it('throws PenpotExporterError on non-2xx export response', async () => {
    const client = makeClient()

    fetchMock.mockResolvedValueOnce(
      mockResponse(200, JSON.stringify({ id: 'profile-id-1' })),
    )
    fetchMock.mockResolvedValueOnce(mockResponse(500, 'internal server error'))

    await expect(
      client.exportShapesBatch(FILE_ID, [makeSpec(1)]),
    ).rejects.toBeInstanceOf(PenpotExporterError)
  })

  it('throws PenpotExporterError with expiry message on 401 in cookie mode', async () => {
    const client = makeClient()

    fetchMock.mockResolvedValueOnce(
      mockResponse(200, JSON.stringify({ id: 'profile-id-1' })),
    )
    fetchMock.mockResolvedValueOnce(mockResponse(401, 'unauthorized'))

    const err = await client.exportShapesBatch(FILE_ID, [makeSpec(1)]).catch((e) => e)
    expect(err).toBeInstanceOf(PenpotExporterError)
    expect((err as PenpotExporterError).body).toContain('PENPOT_AUTH_TOKEN_COOKIE')
  })

  it('re-logs-in and retries once on 401 in password mode', async () => {
    const client = makePasswordClient()
    const uri = 'https://penpot.example.com/assets/out.png'

    // First login (implicit from password mode, triggered by first export call)
    fetchMock.mockResolvedValueOnce(mockLoginResponse('profile-1'))
    // First export attempt returns 401
    fetchMock.mockResolvedValueOnce(mockResponse(401, 'unauthorized'))
    // Re-login
    fetchMock.mockResolvedValueOnce(mockLoginResponse('profile-1'))
    // Retry export succeeds
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, makeExportResponse([{ uri, mtype: 'image/png', filename: 'out.png' }])),
    )
    // Asset download
    fetchMock.mockResolvedValueOnce(mockBinaryResponse(fakeBytes(4)))

    const results = await client.exportShapesBatch(FILE_ID, [makeSpec(1)])
    expect(results).toHaveLength(1)
    expect(results[0]!.filename).toBe('out.png')
    // Total fetch calls: login + export(401) + re-login + export(200) + download
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('sends all specs in a single POST to /api/export', async () => {
    const client = makeClient()
    const specs = [makeSpec(1), makeSpec(2)]
    const uris = [
      'https://penpot.example.com/assets/a.png',
      'https://penpot.example.com/assets/b.png',
    ]

    fetchMock.mockResolvedValueOnce(
      mockResponse(200, JSON.stringify({ id: 'profile-id-1' })),
    )
    fetchMock.mockResolvedValueOnce(
      mockResponse(
        200,
        makeExportResponse([
          { uri: uris[0]!, mtype: 'image/png', filename: 'a.png' },
          { uri: uris[1]!, mtype: 'image/png', filename: 'b.png' },
        ]),
      ),
    )
    fetchMock.mockResolvedValueOnce(mockBinaryResponse(fakeBytes(1)))
    fetchMock.mockResolvedValueOnce(mockBinaryResponse(fakeBytes(2)))

    await client.exportShapesBatch(FILE_ID, specs)

    // Only 1 POST to /api/export (not 2 separate ones)
    const exportCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) =>
      url.endsWith('/api/export'),
    )
    expect(exportCalls).toHaveLength(1)
  })

  it('passes each spec\'s pageId individually so shapes from different pages can be batched', async () => {
    const client = makeClient()
    const PAGE_ID_2 = 'dddddddd-0000-0000-0000-000000000000'
    const specs: BatchExportSpec[] = [
      { shapeId: makeShapeId(1), pageId: PAGE_ID, format: 'png', scale: 1, name: 'shape-1' },
      { shapeId: makeShapeId(2), pageId: PAGE_ID_2, format: 'svg', scale: 2, name: 'shape-2' },
    ]
    const uris = [
      'https://penpot.example.com/assets/shape-1.png',
      'https://penpot.example.com/assets/shape-2.svg',
    ]

    fetchMock.mockResolvedValueOnce(
      mockResponse(200, JSON.stringify({ id: 'profile-id-1' })),
    )
    fetchMock.mockResolvedValueOnce(
      mockResponse(
        200,
        makeExportResponse([
          { uri: uris[0]!, mtype: 'image/png', filename: 'shape-1.png' },
          { uri: uris[1]!, mtype: 'image/svg+xml', filename: 'shape-2.svg' },
        ]),
      ),
    )
    fetchMock.mockResolvedValueOnce(mockBinaryResponse(fakeBytes(1)))
    fetchMock.mockResolvedValueOnce(mockBinaryResponse(fakeBytes(2)))

    const results = await client.exportShapesBatch(FILE_ID, specs)
    expect(results).toHaveLength(2)
    expect(results[0]!.mimeType).toBe('image/png')
    expect(results[1]!.mimeType).toBe('image/svg+xml')

    // Both page IDs must appear in the single export request body
    const exportCall = (fetchMock.mock.calls as [string, RequestInit][]).find(([url]) =>
      url.endsWith('/api/export'),
    )
    const body = exportCall![1].body as string
    expect(body).toContain(PAGE_ID)
    expect(body).toContain(PAGE_ID_2)

    // Only 1 POST to /api/export regardless of different pages
    const exportCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) =>
      url.endsWith('/api/export'),
    )
    expect(exportCalls).toHaveLength(1)
  })
})
