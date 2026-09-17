import { describe, expect, test } from "bun:test"
import { frame, join } from "../../src/server/routes/instance/httpapi/handlers/sse-frame"

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe("SSE frame encoding", () => {
  test("renders an id line and caches identical frames per key", () => {
    const first = frame("evt_cache_a", "evt_cache_a", {
      id: "evt_cache_a",
      type: "server.connected",
      properties: {},
    })
    expect(decode(first)).toBe(
      'id: evt_cache_a\ndata: {"id":"evt_cache_a","type":"server.connected","properties":{}}\n\n',
    )
    expect(frame("evt_cache_a", "evt_cache_a", { id: "evt_cache_a", type: "server.connected", properties: {} })).toBe(
      first,
    )
  })

  test("omits the id line when the event has no id", () => {
    expect(decode(frame("evt_no_id", undefined, { type: "server.heartbeat", properties: {} }))).toBe(
      'data: {"type":"server.heartbeat","properties":{}}\n\n',
    )
  })

  test("joins a batch into one buffer without changing the wire bytes", () => {
    const one = frame("evt_batch_1", "evt_batch_1", { id: "evt_batch_1", type: "a", properties: {} })
    const two = frame("evt_batch_2", "evt_batch_2", { id: "evt_batch_2", type: "b", properties: {} })
    const merged = join([one, two])
    expect(merged.byteLength).toBe(one.byteLength + two.byteLength)
    expect(Array.from(merged)).toEqual([...one, ...two])
    expect(join([one])).toBe(one)
  })
})
