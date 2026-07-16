import { describe, it, expect, vi } from 'vitest'
import {
  CookieJar,
  OidcLoginError,
  decodeHtmlEntities,
  loginHeadlessOidc,
  parseLoginForms,
  type RawHttpFetcher,
  type RawHttpResponse,
} from '../../src/oidc-auth.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RawHttpResponse for testing. */
function mockResponse(
  status: number,
  headers: Record<string, string | string[]>,
  body: string,
  url: string,
): RawHttpResponse {
  return {
    status,
    headers: headers as any,
    url,
    text: vi.fn().mockResolvedValue(body),
  }
}

/** A redirect response (no body needed). */
function redirect(status: 301 | 302 | 307 | 308, location: string, url: string): RawHttpResponse {
  return mockResponse(status, { location }, '', url)
}

/** A redirect with a Set-Cookie header. */
function redirectWithCookie(
  status: 301 | 302,
  location: string,
  cookies: string[],
  url: string,
): RawHttpResponse {
  return mockResponse(status, { location, 'set-cookie': cookies }, '', url)
}

// ---------------------------------------------------------------------------
// CookieJar
// ---------------------------------------------------------------------------

describe('CookieJar', () => {
  describe('addFromHeader', () => {
    it('stores a simple name=value cookie', () => {
      const jar = new CookieJar()
      jar.addFromHeader('session=abc123')
      expect(jar.get('session')).toBe('abc123')
    })

    it('strips Set-Cookie attributes (Path, HttpOnly, SameSite, …)', () => {
      const jar = new CookieJar()
      jar.addFromHeader('auth-token=xyz; Path=/; HttpOnly; SameSite=Lax')
      expect(jar.get('auth-token')).toBe('xyz')
    })

    it('preserves = signs inside the cookie value', () => {
      const jar = new CookieJar()
      // Base64-encoded values often contain trailing '='
      jar.addFromHeader('token=base64==; Path=/')
      expect(jar.get('token')).toBe('base64==')
    })

    it('overwrites a cookie with the same name', () => {
      const jar = new CookieJar()
      jar.addFromHeader('auth-token=first')
      jar.addFromHeader('auth-token=second')
      expect(jar.get('auth-token')).toBe('second')
    })

    it('ignores a header with no = sign', () => {
      const jar = new CookieJar()
      jar.addFromHeader('malformed')
      expect(jar.get('malformed')).toBeUndefined()
    })

    it('ignores an empty string', () => {
      const jar = new CookieJar()
      jar.addFromHeader('')
      expect(jar.toHeader()).toBe('')
    })
  })

  describe('toHeader', () => {
    it('returns empty string for an empty jar', () => {
      expect(new CookieJar().toHeader()).toBe('')
    })

    it('emits name=value pairs joined by "; "', () => {
      const jar = new CookieJar()
      jar.addFromHeader('a=1; Path=/')
      jar.addFromHeader('b=2; Path=/')
      // Map insertion order is preserved
      expect(jar.toHeader()).toBe('a=1; b=2')
    })
  })
})

// ---------------------------------------------------------------------------
// decodeHtmlEntities
// ---------------------------------------------------------------------------

describe('decodeHtmlEntities', () => {
  it('decodes &amp; to &', () => {
    expect(decodeHtmlEntities('a=1&amp;b=2')).toBe('a=1&b=2')
  })

  it('decodes &lt; and &gt;', () => {
    expect(decodeHtmlEntities('a &lt; b &gt; c')).toBe('a < b > c')
  })

  it('decodes &quot; and &#39;', () => {
    expect(decodeHtmlEntities('say &quot;hi&quot; and &#39;bye&#39;')).toBe("say \"hi\" and 'bye'")
  })

  it('leaves unrecognised entities unchanged', () => {
    expect(decodeHtmlEntities('&nbsp; &copy;')).toBe('&nbsp; &copy;')
  })

  it('handles a string with no entities', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text')
  })
})

// ---------------------------------------------------------------------------
// parseLoginForms
// ---------------------------------------------------------------------------

