import * as Sse from "effect/unstable/encoding/Sse"

// SSE frames for a single event are byte-identical for every client receiving
// it, so serialize and encode once and share the immutable bytes across sockets.
// Keyed by a caller-supplied stable identity (event id, or id + payload type);
// bounded so a long-lived process cannot retain every frame it ever emitted.
const encoder = new TextEncoder()
const frames = new Map<string, Uint8Array>()
const FRAME_CACHE_LIMIT = 512
// A frame holds a full serialized event (tool output, base64 attachment), so
// bounding entry count alone still allows hundreds of megabytes to be retained.
const FRAME_CACHE_MAX_BYTES = 8 * 1024 * 1024
// Frames larger than this are unique-enough payloads that caching them only
// evicts frames which genuinely repeat across clients.
const FRAME_CACHE_MAX_FRAME_BYTES = 256 * 1024
let framesBytes = 0
// Per-connection frames carry a freshly minted id, so caching them only churns
// the FIFO and evicts frames that genuinely repeat across clients.
const TRANSIENT_EVENT_TYPES = new Set(["server.connected", "server.heartbeat", "server.desync"])

export function isTransientEvent(type: string) {
  return TRANSIENT_EVENT_TYPES.has(type)
}

/** Drops retained frames so serialized payloads cannot outlive the instance that produced them. */
export function clearFrameCache() {
  frames.clear()
  framesBytes = 0
}

export function frame(key: string, id: string | undefined, payload: unknown, cache = true): Uint8Array {
  if (cache) {
    const cached = frames.get(key)
    if (cached) return cached
  }
  const bytes = encoder.encode(
    Sse.encoder.write({ _tag: "Event", event: "message", id, data: JSON.stringify(payload) }),
  )
  if (cache && bytes.byteLength <= FRAME_CACHE_MAX_FRAME_BYTES) {
    while (frames.size >= FRAME_CACHE_LIMIT || framesBytes + bytes.byteLength > FRAME_CACHE_MAX_BYTES) {
      const oldest = frames.keys().next()
      if (oldest.done) break
      framesBytes -= frames.get(oldest.value)?.byteLength ?? 0
      frames.delete(oldest.value)
    }
    frames.set(key, bytes)
    framesBytes += bytes.byteLength
  }
  return bytes
}

// The HTTP writer emits one syscall per stream element, so collapse a drained
// batch of frames into a single buffer: concatenated SSE frames are byte-identical
// to writing them individually (every frame already ends in a blank line).
export function join(batch: ReadonlyArray<Uint8Array>): Uint8Array {
  if (batch.length <= 1) return batch[0] ?? new Uint8Array(0)
  let total = 0
  for (const chunk of batch) total += chunk.byteLength
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of batch) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}
