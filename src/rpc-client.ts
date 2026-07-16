/**
 * rpc-client.ts
 *
 * Client for Penpot's RPC API (metadata + content mutation) — no browser,
 * no Penpot plugin session. Base URL is passed in, not hardcoded, so this
 * client works against any Penpot instance (self-hosted or design.penpot.app).
 *
 * Auth: a Penpot access token (never logged, never echoed).
 */

export class PenpotRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`${method} failed: HTTP ${status}`)
  }
}

export class PenpotRpcClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call(
    method: string,
    httpMethod: 'GET' | 'POST',
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Token ${this.token}`,
      Accept: 'application/json',
    }

    let url = `${this.baseUrl}/api/rpc/command/${method}`
    let body: string | undefined

    if (httpMethod === 'GET') {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      if (qs) url += `?${qs}`
    } else {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(params)
    }

    const res = await fetch(url, { method: httpMethod, headers, body })

    if (res.status === 204) return null

    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (res.status < 200 || res.status >= 300) {
      throw new PenpotRpcError(method, res.status, parsed)
    }

    return parsed
  }

  // --- Teams / Projects / Files metadata ---

  getTeams(): Promise<unknown> {
    return this.call('get-teams', 'GET', {})
  }

  getTeamFontVariants(teamId: string): Promise<FontVariant[]> {
    return this.call('get-font-variants', 'GET', { 'team-id': teamId }) as Promise<FontVariant[]>
  }

  /**
   * Downloads the binary bytes for a font variant (by its UUID). The Penpot
   * `download-font` command redirects to the storage asset URI; `fetch` follows
   * the redirect automatically. If the endpoint instead returns JSON with a `uri`
   * field (older or differently configured instances), the URI is fetched with
   * the same auth token.
   */
  async downloadFontVariantBytes(variantId: string): Promise<Buffer> {
    const url = `${this.baseUrl}/api/rpc/command/download-font?id=${encodeURIComponent(variantId)}`
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Token ${this.token}` },
      redirect: 'follow',
    })
    if (!res.ok) {
      throw new Error(`Font variant download failed: HTTP ${res.status}`)
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('json') || contentType.includes('transit')) {
      // Endpoint returned JSON/transit with { uri } — fetch the actual asset URI.
      const body = (await res.json()) as { uri?: string }
      if (!body.uri) throw new Error('Font variant download: unexpected response format (no uri field)')
      const fontRes = await fetch(body.uri, {
        headers: { Authorization: `Token ${this.token}` },
      })
      if (!fontRes.ok) throw new Error(`Font asset fetch failed: HTTP ${fontRes.status}`)
      return Buffer.from(await fontRes.arrayBuffer())
    }
    // Redirect was followed → response body is the raw font bytes.
    return Buffer.from(await res.arrayBuffer())
  }

  getProjects(teamId: string): Promise<unknown> {
    return this.call('get-projects', 'GET', { 'team-id': teamId })
  }

  getProjectFiles(projectId: string): Promise<unknown> {
    return this.call('get-project-files', 'GET', { 'project-id': projectId })
  }

  createProject(teamId: string, name: string): Promise<unknown> {
    return this.call('create-project', 'POST', { 'team-id': teamId, name })
  }

  renameProject(id: string, name: string): Promise<unknown> {
    return this.call('rename-project', 'POST', { id, name })
  }

  async deleteProject(id: string): Promise<{ deleted: string }> {
    await this.call('delete-project', 'POST', { id })
    return { deleted: id }
  }

  createFile(projectId: string, name: string): Promise<unknown> {
    return this.call('create-file', 'POST', { 'project-id': projectId, name })
  }

  renameFile(id: string, name: string): Promise<unknown> {
    return this.call('rename-file', 'POST', { id, name })
  }

  async deleteFile(id: string): Promise<{ deleted: string }> {
    await this.call('delete-file', 'POST', { id })
    return { deleted: id }
  }

  // --- File content ---

  async getFile(fileId: string): Promise<FileSummary> {
    return (await this.call('get-file', 'GET', { id: fileId })) as FileSummary
  }

  async updateFile(
    fileId: string,
    revn: number,
    vern: number,
    changes: Change[],
    sessionId: string = crypto.randomUUID(),
  ): Promise<UpdateFileResult> {
    return (await this.call('update-file', 'POST', {
      id: fileId,
      'session-id': sessionId,
      revn,
      vern,
      changes,
    })) as UpdateFileResult
  }

  // --- Media uploads ---

  /**
   * Uploads binary content (a Buffer) as a media object attached to `fileId`.
   * Sends `upload-file-media-object` via multipart/form-data — the only Penpot
   * RPC endpoint that accepts a binary payload rather than JSON.
   *
   * Returns the created `MediaObject` whose `id` can be used as `mediaId` in an
   * `image` shape's `metadata` field.
   */
  async uploadFileMediaObject(
    fileId: string,
    name: string,
    content: Buffer,
    mtype: string,
    isLocal = true,
  ): Promise<MediaObject> {
    const url = `${this.baseUrl}/api/rpc/command/upload-file-media-object`
    const ext = mtype.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'bin'
    const formData = new FormData()
    formData.append('file-id', fileId)
    formData.append('is-local', String(isLocal))
    formData.append('name', name)
    formData.append('content', new Blob([content.buffer as ArrayBuffer], { type: mtype }), `${name}.${ext}`)

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Token ${this.token}`, Accept: 'application/json' },
      body: formData,
    })

    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (res.status < 200 || res.status >= 300) {
      throw new PenpotRpcError('upload-file-media-object', res.status, parsed)
    }

    return parsed as MediaObject
  }

  /**
   * Creates a media object in `fileId` by having Penpot's server download the
   * image from `imageUrl` (POST `create-file-media-object-from-url`). Prefer
   * this over `uploadFileMediaObject` when you already have an HTTPS URL, so the
   * MCP server doesn't need to buffer the image bytes itself.
   */
  createFileMediaObjectFromUrl(
    fileId: string,
    imageUrl: string,
    name?: string,
    isLocal = true,
  ): Promise<MediaObject> {
    const params: Record<string, unknown> = { 'file-id': fileId, 'is-local': isLocal, url: imageUrl }
    if (name) params['name'] = name
    return this.call('create-file-media-object-from-url', 'POST', params) as Promise<MediaObject>
  }
}

/**
 * A Penpot file media object — the server-side record created by
 * `upload-file-media-object` or `create-file-media-object-from-url`.
 * Use its `id` as the `mediaId` when building an `image` shape.
 */
export type MediaObject = {
  id: string
  name: string
  width: number
  height: number
  mtype: string
  isLocal: boolean
}

export type FileComponent = {
  id: string
  name: string
  path: string
  mainInstanceId: string
  mainInstancePage: string
  variantId?: string
  variantProperties?: Array<{ name: string; value: string }>
}

export type FontVariant = {
  id: string
  teamId: string
  fontId: string
  fontFamily: string
  fontWeight: number
  fontStyle: string
  ttfFileId: string | null
  otfFileId: string | null
  woff1FileId: string | null
  woff2FileId: string | null
}

export type FileSummary = {
  id: string
  revn: number
  vern: number
  name: string
  data: {
    pages: string[]
    pagesIndex: Record<string, { id: string; name: string; objects: Record<string, unknown> }>
    components?: Record<string, FileComponent>
  }
}

export type Change = Record<string, unknown>

export type UpdateFileResult = {
  revn: number
  lagged: Array<{ id: string; revn: number; fileId: string; sessionId: string; changes: Change[] }>
}
