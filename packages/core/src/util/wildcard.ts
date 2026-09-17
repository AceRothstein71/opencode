export * as Wildcard from "./wildcard"

// Compiled patterns never carry the g or y flag, so the cached regex keeps no lastIndex state.
const compiled = new Map<string, RegExp>()

function glob(pattern: string) {
  const cached = compiled.get(pattern)
  if (cached) return cached
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  const expression = new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s")
  if (compiled.size >= 512) {
    const oldest = compiled.keys().next()
    if (!oldest.done) compiled.delete(oldest.value)
  }
  compiled.set(pattern, expression)
  return expression
}

export function match(input: string, pattern: string) {
  return glob(pattern).test(input.replaceAll("\\", "/"))
}
