import { describe, it, expect } from 'vitest'
import {
  kw,
  uuid,
  encodeMap,
  TransitKeyword,
  TransitUuid,
} from '../../src/transit.js'

// ---------------------------------------------------------------------------
// kw / uuid factory helpers
// ---------------------------------------------------------------------------

describe('kw', () => {
  it('returns a TransitKeyword', () => {
    const k = kw('my-key')
    expect(k).toBeInstanceOf(TransitKeyword)
  })

  it('stores the name unchanged', () => {
    expect(kw('export-shapes').name).toBe('export-shapes')
    expect(kw('').name).toBe('')
  })
})

describe('uuid', () => {
  it('returns a TransitUuid', () => {
    const u = uuid('aaa-bbb-ccc')
    expect(u).toBeInstanceOf(TransitUuid)
  })

  it('stores the value unchanged', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(uuid(id).value).toBe(id)
  })
})

// ---------------------------------------------------------------------------
// encodeMap
// ---------------------------------------------------------------------------

/**
 * Decode the output of encodeMap into a plain object for easier assertions.
 * The format is ["^ ", "~:key1", val1, "~:key2", val2, ...].
 */
function decodeTransitMap(json: string): Record<string, unknown> {
  const arr = JSON.parse(json) as unknown[]
  if (arr[0] !== '^ ') throw new Error('expected transit map marker "^ "')
  const result: Record<string, unknown> = {}
  for (let i = 1; i < arr.length; i += 2) {
    const rawKey = arr[i] as string
    const key = rawKey.replace(/^~:/, '')
    result[key] = arr[i + 1]
  }
  return result
}

describe('encodeMap', () => {
  it('produces valid JSON', () => {
    expect(() => JSON.parse(encodeMap({ a: 'b' }))).not.toThrow()
  })

  it('wraps the output in the transit map marker ["^ ", ...]', () => {
    const parsed = JSON.parse(encodeMap({ x: 1 })) as unknown[]
    expect(parsed[0]).toBe('^ ')
  })

  it('encodes string keys as "~:<key>"', () => {
    const parsed = JSON.parse(encodeMap({ cmd: 'hello' })) as string[]
    expect(parsed[1]).toBe('~:cmd')
  })

  it('passes through plain string values unchanged', () => {
    const decoded = decodeTransitMap(encodeMap({ name: 'world' }))
    expect(decoded['name']).toBe('world')
  })

  it('passes through number values unchanged', () => {
    const decoded = decodeTransitMap(encodeMap({ scale: 2.5 }))
    expect(decoded['scale']).toBe(2.5)
  })

  it('passes through boolean values unchanged', () => {
    const decoded = decodeTransitMap(encodeMap({ wait: true }))
    expect(decoded['wait']).toBe(true)
  })

  it('passes through null unchanged', () => {
    const decoded = decodeTransitMap(encodeMap({ x: null }))
    expect(decoded['x']).toBeNull()
  })

  it('encodes a TransitKeyword value as "~:<name>"', () => {
    const decoded = decodeTransitMap(encodeMap({ cmd: kw('export-shapes') }))
    expect(decoded['cmd']).toBe('~:export-shapes')
  })

  it('encodes a TransitUuid value as "~u<value>"', () => {
    const decoded = decodeTransitMap(encodeMap({ id: uuid('aaa-bbb') }))
    expect(decoded['id']).toBe('~uaaa-bbb')
  })

  it('encodes an array of mixed values recursively', () => {
    const decoded = decodeTransitMap(
      encodeMap({ items: [kw('a'), uuid('b'), 'c', 42, true] }),
    )
    expect(decoded['items']).toEqual(['~:a', '~ub', 'c', 42, true])
  })

  it('encodes a nested Map value in transit map format', () => {
    const inner = new Map<string, TransitKeyword>([['type', kw('png')]])
    const decoded = decodeTransitMap(encodeMap({ nested: inner }))
    // Inner map should itself be ["^ ", "~:type", "~:png"]
    expect(decoded['nested']).toEqual(['^ ', '~:type', '~:png'])
  })

  it('handles multiple keys in insertion order', () => {
    const encoded = encodeMap({ a: kw('first'), b: kw('second'), c: 3 })
    const parsed = JSON.parse(encoded) as unknown[]
    // [0]="^ ", [1]="~:a", [2]="~:first", [3]="~:b", [4]="~:second", [5]="~:c", [6]=3
    expect(parsed[1]).toBe('~:a')
    expect(parsed[2]).toBe('~:first')
    expect(parsed[3]).toBe('~:b')
    expect(parsed[4]).toBe('~:second')
    expect(parsed[5]).toBe('~:c')
    expect(parsed[6]).toBe(3)
  })

  it('encodes an array nested inside another array', () => {
    const decoded = decodeTransitMap(
      encodeMap({ matrix: [[kw('x'), 1], [kw('y'), 2]] }),
    )
    expect(decoded['matrix']).toEqual([['~:x', 1], ['~:y', 2]])
  })

  it('round-trips the export-shapes shape used by the exporter client', () => {
    // Matches the actual call in exporter-client.ts
    const result = encodeMap({
      cmd: kw('export-shapes'),
      wait: true,
      'profile-id': uuid('profile-uuid'),
      exports: [
        new Map<string, TransitKeyword | TransitUuid | string | number>([
          ['page-id', uuid('page-uuid')],
          ['file-id', uuid('file-uuid')],
          ['object-id', uuid('object-uuid')],
          ['type', kw('png')],
          ['scale', 1],
          ['suffix', ''],
          ['name', 'export'],
        ]),
      ],
    })

    // Must be valid JSON
    expect(() => JSON.parse(result)).not.toThrow()

    // Must contain the expected transit-encoded strings
    expect(result).toContain('~:export-shapes')
    expect(result).toContain('~uprofile-uuid')
    expect(result).toContain('~upage-uuid')
    expect(result).toContain('~:png')
  })
})
