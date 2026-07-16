import { describe, it, expect } from 'vitest'
import { resolveColor, resolveRadius, resolveShadow, resolveSpacing, type TokenFile } from '../../src/tools/tokens.js'

const tokens: TokenFile = {
  colors: { accent: '#7AA2FF' },
  spacing: { sm: 8, md: 16 },
  radii: { sm: 4, pill: 999 },
  shadows: {
    card: { style: 'drop-shadow', color: '#000000', opacity: 0.3, offsetX: 4, offsetY: 4, blur: 8, spread: 2 },
    ring: { style: 'inner-shadow', color: { token: 'accent' }, opacity: 1, offsetX: 0, offsetY: 0, blur: 0, spread: 2 },
  },
}

describe('resolveColor', () => {
  it('passes through a literal hex string unchanged', () => {
    expect(resolveColor('#FF0000', tokens)).toBe('#FF0000')
  })

  it('resolves a { token } reference against the colors table', () => {
    expect(resolveColor({ token: 'accent' }, tokens)).toBe('#7AA2FF')
  })

  it('throws with the list of known tokens when the token is unknown', () => {
    expect(() => resolveColor({ token: 'nope' }, tokens)).toThrow(/Unknown color token "nope"/)
  })
})

describe('resolveSpacing', () => {
  it('passes through a literal number unchanged', () => {
    expect(resolveSpacing(12, tokens)).toBe(12)
  })

  it('resolves a { token } reference against the spacing table', () => {
    expect(resolveSpacing({ token: 'md' }, tokens)).toBe(16)
  })

  it('returns undefined when given undefined (optional field left unset)', () => {
    expect(resolveSpacing(undefined, tokens)).toBeUndefined()
  })

  it('throws with the list of known tokens when the token is unknown', () => {
    expect(() => resolveSpacing({ token: 'nope' }, tokens)).toThrow(/Unknown spacing token "nope"/)
  })
})

describe('resolveRadius', () => {
  it('passes through a literal number unchanged', () => {
    expect(resolveRadius(6, tokens)).toBe(6)
  })

  it('resolves a { token } reference against the radii table', () => {
    expect(resolveRadius({ token: 'pill' }, tokens)).toBe(999)
  })

  it('throws with the list of known tokens when the token is unknown', () => {
    expect(() => resolveRadius({ token: 'nope' }, tokens)).toThrow(/Unknown radii token "nope"/)
  })
})

describe('resolveShadow', () => {
  it('passes through an inline shadow object unchanged', () => {
    const inline = { style: 'drop-shadow' as const, color: '#111111', opacity: 0.5, offsetX: 1, offsetY: 1, blur: 2, spread: 0 }
    expect(resolveShadow(inline, tokens)).toEqual(inline)
  })

  it('resolves a { token } reference against the shadows table', () => {
    expect(resolveShadow({ token: 'card' }, tokens)).toEqual(tokens.shadows!.card)
  })

  it('a resolved shadow token can itself hold a { token } color reference, resolved separately via resolveColor', () => {
    const shadow = resolveShadow({ token: 'ring' }, tokens)
    expect(resolveColor(shadow.color, tokens)).toBe('#7AA2FF')
  })

  it('throws with the list of known tokens when the token is unknown', () => {
    expect(() => resolveShadow({ token: 'nope' }, tokens)).toThrow(/Unknown shadow token "nope"/)
  })
})
