/**
 * Unit tests for checkpoints.ts — in-memory and disk-persistence paths.
 *
 * Each test that exercises disk writes uses a unique temporary directory (created
 * under the OS temp folder) so the tests are fully isolated from each other and
 * from any real checkpoint store.  The directories are removed in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Re-import the module fresh for each describe block so the module-level state
// (the checkpoints Map and persistenceDir) is isolated between test groups.
// Vitest does NOT reset module state between tests by default, so we reset the
// store manually using a dedicated helper exported solely for testing.
import {
  initCheckpointStore,
  saveCheckpoint,
  getCheckpoint,
  deleteCheckpoint,
} from '../../src/checkpoints.js'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a temporary directory that is cleaned up after the test. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'penpot-checkpoints-test-'))
}

const DUMMY_SHAPE = {
  id: 'shape-1',
  type: 'rect' as const,
  name: 'Rect',
  parentId: '00000000-0000-0000-0000-000000000000',
  frameId: '00000000-0000-0000-0000-000000000000',
  'parent-id': '00000000-0000-0000-0000-000000000000',
  'frame-id': '00000000-0000-0000-0000-000000000000',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  'transform-inverse': { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  selrect: { x: 0, y: 0, x1: 0, y1: 0, x2: 100, y2: 100, width: 100, height: 100 },
  points: [],
  hideFillOnExport: false,
  'hide-fill-on-export': false,
}

const PAGES = { 'page-1': { [DUMMY_SHAPE.id]: DUMMY_SHAPE } }

// ── in-memory mode (no persistenceDir) ───────────────────────────────────────

describe('in-memory mode', () => {
  it('saveCheckpoint returns a checkpoint with a UUID id', async () => {
    const cp = await saveCheckpoint('file-1', PAGES)
    expect(cp.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(cp.fileId).toBe('file-1')
    expect(cp.pages['page-1']!['shape-1']).toBeDefined()
  })

  it('getCheckpoint retrieves the saved checkpoint', async () => {
    const cp = await saveCheckpoint('file-1', PAGES)
    const fetched = getCheckpoint(cp.id)
    expect(fetched).toBeDefined()
    expect(fetched!.id).toBe(cp.id)
  })

  it('getCheckpoint returns undefined for an unknown id', () => {
    expect(getCheckpoint('does-not-exist')).toBeUndefined()
  })

  it('deleteCheckpoint returns true and removes the checkpoint', async () => {
    const cp = await saveCheckpoint('file-1', PAGES)
    const existed = await deleteCheckpoint(cp.id)
    expect(existed).toBe(true)
    expect(getCheckpoint(cp.id)).toBeUndefined()
  })

  it('deleteCheckpoint returns false for an unknown id', async () => {
    expect(await deleteCheckpoint('not-a-real-id')).toBe(false)
  })

  it('snapshot is deep-cloned (mutations do not corrupt the checkpoint)', async () => {
    const mutablePages: typeof PAGES = { 'page-1': { [DUMMY_SHAPE.id]: { ...DUMMY_SHAPE } } }
    const cp = await saveCheckpoint('file-1', mutablePages)
    // Mutate the original object after saving.
    mutablePages['page-1']![DUMMY_SHAPE.id]!.x = 999
    const fetched = getCheckpoint(cp.id)!
    expect(fetched.pages['page-1']![DUMMY_SHAPE.id]!.x).toBe(0)
  })

  it('pageId is stored when supplied', async () => {
    const cp = await saveCheckpoint('file-1', PAGES, 'page-1')
    expect(cp.pageId).toBe('page-1')
  })

  it('pageId is undefined for a whole-file checkpoint', async () => {
    const cp = await saveCheckpoint('file-1', PAGES)
    expect(cp.pageId).toBeUndefined()
  })
})

// ── disk-persistence mode ─────────────────────────────────────────────────────

describe('disk persistence', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function freshStore(): Promise<string> {
    const dir = await makeTmpDir()
    tmpDirs.push(dir)
    await initCheckpointStore(dir)
    return dir
  }

  it('initCheckpointStore creates the directory if it does not exist', async () => {
    const parent = await makeTmpDir()
    tmpDirs.push(parent)
    const newDir = join(parent, 'nested', 'checkpoints')
    await initCheckpointStore(newDir)
    // If mkdir didn't throw, the dir now exists.
    const files = await readdir(newDir)
    expect(files).toEqual([])
  })

  it('saveCheckpoint writes a JSON file named <id>.json', async () => {
    const dir = await freshStore()
    const cp = await saveCheckpoint('file-1', PAGES)
    const files = await readdir(dir)
    expect(files).toContain(`${cp.id}.json`)
  })

  it('the JSON file is a valid serialisation of the checkpoint', async () => {
    const dir = await freshStore()
    const cp = await saveCheckpoint('file-1', PAGES, 'page-1')
    const raw = await readFile(join(dir, `${cp.id}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.id).toBe(cp.id)
    expect(parsed.fileId).toBe('file-1')
    expect(parsed.pageId).toBe('page-1')
    expect(parsed.pages['page-1']['shape-1'].x).toBe(0)
  })

  it('deleteCheckpoint removes the JSON file from disk', async () => {
    const dir = await freshStore()
    const cp = await saveCheckpoint('file-1', PAGES)
    await deleteCheckpoint(cp.id)
    const files = await readdir(dir)
    expect(files).not.toContain(`${cp.id}.json`)
  })

  it('initCheckpointStore loads existing checkpoint files', async () => {
    // Write a checkpoint file manually, then init against the same dir.
    const dir = await makeTmpDir()
    tmpDirs.push(dir)

    const fake = {
      id: '11111111-1111-1111-1111-111111111111',
      fileId: 'file-loaded',
      createdAt: new Date().toISOString(),
      pages: PAGES,
    }
    await writeFile(join(dir, `${fake.id}.json`), JSON.stringify(fake))

    const { loaded } = await initCheckpointStore(dir)
    expect(loaded).toBe(1)
    const fetched = getCheckpoint(fake.id)
    expect(fetched).toBeDefined()
    expect(fetched!.fileId).toBe('file-loaded')
  })

  it('initCheckpointStore skips files that are not .json', async () => {
    const dir = await makeTmpDir()
    tmpDirs.push(dir)
    await writeFile(join(dir, 'README.txt'), 'not a checkpoint')
    const { loaded } = await initCheckpointStore(dir)
    expect(loaded).toBe(0)
  })

  it('initCheckpointStore skips corrupt JSON files gracefully', async () => {
    const dir = await makeTmpDir()
    tmpDirs.push(dir)
    await writeFile(join(dir, 'corrupt.json'), '{ bad json')
    const { loaded } = await initCheckpointStore(dir)
    expect(loaded).toBe(0)
  })

  it('initCheckpointStore skips JSON files missing required fields', async () => {
    const dir = await makeTmpDir()
    tmpDirs.push(dir)
    await writeFile(join(dir, 'incomplete.json'), JSON.stringify({ pages: {} }))
    const { loaded } = await initCheckpointStore(dir)
    expect(loaded).toBe(0)
  })

  it('multiple checkpoints are each written as their own file', async () => {
    const dir = await freshStore()
    const cp1 = await saveCheckpoint('file-1', PAGES)
    const cp2 = await saveCheckpoint('file-2', PAGES)
    const files = await readdir(dir)
    expect(files).toContain(`${cp1.id}.json`)
    expect(files).toContain(`${cp2.id}.json`)
  })

  it('surviving a restart: checkpoint is available after re-init from same dir', async () => {
    const dir = await makeTmpDir()
    tmpDirs.push(dir)

    // First "process": save a checkpoint.
    await initCheckpointStore(dir)
    const cp = await saveCheckpoint('file-restart', PAGES)
    const savedId = cp.id

    // Second "process": re-init from the same directory — simulates a restart.
    const { loaded } = await initCheckpointStore(dir)
    expect(loaded).toBeGreaterThanOrEqual(1)
    const fetched = getCheckpoint(savedId)
    expect(fetched).toBeDefined()
    expect(fetched!.fileId).toBe('file-restart')
  })
})
