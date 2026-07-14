/**
 * test/integration/helpers/env-loader.ts
 *
 * Loads `.env` into process.env before any integration test file imports run,
 * so PENPOT_BASE_URL/PENPOT_ACCESS_TOKEN are populated by the time rpc-client.ts
 * (or anything reading process.env directly) is constructed. Already-exported
 * shell vars win over `.env` — CI can set secrets without a file on disk.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) {
  const text = readFileSync(envPath, 'utf-8')
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=')
    if (idx === -1 || line.trimStart().startsWith('#')) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}
