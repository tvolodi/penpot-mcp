/**
 * font-metrics.ts
 *
 * Fetches real font files and measures text against them with opentype.js,
 * so `penpot_measure_text` returns actual glyph-advance widths/line heights
 * instead of a guess — Penpot itself only knows rendered text bounds after
 * client-side canvas layout (there is no backend RPC for this; confirmed by
 * reading penpot/penpot's rpc/commands sources), so this package has to do
 * its own shaping.
 *
 * Font resolution priority:
 *  1. Google Fonts — fetched from `fonts.googleapis.com/css2` (no API key
 *     required). A plain-text (non-browser) `User-Agent` is used deliberately
 *     — Google's CSS endpoint serves modern browsers WOFF2, which opentype.js
 *     cannot decode, but serves legacy/plain clients a `.ttf`, which it can.
 *  2. Penpot team/custom fonts — if a `PenpotFontClient` is supplied and
 *     Google Fonts lookup fails, all teams accessible to the configured token
 *     are searched for a matching font variant, and the variant's binary is
 *     downloaded via `download-font`. This covers fonts uploaded to your own
 *     Penpot instance that are not on Google Fonts.
 *
 * Fetched bytes are parsed once and cached in-process (keyed by
 * family+weight), since font files rarely change within a server's
 * lifetime and re-fetching per call would make every measurement a network
 * round trip.
 */

import opentype from 'opentype.js'

const GOOGLE_FONTS_CSS_URL = 'https://fonts.googleapis.com/css2'
// Deliberately not a browser UA: modern browsers get WOFF2 from this endpoint,
// which opentype.js can't parse. This UA string is old enough that Google's
// CSS endpoint falls back to plain TrueType.
const LEGACY_USER_AGENT = 'Mozilla/5.0 (Windows NT 6.1; rv:2.0)'

export class FontFetchError extends Error {
  constructor(
    public readonly family: string,
    public readonly weight: string,
    reason: string,
  ) {
    super(`Could not fetch font "${family}" (weight ${weight}): ${reason}`)
  }
}

const fontCache = new Map<string, opentype.Font>()

function cacheKey(family: string, weight: string): string {
  return `${family.toLowerCase()}::${weight}`
}

/**
 * Minimal interface from PenpotRpcClient needed for custom-font lookup.
 * Declared here (not imported from rpc-client.ts) so font-metrics.ts stays
 * decoupled from the Penpot client type — unit tests can supply a plain mock.
 */
export type PenpotFontClient = {
  getTeams(): Promise<unknown>
  getTeamFontVariants(teamId: string): Promise<Array<{ id: string; fontFamily: string; fontWeight: number; fontStyle: string }>>
  downloadFontVariantBytes(variantId: string): Promise<Buffer>
}

async function fetchGoogleFontBytes(family: string, weight: string): Promise<Buffer> {
  const qs = new URLSearchParams({ family: `${family}:wght@${weight}` })
  const res = await fetch(`${GOOGLE_FONTS_CSS_URL}?${qs.toString()}`, {
    headers: { 'User-Agent': LEGACY_USER_AGENT },
  })
  if (!res.ok) {
    throw new FontFetchError(family, weight, `Google Fonts CSS lookup failed with HTTP ${res.status}`)
  }
  const css = await res.text()
  const fontUrl = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1]
  if (!fontUrl) {
    throw new FontFetchError(family, weight, 'no matching font family/weight found on Google Fonts')
  }

  const fontRes = await fetch(fontUrl)
  if (!fontRes.ok) {
    throw new FontFetchError(family, weight, `font file download failed with HTTP ${fontRes.status}`)
  }
  return Buffer.from(await fontRes.arrayBuffer())
}

/**
 * Searches all teams accessible via `client` for a custom font variant
 * matching `family` (case-insensitive) and `weight`. "normal" style is
 * preferred when multiple variants exist for the same family+weight.
 * Throws a `FontFetchError` with a combined message if no match is found.
 */
async function fetchPenpotFontBytes(
  client: PenpotFontClient,
  family: string,
  weight: string,
  googleError: FontFetchError,
): Promise<Buffer> {
  const teams = (await client.getTeams()) as Array<{ id: string }>
  for (const team of teams) {
    const variants = await client.getTeamFontVariants(team.id)
    const familyLower = family.toLowerCase()
    const match =
      variants.find((v) => v.fontFamily.toLowerCase() === familyLower && String(v.fontWeight) === weight && v.fontStyle === 'normal') ??
      variants.find((v) => v.fontFamily.toLowerCase() === familyLower && String(v.fontWeight) === weight)
    if (match) return client.downloadFontVariantBytes(match.id)
  }
  throw new FontFetchError(family, weight, `not found on Google Fonts (${googleError.message}) or in any accessible Penpot team`)
}

/** Fetches font bytes from Google Fonts; falls back to Penpot custom fonts if a client is given and Google Fonts fails. */
async function fetchFontBytes(family: string, weight: string, penpotClient?: PenpotFontClient): Promise<Buffer> {
  try {
    return await fetchGoogleFontBytes(family, weight)
  } catch (err) {
    if (!(err instanceof FontFetchError) || !penpotClient) throw err
    return fetchPenpotFontBytes(penpotClient, family, weight, err)
  }
}

