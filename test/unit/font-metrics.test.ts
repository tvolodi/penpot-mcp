import { describe, it, expect, vi, afterEach } from 'vitest'
import { measureText, loadFont, FontFetchError, type MeasurableFont, type PenpotFontClient } from '../../src/font-metrics.js'

/**
 * A fake `MeasurableFont`: every glyph is 10 units wide in a 100-units-per-em
 * face (so a `fontSize: 100` call reads as "10px per character" for easy
 * arithmetic), with one hand-picked kerning pair ("A" followed by "V" pulls
 * 2 units closer) to exercise the kerning path without needing a real parsed
 * font file (which would require network access to fetch).
 */
function fakeFont(): MeasurableFont {
  return {
    unitsPerEm: 100,
    ascender: 80,
    descender: -20,
    charToGlyph: (c: string) => ({ advanceWidth: 10, unicode: c.codePointAt(0) }) as never,
    getKerningValue: (left, right) => {
      const l = (left as unknown as { unicode: number }).unicode
      const r = (right as unknown as { unicode: number }).unicode
      return l === 'A'.codePointAt(0) && r === 'V'.codePointAt(0) ? -2 : 0
    },
  }
}

describe('measureText', () => {
  it('measures a single line with no wrapping: width is per-glyph advance summed, height is one line', () => {
    const font = fakeFont()
    const result = measureText(font, 'Hello', 100)
    expect(result.width).toBe(50) // 5 chars * 10 units/char at fontSize 100 (1:1 scale)
    expect(result.lineHeight).toBe(100) // (ascender 80 - descender -20) * scale 1
    expect(result.height).toBe(100)
    expect(result.lines).toEqual([{ text: 'Hello', width: 50 }])
  })

  it('applies kerning between consecutive glyphs', () => {
    const font = fakeFont()
    const result = measureText(font, 'AV', 100)
    // 2 glyphs * 10 + kerning (-2) = 18
    expect(result.width).toBe(18)
  })

  it('scales width/height proportionally to fontSize', () => {
    const font = fakeFont()
    const result = measureText(font, 'Hi', 50)
    expect(result.width).toBe(10) // 2 chars * 10 units * (50/100) scale
    expect(result.lineHeight).toBe(50)
  })

  it('splits on explicit newlines without wrapping when maxWidth is omitted', () => {
    const font = fakeFont()
    const result = measureText(font, 'Hi\nWorld!', 100)
    expect(result.lines).toEqual([
      { text: 'Hi', width: 20 },
      { text: 'World!', width: 60 },
    ])
    expect(result.width).toBe(60) // widest line
    expect(result.height).toBe(200) // 2 lines * lineHeight 100
  })

  it('preserves an empty line from consecutive newlines', () => {
    const font = fakeFont()
    const result = measureText(font, 'A\n\nB', 100)
    expect(result.lines).toEqual([
      { text: 'A', width: 10 },
      { text: '', width: 0 },
      { text: 'B', width: 10 },
    ])
  })

  it('word-wraps greedily to fit maxWidth, without breaking mid-word', () => {
    const font = fakeFont()
    // "one" = 30, "two" = 30, "one two" = 70 (30 + 10-space + 30)
    const result = measureText(font, 'one two three', 100, 65)
    expect(result.lines.map((l) => l.text)).toEqual(['one', 'two', 'three'])
    for (const line of result.lines) {
      expect(line.width).toBeLessThanOrEqual(65)
    }
  })

  it('keeps a single word that alone exceeds maxWidth on its own line instead of breaking it', () => {
    const font = fakeFont()
    const result = measureText(font, 'supercalifragilistic word', 100, 50)
    expect(result.lines[0]!.text).toBe('supercalifragilistic')
    expect(result.lines[0]!.width).toBeGreaterThan(50)
  })

  it('re-wraps each explicit line independently when maxWidth is given', () => {
    const font = fakeFont()
    const result = measureText(font, 'aa bb cc\ndd ee ff', 100, 65)
    // Each "\n"-separated segment gets its own greedy wrap pass.
    expect(result.lines.map((l) => l.text)).toEqual(['aa bb', 'cc', 'dd ee', 'ff'])
  })
})

// Unique family names so the module-level cache (keyed by family::weight) never
// short-circuits these tests regardless of run order.
const FAKE_GOOGLE_CSS = '/* no url() here — simulates a font not on Google Fonts */'

