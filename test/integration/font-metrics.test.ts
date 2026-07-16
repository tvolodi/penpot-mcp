/**
 * test/integration/font-metrics.test.ts
 *
 * Two describe blocks:
 *  1. "live Google Fonts" — no Penpot credentials needed; makes real calls to
 *     fonts.googleapis.com. Skips when offline.
 *  2. "live Penpot custom fonts" — needs PENPOT_BASE_URL + PENPOT_ACCESS_TOKEN.
 *     Tests the Penpot fallback in `loadFont`. Skips when credentials absent.
 *     If the account has no custom fonts uploaded, the test verifies the combined
 *     error message; if it does, it loads and measures a real custom font.
 *
 * Both suites belong here (not in unit/) because they make real network calls,
 * which the unit suite's "no network" rule excludes.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { loadFont, measureText, FontFetchError } from '../../src/font-metrics.js'
import { hasPenpotCredentials, makeClient } from './helpers/scratch-project.js'

let googleReachable = false
beforeAll(async () => {
  try {
    const res = await fetch('https://fonts.googleapis.com/css2?family=Inter:wght@400')
    googleReachable = res.ok
  } catch {
    googleReachable = false
  }
}, 10_000)

describe('penpot_measure_text font fetching (live Google Fonts)', () => {
  it('fetches and measures a real Google Font, producing plausible non-zero metrics', async () => {
    if (!googleReachable) return
    const font = await loadFont('Inter', '400')
    const result = measureText(font, 'Hello, world!', 16)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
    expect(result.lines).toHaveLength(1)
  })

  it('caches a font across calls instead of re-fetching', async () => {
    if (!googleReachable) return
    const first = await loadFont('Roboto', '400')
    const second = await loadFont('Roboto', '400')
    expect(first).toBe(second)
  })

  it('throws a FontFetchError for a family that does not exist on Google Fonts', async () => {
    if (!googleReachable) return
    await expect(loadFont('Definitely Not A Real Font Family XYZ123', '400')).rejects.toThrow(FontFetchError)
  })
})

describe('penpot_measure_text Penpot custom-font fallback (live Penpot)', () => {
  it('loads a custom font from Penpot teams (or verifies combined error when none uploaded)', async () => {
    if (!hasPenpotCredentials()) return

    const client = makeClient()

    // Collect all font variants across all accessible teams.
    const teams = (await client.getTeams()) as Array<{ id: string }>
    let firstVariant: { fontFamily: string; fontWeight: number; fontStyle: string } | undefined
    for (const team of teams) {
      const variants = await client.getTeamFontVariants(team.id)
      firstVariant = variants[0]
      if (firstVariant) break
    }

    if (!firstVariant) {
      // No custom fonts on this account — verify the combined error message instead.
      const err = await loadFont('__integration_test_missing_font__', '400', client).catch((e) => e)
      expect(err).toBeInstanceOf(FontFetchError)
      expect((err as FontFetchError).message).toMatch(/not found on Google Fonts/)
      expect((err as FontFetchError).message).toMatch(/Penpot team/)
      return
    }

    // There IS a custom font — load it and verify the result is measurable.
    const font = await loadFont(firstVariant.fontFamily, String(firstVariant.fontWeight), client)
    expect(font.unitsPerEm).toBeGreaterThan(0)
    const result = measureText(font, 'Aa', 16)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })
})