/**
 * Loads and parses a font (family + numeric weight string, e.g. "400"), using
 * the in-process cache when available.
 *
 * Resolution order:
 *  1. Google Fonts (public CDN, no API key needed).
 *  2. Penpot team/custom fonts — searched across all teams the configured
 *     token has access to, if `penpotClient` is supplied and Google Fonts
 *     returns no match. The variant whose `fontStyle` is "normal" is
 *     preferred when multiple variants share the same family+weight.
 *
 * Throws `FontFetchError` if the font cannot be found or parsed.
 */
export async function loadFont(family: string, weight: string = '400', penpotClient?: PenpotFontClient): Promise<opentype.Font> {
  const key = cacheKey(family, weight)
  const cached = fontCache.get(key)
  if (cached) return cached

  const bytes = await fetchFontBytes(family, weight, penpotClient)
  let font: opentype.Font
  try {
    font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown parse error'
    throw new FontFetchError(family, weight, `downloaded font could not be parsed: ${reason}`)
  }

  fontCache.set(key, font)
  return font
}

/**
 * The minimal subset of `opentype.Font` that `measureText` needs — narrowed out
 * so unit tests can measure against a hand-built fake instead of a real parsed
 * font file (which would require network access to fetch).
 */
export type MeasurableFont = {
  unitsPerEm: number
  ascender: number
  descender: number
  charToGlyph(c: string): opentype.Glyph
  getKerningValue(left: opentype.Glyph, right: opentype.Glyph): number
}

export type LineMetrics = {
  text: string
  width: number
}

export type TextMeasurement = {
  /** Natural width of the widest line, in pixels at the given font size — no wrapping applied. */
  width: number
  /** Total height across all lines, in pixels, using the font's own ascender/descender metrics. */
  height: number
  /** Height of a single line, in pixels — `height` is this times the number of lines. */
  lineHeight: number
  /** Per-line breakdown (split on explicit "\n" only, or re-wrapped if `maxWidth` was given). */
  lines: LineMetrics[]
}

/**
 * Sums glyph advance widths (plus GPOS pair-kerning between consecutive glyphs)
 * for `text` at `fontSize`. Deliberately bypasses `Font.getAdvanceWidth`/
 * `getPath`'s bidi-shaping pipeline: that pipeline unconditionally runs GSUB
 * `ccmp`/contextual-substitution lookups, and opentype.js 2.0.0 throws
 * ("substFormat: 2 is not yet supported") on lookup tables present in most
 * current-generation Google Fonts, including Inter and Roboto — confirmed by
 * hitting that crash live against both during development. Per-glyph cmap
 * lookup + hmtx advance + GPOS kerning avoids that broken path entirely, at
 * the cost of not applying ligature substitution (e.g. "fi" as one glyph) —
 * an acceptable width difference (a few percent at most on ligature-heavy
 * text) next to a hard crash on most real-world fonts.
 */
function measureLineWidth(font: MeasurableFont, line: string, fontSize: number): number {
  const scale = fontSize / font.unitsPerEm
  let width = 0
  let prevGlyph: opentype.Glyph | undefined
  for (const ch of line) {
    const glyph = font.charToGlyph(ch)
    if (prevGlyph) width += font.getKerningValue(prevGlyph, glyph) * scale
    width += (glyph.advanceWidth ?? 0) * scale
    prevGlyph = glyph
  }
  return width
}

/**
 * Measures `characters` against a real font's glyph metrics. Always splits on
 * explicit "\n" first; if `maxWidth` is given, each resulting line is greedily
 * re-wrapped on word boundaries so no line's measured width exceeds it (matching
 * how a fixed-width text shape would actually flow), except for single words
 * that alone exceed `maxWidth`, which are left unbroken.
 */
export function measureText(
  font: MeasurableFont,
  characters: string,
  fontSize: number,
  maxWidth?: number,
): TextMeasurement {
  const scale = fontSize / font.unitsPerEm
  const lineHeight = (font.ascender - font.descender) * scale

  const rawLines = characters.split('\n')
  const lines: LineMetrics[] = []
  for (const rawLine of rawLines) {
    if (maxWidth === undefined) {
      lines.push({ text: rawLine, width: measureLineWidth(font, rawLine, fontSize) })
      continue
    }
    lines.push(...wrapLine(font, rawLine, fontSize, maxWidth))
  }

  const width = Math.max(0, ...lines.map((l) => l.width))
  return { width, height: lineHeight * lines.length, lineHeight, lines }
}

function wrapLine(font: MeasurableFont, line: string, fontSize: number, maxWidth: number): LineMetrics[] {
  if (line === '') return [{ text: '', width: 0 }]

  const words = line.split(' ')
  const result: LineMetrics[] = []
  let current = ''

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    const candidateWidth = measureLineWidth(font, candidate, fontSize)
    if (candidateWidth <= maxWidth || current === '') {
      current = candidate
    } else {
      result.push({ text: current, width: measureLineWidth(font, current, fontSize) })
      current = word
    }
  }
  result.push({ text: current, width: measureLineWidth(font, current, fontSize) })
  return result
}
