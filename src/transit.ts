/**
 * transit.ts
 *
 * Minimal transit+json encoder for the one shape of request this package
 * needs: Penpot's `/api/export` endpoint (the exporter microservice) only
 * accepts `application/transit+json`, not plain JSON — verified empirically
 * against a live instance (plain JSON produces a 500 from a `conj`/`merge`
 * error inside the exporter's ClojureScript handler).
 *
 * This is intentionally not a general transit-format implementation — it
 * covers exactly the value types this request needs: maps (encoded as
 * `["^ ", k1, v1, k2, v2, ...]`), keywords (`"~:name"`), UUID-tagged strings
 * (`"~uXXXX"`), plain strings, numbers, booleans, and arrays of the above.
 */

export type TransitValue =
  | string
  | number
  | boolean
  | null
  | TransitKeyword
  | TransitUuid
  | TransitValue[]
  | Map<string, TransitValue>

export class TransitKeyword {
  constructor(public readonly name: string) {}
}

export class TransitUuid {
  constructor(public readonly value: string) {}
}

export function kw(name: string): TransitKeyword {
  return new TransitKeyword(name)
}

export function uuid(value: string): TransitUuid {
  return new TransitUuid(value)
}

function encodeValue(value: TransitValue): unknown {
  if (value instanceof TransitKeyword) return `~:${value.name}`
  if (value instanceof TransitUuid) return `~u${value.value}`
  if (Array.isArray(value)) return value.map(encodeValue)
  if (value instanceof Map) {
    const out: unknown[] = ['^ ']
    for (const [k, v] of value) {
      out.push(`~:${k}`, encodeValue(v))
    }
    return out
  }
  return value
}

/** Encodes a plain object as a transit+json map, treating every value as a TransitValue. */
export function encodeMap(obj: Record<string, TransitValue>): string {
  const map = new Map(Object.entries(obj))
  return JSON.stringify(encodeValue(map))
}
