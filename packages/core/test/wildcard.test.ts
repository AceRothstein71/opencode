import { describe, expect, test } from "bun:test"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

describe("Wildcard.match", () => {
  test("matches exact patterns", () => {
    expect(Wildcard.match("bash", "bash")).toBe(true)
    expect(Wildcard.match("bash", "edit")).toBe(false)
  })

  test("supports star and question wildcards", () => {
    expect(Wildcard.match("git status", "git *")).toBe(true)
    expect(Wildcard.match("git status", "git st?tus")).toBe(true)
    expect(Wildcard.match("git status", "git ?tatu")).toBe(false)
  })

  test("treats backslashes as path separators", () => {
    expect(Wildcard.match("src\\index.ts", "src/index.ts")).toBe(true)
    expect(Wildcard.match("src/index.ts", "src\\index.ts")).toBe(true)
  })

  test("escapes regex metacharacters in patterns", () => {
    expect(Wildcard.match("file.txt", "file.txt")).toBe(true)
    expect(Wildcard.match("fileXtxt", "file.txt")).toBe(false)
    expect(Wildcard.match("a+b", "a+b")).toBe(true)
  })

  test("caches compiled patterns without changing results", () => {
    const pattern = "packages/*/src/*.ts"
    const first = Wildcard.match("packages/core/src/index.ts", pattern)
    const second = Wildcard.match("packages/core/src/index.ts", pattern)
    const mismatch = Wildcard.match("packages/core/test/index.ts", pattern)
    expect(first).toBe(true)
    expect(second).toBe(first)
    expect(mismatch).toBe(false)
  })
})
