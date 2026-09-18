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

  const invalidSchemaKeywords = (schema: unknown) => {
    const invalid: string[] = []
    const walk = (value: unknown, path: string) => {
      if (value === null || typeof value !== "object") return
      if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`))
      const entries = value as Record<string, unknown>
      if ("required" in entries && !Array.isArray(entries.required)) invalid.push(`${path}.required`)
      if ("properties" in entries && (typeof entries.properties !== "object" || Array.isArray(entries.properties)))
        invalid.push(`${path}.properties`)
      for (const keyword of ["anyOf", "oneOf", "allOf", "enum"]) {
        const members = entries[keyword]
        if (Array.isArray(members) && members.length === 0) invalid.push(`${path}.${keyword}`)
      }
      Object.entries(entries).forEach(([key, item]) => walk(item, `${path}.${key}`))
    }
    walk(schema, "schema")
    return invalid
  }

  const emitted = (inputSchema: unknown) => {
    const tool = mcpTool()
    tool.inputSchema = inputSchema
    return asSchema(
      McpCatalog.convertTool(tool, clientReturning({ content: [], structuredContent: {} })).inputSchema!,
    ).jsonSchema as Record<string, unknown>
  }

  test("drops over-budget subtrees instead of emitting invalid JSON Schema keywords", () => {
    const node = (depth: number): Record<string, unknown> =>
      depth === 0
        ? { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
        : {
            type: "object",
            properties: { name: { type: "string" }, children: { type: "array", items: node(depth - 1) } },
            required: ["name"],
          }

    expect(invalidSchemaKeywords(emitted({ type: "object", properties: { data: node(6) }, required: ["data"] }))).toEqual(
      [],
    )
  })

  test("never emits empty anyOf/oneOf/allOf/enum at the depth or node budget boundary", () => {
    const union = { anyOf: [{ type: "string" }, { type: "number" }] }
    let depthSchema: Record<string, unknown> = union
    for (let index = 0; index < 5; index++) depthSchema = { items: depthSchema }

    const props: Record<string, unknown> = {}
    for (let index = 0; index < 496; index++) props[`p${index}`] = { type: "string" }
    props.zzz_enum = { enum: [{ deep: { type: "string" } }, { deep: { type: "string" } }] }
    props.zzz_union = union

    expect(invalidSchemaKeywords(emitted({ type: "object", properties: { k: depthSchema } }))).toEqual([])
    expect(invalidSchemaKeywords(emitted({ type: "object", properties: props }))).toEqual([])
  })

  test("keeps a cyclic tool callable by dropping required entries whose property was pruned", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: { kept: { type: "string" } } }
    cyclic.properties = { kept: { type: "string" }, self: cyclic }
    cyclic.required = ["kept", "self"]

    const schema = emitted(cyclic)

    expect(schema.required).toEqual(["kept"])
    expect(invalidSchemaKeywords(schema)).toEqual([])
  })

  test("drops a fully pruned required list rather than emitting an unsatisfiable tool", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} }
    cyclic.properties = { self: cyclic }
    cyclic.required = ["self"]

    const schema = emitted(cyclic)

    expect(schema.required).toBeUndefined()
    expect(schema.additionalProperties).toBe(false)
  })

  test("normalizes draft-07 tuple items to a single schema", () => {
    const schema = emitted({
      type: "object",
      properties: { k: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    })

    expect(schema.properties).toMatchObject({ k: { type: "array", items: {} } })
    expect(invalidSchemaKeywords(schema)).toEqual([])
  })

  test("does not throw on a null input schema", () => {
    const tool = mcpTool()
    tool.inputSchema = null

    expect(() =>
      McpCatalog.convertTool(tool, clientReturning({ content: [], structuredContent: {} })),
    ).not.toThrow()
  })
})
