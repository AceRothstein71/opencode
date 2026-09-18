import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  // Lexical containment is not enough: a symlink inside the worktree can point
  // outside it (e.g. `vendor/x -> /etc`). Require both the lexical path and its
  // symlink-resolved target to stay inside before skipping the prompt.
  const resolved = FSUtil.resolveExisting(full)
  if (containsPath(full, ins) && containsPath(resolved, ins)) return false

  // Prompt and persist the glob on the *resolved* target, not the lexical path.
  // The approval cache matches request patterns against the saved glob, so keying
  // it lexically would let a later symlink swap (`vendor -> /etc`) reuse a `vendor/*`
  // grant on `/etc/*` without re-prompting.
  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? resolved : path.dirname(resolved)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: resolved,
      parentDir: dir,
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}
