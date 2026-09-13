import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { tmpdir } from "../fixture/fixture"

type WorkerMessage = {
  directory: string
  output: string
  ready?: string
  barrier?: string
  file?: string
  nativeIndexLock?: boolean
  patchAfterIgnore?: boolean
}

type WorkerResult = {
  code: number
  stdout: string
  stderr: string
}

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/snapshot-lock-worker.ts")
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function waitFor(file: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

function runWorker(message: WorkerMessage, env: Record<string, string>) {
  return new Promise<WorkerResult>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify(message)], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout.on("data", (data) => stdout.push(Buffer.from(data)))
    proc.stderr.on("data", (data) => stderr.push(Buffer.from(data)))
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })
    })
  })
}

async function testEnvironment() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-lock-"))
  temporary.push(dir)
  return {
    data: path.join(dir, "data"),
    state: path.join(dir, "state"),
    env: {
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_STATE_HOME: path.join(dir, "state"),
      // snapshot.test.ts temporarily sets GIT_CONFIG_GLOBAL for its own cases;
      // subprocess workers must not inherit that transient process-wide config.
      GIT_CONFIG_GLOBAL: os.devNull,
    },
  }
}

async function gitWrapper(dir: string) {
  const realGit = Bun.which("git")
  if (!realGit) throw new Error("git is required for snapshot tests")
  await fs.mkdir(dir, { recursive: true })
  const wrapper = path.join(dir, "git")
  await Bun.write(
    wrapper,
    `#!/bin/sh
for arg in "$@"; do
  if { [ "$arg" = "add" ] || [ "$arg" = "write-tree" ]; } && [ -n "$SNAPSHOT_TEST_GIT_ACTIVE" ]; then
    if ! (set -C; : > "$SNAPSHOT_TEST_GIT_ACTIVE") 2>/dev/null; then
      printf 'snapshot transaction overlap\\n' >&2
      exit 97
    fi
    trap 'rm -f "$SNAPSHOT_TEST_GIT_ACTIVE"' 0
    sleep 0.05
  fi
  if [ "$arg" = "$SNAPSHOT_TEST_GIT_FAILURE" ] || \\
    { [ "$SNAPSHOT_TEST_GIT_FAILURE" = "write-tree-invalid" ] && [ "$arg" = "write-tree" ]; }; then
    if [ -n "$SNAPSHOT_TEST_GIT_COUNT" ]; then printf '1\\n' >> "$SNAPSHOT_TEST_GIT_COUNT"; fi
    if [ "$SNAPSHOT_TEST_GIT_FAILURE" = "write-tree-invalid" ]; then printf 'not-a-tree\\n'; exit 0; fi
    if [ "$SNAPSHOT_TEST_GIT_FAILURE" = "add-index-lock" ]; then
      for option in "$@"; do
        if [ "$previous" = "--git-dir" ]; then gitdir="$option"; break; fi
        previous="$option"
      done
      printf "fatal: Unable to create '%s/index.lock': File exists.\\n" "$gitdir" >&2
      exit 128
    fi
    printf 'forced %s failure\\n' "$SNAPSHOT_TEST_GIT_FAILURE" >&2
    exit 128
  fi
done
'${realGit}' "$@"
`,
  )
  await fs.chmod(wrapper, 0o755)
  return dir
}

