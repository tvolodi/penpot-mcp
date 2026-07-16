#!/usr/bin/env node
/**
 * server.ts
 *
 * MCP stdio server exposing headless Penpot project/file/content tools.
 * No browser, no Penpot plugin session — pure RPC calls against
 * PENPOT_BASE_URL, authenticated with PENPOT_ACCESS_TOKEN.
 *
 * This package has no project-specific knowledge: colors/fonts are
 * resolved from whatever file PENPOT_TOKENS_PATH points at, set per
 * consuming project. See README.md for setup instructions.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { PenpotRpcClient, PenpotRpcError } from './rpc-client.js'
import { PenpotExporterClient } from './exporter-client.js'
import { projectFileTools, type ToolDefinition } from './tools/project-files.js'
import { contentTools } from './tools/content.js'
import { registerExportTool } from './tools/export.js'

function registerTools(server: McpServer, client: PenpotRpcClient, tools: ToolDefinition<any>[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (input: unknown) => {
        try {
          const parsedInput = tool.inputSchema.parse(input ?? {})
          const result = await tool.handler(client, parsedInput)
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          }
        } catch (err) {
          const message =
            err instanceof PenpotRpcError
              ? `${err.message}`
              : err instanceof Error
                ? err.message
                : 'Unknown error'
          return {
            content: [{ type: 'text', text: message }],
            isError: true,
          }
        }
      },
    )
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const client = new PenpotRpcClient(config.PENPOT_BASE_URL, config.PENPOT_ACCESS_TOKEN)

  const server = new McpServer({
    name: 'penpot-headless',
    version: '0.2.0',
  })

  registerTools(server, client, projectFileTools)
  registerTools(server, client, contentTools(config.PENPOT_TOKENS_PATH))

  // Register penpot_export_shape if any auth mode for the exporter is configured.
  // PENPOT_LOGIN_EMAIL/PASSWORD (password login) takes precedence over
  // PENPOT_AUTH_TOKEN_COOKIE (pre-obtained SSO/OIDC cookie).
  if (config.PENPOT_LOGIN_EMAIL && config.PENPOT_LOGIN_PASSWORD) {
    const exporter = new PenpotExporterClient(config.PENPOT_BASE_URL, {
      mode: 'password',
      email: config.PENPOT_LOGIN_EMAIL,
      password: config.PENPOT_LOGIN_PASSWORD,
    })
    registerExportTool(server, exporter)
  } else if (config.PENPOT_AUTH_TOKEN_COOKIE) {
    const exporter = new PenpotExporterClient(config.PENPOT_BASE_URL, {
      mode: 'cookie',
      authTokenCookie: config.PENPOT_AUTH_TOKEN_COOKIE,
    })
    registerExportTool(server, exporter)
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown error'
  process.stderr.write(`penpot-headless server failed to start: ${message}\n`)
  process.exitCode = 1
})
