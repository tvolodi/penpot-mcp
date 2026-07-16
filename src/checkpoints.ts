/**
 * checkpoints.ts
 *
 * In-memory storage for `penpot_checkpoint`/`penpot_restore_checkpoint`: a snapshot of
 * every shape on a page at a point in time, keyed by a caller-opaque checkpoint id.
 *
 * There is no "revert to revn X" primitive in Penpot's RPC API — `update-file` only
 * accepts forward changes (add-obj/del-obj/mod-obj/etc.), so restoring means diffing
 * current page state against the snapshot and replaying corrective changes: recreate
 * shapes the snapshot has but the page no longer does, delete shapes the page has that
 * the snapshot didn't, and overwrite shapes present in both back to their snapshotted
 * form (see `restoreShapeAsAddObj` in shape-builders.ts). This module only stores the
 * snapshot; tools/content.ts computes and sends the diff.
 *
 * Held in process memory, not persisted to disk — a checkpoint is lost if the MCP server
 * restarts before restore is called. Consuming projects needing durability across
 * restarts should snapshot via `penpot_get_file_snapshot` themselves instead.
 */

import { randomUUID } from 'node:crypto'
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

/**
 * Save a checkpoint for one or more pages.
 *
 * @param fileId   - The Penpot file id.
 * @param pages    - Map of pageId → shape-objects to snapshot.
 * @param pageId   - Set to a single page id when the checkpoint is page-scoped;
 *                   omit (or pass undefined) for a whole-file checkpoint.
 */
export function saveCheckpoint(
  fileId: string,
  pages: Record<string, Record<string, ShapeNode>>,
  pageId?: string,
): Checkpoint {
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
  return checkpoint
}

export function getCheckpoint(checkpointId: string): Checkpoint | undefined {
  return checkpoints.get(checkpointId)
}

/**
 * Explicitly discards a checkpoint. Restoring does NOT do this automatically — a
 * checkpoint is reusable (restore the same point multiple times) until the caller
 * discards it or the server process restarts.
 */
export function deleteCheckpoint(checkpointId: string): boolean {
  return checkpoints.delete(checkpointId)
}
