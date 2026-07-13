/**
 * tools/project-files.ts
 *
 * MCP tool definitions for Penpot team/project/file metadata CRUD.
 * Each tool has a Zod input schema (used both for validation and for
 * deriving the JSON Schema advertised via tools/list) and a handler
 * that delegates to PenpotRpcClient.
 */

import { z } from 'zod'
import type { PenpotRpcClient } from '../rpc-client.js'

export type ToolDefinition<TInput> = {
  name: string
  description: string
  inputSchema: z.ZodType<TInput>
  handler: (client: PenpotRpcClient, input: TInput) => Promise<unknown>
}

const listTeams: ToolDefinition<Record<string, never>> = {
  name: 'penpot_list_teams',
  description: 'List all Penpot teams accessible to the configured access token.',
  inputSchema: z.object({}),
  handler: (client) => client.getTeams(),
}

const listProjects: ToolDefinition<{ teamId: string }> = {
  name: 'penpot_list_projects',
  description: 'List all projects within a Penpot team.',
  inputSchema: z.object({ teamId: z.string().min(1) }),
  handler: (client, { teamId }) => client.getProjects(teamId),
}

const listFiles: ToolDefinition<{ projectId: string }> = {
  name: 'penpot_list_files',
  description: 'List all files within a Penpot project.',
  inputSchema: z.object({ projectId: z.string().min(1) }),
  handler: (client, { projectId }) => client.getProjectFiles(projectId),
}

const createProject: ToolDefinition<{ teamId: string; name: string }> = {
  name: 'penpot_create_project',
  description: 'Create a new project within a Penpot team.',
  inputSchema: z.object({ teamId: z.string().min(1), name: z.string().min(1) }),
  handler: (client, { teamId, name }) => client.createProject(teamId, name),
}

const renameProject: ToolDefinition<{ projectId: string; name: string }> = {
  name: 'penpot_rename_project',
  description: 'Rename an existing Penpot project.',
  inputSchema: z.object({ projectId: z.string().min(1), name: z.string().min(1) }),
  handler: (client, { projectId, name }) => client.renameProject(projectId, name),
}

const deleteProject: ToolDefinition<{ projectId: string }> = {
  name: 'penpot_delete_project',
  description: 'Delete a Penpot project.',
  inputSchema: z.object({ projectId: z.string().min(1) }),
  handler: (client, { projectId }) => client.deleteProject(projectId),
}

const createFile: ToolDefinition<{ projectId: string; name: string }> = {
  name: 'penpot_create_file',
  description: 'Create a new file within a Penpot project.',
  inputSchema: z.object({ projectId: z.string().min(1), name: z.string().min(1) }),
  handler: (client, { projectId, name }) => client.createFile(projectId, name),
}

const renameFile: ToolDefinition<{ fileId: string; name: string }> = {
  name: 'penpot_rename_file',
  description: 'Rename an existing Penpot file.',
  inputSchema: z.object({ fileId: z.string().min(1), name: z.string().min(1) }),
  handler: (client, { fileId, name }) => client.renameFile(fileId, name),
}

const deleteFile: ToolDefinition<{ fileId: string }> = {
  name: 'penpot_delete_file',
  description: 'Delete a Penpot file.',
  inputSchema: z.object({ fileId: z.string().min(1) }),
  handler: (client, { fileId }) => client.deleteFile(fileId),
}

const getFileSnapshot: ToolDefinition<{ fileId: string }> = {
  name: 'penpot_get_file_snapshot',
  description:
    'Read a Penpot file, including its pages, shape tree, and current revn/vern (needed before any content mutation).',
  inputSchema: z.object({ fileId: z.string().min(1) }),
  handler: (client, { fileId }) => client.getFile(fileId),
}

export const projectFileTools = [
  listTeams,
  listProjects,
  listFiles,
  createProject,
  renameProject,
  deleteProject,
  createFile,
  renameFile,
  deleteFile,
  getFileSnapshot,
]
