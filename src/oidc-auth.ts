/**
 * oidc-auth.ts
 *
 * Headless OIDC/SSO login for Penpot's export pipeline.
 *
 * Drives the OIDC authorization-code flow over plain HTTP (no browser),
 * by following the redirect chain from Penpot's OAuth endpoint to the
 * identity provider's login page, submitting the HTML login form with
 * the supplied credentials, and capturing the resulting auth-token cookie.
 *
 * Works for standard form-based IdPs (Keycloak, Authentik, Dex, etc.) that
 * render a regular HTML form on their authorization endpoint. Does NOT
 * work for JavaScript-only login pages (Google, Microsoft, Okta hosted
 * login) — use PENPOT_AUTH_TOKEN_COOKIE for those instead.
 *
 * Multi-step flows (e.g. Authentik's "username on page 1, password on page
 * 2") are handled by a MAX_FORM_STEPS loop that re-parses and re-submits
 * until the auth-token cookie appears or an error is raised.
 */

import * as http from 'node:http'
import * as https from 'node:https'
import { URL } from 'node:url'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OidcLoginError extends Error {
  constructor(
    public readonly step: 'redirect' | 'form' | 'submit' | 'cookie',
    message: string,
  ) {
    super(`OIDC headless login failed at step "${step}": ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Cookie jar
// ---------------------------------------------------------------------------

/**
 * Minimal cookie jar that accumulates Set-Cookie header values and emits
 * them as a Cookie header for subsequent requests.
 *
 * Domain/path scoping is intentionally not enforced — we are driving a
 * single short-lived OIDC flow across a small number of trusted domains,
 * and cross-domain cookie leakage within that flow is acceptable and
 * necessary (Penpot sets state/CSRF cookies, IdP reads them on the
 * redirect, Penpot reads the IdP session cookie on the return leg).
 */
export class CookieJar {
  private readonly store = new Map<string, string>()

  /**
   * Parse and store a single Set-Cookie header value.
   * Only the name=value pair is extracted; attributes (Path, HttpOnly,
   * Expires, …) are discarded.
   */
  addFromHeader(setCookieValue: string): void {
    // e.g. "auth-token=abc123; Path=/; HttpOnly; SameSite=Lax"
    const [nameVal] = setCookieValue.split(';')
    if (!nameVal) return
    const eqIdx = nameVal.indexOf('=')
    if (eqIdx === -1) return
    const name = nameVal.slice(0, eqIdx).trim()
    const value = nameVal.slice(eqIdx + 1).trim()
    if (name) this.store.set(name, value)
  }

  /** Build the Cookie header value to send on the next request. */
  toHeader(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** Retrieve a specific cookie by name. */
  get(name: string): string | undefined {
    return this.store.get(name)
  }
}

// ---------------------------------------------------------------------------
// HTML form parsing
// ---------------------------------------------------------------------------

/** A parsed HTML login form ready to be submitted. */
export interface ParsedForm {
  /** Resolved absolute form action URL. */
  action: string
  /** HTTP method (lowercase). */
  method: string
  /**
   * All form fields to be submitted.
   * Hidden fields carry their default values; text/email/password fields are
   * present but empty — the caller sets the credential values before posting.
   */
  fields: Map<string, string>
  /** Name of the detected username / e-mail input (`null` if not found). */
  usernameFieldName: string | null
  /** Name of the detected password input (`null` if not found). */
  passwordFieldName: string | null
}

/**
 * Extract login-looking forms from an HTML page.
 *
 * A form is considered a login form if it contains either a `type="password"`
 * input or a recognisable username/e-mail input, so that single-step forms
 * (Keycloak-style: username + password together) AND multi-step flows
 * (Authentik-style: username first, password second) are both handled.
 *
 * @param html    Raw HTML string from the IdP authorization page.
 * @param pageUrl URL of the page (used to resolve relative action URLs).
 */
export function parseLoginForms(html: string, pageUrl: string): ParsedForm[] {
  const results: ParsedForm[] = []

  const formRe = /<form([^>]*)>([\s\S]*?)<\/form>/gi
  for (const formMatch of html.matchAll(formRe)) {
    const formAttrs = formMatch[1]!
    const formBody = formMatch[2]!

    const actionRaw = extractAttr(formAttrs, 'action')
    const methodRaw = extractAttr(formAttrs, 'method') ?? 'post'
    const method = methodRaw.toLowerCase()

    // Decode HTML entities in the action attribute (common: &amp; → &)
    const actionDecoded = decodeHtmlEntities(actionRaw ?? '')
    const action = actionDecoded
      ? actionDecoded.startsWith('http')
        ? actionDecoded
        : safeResolveUrl(actionDecoded, pageUrl)
      : pageUrl

    const fields = new Map<string, string>()
    let usernameFieldName: string | null = null
    let passwordFieldName: string | null = null

    const inputRe = /<input([^>]*?)(?:\s*\/?>)/gi
    for (const inputMatch of formBody.matchAll(inputRe)) {
      const attrs = inputMatch[1]!
      const name = extractAttr(attrs, 'name')
      if (!name) continue

      const type = (extractAttr(attrs, 'type') ?? 'text').toLowerCase()
      const value = extractAttr(attrs, 'value') ?? ''

      // These input types are not sent as form fields in a POST body
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue

      fields.set(name, value)

      if (type === 'password') {
        passwordFieldName = name
      } else if (type !== 'hidden' && type !== 'checkbox' && type !== 'radio') {
        // Heuristic: is this a username / e-mail field?
        const id = extractAttr(attrs, 'id') ?? ''
        const autocomplete = extractAttr(attrs, 'autocomplete') ?? ''
        if (
          type === 'email' ||
          /^(user|email|login|uid|ue|username|email-or-username)$/i.test(name) ||
          /user(?:name)?|e.?mail|log.?in/i.test(id) ||
          /username|email/i.test(autocomplete)
        ) {
          usernameFieldName = name
        }
      }
    }

    // Only retain forms that look like login forms
    if (passwordFieldName !== null || usernameFieldName !== null) {
      results.push({ action, method, fields, usernameFieldName, passwordFieldName })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// HTML / URL utilities
// ---------------------------------------------------------------------------

/** Decode the minimal set of HTML entities that appear in form action URLs. */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
}

function safeResolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).href
  } catch {
    return relative
  }
}

/** Extract an HTML attribute value (double-quoted, single-quoted, or unquoted). */
function extractAttr(attrs: string, attrName: string): string | undefined {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const dq = attrs.match(new RegExp(`\\b${escaped}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]
  if (dq !== undefined) return dq
  const sq = attrs.match(new RegExp(`\\b${escaped}\\s*=\\s*'([^']*)'`, 'i'))?.[1]
  if (sq !== undefined) return sq
  const uq = attrs.match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>/"'][^\\s>]*)`, 'i'))?.[1]
  return uq
}

// ---------------------------------------------------------------------------
// Raw HTTP request (single hop, no redirect following)
// ---------------------------------------------------------------------------

export interface RawHttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  url: string
  text(): Promise<string>
}

