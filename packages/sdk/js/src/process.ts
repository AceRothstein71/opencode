import { type ChildProcess, spawnSync } from "node:child_process"

// Duplicated from `packages/opencode/src/util/process.ts` because the SDK cannot
// import `opencode` without creating a cycle (`opencode` depends on `@opencode-ai/sdk`).
const STOP_ESCALATE_MS = 2_000
const STOP_FINAL_WAIT_MS = 5_000

export async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  if (process.platform === "win32" && proc.pid) {
    const out = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true })
    if (!out.error && out.status === 0) return
    proc.kill()
    return
  }

  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()))
  proc.kill("SIGTERM")
  const escalate = setTimeout(() => {
    try {
      proc.kill("SIGKILL")
    } catch {}
  }, STOP_ESCALATE_MS)
  let finalWait: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      finalWait = setTimeout(resolve, STOP_FINAL_WAIT_MS)
    }),
  ])
  clearTimeout(escalate)
  if (finalWait) clearTimeout(finalWait)
}

export function bindAbort(proc: ChildProcess, signal?: AbortSignal, onAbort?: () => void) {
  if (!signal) return () => {}
  const abort = () => {
    clear()
    void stop(proc)
    onAbort?.()
  }
  const clear = () => {
    signal.removeEventListener("abort", abort)
    proc.off("exit", clear)
    proc.off("error", clear)
  }
  if (proc.exitCode !== null || proc.signalCode !== null) return clear
  signal.addEventListener("abort", abort, { once: true })
  proc.on("exit", clear)
  proc.on("error", clear)
  if (signal.aborted) abort()
  return clear
}