describe('parseLoginForms', () => {
  const PAGE_URL = 'https://auth.example.com/realms/myrealm/protocol/openid-connect/auth'

  it('detects a Keycloak-style single form with username and password', () => {
    const html = `
      <form id="kc-form-login"
            action="https://auth.example.com/realms/myrealm/login-actions/authenticate?session_code=abc&amp;tab_id=xyz"
            method="post">
        <input type="text" id="username" name="username" value="" />
        <input type="password" id="password" name="password" />
        <input type="hidden" name="credentialId" value="" />
        <input type="submit" name="login" value="Sign In" />
      </form>
    `
    const forms = parseLoginForms(html, PAGE_URL)
    expect(forms).toHaveLength(1)
    const form = forms[0]!
    expect(form.usernameFieldName).toBe('username')
    expect(form.passwordFieldName).toBe('password')
    expect(form.method).toBe('post')
    // &amp; in the action URL must be decoded
    expect(form.action).toBe(
      'https://auth.example.com/realms/myrealm/login-actions/authenticate?session_code=abc&tab_id=xyz',
    )
    // Hidden fields are collected; submit is excluded
    expect(form.fields.has('credentialId')).toBe(true)
    expect(form.fields.has('login')).toBe(false)
    // Credential fields are present but empty
    expect(form.fields.get('username')).toBe('')
    expect(form.fields.get('password')).toBe('')
  })

  it('detects an Authentik-style username-only form (step 1 of multi-step)', () => {
    const html = `
      <form class="pf-c-form" method="POST" action="/authentik/login">
        <input class="pf-c-form-control" name="ue" type="text" autocomplete="email username" />
        <button type="submit">Continue</button>
      </form>
    `
    const forms = parseLoginForms(html, PAGE_URL)
    expect(forms).toHaveLength(1)
    const form = forms[0]!
    expect(form.usernameFieldName).toBe('ue')
    expect(form.passwordFieldName).toBeNull()
  })

  it('detects a password-only form (step 2 of multi-step flow)', () => {
    const html = `
      <form method="POST" action="/authentik/password">
        <input type="password" name="password" />
        <button type="submit">Login</button>
      </form>
    `
    const forms = parseLoginForms(html, PAGE_URL)
    expect(forms).toHaveLength(1)
    const form = forms[0]!
    expect(form.usernameFieldName).toBeNull()
    expect(form.passwordFieldName).toBe('password')
  })

  it('ignores forms with no recognisable login fields (e.g. a search form)', () => {
    const html = `
      <form method="GET" action="/search">
        <input type="text" name="q" />
        <input type="submit" value="Search" />
      </form>
    `
    expect(parseLoginForms(html, PAGE_URL)).toHaveLength(0)
  })

  it('returns empty array when there are no forms at all', () => {
    expect(parseLoginForms('<html><body><p>No form here</p></body></html>', PAGE_URL)).toHaveLength(0)
  })

  it('resolves relative action URLs against pageUrl', () => {
    const html = `
      <form method="post" action="/login-actions/authenticate">
        <input type="password" name="password" />
      </form>
    `
    const forms = parseLoginForms(html, 'https://auth.example.com/realms/myrealm/')
    expect(forms[0]!.action).toBe('https://auth.example.com/login-actions/authenticate')
  })

  it('uses pageUrl as action fallback when action attribute is absent', () => {
    const html = `
      <form method="post">
        <input type="email" name="email" />
        <input type="password" name="password" />
      </form>
    `
    const forms = parseLoginForms(html, PAGE_URL)
    expect(forms[0]!.action).toBe(PAGE_URL)
  })

  it('detects username field via type="email"', () => {
    const html = `
      <form method="post" action="/login">
        <input type="email" name="mail" />
        <input type="password" name="pw" />
      </form>
    `
    const forms = parseLoginForms(html, PAGE_URL)
    expect(forms[0]!.usernameFieldName).toBe('mail')
    expect(forms[0]!.passwordFieldName).toBe('pw')
  })

  it('only returns the first matching form (login page top-to-bottom)', () => {
    const html = `
      <form method="post" action="/login">
        <input type="text" name="username" />
        <input type="password" name="password" />
      </form>
      <form method="post" action="/forgot">
        <input type="email" name="email" />
        <input type="submit" value="Reset" />
      </form>
    `
    const forms = parseLoginForms(html, PAGE_URL)
    expect(forms).toHaveLength(2)
    expect(forms[0]!.action).toContain('/login')
  })
})

