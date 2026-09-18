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

  test("matchStrict refuses flag-bearing trailing arguments", () => {
    expect(Wildcard.matchStrict("rm -rf /", "rm *")).toBe(false)
    expect(Wildcard.matchStrict("ls -la", "ls *")).toBe(false)
    expect(Wildcard.matchStrict("rm file.txt", "rm *")).toBe(true)
    expect(Wildcard.matchStrict("rm", "rm *")).toBe(true)
    expect(Wildcard.matchStrict("src/foo.ts", "src/*")).toBe(true)
  })

  test("matchStrict refuses flags in any argument position", () => {
    expect(Wildcard.matchStrict("rm x -rf /", "rm *")).toBe(false)
    expect(Wildcard.matchStrict("git push origin --force", "git push *")).toBe(false)
    expect(Wildcard.matchStrict("chmod 777 /etc -R", "chmod *")).toBe(false)
    expect(Wildcard.matchStrict("git push origin main", "git push *")).toBe(true)
    expect(Wildcard.matchStrict("chmod 777 /etc", "chmod *")).toBe(true)
  })

  test("matchStrict refuses pathname globs from inheriting a literal grant", () => {
    expect(Wildcard.matchStrict("cat */../../../../etc/passwd", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat ?/etc/passwd", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat [a]/etc/passwd", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat a*/../../etc/passwd", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("rm *", "rm *")).toBe(false)
    expect(Wildcard.matchStrict("cat foo.txt", "cat *")).toBe(true)
    expect(Wildcard.matchStrict("rm file.txt", "rm *")).toBe(true)
  })

  test("matchStrict treats file-path patterns verbatim", () => {
    expect(Wildcard.matchStrict("src/foo.ts", "src/*")).toBe(true)
    expect(Wildcard.matchStrict('my"file.txt', "myfile.txt")).toBe(false)
    expect(Wildcard.matchStrict("myfile.txt", "myfile.txt")).toBe(true)
  })

  test("matchStrict refuses tilde-user and traversal expansions", () => {
    expect(Wildcard.matchStrict("cat ~root/.ssh/id_rsa", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat ~+/etc/passwd", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat ~-/etc/passwd", "cat *")).toBe(false)
    expect(Wildcard.matchStrict('cat "~root/.ssh/id_rsa"', "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat link/../etc/passwd", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat ../sibling/file.txt", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat a/..", "cat *")).toBe(false)

    expect(Wildcard.matchStrict("cat ~/notes.txt", "cat *")).toBe(true)
    expect(Wildcard.matchStrict("cat ~", "cat *")).toBe(true)
    expect(Wildcard.matchStrict("cat ..hidden", "cat *")).toBe(true)
    expect(Wildcard.matchStrict("cat foo.txt", "cat *")).toBe(true)
  })

  test("matchStrict refuses backslash-escaped traversal", () => {
    expect(Wildcard.matchStrict("cat \\.\\./etc/passwd", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat \\.\\./\\.\\./etc/passwd", "cat *")).toBe(false)
    expect(Wildcard.matchStrict("cat \\../etc/passwd", "cat *")).toBe(false)
    // An escaped dot that does not form `..` is an ordinary hidden path.
    expect(Wildcard.matchStrict("cat \\.hidden", "cat *")).toBe(true)
  })

  test("matchStrict leaves file-path grants unaffected by traversal guards", () => {
    expect(Wildcard.matchStrict("../sibling/file.txt", "../sibling/*")).toBe(true)
    expect(Wildcard.matchStrict("./nested/file.txt", "./nested/*")).toBe(true)
  })
})
