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
 * Two auth modes are supported:
 *
 *   'password' — logs in once with email/password to obtain the cookie,
 *     caches it for the process lifetime, and re-logs-in automatically on
 *     expiry. Works for Penpot instances that expose password login.
 *
 *   'cookie' — accepts a raw auth-token value the caller already obtained
 *     (e.g. by completing an OIDC/SSO login in a real browser and copying
 *     the auth-token cookie). The profile-id is fetched via `get-profile`
 *     on first use. No automatic re-login is possible; a helpful error is
 *     thrown if the cookie expires.
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

export type ExportFormat = 'png' | 'svg' | 'pdf'

export type ExportResult = {
  data: Buffer
  mimeType: string
  filename: string
}

export type BatchExportSpec = {
  shapeId: string
  pageId: string
  format: ExportFormat
  scale: number
  name: string
}

/** Discriminated union describing how the exporter authenticates. */
export type ExporterAuth =
  | { mode: 'password'; email: string; password: string }
  | { mode: 'cookie'; authTokenCookie: string }

export class PenpotExporterClient {
  private authCookie: string | undefined
  private profileId: string | undefined

  constructor(
    private readonly baseUrl: string,
    private readonly auth: ExporterAuth,
  ) {
    if (auth.mode === 'cookie') {
      // Pre-seed the cookie so the first exportShape call skips the login step.
      this.authCookie = auth.authTokenCookie
    }
  }

  private async login(): Promise<void> {
    if (this.auth.mode !== 'password') {
      // Should never be reached — ensureSession guards this.
      throw new Error('Internal error: login() called in cookie auth mode')
    }
    const res = await fetch(`${this.baseUrl}/api/rpc/command/login-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: this.auth.email, password: this.auth.password }),
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

  /**
   * Fetches the profile-id for the currently cached cookie via `get-profile`.
   * Used in cookie mode where there is no login response to parse.
   */
  private async fetchProfileId(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/rpc/command/get-profile`, {
      headers: { Cookie: `auth-token=${this.authCookie!}`, Accept: 'application/json' },
    })
    const text = await res.text()
    if (res.status < 200 || res.status >= 300) {
      throw new PenpotExporterError('login', res.status, text)
    }
    const profile = JSON.parse(text) as { id?: string }
    if (!profile.id) {
      throw new PenpotExporterError('login', res.status, 'no profile id in get-profile response')
    }
    this.profileId = profile.id
  }

  private async ensureSession(): Promise<{ cookie: string; profileId: string }> {
    if (!this.authCookie) {
      // password mode only — cookie mode pre-seeds authCookie in the constructor.
      await this.login()
    }
    if (!this.profileId) {
      if (this.auth.mode === 'cookie') {
        await this.fetchProfileId()
      }
      // In password mode profileId is always set by login() above.
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

    // The session cookie can expire between calls.
    if ((res.status === 401 || res.status === 403) && retry) {
      if (this.auth.mode === 'password') {
        // Re-login and retry once.
        this.authCookie = undefined
        this.profileId = undefined
        return this.exportShape(fileId, pageId, shapeId, format, scale, name, false)
      } else {
        // Cookie mode: no credentials to re-login with.
        throw new PenpotExporterError(
          'export',
          res.status,
          'The PENPOT_AUTH_TOKEN_COOKIE session has expired. ' +
            'Obtain a fresh auth-token cookie by completing the OIDC/SSO login in your browser ' +
            '(DevTools → Application → Cookies → auth-token), update PENPOT_AUTH_TOKEN_COOKIE ' +
            'with the new value, and restart the MCP server.',
        )
      }
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

  /**
   * Exports multiple shapes in a single request to the Penpot exporter,
   * returning one ExportResult per spec in the same order.
   */
  async exportShapesBatch(
    fileId: string,
    specs: BatchExportSpec[],
    retry: boolean = true,
  ): Promise<ExportResult[]> {
    if (specs.length === 0) return []

    const { cookie, profileId } = await this.ensureSession()

    const body = encodeMap({
      cmd: kw('export-shapes'),
      wait: true,
      'profile-id': uuid(profileId),
      exports: specs.map(
        (spec) =>
          new Map<string, any>([
            ['page-id', uuid(spec.pageId)],
            ['file-id', uuid(fileId)],
            ['object-id', uuid(spec.shapeId)],
            ['type', kw(spec.format)],
            ['scale', spec.scale],
            ['suffix', ''],
            ['name', spec.name],
          ]),
      ),
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

    if ((res.status === 401 || res.status === 403) && retry) {
      if (this.auth.mode === 'password') {
        this.authCookie = undefined
        this.profileId = undefined
        return this.exportShapesBatch(fileId, specs, false)
      } else {
        throw new PenpotExporterError(
          'export',
          res.status,
          'The PENPOT_AUTH_TOKEN_COOKIE session has expired. ' +
            'Obtain a fresh auth-token cookie by completing the OIDC/SSO login in your browser ' +
            '(DevTools → Application → Cookies → auth-token), update PENPOT_AUTH_TOKEN_COOKIE ' +
            'with the new value, and restart the MCP server.',
        )
      }
    }

    if (res.status < 200 || res.status >= 300) {
      throw new PenpotExporterError('export', res.status, text)
    }

    // Parse all result entries from the transit+json response.
    // Each export result appears as a transit map containing :uri, :mtype, :filename keys;
    // matchAll extracts them all in document order, which matches the exports array order.
    const uris = [...text.matchAll(/"~:uri":\{"~#uri":"([^"]+)"\}/g)].map((m) => m[1]!)
    const mtypes = [...text.matchAll(/"~:mtype":"([^"]+)"/g)].map((m) => m[1]!)
    const filenameMatches = [...text.matchAll(/"~:filename":"([^"]+)"/g)].map((m) => m[1])

    if (uris.length !== specs.length) {
      throw new PenpotExporterError(
        'export',
        res.status,
        `Expected ${specs.length} export result(s) but got ${uris.length} URI(s) in response`,
      )
    }

    return Promise.all(
      uris.map(async (uri, i) => {
        const assetRes = await fetch(uri, {
          headers: { Cookie: `auth-token=${cookie}` },
        })
        if (assetRes.status < 200 || assetRes.status >= 300) {
          throw new PenpotExporterError('download', assetRes.status, await assetRes.text())
        }
        const arrayBuffer = await assetRes.arrayBuffer()
        return {
          data: Buffer.from(arrayBuffer),
          mimeType: mtypes[i] ?? `image/${specs[i]!.format}`,
          filename: filenameMatches[i] ?? `${specs[i]!.name}.${specs[i]!.format}`,
        } satisfies ExportResult
      }),
    )
  }
}