/** Returns a minimal fetch mock that serves `FAKE_GOOGLE_CSS` for the Google Fonts CSS URL. */
function mockGoogleFontsNotFound() {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => FAKE_GOOGLE_CSS,
    headers: { get: () => 'text/css' },
  })
}

describe('loadFont — Penpot team-font fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws FontFetchError without calling penpotClient when no client is provided', async () => {
    vi.stubGlobal('fetch', mockGoogleFontsNotFound())
    await expect(loadFont('__unit_test_no_client__', '400')).rejects.toThrow(FontFetchError)
  })

  it('calls getTeams + getTeamFontVariants when Google Fonts finds no match', async () => {
    vi.stubGlobal('fetch', mockGoogleFontsNotFound())

    const client: PenpotFontClient = {
      getTeams: vi.fn().mockResolvedValue([{ id: 'team-abc' }]),
      getTeamFontVariants: vi.fn().mockResolvedValue([]),
      downloadFontVariantBytes: vi.fn(),
    }

    await expect(loadFont('__unit_test_team_dispatch__', '700', client)).rejects.toThrow(FontFetchError)
    expect(client.getTeams).toHaveBeenCalledOnce()
    expect(client.getTeamFontVariants).toHaveBeenCalledWith('team-abc')
    expect(client.downloadFontVariantBytes).not.toHaveBeenCalled()
  })

  it('throws a combined error message when font is absent from both Google Fonts and Penpot', async () => {
    vi.stubGlobal('fetch', mockGoogleFontsNotFound())

    const client: PenpotFontClient = {
      getTeams: vi.fn().mockResolvedValue([{ id: 'team-1' }]),
      getTeamFontVariants: vi.fn().mockResolvedValue([
        { id: 'v1', fontFamily: 'Other Font', fontWeight: 400, fontStyle: 'normal' },
      ]),
      downloadFontVariantBytes: vi.fn(),
    }

    const err = await loadFont('__unit_test_combined_error__', '400', client).catch((e) => e)
    expect(err).toBeInstanceOf(FontFetchError)
    expect((err as FontFetchError).message).toMatch(/not found on Google Fonts/)
    expect((err as FontFetchError).message).toMatch(/Penpot team/)
  })

  it('searches multiple teams and returns the first matching variant', async () => {
    vi.stubGlobal('fetch', mockGoogleFontsNotFound())

    // The matching variant is in team-2, not team-1. downloadFontVariantBytes
    // would be called with the matched variant's id — but since we can't easily
    // provide parseable bytes in a unit test, we just assert it IS called and
    // let it throw; we only care that the right id was dispatched.
    const client: PenpotFontClient = {
      getTeams: vi.fn().mockResolvedValue([{ id: 'team-1' }, { id: 'team-2' }]),
      getTeamFontVariants: vi.fn().mockImplementation(async (teamId: string) => {
        if (teamId === 'team-1') return []
        return [{ id: 'variant-xyz', fontFamily: 'My Brand Font', fontWeight: 400, fontStyle: 'normal' }]
      }),
      downloadFontVariantBytes: vi.fn().mockRejectedValue(new Error('stop here')),
    }

    await expect(loadFont('My Brand Font', '400', client)).rejects.toThrow('stop here')
    expect(client.downloadFontVariantBytes).toHaveBeenCalledWith('variant-xyz')
  })

  it('prefers the "normal" style variant when multiple styles share the same family+weight', async () => {
    vi.stubGlobal('fetch', mockGoogleFontsNotFound())

    const client: PenpotFontClient = {
      getTeams: vi.fn().mockResolvedValue([{ id: 'team-1' }]),
      getTeamFontVariants: vi.fn().mockResolvedValue([
        { id: 'italic-id', fontFamily: 'Brand Font', fontWeight: 400, fontStyle: 'italic' },
        { id: 'normal-id', fontFamily: 'Brand Font', fontWeight: 400, fontStyle: 'normal' },
      ]),
      downloadFontVariantBytes: vi.fn().mockRejectedValue(new Error('stop here')),
    }

    await expect(loadFont('Brand Font', '400', client)).rejects.toThrow('stop here')
    expect(client.downloadFontVariantBytes).toHaveBeenCalledWith('normal-id')
  })
})
