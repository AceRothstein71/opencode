export * as Wildcard from "./wildcard"

// Compiled patterns never carry the g or y flag, so the cached regex keeps no lastIndex state.
const compiled = new Map<string, RegExp>()

function glob(pattern: string, strict: boolean) {
  const cacheKey = (strict ? "strict:" : "glob:") + pattern
  const cached = compiled.get(cacheKey)
  if (cached) return cached
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + (strict ? "( (?!-)\\S*)*" : "( .*)?")

  const expression = new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s")
  if (compiled.size >= 512) {
    const oldest = compiled.keys().next()
    if (!oldest.done) compiled.delete(oldest.value)
  }
  compiled.set(cacheKey, expression)
  return expression
}

export function match(input: string, pattern: string) {
  return glob(pattern, false).test(input.replaceAll("\\", "/"))
}

/**
 * Like `match`, but the optional trailing argument group of a `"cmd *"`
 * pattern will not match an argument that starts with `-`, in any position.
 * A user grant persisted as `rm *` must not silently auto-approve
 * `rm -rf /` or `rm x -rf /`; a fresh prompt is required for flag-bearing
 * invocations.
 */
export function matchStrict(input: string, pattern: string) {
  return glob(pattern, true).test(input.replaceAll("\\", "/"))
}