/**
 * Signature for the low-level HTTP fetcher.
 * The real implementation uses Node's `http`/`https` modules;
 * tests inject a mock that returns canned responses.
 */
export type RawHttpFetcher = (
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<RawHttpResponse>

/**
 * Makes a single HTTP/HTTPS request without following redirects.
 * Exported to allow injection in tests.
 */
export const rawHttpRequest: RawHttpFetcher = (urlStr, options) => {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(urlStr)
    } catch {
      reject(new Error(`OIDC: malformed URL: ${urlStr}`))
      return
    }

    const isHttps = parsedUrl.protocol === 'https:'
    const mod = isHttps ? https : http
    const bodyBuf = options.body !== undefined ? Buffer.from(options.body, 'utf-8') : undefined

    const reqOptions: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port !== '' ? Number(parsedUrl.port) : isHttps ? 443 : 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method ?? 'GET',
      headers: {
        ...options.headers,
        ...(bodyBuf !== undefined ? { 'Content-Length': String(bodyBuf.length) } : {}),
      },
    }

    const req = mod.request(reqOptions, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        url: urlStr,
        text: () =>
          new Promise<string>((ok, fail) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => ok(Buffer.concat(chunks).toString('utf-8')))
            res.on('error', fail)
          }),
      })
    })

    req.on('error', reject)
    if (bodyBuf !== undefined) req.write(bodyBuf)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Main headless OIDC login
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 20
const MAX_FORM_STEPS = 5

/**
 * Drives a headless OIDC/SSO login flow against a Penpot instance and
 * returns the resulting `auth-token` cookie value.
 *
 * Flow:
 * 1. `GET {baseUrl}/api/auth/oauth/{provider}` — Penpot redirects to the
 *    IdP's authorization endpoint (with state/PKCE parameters).
 * 2. Follow the redirect chain to the IdP's login page.
 * 3. Parse the HTML form; heuristically identify username and password fields.
 * 4. Submit the form (POST) with the supplied credentials.
 * 5. Follow the redirect chain back to Penpot's OIDC callback, which sets
 *    `Set-Cookie: auth-token=…` and redirects to the main app.
 * 6. Return the auth-token cookie value.
 *
 * Multi-step IdP flows (e.g. Authentik: username on page 1, password on
 * page 2) are handled by repeating steps 3–4 up to MAX_FORM_STEPS times.
 *
 * @param baseUrl  Penpot instance base URL (no trailing slash needed).
 * @param provider Penpot OAuth provider name configured on the server (usually `"oidc"`).
 * @param username IdP username or e-mail address.
 * @param password IdP password.
 * @param fetcher  HTTP implementation (injectable; defaults to `rawHttpRequest`).
 */
