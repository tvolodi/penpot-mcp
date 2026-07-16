/**
 * checkpoints.ts
 *
 * Storage for `penpot_checkpoint`/`penpot_restore_checkpoint`: a snapshot of every
 * shape on a page at a point in time, keyed by a caller-opaque checkpoint id.
 *
 * There is no "revert to revn X" primitive in Penpot's RPC API — `update-file` only
 * accepts forward changes (add-obj/del-obj/mod-obj/etc.), so restoring means diffing
 * current page state against the snapshot and replaying corrective changes: recreate
 * shapes the snapshot has but the page no longer does, delete shapes the page has that
 * the snapshot didn't, and overwrite shapes present in both back to their snapshotted
 * form (see `restoreShapeAsAddObj` in shape-builders.ts). This module only stores the
 * snapshot; tools/content.ts computes and sends the diff.
 *
 * Persistence modes:
 *   - In-memory only (default): checkpoints are lost when the MCP server process exits.
 *   - Disk-backed (PENPOT_CHECKPOINTS_PATH set): each checkpoint is written as a JSON
 *     file to the configured directory so it survives a server restart. Call
 *     `initCheckpointStore(dir)` once at server startup to load any existing files and
 *     enable the disk-write path.
 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ShapeNode } from './shape-builders.js'

export type Checkpoint = {
  id: string
  fileId: string
  /** Populated when the checkpoint was scoped to a single page; undefined for whole-file checkpoints. */
  pageId?: string
  createdAt: string
  /** Snapshotted shapes per page (pageId → shape objects map). */
  pages: Record<string, Record<string, ShapeNode>>
}

const checkpoints = new Map<string, Checkpoint>()

/** Set by `initCheckpointStore`; undefined means in-memory-only mode. */
let persistenceDir: string | undefined

/**
 * Initialise disk persistence for checkpoints.
 *
 * Creates `dir` if it does not already exist, then loads every `<uuid>.json` file
 * found there — so checkpoints written by a previous server process are available
 * immediately after restart.
 *
 * Must be called at most once, before the MCP server starts accepting requests.
 *
 * @returns The number of checkpoint files successfully loaded from disk.
 */
export async function initCheckpointStore(dir: string): Promise<{ loaded: number }> {
  await mkdir(dir, { recursive: true })
  persistenceDir = dir

  let loaded = 0
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    // If readdir fails (e.g. race with another process) just start with empty state.
    return { loaded: 0 }
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const checkpoint = JSON.parse(raw) as Checkpoint
      // Basic sanity check before trusting the file.
      if (typeof checkpoint.id === 'string' && typeof checkpoint.fileId === 'string') {
        checkpoints.set(checkpoint.id, checkpoint)
        loaded++
      }
    } catch {
      // Ignore corrupt or partial checkpoint files written during a previous crash.
    }
  }
  return { loaded }
}

/**
 * Save a checkpoint for one or more pages.
 *
 * When disk persistence is enabled (i.e. `initCheckpointStore` has been called),
 * the checkpoint is also written to `<persistenceDir>/<id>.json` so that it
 * survives a server restart. The write is awaited — if it fails the error is
 * propagated so the caller knows the checkpoint was not persisted to disk.
 *
 * @param fileId   - The Penpot file id.
 * @param pages    - Map of pageId → shape-objects to snapshot.
 * @param pageId   - Set to a single page id when the checkpoint is page-scoped;
 *                   omit (or pass undefined) for a whole-file checkpoint.
 */
export async function saveCheckpoint(
  fileId: string,
  pages: Record<string, Record<string, ShapeNode>>,
  pageId?: string,
): Promise<Checkpoint> {
  const checkpoint: Checkpoint = {
    id: randomUUID(),
    fileId,
    pageId,
    createdAt: new Date().toISOString(),
    // Deep-clone so later mutations to the live page's objects (e.g. a batch tool's
    // in-memory shadow) can never retroactively alter an already-saved checkpoint.
    pages: structuredClone(pages),
  }
  checkpoints.set(checkpoint.id, checkpoint)

  if (persistenceDir) {
    await writeFile(join(persistenceDir, `${checkpoint.id}.json`), JSON.stringify(checkpoint))
  }

  return checkpoint
}

export function getCheckpoint(checkpointId: string): Checkpoint | undefined {
  return checkpoints.get(checkpointId)
}

/**
 * Explicitly discards a checkpoint. Restoring does NOT do this automatically — a
 * checkpoint is reusable (restore the same point multiple times) until the caller
 * discards it or the server process restarts.
 *
 * When disk persistence is enabled, also removes the corresponding JSON file.
 * File deletion errors are logged to stderr but do not cause the function to throw
 * (the in-memory deletion has already succeeded).
 */
export async function deleteCheckpoint(checkpointId: string): Promise<boolean> {
  const existed = checkpoints.delete(checkpointId)
  if (existed && persistenceDir) {
    try {
      await unlink(join(persistenceDir, `${checkpointId}.json`))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`penpot-checkpoints: failed to remove ${checkpointId}.json: ${msg}\n`)
    }
  }
  return existed
}
