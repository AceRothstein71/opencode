const ROLE_ASSISTANT = /"role"\s*:\s*""/g

export function rewriteSnowflakeRole(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { done, value } = await reader.read()
      if (done) {
        ctrl.close()
        return
      }
      const text = decoder.decode(value, { stream: true })
      ctrl.enqueue(encoder.encode(text.includes('"role"') ? text.replace(ROLE_ASSISTANT, '"role":"assistant"') : text))
    },
    cancel() {
      reader.cancel()
    },
  })
}

export * as Snowflake from "./snowflake"
