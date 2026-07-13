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
  PENPOT_LOGIN_EMAIL: z.string().optional(),
  PENPOT_LOGIN_PASSWORD: z.string().optional(),
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
