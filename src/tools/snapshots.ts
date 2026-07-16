/**
 * tools/snapshots.ts
 *
 * MCP tool definitions for Penpot file version history (snapshots).
 * Exposes the server-side `file_change` snapshot mechanism — the same
 * named-version history a human can create and restore from the Penpot UI.
 *
 * RPC commands used:
 *   get-file-snapshots      → penpot_list_file_snapshots
 *   create-file-snapshot    → penpot_create_file_snapshot
 *   restore-file-snapshot   → penpot_restore_file_snapshot
 *   update-file-snapshot    → penpot_rename_file_snapshot
 *   delete-file-snapshot    → penpot_delete_file_snapshot
 *   get-file-snapshot       → penpot_get_file_snapshot_data
 *   lock-file-snapshot      → penpot_lock_file_snapshot
 *   unlock-file-snapshot    → penpot_unlock_file_snapshot
 *
 * Notes on snapshot types:
 *   - User-created snapshots (`createdBy: "user"`) are permanent until
 *     explicitly deleted; they can be renamed, locked, and unlocked.
 *   - System snapshots (`createdBy: "system"`) are created automatically
 *     before each restore to preserve recovery options; they expire after
 *     a server-configured delay and cannot be renamed, deleted, or locked
 *     via the API — only user-created snapshots support those operations.
 */

import { z } from 'zod'
import type { PenpotRpcClient } from '../rpc-client.js'
import type { ToolDefinition } from './project-files.js'

// ---------------------------------------------------------------------------
// penpot_list_file_snapshots
// ---------------------------------------------------------------------------

const listFileSnapshots: ToolDefinition<{ fileId: string }> = {
  name: 'penpot_list_file_snapshots',
  description:
    'List all named snapshots (version history) for a Penpot file. ' +
    'Returns each snapshot\'s id, label, revn, createdAt, createdBy, and lock state. ' +
    '`createdBy: "user"` entries are snapshots saved explicitly (from the UI or via ' +
    '`penpot_create_file_snapshot`); `createdBy: "system"` entries are automatic ' +
    'backups Penpot creates before a restore — they expire automatically. ' +
    'Use the returned `id` with `penpot_restore_file_snapshot` to roll back to a version.',
  inputSchema: z.object({ fileId: z.string().min(1) }),
  handler: (client, { fileId }) => client.listFileSnapshots(fileId),
}

// ---------------------------------------------------------------------------
// penpot_create_file_snapshot
// ---------------------------------------------------------------------------

const createFileSnapshot: ToolDefinition<{ fileId: string; label?: string }> = {
  name: 'penpot_create_file_snapshot',
  description:
    'Create a named snapshot of the current state of a Penpot file (equivalent to ' +
    '"Save version" in the Penpot UI). The optional `label` names the version; ' +
    'if omitted Penpot generates a timestamp-based label. ' +
    'Returns the new snapshot\'s metadata including its `id`. ' +
    'Only user-created snapshots can later be renamed, deleted, or locked.',
  inputSchema: z.object({
    fileId: z.string().min(1),
    label: z.string().min(1).optional(),
  }),
  handler: (client, { fileId, label }) => client.createFileSnapshot(fileId, label),
}

// ---------------------------------------------------------------------------
// penpot_restore_file_snapshot
// ---------------------------------------------------------------------------

const restoreFileSnapshot: ToolDefinition<{ fileId: string; snapshotId: string }> = {
  name: 'penpot_restore_file_snapshot',
  description:
    'Restore a Penpot file to the state captured in a named snapshot ' +
    '(equivalent to "Restore version" in the Penpot UI). ' +
    'Penpot automatically creates a system backup snapshot of the current ' +
    'file state before applying the restore, so you can undo a restore by ' +
    'listing snapshots again and restoring the most recent system entry. ' +
    'Requires the `fileId` and the `snapshotId` returned by ' +
    '`penpot_list_file_snapshots`. ' +
    'The restore replaces the file\'s live data — all agents and browser ' +
    'sessions editing the file will see the updated content.',
  inputSchema: z.object({
    fileId: z.string().min(1),
    snapshotId: z.string().min(1),
  }),
  handler: (client, { fileId, snapshotId }) => client.restoreFileSnapshot(fileId, snapshotId),
}

