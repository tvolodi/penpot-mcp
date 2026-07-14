/**
 * test/integration/helpers/scratch-project.ts
 *
 * Integration tests hit the real Penpot RPC API — the only reliable way to check
 * this package's assumptions about Penpot's undocumented `add-obj`/`mod-obj`/
 * `add-component` wire schema, since malli accepting a change doesn't mean Penpot's
 * editor will render or recognize it correctly (see the variant-id bug caught by
 * live testing during development). Every scratch project created here is deleted
 * in a `finally`, so a failing assertion never leaves debris in the account.
 */
import { resolve } from 'node:path'
import { loadConfig } from '../../../src/config.js'
import { PenpotRpcClient } from '../../../src/rpc-client.js'

export const TEST_TOKENS_PATH = resolve(import.meta.dirname, '../fixtures/tokens.json')

let cachedTeamId: string | undefined

/** True if PENPOT_ACCESS_TOKEN etc. are configured; integration tests skip themselves if not. */
export function hasPenpotCredentials(): boolean {
  try {
    loadConfig()
    return true
  } catch {
    return false
  }
}

export function makeClient(): PenpotRpcClient {
  const config = loadConfig()
  return new PenpotRpcClient(config.PENPOT_BASE_URL, config.PENPOT_ACCESS_TOKEN)
}

async function getTeamId(client: PenpotRpcClient): Promise<string> {
  if (cachedTeamId) return cachedTeamId
  const teams = (await client.getTeams()) as Array<{ id: string }>
  const first = teams[0]
  if (!first) throw new Error('No Penpot teams accessible with the configured access token')
  cachedTeamId = first.id
  return cachedTeamId
}

export type ScratchProject = {
  client: PenpotRpcClient
  projectId: string
  fileId: string
  pageId: string
}

/**
 * Creates a throwaway Penpot project + file + default page, runs `fn` against it,
 * and deletes the project afterward — regardless of whether `fn` throws. Name is
 * prefixed so any project left behind by a crashed test run (e.g. `SIGKILL`
 * mid-test) is identifiable and safe to bulk-delete by hand.
 */
export async function withScratchProject<T>(
  namePrefix: string,
  fn: (scratch: ScratchProject) => Promise<T>,
): Promise<T> {
  const client = makeClient()
  const teamId = await getTeamId(client)
  const project = (await client.createProject(teamId, `vitest-${namePrefix}-${Date.now()}`)) as { id: string }

  try {
    const file = (await client.createFile(project.id, 'test')) as {
      id: string
      data: { pages: string[] }
    }
    const pageId = file.data.pages[0]
    if (!pageId) throw new Error('Newly created file has no default page')

    return await fn({ client, projectId: project.id, fileId: file.id, pageId })
  } finally {
    await client.deleteProject(project.id)
  }
}

/**
 * Duck-typed subset of `ToolDefinition<T>` that erases the exact input type —
 * `tools.find((t) => t.name === '...')` collapses to a union across every tool's
 * differently-shaped input, which TypeScript can't narrow from a string
 * comparison, so `callTool` intentionally doesn't try to type-check `input`
 * against the found tool's specific schema. Zod validates it at runtime instead,
 * same as the real MCP framework does with data arriving over the wire.
 */
type AnyTool = {
  inputSchema: { parse: (input: unknown) => unknown }
  handler: (client: PenpotRpcClient, input: never) => Promise<unknown>
}

/**
 * Parses `input` through the tool's own Zod `inputSchema` before calling `handler`,
 * exactly like the MCP framework does. Calling `.handler()` directly with a raw
 * object skips `.default(...)` application (e.g. `parentId` defaulting to
 * ROOT_FRAME_ID) — a real bug hit while writing early ad hoc verification scripts
 * during development, worth guarding against here permanently.
 */
export function callTool(tool: AnyTool, client: PenpotRpcClient, input: unknown): Promise<unknown> {
  const parsed = tool.inputSchema.parse(input)
  return tool.handler(client, parsed as never)
}
