export * as Wildcard from "./wildcard"

// Compiled patterns never carry the g or y flag, so the cached regex keeps no lastIndex state.
const compiled = new Map<string, RegExp>()

// A shell removes quoting and backslash escapes before it executes a command, so
// `rm "-rf" /`, `rm '-rf' /` and `rm \-rf /` all run `rm -rf /`. Strip the quoting
// the shell would strip *before* matching, otherwise the strict argument check can
// be defeated by wrapping a flag in quotes.
//
// Backslashes are only unescaped when they escape a shell-special character that
// could hide a flag (or another quote). A Windows path separator is followed by a
// drive/name character (`C:\Windows`), so it is preserved here and normalized by
// `glob`/the caller afterwards.
const SHELL_ESCAPES = new Set(["-", '"', "'", "`", "$", " ", "\\", "(", ")"])

function unquote(value: string) {
  let out = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      out += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "\\" && index + 1 < value.length && SHELL_ESCAPES.has(value[index + 1])) {
      out += value[++index]
      continue
    }
    out += char
  }
  return out
}

function glob(pattern: string, strict: boolean) {
  const cacheKey = (strict ? "strict:" : "glob:") + pattern
  const cached = compiled.get(cacheKey)
  if (cached) return cached
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  // The strict group refuses a flag in any argument position *and* refuses an
  // argument that still contains a shell expansion after unquoting. `cat $FILE`
  // executes against a path the matcher never saw, and `$(echo -rf) /` can expand
  // to flags, so neither may inherit a saved `cat *` grant.
  if (escaped.endsWith(" .*"))
    escaped = escaped.slice(0, -3) + (strict ? "( (?!-)[^\\s$`(){}]*)*" : "( .*)?")

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
 * pattern will not match an argument that starts with `-` (in any position) or
 * that still contains a shell expansion (`$`, backtick, parentheses, braces).
 * A user grant persisted as `rm *` must not silently auto-approve `rm -rf /`,
 * `rm x -rf /`, `rm "-rf" /`, or `cat $FILE`; a fresh prompt is required for
 * flag-bearing or expansion-bearing invocations.
 */
export function matchStrict(input: string, pattern: string) {
  return glob(unquote(pattern), true).test(unquote(input).replaceAll("\\", "/"))
}
