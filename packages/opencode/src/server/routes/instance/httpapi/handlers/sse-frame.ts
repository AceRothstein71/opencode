import * as Sse from "effect/unstable/encoding/Sse"

// SSE frames for a single event are byte-identical for every client receiving
// it, so serialize and encode once and share the immutable bytes across sockets.
// Keyed by a caller-supplied stable identity (event id, or id + payload type);
// bounded so a long-lived process cannot retain every frame it ever emitted.
const encoder = new TextEncoder()
const frames = new Map<string, Uint8Array>()
const FRAME_CACHE_LIMIT = 512

export function frame(key: string, id: string | undefined, payload: unknown): Uint8Array {
  const cached = frames.get(key)
  if (cached) return cached
  const bytes = encoder.encode(
    Sse.encoder.write({ _tag: "Event", event: "message", id, data: JSON.stringify(payload) }),
  )
  if (frames.size >= FRAME_CACHE_LIMIT) {
    const oldest = frames.keys().next()
    if (!oldest.done) frames.delete(oldest.value)
  }
  frames.set(key, bytes)
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
