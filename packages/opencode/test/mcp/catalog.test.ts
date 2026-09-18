import { describe, expect, test } from "bun:test"
import { asSchema } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content, structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content: [], structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

describe("McpCatalog.assignToolNames", () => {
  test("gives colliding sanitized names distinct keys", () => {
    const names = McpCatalog.assignToolNames([
      { clientName: "a.b", name: "x" },
      { clientName: "a_b", name: "x" },
      { clientName: "a b", name: "x" },
    ])

    const assigned = [...names.values()].map((perServer) => perServer.get("x"))
    expect(new Set(assigned).size).toBe(3)
    expect(assigned[0]).toBe("a_b_x")
  })

  test("keeps distinct raw names distinct within one server", () => {
    const names = McpCatalog.assignToolNames([
      { clientName: "srv", name: "a.b" },
      { clientName: "srv", name: "a_b" },
    ])

    const byName = names.get("srv")!
    expect(byName.get("a.b")).toBe("srv_a_b")
    expect(byName.get("a_b")).toBeDefined()
    expect(byName.get("a_b")).not.toBe("srv_a_b")
  })
})

describe("McpCatalog.convertTool bounds untrusted server input", () => {
  test("prefixes the description with the server name and caps its length", () => {
    const tool = McpCatalog.convertTool(
      { ...mcpTool(), description: "x".repeat(10_000) },
      clientReturning({ content: [], structuredContent: {} }),
      undefined,
      "my-server",
    )

    expect(tool.description?.startsWith("[my-server] ")).toBe(true)
    expect(tool.description?.length).toBeLessThan(5_000)
  })

  test("does not recurse forever on a deeply nested input schema", () => {
    let schema: Record<string, unknown> = { type: "string" }
    for (let index = 0; index < 200; index++) schema = { type: "object", properties: { nested: schema } }

    const deep = mcpTool()
    deep.inputSchema = schema

    expect(() => McpCatalog.convertTool(deep, clientReturning({ content: [], structuredContent: {} }))).not.toThrow()
  })

  test("drops over-budget subtrees instead of emitting invalid JSON Schema keywords", () => {
    const node = (depth: number): Record<string, unknown> =>
      depth === 0
        ? { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
        : {
            type: "object",
            properties: { name: { type: "string" }, children: { type: "array", items: node(depth - 1) } },
            required: ["name"],
          }

    const deep = mcpTool()
    deep.inputSchema = { type: "object", properties: { data: node(6) }, required: ["data"] }

    const tool = McpCatalog.convertTool(deep, clientReturning({ content: [], structuredContent: {} }))
    const schema = asSchema(tool.inputSchema!).jsonSchema as Record<string, unknown>

    const invalid: string[] = []
    const walk = (value: unknown, path: string) => {
      if (value === null || typeof value !== "object") return
      if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`))
      const entries = value as Record<string, unknown>
      if ("required" in entries && !Array.isArray(entries.required)) invalid.push(`${path}.required`)
      if ("properties" in entries && (typeof entries.properties !== "object" || Array.isArray(entries.properties)))
        invalid.push(`${path}.properties`)
      Object.entries(entries).forEach(([key, item]) => walk(item, `${path}.${key}`))
    }
    walk(schema, "schema")

    expect(invalid).toEqual([])
  })
})