describe("snapshot cross-process git lock", () => {
  test("serializes concurrent track transactions across processes", async () => {
    const repo = await tmpdir({ git: true })
    await using _repo = repo
    const environment = await testEnvironment()
    const wrapper = await gitWrapper(path.join(environment.data, "bin"))
    const active = path.join(environment.data, "active")
    const barrier = path.join(environment.data, "barrier")
    const count = 8
    const workers = Array.from({ length: count }, (_, index) => {
      const output = path.join(environment.data, `output-${index}.json`)
      const ready = path.join(environment.data, `ready-${index}`)
      return {
        output,
        ready,
        run: runWorker(
          { directory: repo.path, output, ready, barrier, file: `worker-${index}.txt` },
          {
            ...environment.env,
            PATH: `${wrapper}${path.delimiter}${process.env.PATH}`,
            SNAPSHOT_TEST_GIT_FAILURE: "",
            SNAPSHOT_TEST_GIT_ACTIVE: active,
          },
        ),
      }
    })
    await Promise.all(workers.map((item) => waitFor(item.ready)))
    await Bun.write(barrier, "go")
    const results = await Promise.all(workers.map((item) => item.run))
    expect(results.map((item) => item.code)).toEqual(Array.from({ length: count }, () => 0))
    expect(results.flatMap((item) => [item.stdout, item.stderr]).join("\n")).not.toContain("snapshot transaction overlap")
    const trees = await Promise.all(workers.map((item) => Bun.file(item.output).json() as Promise<{ first?: string }>))
    expect(trees.map((item) => item.first)).toEqual(trees.map(() => expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)))
  }, 60_000)

  test("returns undefined without deleting an ownership-unknown native index lock", async () => {
    const repo = await tmpdir({ git: true })
    await using _repo = repo
    const environment = await testEnvironment()
    const output = path.join(environment.data, "result.json")
    const result = await runWorker(
      { directory: repo.path, output, nativeIndexLock: true },
      environment.env,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toBe("")
    const snapshot = await Bun.file(output).json() as { first?: string; second?: string; indexLockExists?: boolean }
    expect(snapshot).toMatchObject({
      first: expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      indexLockExists: true,
    })
    expect(snapshot.second).toBeUndefined()
  }, 30_000)

  test.each([
    ["init", "setup"],
    ["add", "stage"],
    ["write-tree", "write-tree"],
    ["write-tree-invalid", "tree-hash"],
  ])("returns undefined when %s fails", async (failure) => {
    const repo = await tmpdir({ git: true })
    await using _repo = repo
    const environment = await testEnvironment()
    const wrapper = await gitWrapper(path.join(environment.data, "bin"))
    const output = path.join(environment.data, "result.json")
    const result = await runWorker(
      { directory: repo.path, output, file: "tracked.txt" },
      {
        ...environment.env,
        PATH: `${wrapper}${path.delimiter}${process.env.PATH}`,
        SNAPSHOT_TEST_GIT_FAILURE: failure,
      },
    )
    expect(result.code, result.stderr).toBe(0)
    expect(await Bun.file(output).json()).toEqual({ first: undefined })
  }, 30_000)

  test("does not publish a patch after dropping ignored files fails", async () => {
    const repo = await tmpdir({ git: true })
    await using _repo = repo
    const environment = await testEnvironment()
    const wrapper = await gitWrapper(path.join(environment.data, "bin"))
    const output = path.join(environment.data, "result.json")
    const result = await runWorker(
      { directory: repo.path, output, file: "tracked.txt", patchAfterIgnore: true },
      {
        ...environment.env,
        PATH: `${wrapper}${path.delimiter}${process.env.PATH}`,
        SNAPSHOT_TEST_GIT_FAILURE: "rm",
      },
    )
    expect(result.code, result.stderr).toBe(0)
    expect(await Bun.file(output).json()).toEqual({
      first: expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      patch: { hash: expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), files: [] },
    })
  }, 30_000)

  test("does not retry unrelated Git failures", async () => {
    const repo = await tmpdir({ git: true })
    await using _repo = repo
    const environment = await testEnvironment()
    const wrapper = await gitWrapper(path.join(environment.data, "bin"))
    const count = path.join(environment.data, "count")
    const output = path.join(environment.data, "result.json")
    const result = await runWorker(
      { directory: repo.path, output, file: "tracked.txt" },
      {
        ...environment.env,
        PATH: `${wrapper}${path.delimiter}${process.env.PATH}`,
        SNAPSHOT_TEST_GIT_FAILURE: "add",
        SNAPSHOT_TEST_GIT_COUNT: count,
      },
    )
    expect(result.code, result.stderr).toBe(0)
    expect((await Bun.file(count).text()).trim().split("\n")).toHaveLength(1)
    expect(await Bun.file(output).json()).toEqual({ first: undefined })
  }, 30_000)
})
