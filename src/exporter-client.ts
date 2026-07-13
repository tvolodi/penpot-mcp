/**
 * exporter-client.ts
 *
 * Client for Penpot's shape/page render-to-image capability.
 *
 * This is a *separate* auth mode from PenpotRpcClient: the render pipeline
 * (`POST /api/export`, handled by the exporter microservice) authenticates
 * via the `auth-token` session cookie exclusively — a personal access token
 * in an `Authorization` header is never read on this path. Confirmed by
 * reading Penpot 2.16.2 source (`exporter/src/app/http.cljs`'s `wrap-auth`
 * reads the literal `auth-token` cookie and nothing else) and empirically
 * against a live instance.
 *
 * So this client logs in once with email/password to obtain that cookie,
 * caches it for the process lifetime, and re-logs-in on expiry.
 */

import { encodeMap, kw, uuid } from './transit.js'

export class PenpotExporterError extends Error {
  constructor(
    public readonly step: 'login' | 'export' | 'download',
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`penpot export ${step} failed: HTTP ${status}`)
  }
}

export type ExportFormat = 'png' | 'svg'

export type ExportResult = {
  data: Buffer
  mimeType: string
  filename: string
}

export class PenpotExporterClient {
  private authCookie: string | undefined
  private profileId: string | undefined

  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly password: string,
  ) {}

  private async login(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/rpc/command/login-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    })

    const text = await res.text()
    if (res.status < 200 || res.status >= 300) {
      throw new PenpotExporterError('login', res.status, text)
    }

    const setCookie = res.headers.get('set-cookie')
    const cookieMatch = setCookie?.match(/auth-token=([^;]+)/)
    if (!cookieMatch) {
      throw new PenpotExporterError('login', res.status, 'no auth-token cookie in login response')
    }
    this.authCookie = cookieMatch[1]

    const profile = JSON.parse(text) as { id?: string }
    if (!profile.id) {
      throw new PenpotExporterError('login', res.status, 'no profile id in login response')
    }
    this.profileId = profile.id
  }

  private async ensureSession(): Promise<{ cookie: string; profileId: string }> {
    if (!this.authCookie || !this.profileId) {
      await this.login()
    }
    return { cookie: this.authCookie!, profileId: this.profileId! }
  }

  async exportShape(
    fileId: string,
    pageId: string,
    shapeId: string,
    format: ExportFormat = 'png',
    scale: number = 1,
    name: string = 'export',
    retry: boolean = true,
  ): Promise<ExportResult> {
    const { cookie, profileId } = await this.ensureSession()

    const body = encodeMap({
      cmd: kw('export-shapes'),
      wait: true,
      'profile-id': uuid(profileId),
      exports: [
        new Map<string, any>([
          ['page-id', uuid(pageId)],
          ['file-id', uuid(fileId)],
          ['object-id', uuid(shapeId)],
          ['type', kw(format)],
          ['scale', scale],
          ['suffix', ''],
          ['name', name],
        ]),
      ],
    })

    const res = await fetch(`${this.baseUrl}/api/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/transit+json',
        Accept: 'application/transit+json',
        Cookie: `auth-token=${cookie}`,
      },
      body,
    })

    const text = await res.text()

    // The session cookie can expire between calls; re-login once and retry.
    if ((res.status === 401 || res.status === 403) && retry) {
      this.authCookie = undefined
      this.profileId = undefined
      return this.exportShape(fileId, pageId, shapeId, format, scale, name, false)
    }

    if (res.status < 200 || res.status >= 300) {
      throw new PenpotExporterError('export', res.status, text)
    }

    const uri = text.match(/"~:uri":\{"~#uri":"([^"]+)"\}/)?.[1]
    const mtype = text.match(/"~:mtype":"([^"]+)"/)?.[1]
    const filename = text.match(/"~:filename":"([^"]+)"/)?.[1] ?? `${name}.${format}`
    if (!uri || !mtype) {
      throw new PenpotExporterError('export', res.status, text)
    }

    const assetRes = await fetch(uri, {
      headers: { Cookie: `auth-token=${cookie}` },
    })
    if (assetRes.status < 200 || assetRes.status >= 300) {
      throw new PenpotExporterError('download', assetRes.status, await assetRes.text())
    }

    const arrayBuffer = await assetRes.arrayBuffer()
    return {
      data: Buffer.from(arrayBuffer),
      mimeType: mtype,
      filename,
    }
  }
}
