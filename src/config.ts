/**
 * config.ts
 *
 * Environment configuration for the penpot-headless MCP server.
 * No project-specific defaults here — every consuming project sets its
 * own PENPOT_BASE_URL, PENPOT_ACCESS_TOKEN, and PENPOT_TOKENS_PATH.
 */

import { z } from 'zod'

const envSchema = z.object({
  PENPOT_BASE_URL: z.string().url('PENPOT_BASE_URL must be a valid URL, e.g. https://design.penpot.app'),
  PENPOT_ACCESS_TOKEN: z.string().min(1, 'PENPOT_ACCESS_TOKEN is not set'),
  PENPOT_TOKENS_PATH: z.string().default('./design-tokens/tokens.json'),
  // Optional: only required for penpot_export_shape. Penpot's render pipeline
  // authenticates via session cookie, not the access token above — see
  // exporter-client.ts for why. When unset, the export tool is not registered.
  //
  // Two mutually exclusive ways to supply the cookie:
  //   1. PENPOT_LOGIN_EMAIL + PENPOT_LOGIN_PASSWORD — the server logs in with
  //      email/password and caches the resulting auth-token cookie, refreshing
  //      it automatically on expiry. Works for instances with password auth.
  //   2. PENPOT_AUTH_TOKEN_COOKIE — a raw auth-token cookie value obtained by
  //      completing SSO/OIDC login in a real browser. Useful for instances
  //      that don't expose password login. The server uses it as-is and emits
  //      a clear error if it expires (no automatic refresh is possible).
  //      To get the value: open your Penpot instance in a browser, complete the
  //      SSO login, then copy the `auth-token` cookie from DevTools → Application
  //      → Cookies (or `document.cookie`).
  //
  // If both are set, PENPOT_LOGIN_EMAIL/PENPOT_LOGIN_PASSWORD takes precedence.
  PENPOT_LOGIN_EMAIL: z.string().optional(),
  PENPOT_LOGIN_PASSWORD: z.string().optional(),
  PENPOT_AUTH_TOKEN_COOKIE: z.string().optional(),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join('; ')
    throw new Error(`Invalid penpot-headless configuration: ${message}`)
  }
  return parsed.data
}
