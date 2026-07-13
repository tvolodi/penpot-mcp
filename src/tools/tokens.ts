/**
 * tools/tokens.ts
 *
 * Loads and validates a project's design-token file, and resolves
 * `{ token: "name" }` references against it. This is the one seam that
 * keeps the MCP server itself free of any project-specific color/font
 * values — every consuming project supplies its own token file at
 * PENPOT_TOKENS_PATH.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

const tokenFileSchema = z.object({
  colors: z.record(z.string(), z.string()),
  fonts: z
    .record(z.string(), z.object({ family: z.string(), weights: z.array(z.string()).optional() }))
    .optional(),
})

export type TokenFile = z.infer<typeof tokenFileSchema>

export async function loadTokenFile(path: string): Promise<TokenFile> {
  const absolutePath = resolve(path)
  let raw: string
  try {
    raw = await readFile(absolutePath, 'utf-8')
  } catch {
    throw new Error(`Could not read token file at ${absolutePath}`)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`Token file at ${absolutePath} is not valid JSON`)
  }

  const parsed = tokenFileSchema.safeParse(json)
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Token file at ${absolutePath} is invalid: ${message}`)
  }

  return parsed.data
}

/** A color value that is either a literal hex string or a `{ token: "name" }` reference. */
export const colorValueSchema = z.union([
  z.string(),
  z.object({ token: z.string() }),
])
export type ColorValue = z.infer<typeof colorValueSchema>

export function resolveColor(value: ColorValue, tokens: TokenFile): string {
  if (typeof value === 'string') return value
  const resolved = tokens.colors[value.token]
  if (!resolved) {
    const known = Object.keys(tokens.colors).join(', ')
    throw new Error(`Unknown color token "${value.token}". Known tokens: ${known}`)
  }
  return resolved
}
