/**
 * tools/comments.ts
 *
 * MCP tool definitions for Penpot comment threads and comments.
 * Covers listing, creating, replying to, resolving, updating, and deleting
 * comment threads and individual comments.
 */

import { z } from 'zod'
import type { PenpotRpcClient } from '../rpc-client.js'
import type { ToolDefinition } from './project-files.js'

// ---------------------------------------------------------------------------
// penpot_list_comment_threads
// ---------------------------------------------------------------------------

const listCommentThreads: ToolDefinition<{ fileId: string }> = {
  name: 'penpot_list_comment_threads',
  description:
    'List all comment threads in a Penpot file. Returns each thread\'s id, position, content (the opening message), resolution status, and participant list.',
  inputSchema: z.object({ fileId: z.string().min(1) }),
  handler: (client, { fileId }) => client.getCommentThreads(fileId),
}

// ---------------------------------------------------------------------------
// penpot_get_comments
// ---------------------------------------------------------------------------

const getComments: ToolDefinition<{ threadId: string }> = {
  name: 'penpot_get_comments',
  description:
    'Get all reply comments within a comment thread. Returns each comment\'s id, content, author, and timestamps.',
  inputSchema: z.object({ threadId: z.string().min(1) }),
  handler: (client, { threadId }) => client.getComments(threadId),
}

// ---------------------------------------------------------------------------
// penpot_create_comment_thread
// ---------------------------------------------------------------------------

type CreateCommentThreadInput = {
  fileId: string
  pageId: string
  x: number
  y: number
  content: string
  frameId?: string
}

const createCommentThread: ToolDefinition<CreateCommentThreadInput> = {
  name: 'penpot_create_comment_thread',
  description:
    'Create a new comment thread pinned to a canvas position on a page. ' +
    '`x`/`y` are the canvas coordinates where the comment pin appears. ' +
    'Optionally supply `frameId` to attach the thread to a specific frame; ' +
    'omit it to place the thread on the page root.',
  inputSchema: z.object({
    fileId: z.string().min(1),
    pageId: z.string().min(1),
    x: z.number(),
    y: z.number(),
    content: z.string().min(1),
    frameId: z.string().optional(),
  }),
  handler: (client: PenpotRpcClient, { fileId, pageId, x, y, content, frameId }: CreateCommentThreadInput) =>
    client.createCommentThread(fileId, pageId, { x, y }, content, frameId),
}

// ---------------------------------------------------------------------------
// penpot_create_comment
// ---------------------------------------------------------------------------

const createComment: ToolDefinition<{ threadId: string; content: string }> = {
  name: 'penpot_create_comment',
  description: 'Add a reply comment to an existing comment thread.',
  inputSchema: z.object({
    threadId: z.string().min(1),
    content: z.string().min(1),
  }),
  handler: (client, { threadId, content }) => client.createComment(threadId, content),
}

// ---------------------------------------------------------------------------
// penpot_update_comment
// ---------------------------------------------------------------------------

const updateComment: ToolDefinition<{ id: string; content: string }> = {
  name: 'penpot_update_comment',
  description: 'Edit the text content of an existing comment (the opening message of a thread or a reply).',
  inputSchema: z.object({
    id: z.string().min(1),
    content: z.string().min(1),
  }),
  handler: (client, { id, content }) => client.updateComment(id, content),
}

// ---------------------------------------------------------------------------
// penpot_resolve_comment_thread
// ---------------------------------------------------------------------------

const resolveCommentThread: ToolDefinition<{ id: string; isResolved: boolean }> = {
  name: 'penpot_resolve_comment_thread',
  description:
    'Mark a comment thread as resolved (`isResolved: true`) or reopen it (`isResolved: false`). ' +
    'Resolved threads are hidden by default in Penpot\'s UI but remain accessible.',
  inputSchema: z.object({
    id: z.string().min(1),
    isResolved: z.boolean(),
  }),
  handler: (client, { id, isResolved }) => client.updateCommentThread(id, isResolved),
}

// ---------------------------------------------------------------------------
// penpot_delete_comment
// ---------------------------------------------------------------------------

const deleteComment: ToolDefinition<{ id: string }> = {
  name: 'penpot_delete_comment',
  description: 'Delete a single comment (reply) from a thread. Only the comment author can delete their own comment.',
  inputSchema: z.object({ id: z.string().min(1) }),
  handler: (client, { id }) => client.deleteComment(id),
}

// ---------------------------------------------------------------------------
// penpot_delete_comment_thread
// ---------------------------------------------------------------------------

const deleteCommentThread: ToolDefinition<{ id: string }> = {
  name: 'penpot_delete_comment_thread',
  description:
    'Delete an entire comment thread and all its replies. Only the thread owner can delete it.',
  inputSchema: z.object({ id: z.string().min(1) }),
  handler: (client, { id }) => client.deleteCommentThread(id),
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const commentTools: ToolDefinition<any>[] = [
  listCommentThreads,
  getComments,
  createCommentThread,
  createComment,
  updateComment,
  resolveCommentThread,
  deleteComment,
  deleteCommentThread,
]
