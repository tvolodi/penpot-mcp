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
  // Three mutually exclusive ways to supply the cookie, checked in this order:
  //   1. PENPOT_LOGIN_EMAIL + PENPOT_LOGIN_PASSWORD — logs in with email/password
  //      and caches the resulting auth-token cookie, refreshing it automatically
  //      on expiry. Works for instances that expose password login.
  //   2. PENPOT_OIDC_USERNAME + PENPOT_OIDC_PASSWORD — headless OIDC/SSO login:
  //      the server follows the OIDC redirect chain, submits the IdP HTML login
  //      form, and captures the resulting auth-token cookie automatically. Works
  //      for standard form-based IdPs (Keycloak, Authentik, Dex, …). Refreshes
  //      automatically on expiry. Set PENPOT_OIDC_PROVIDER if your Penpot instance
  //      uses a provider name other than "oidc" (the default).
  //   3. PENPOT_AUTH_TOKEN_COOKIE — a raw auth-token cookie value obtained by
  //      completing SSO/OIDC login in a real browser. Useful for instances with
  //      JavaScript-driven login pages (Google, Microsoft, Okta). No automatic
  //      refresh: a clear error is emitted if the cookie expires.
  //      To get the value: open your Penpot instance in a browser, complete the
  //      SSO login, then copy the `auth-token` cookie from DevTools → Application
  //      → Cookies (not the full Cookie header — just the value after `auth-token=`).
  PENPOT_LOGIN_EMAIL: z.string().optional(),
  PENPOT_LOGIN_PASSWORD: z.string().optional(),
  PENPOT_OIDC_USERNAME: z.string().optional(),
  PENPOT_OIDC_PASSWORD: z.string().optional(),
  PENPOT_OIDC_PROVIDER: z.string().default('oidc'),
  PENPOT_AUTH_TOKEN_COOKIE: z.string().optional(),
  /**
   * Optional directory for persisting checkpoints to disk.
   * When set, penpot_checkpoint writes a JSON file to this directory so the
   * checkpoint survives an MCP server restart.  When unset, checkpoints live
   * only in process memory and are lost on restart (the previous behaviour).
   * The directory is created automatically if it does not already exist.
   */
  PENPOT_CHECKPOINTS_PATH: z.string().optional(),
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
