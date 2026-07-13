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
}

export type FileSummary = {
  id: string
  revn: number
  vern: number
  name: string
  data: {
    pages: string[]
    pagesIndex: Record<string, { id: string; name: string; objects: Record<string, unknown> }>
  }
}

export type Change = Record<string, unknown>

export type UpdateFileResult = {
  revn: number
  lagged: Array<{ id: string; revn: number; fileId: string; sessionId: string; changes: Change[] }>
}
