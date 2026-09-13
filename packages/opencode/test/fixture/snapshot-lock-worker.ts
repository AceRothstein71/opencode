import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Snapshot } from "../../src/snapshot"
import { InstanceStore } from "../../src/project/instance-store"
import { provideInstance, testInstanceStoreLayer } from "./fixture"

type Message = {
  directory: string
  output: string
  ready?: string
  barrier?: string
  file?: string
  nativeIndexLock?: boolean
  patchAfterIgnore?: boolean
}

const message: Message = JSON.parse(process.argv[2] ?? "{}")

async function waitFor(file: string) {
  for (;;) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(10)
  }
}

async function snapshotGitdir() {
  const root = path.join(process.env.XDG_DATA_HOME!, "opencode", "snapshot")
  const projects = await fs.readdir(root)
  const directories = await Promise.all(
    projects.map(async (project) => {
      const children = await fs.readdir(path.join(root, project))
      return children.map((child) => path.join(root, project, child))
    }),
  )
  const gitdir = directories.flat().at(0)
  if (!gitdir) throw new Error("snapshot git directory was not created")
  return gitdir
}

const layer = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])),
  testInstanceStoreLayer,
)

const result = await Effect.runPromise(
  Effect.gen(function* () {
    if (message.file) yield* Effect.promise(() => fs.writeFile(path.join(message.directory, message.file!), process.pid.toString()))
    if (message.ready) yield* Effect.promise(() => fs.writeFile(message.ready!, process.pid.toString()))
    if (message.barrier) yield* Effect.promise(() => waitFor(message.barrier!))

    const snapshot = yield* Snapshot.Service
    const first = yield* snapshot.track()
    if (message.patchAfterIgnore) {
      yield* Effect.promise(() => fs.writeFile(path.join(message.directory, "tracked.txt"), "changed"))
      yield* Effect.promise(() => fs.writeFile(path.join(message.directory, ".gitignore"), "tracked.txt\n"))
      const patch = yield* snapshot.patch(first ?? "missing")
      return { first, patch }
    }
    if (!message.nativeIndexLock) return { first }

    const gitdir = yield* Effect.promise(snapshotGitdir)
    yield* Effect.promise(() => fs.writeFile(path.join(message.directory, "changed.txt"), "changed"))
    yield* Effect.promise(() => fs.writeFile(path.join(gitdir, "index.lock"), ""))
    const second = yield* snapshot.track()
    return {
      first,
      second,
      indexLockExists: yield* Effect.promise(() => Bun.file(path.join(gitdir, "index.lock")).exists()),
    }
  }).pipe(provideInstance(message.directory), Effect.provide(layer)),
)

await fs.writeFile(message.output, JSON.stringify(result))