// ---------------------------------------------------------------------------
// loginHeadlessOidc — with mock HTTP fetcher
// ---------------------------------------------------------------------------

describe('loginHeadlessOidc', () => {
  const BASE = 'https://penpot.example.com'
  const PROVIDER = 'oidc'
  const USERNAME = 'user@example.com'
  const PASSWORD = 'secret'
  const IDP_AUTH_URL = 'https://auth.example.com/realms/myrealm/protocol/openid-connect/auth?state=abc&code_challenge=xyz'
  const IDP_POST_URL = 'https://auth.example.com/realms/myrealm/login-actions/authenticate?session_code=sc&tab_id=t'
  const PENPOT_CALLBACK_URL = `${BASE}/api/auth/oauth/oidc/callback?code=CODE&state=abc`
  const PENPOT_HOME = `${BASE}/`
  const AUTH_TOKEN = 'the-auth-token-value'

  const KEYCLOAK_LOGIN_HTML = `
    <html><body>
      <form id="kc-form-login" action="${IDP_POST_URL}" method="post">
        <input type="text" id="username" name="username" value="" />
        <input type="password" id="password" name="password" />
        <input type="hidden" name="credentialId" value="" />
        <input type="submit" name="login" value="Sign In" />
      </form>
    </body></html>
  `

  /**
   * Happy path: Penpot → IdP redirect → login page → submit creds →
   * Penpot callback (sets auth-token cookie) → home page.
   */
  it('returns auth-token cookie on successful Keycloak-style login', async () => {
    const fetcher = vi.fn<RawHttpFetcher>()
    fetcher
      // 1. GET /api/auth/oauth/oidc → 302 to IdP
      .mockResolvedValueOnce(redirect(302, IDP_AUTH_URL, `${BASE}/api/auth/oauth/oidc`))
      // 2. GET IdP auth URL → 200 with login form
      .mockResolvedValueOnce(mockResponse(200, {}, KEYCLOAK_LOGIN_HTML, IDP_AUTH_URL))
      // 3. POST form → 302 to Penpot callback
      .mockResolvedValueOnce(redirect(302, PENPOT_CALLBACK_URL, IDP_POST_URL))
      // 4. GET Penpot callback → 302 to home, sets auth-token cookie
      .mockResolvedValueOnce(
        redirectWithCookie(302, PENPOT_HOME, [`auth-token=${AUTH_TOKEN}; Path=/; HttpOnly`], PENPOT_CALLBACK_URL),
      )
      // 5. GET home → 200 (should not be reached — cookie detected on step 4)
      .mockResolvedValueOnce(mockResponse(200, {}, '<html>Home</html>', PENPOT_HOME))

    const token = await loginHeadlessOidc(BASE, PROVIDER, USERNAME, PASSWORD, fetcher)
    expect(token).toBe(AUTH_TOKEN)

    // Verify credentials were POSTed in step 3
    const postCall = fetcher.mock.calls[2]!
    expect(postCall[0]).toBe(IDP_POST_URL)
    expect(postCall[1].method).toBe('POST')
    expect(postCall[1].body).toContain(`username=${encodeURIComponent(USERNAME)}`)
    expect(postCall[1].body).toContain(`password=${encodeURIComponent(PASSWORD)}`)
  })

  it('returns auth-token immediately if it is set during the initial redirect chain', async () => {
    const fetcher = vi.fn<RawHttpFetcher>()
    // Already-authenticated session: Penpot OIDC start → callback → home with cookie
    fetcher
      .mockResolvedValueOnce(redirect(302, PENPOT_CALLBACK_URL, `${BASE}/api/auth/oauth/oidc`))
      .mockResolvedValueOnce(
        redirectWithCookie(302, PENPOT_HOME, [`auth-token=${AUTH_TOKEN}; Path=/`], PENPOT_CALLBACK_URL),
      )

    const token = await loginHeadlessOidc(BASE, PROVIDER, USERNAME, PASSWORD, fetcher)
    expect(token).toBe(AUTH_TOKEN)
    // Should not have made a third request
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('handles a multi-step flow (username on page 1, password on page 2)', async () => {
    const STEP1_HTML = `
      <form method="POST" action="https://auth.example.com/step1">
        <input type="text" name="ue" autocomplete="email username" />
        <button type="submit">Continue</button>
      </form>
    `
    const STEP2_HTML = `
      <form method="POST" action="https://auth.example.com/step2">
        <input type="password" name="password" />
        <input type="hidden" name="flow_id" value="flow123" />
        <button type="submit">Login</button>
      </form>
    `
    const fetcher = vi.fn<RawHttpFetcher>()
    fetcher
      // 1. Initiate OIDC → redirect to IdP
      .mockResolvedValueOnce(redirect(302, 'https://auth.example.com/step1', `${BASE}/api/auth/oauth/oidc`))
      // 2. GET step1 → username form
      .mockResolvedValueOnce(mockResponse(200, {}, STEP1_HTML, 'https://auth.example.com/step1'))
      // 3. POST username → step2 page
      .mockResolvedValueOnce(
        mockResponse(200, {}, STEP2_HTML, 'https://auth.example.com/step2'),
      )
      // 4. POST password → Penpot callback redirect
      .mockResolvedValueOnce(redirect(302, PENPOT_CALLBACK_URL, 'https://auth.example.com/step2'))
      // 5. Penpot callback → sets auth-token
      .mockResolvedValueOnce(
        redirectWithCookie(302, PENPOT_HOME, [`auth-token=${AUTH_TOKEN}; Path=/`], PENPOT_CALLBACK_URL),
      )

    const token = await loginHeadlessOidc(BASE, PROVIDER, USERNAME, PASSWORD, fetcher)
    expect(token).toBe(AUTH_TOKEN)

    // Step 3: username-only POST
    const step1Post = fetcher.mock.calls[2]!
    expect(step1Post[1].body).toContain(`ue=${encodeURIComponent(USERNAME)}`)
    expect(step1Post[1].body).not.toContain('password=')

    // Step 4: password-only POST (flow_id hidden field preserved)
    const step2Post = fetcher.mock.calls[3]!
    expect(step2Post[1].body).toContain(`password=${encodeURIComponent(PASSWORD)}`)
    expect(step2Post[1].body).toContain('flow_id=flow123')
  })

  it('preserves hidden CSRF/session fields when submitting the login form', async () => {
    const HTML_WITH_CSRF = `
      <form method="post" action="${IDP_POST_URL}">
        <input type="hidden" name="csrf_token" value="tok123" />
        <input type="hidden" name="state" value="state456" />
        <input type="text" name="username" />
        <input type="password" name="password" />
      </form>
    `
    const fetcher = vi.fn<RawHttpFetcher>()
    fetcher
      .mockResolvedValueOnce(redirect(302, IDP_AUTH_URL, `${BASE}/api/auth/oauth/oidc`))
      .mockResolvedValueOnce(mockResponse(200, {}, HTML_WITH_CSRF, IDP_AUTH_URL))
      .mockResolvedValueOnce(redirect(302, PENPOT_CALLBACK_URL, IDP_POST_URL))
      .mockResolvedValueOnce(
        redirectWithCookie(302, PENPOT_HOME, [`auth-token=${AUTH_TOKEN}`], PENPOT_CALLBACK_URL),
      )

    await loginHeadlessOidc(BASE, PROVIDER, USERNAME, PASSWORD, fetcher)

    const postCall = fetcher.mock.calls[2]!
    const body = postCall[1].body ?? ''
    expect(body).toContain('csrf_token=tok123')
    expect(body).toContain('state=state456')
  })

  it('throws OidcLoginError("form") when no login form is found on the IdP page', async () => {
    const fetcher = vi.fn<RawHttpFetcher>()
    fetcher
      .mockResolvedValueOnce(redirect(302, IDP_AUTH_URL, `${BASE}/api/auth/oauth/oidc`))
      // IdP returns a JavaScript-driven SPA shell with no HTML form
      .mockResolvedValueOnce(
        mockResponse(200, {}, '<html><body><div id="root"></div></body></html>', IDP_AUTH_URL),
      )

    await expect(loginHeadlessOidc(BASE, PROVIDER, USERNAME, PASSWORD, fetcher)).rejects.toMatchObject({
      step: 'form',
    })
  })

  it('throws OidcLoginError("cookie") when no auth-token cookie appears after login', async () => {
    const fetcher = vi.fn<RawHttpFetcher>()
    fetcher
      .mockResolvedValueOnce(redirect(302, IDP_AUTH_URL, `${BASE}/api/auth/oauth/oidc`))
      .mockResolvedValueOnce(mockResponse(200, {}, KEYCLOAK_LOGIN_HTML, IDP_AUTH_URL))
      // Server responds 200 with an "invalid credentials" page (no form, no cookie set)
      .mockResolvedValueOnce(
        mockResponse(200, {}, '<html><body><p>Invalid username or password.</p></body></html>', IDP_POST_URL),
      )

    await expect(loginHeadlessOidc(BASE, PROVIDER, USERNAME, PASSWORD, fetcher)).rejects.toMatchObject({
      step: 'cookie',
    })
  })

  it('throws OidcLoginError("redirect") on non-2xx non-redirect response', async () => {
    const fetcher = vi.fn<RawHttpFetcher>()
    fetcher.mockResolvedValueOnce(mockResponse(500, {}, 'Internal Server Error', `${BASE}/api/auth/oauth/oidc`))

    await expect(loginHeadlessOidc(BASE, PROVIDER, USERNAME, PASSWORD, fetcher)).rejects.toMatchObject({
      step: 'redirect',
    })
  })

  it('sends Cookie header on every request once cookies are accumulated', async () => {
    const fetcher = vi.fn<RawHttpFetcher>()
    // Penpot sets a state/CSRF cookie on the initial redirect
    fetcher
      .mockResolvedValueOnce(
        redirectWithCookie(
          302,
          IDP_AUTH_URL,
          ['penpot-csrf=csrf-value; Path=/'],
          `${BASE}/api/auth/oauth/oidc`,
        ),
      )
      .mockResolvedValueOnce(mockResponse(200, {}, KEYCLOAK_LOGIN_HTML, IDP_AUTH_URL))
      .mockResolvedValueOnce(redirect(302, PENPOT_CALLBACK_URL, IDP_POST_URL))
      .mockResolvedValueOnce(
        redirectWithCookie(302, PENPOT_HOME, [`auth-token=${AUTH_TOKEN}`], PENPOT_CALLBACK_URL),
      )

    await loginHeadlessOidc(BASE, PROVIDER, USERNAME, PASSWORD, fetcher)

    // The CSRF cookie set in step 1 should be forwarded in step 2
    const step2Headers = fetcher.mock.calls[1]![1].headers ?? {}
    expect(step2Headers['Cookie']).toContain('penpot-csrf=csrf-value')
  })

  it('follows 307 redirects preserving POST method and body', async () => {
    const fetcher = vi.fn<RawHttpFetcher>()
    fetcher
      .mockResolvedValueOnce(redirect(302, IDP_AUTH_URL, `${BASE}/api/auth/oauth/oidc`))
      .mockResolvedValueOnce(mockResponse(200, {}, KEYCLOAK_LOGIN_HTML, IDP_AUTH_URL))
      // Simulate a 307 Temporary Redirect after form submission
      .mockResolvedValueOnce({
        status: 307,
        headers: { location: IDP_POST_URL + '&retry=1' } as any,
        url: IDP_POST_URL,
        text: vi.fn().mockResolvedValue(''),
      })
      // The 307 redirect target receives the POST too
      .mockResolvedValueOnce(redirect(302, PENPOT_CALLBACK_URL, IDP_POST_URL + '&retry=1'))
      .mockResolvedValueOnce(
        redirectWithCookie(302, PENPOT_HOME, [`auth-token=${AUTH_TOKEN}`], PENPOT_CALLBACK_URL),
      )

    const token = await loginHeadlessOidc(BASE, PROVIDER, USERNAME, PASSWORD, fetcher)
    expect(token).toBe(AUTH_TOKEN)

    // The request after the 307 should also be POST (method preserved)
    const retryCall = fetcher.mock.calls[3]!
    expect(retryCall[1].method).toBe('POST')
  })
})
