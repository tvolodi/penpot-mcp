/**
 * tools/tokens.ts
 *
 * Loads and validates a project's design-token file, and resolves
 * `{ token: "name" }` references against it. This is the one seam that
 * keeps the MCP server itself free of any project-specific color/font/
 * spacing/radius/shadow values — every consuming project supplies its own
 * token file at PENPOT_TOKENS_PATH.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

/** A color value that is either a literal hex string or a `{ token: "name" }` reference. */
export const colorValueSchema = z.union([
  z.string(),
  z.object({ token: z.string() }),
])
export type ColorValue = z.infer<typeof colorValueSchema>

const shadowTokenSchema = z.object({
  style: z.enum(['drop-shadow', 'inner-shadow']).default('drop-shadow'),
  color: colorValueSchema,
  opacity: z.number().min(0).max(1).default(1),
  offsetX: z.number().default(0),
  offsetY: z.number().default(0),
  blur: z.number().min(0).default(0),
  spread: z.number().default(0),
})

export type ShadowToken = z.infer<typeof shadowTokenSchema>

const tokenFileSchema = z.object({
  colors: z.record(z.string(), z.string()),
  fonts: z
    .record(z.string(), z.object({ family: z.string(), weights: z.array(z.string()).optional() }))
    .optional(),
  /** Spacing scale (gaps, padding, margins) — plain numbers, referenced via `{ token: "name" }`. */
  spacing: z.record(z.string(), z.number()).optional(),
  /** Corner-radius scale — plain numbers, referenced via `{ token: "name" }` on r1-r4 fields. */
  radii: z.record(z.string(), z.number()).optional(),
  /** Named drop/inner-shadow presets, referenced via `{ token: "name" }` on a shape's `shadows` field. */
  shadows: z.record(z.string(), shadowTokenSchema).optional(),
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

export function resolveColor(value: ColorValue, tokens: TokenFile): string {
  if (typeof value === 'string') return value
  const resolved = tokens.colors[value.token]
  if (!resolved) {
    const known = Object.keys(tokens.colors).join(', ')
    throw new Error(`Unknown color token "${value.token}". Known tokens: ${known}`)
  }
  return resolved
}

/** A numeric value (spacing gap/padding/margin, or a corner radius) that is either a literal
 * number or a `{ token: "name" }` reference. */
export const numberValueSchema = z.union([z.number(), z.object({ token: z.string() })])
export type NumberValue = z.infer<typeof numberValueSchema>

function resolveNumber(
  value: NumberValue | undefined,
  table: Record<string, number> | undefined,
  tableName: string,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return value
  const resolved = table?.[value.token]
  if (resolved === undefined) {
    const known = Object.keys(table ?? {}).join(', ')
    throw new Error(`Unknown ${tableName} token "${value.token}". Known tokens: ${known}`)
  }
  return resolved
}

/** Resolves a `{ token: "name" }` reference against the token file's `spacing` table (gaps, padding, margins). */
export function resolveSpacing(value: NumberValue | undefined, tokens: TokenFile): number | undefined {
  return resolveNumber(value, tokens.spacing, 'spacing')
}

/** Resolves a `{ token: "name" }` reference against the token file's `radii` table (corner radii). */
export function resolveRadius(value: NumberValue | undefined, tokens: TokenFile): number | undefined {
  return resolveNumber(value, tokens.radii, 'radii')
}

/** A shadow value that is either an inline object or a `{ token: "name" }` reference into the
 * token file's `shadows` table. */
export const shadowValueSchema = z.union([shadowTokenSchema, z.object({ token: z.string() })])
export type ShadowValue = z.infer<typeof shadowValueSchema>

export function resolveShadow(value: ShadowValue, tokens: TokenFile): ShadowToken {
  if ('token' in value) {
    const resolved = tokens.shadows?.[value.token]
    if (!resolved) {
      const known = Object.keys(tokens.shadows ?? {}).join(', ')
      throw new Error(`Unknown shadow token "${value.token}". Known tokens: ${known}`)
    }
    return resolved
  }
  return value
}