// ---------------------------------------------------------------------------
// penpot_rename_file_snapshot
// ---------------------------------------------------------------------------

const renameFileSnapshot: ToolDefinition<{ snapshotId: string; label: string }> = {
  name: 'penpot_rename_file_snapshot',
  description:
    'Rename an existing user-created snapshot. ' +
    'Only snapshots with `createdBy: "user"` can be renamed; ' +
    'system-created automatic backups will return an error.',
  inputSchema: z.object({
    snapshotId: z.string().min(1),
    label: z.string().min(1),
  }),
  handler: (client, { snapshotId, label }) => client.renameFileSnapshot(snapshotId, label),
}

// ---------------------------------------------------------------------------
// penpot_delete_file_snapshot
// ---------------------------------------------------------------------------

const deleteFileSnapshot: ToolDefinition<{ snapshotId: string }> = {
  name: 'penpot_delete_file_snapshot',
  description:
    'Delete a user-created snapshot. ' +
    'Only snapshots with `createdBy: "user"` can be deleted; ' +
    'system-created backups expire automatically and cannot be manually deleted. ' +
    'Locked snapshots (those with a `lockedBy` field set) cannot be deleted — ' +
    'call `penpot_unlock_file_snapshot` first.',
  inputSchema: z.object({ snapshotId: z.string().min(1) }),
  handler: (client, { snapshotId }) => client.deleteFileSnapshot(snapshotId),
}

// ---------------------------------------------------------------------------
// penpot_get_file_snapshot_data
// ---------------------------------------------------------------------------

const getFileSnapshotData: ToolDefinition<{ fileId: string; snapshotId: string }> = {
  name: 'penpot_get_file_snapshot_data',
  description:
    'Retrieve the full file content (pages, shape tree) as it existed at a specific ' +
    'snapshot — for read-only inspection or comparison, without modifying the live file. ' +
    'Returns the same structure as `penpot_get_file_snapshot` but sourced from the ' +
    'historical snapshot data. Use `penpot_restore_file_snapshot` to actually roll back.',
  inputSchema: z.object({
    fileId: z.string().min(1),
    snapshotId: z.string().min(1),
  }),
  handler: (client, { fileId, snapshotId }) => client.getFileSnapshotData(fileId, snapshotId),
}

// ---------------------------------------------------------------------------
// penpot_lock_file_snapshot
// ---------------------------------------------------------------------------

const lockFileSnapshot: ToolDefinition<{ snapshotId: string }> = {
  name: 'penpot_lock_file_snapshot',
  description:
    'Lock a user-created snapshot to prevent accidental deletion. ' +
    'A locked snapshot cannot be deleted until it is unlocked via ' +
    '`penpot_unlock_file_snapshot`. ' +
    'Only the snapshot\'s creator can lock it, and only user-created snapshots ' +
    'can be locked.',
  inputSchema: z.object({ snapshotId: z.string().min(1) }),
  handler: (client, { snapshotId }) => client.lockFileSnapshot(snapshotId),
}

// ---------------------------------------------------------------------------
// penpot_unlock_file_snapshot
// ---------------------------------------------------------------------------

const unlockFileSnapshot: ToolDefinition<{ snapshotId: string }> = {
  name: 'penpot_unlock_file_snapshot',
  description:
    'Unlock a previously locked user-created snapshot, allowing it to be deleted again. ' +
    'Only the snapshot\'s creator can unlock it.',
  inputSchema: z.object({ snapshotId: z.string().min(1) }),
  handler: (client, { snapshotId }) => client.unlockFileSnapshot(snapshotId),
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const snapshotTools: ToolDefinition<any>[] = [
  listFileSnapshots,
  createFileSnapshot,
  restoreFileSnapshot,
  renameFileSnapshot,
  deleteFileSnapshot,
  getFileSnapshotData,
  lockFileSnapshot,
  unlockFileSnapshot,
]