export async function loginHeadlessOidc(
  baseUrl: string,
  provider: string,
  username: string,
  password: string,
  fetcher: RawHttpFetcher = rawHttpRequest,
): Promise<string> {
  const jar = new CookieJar()

  /**
   * Follow the redirect chain from `startUrl`, collecting cookies along the
   * way, until either a non-redirect response is received or the auth-token
   * cookie appears (meaning the OIDC callback succeeded mid-chain).
   *
   * On a 301/302/303 the method is switched to GET (standard browser
   * behaviour). On 307/308 the original method and body are preserved.
   */
  async function follow(
    startUrl: string,
    method: 'GET' | 'POST' = 'GET',
    body?: string,
  ): Promise<{ html: string; finalUrl: string }> {
    let url = startUrl
    let currentMethod: string = method
    let currentBody: string | undefined = body

    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'penpot-headless-mcp/oidc-login',
      }
      const cookieStr = jar.toHeader()
      if (cookieStr) headers['Cookie'] = cookieStr
      if (currentMethod === 'POST' && currentBody !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }

      const res = await fetcher(url, { method: currentMethod, headers, body: currentBody })

      // Accumulate Set-Cookie headers (Node's http module delivers these as string[])
      const setCookies = res.headers['set-cookie']
      if (setCookies) {
        for (const c of setCookies) {
          jar.addFromHeader(c)
        }
      }

      // Penpot sets auth-token on the OIDC callback redirect response itself —
      // detect it here so we don't make an unnecessary extra request.
      if (jar.get('auth-token') !== undefined) {
        return { html: '', finalUrl: url }
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers['location']
        if (typeof location !== 'string' || !location) {
          throw new OidcLoginError('redirect', `HTTP ${res.status} with no Location header at ${url}`)
        }
        url = location.startsWith('http') ? location : safeResolveUrl(location, url)
        // 307/308 → keep method+body; 301/302/303 → switch to GET (RFC 7231 §6.4)
        if (res.status !== 307 && res.status !== 308) {
          currentMethod = 'GET'
          currentBody = undefined
        }
        continue
      }

      if (res.status < 200 || res.status >= 300) {
        throw new OidcLoginError('redirect', `Unexpected HTTP ${res.status} at ${url}`)
      }

      return { html: await res.text(), finalUrl: url }
    }

    throw new OidcLoginError('redirect', `Exceeded maximum redirect depth (${MAX_REDIRECTS})`)
  }

  // ── 1. Initiate the OIDC flow ────────────────────────────────────────────
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const oidcStartUrl = `${normalizedBase}/api/auth/oauth/${encodeURIComponent(provider)}`
  let { html, finalUrl } = await follow(oidcStartUrl)

  // Edge case: auth-token already set (previous session cookie reused)
  const immediateToken = jar.get('auth-token')
  if (immediateToken !== undefined) return immediateToken

  // ── 2. Submit login form(s) ──────────────────────────────────────────────

  for (let step = 0; step < MAX_FORM_STEPS; step++) {
    const midToken = jar.get('auth-token')
    if (midToken !== undefined) return midToken

    // `html` is empty only when auth-token was detected mid-redirect-chain
    if (!html) break

    const forms = parseLoginForms(html, finalUrl)
    if (forms.length === 0) {
      if (step === 0) {
        // We never reached a login form — the IdP's authorization page contains
        // no HTML form at all, which typically means it's a JavaScript-driven
        // login UI (Google, Microsoft, Okta hosted login, etc.).
        throw new OidcLoginError(
          'form',
          `No login form found on IdP page at ${finalUrl}. ` +
            `The identity provider may require JavaScript for its login UI ` +
            `(e.g. Google, Microsoft, Okta). ` +
            `Use PENPOT_AUTH_TOKEN_COOKIE for JavaScript-driven login pages.`,
        )
      }
      // Credentials were submitted but the response has no form and no
      // auth-token — likely a credentials-rejected error page. Fall through
      // to the final cookie check, which will emit a clear error.
      break
    }

    const form = forms[0]!
    const fields = new Map(form.fields)

    // Fill whichever credential fields are present on this step
    if (form.usernameFieldName !== null) fields.set(form.usernameFieldName, username)
    if (form.passwordFieldName !== null) fields.set(form.passwordFieldName, password)

    const formBody = [...fields.entries()]
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')

    ;({ html, finalUrl } = await follow(form.action, 'POST', formBody))
  }

  // ── 3. Return auth-token ─────────────────────────────────────────────────
  const authToken = jar.get('auth-token')
  if (authToken === undefined) {
    throw new OidcLoginError(
      'cookie',
      `No auth-token cookie received after completing the OIDC flow. ` +
        `Final URL: ${finalUrl}. ` +
        `Verify that PENPOT_OIDC_USERNAME and PENPOT_OIDC_PASSWORD are correct ` +
        `and that the identity provider accepted the credentials.`,
    )
  }

  return authToken
}
