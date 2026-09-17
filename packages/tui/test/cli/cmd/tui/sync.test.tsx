/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("session.deleted prunes every session-keyed slice", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    const pruneSessionID = "ses_prune"
    const pruneMessageID = "msg_prune"
    const prunePartID = "prt_prune"
    const info = {
      id: pruneSessionID,
      slug: pruneSessionID,
      projectID: "project",
      directory: "/tmp/opencode/packages/tui",
      title: "prune",
      version: "1.15.13",
      time: { created: 0, updated: 0 },
    }
    const message = {
      id: pruneMessageID,
      sessionID: pruneSessionID,
      role: "user" as const,
      agent: "build",
      model: { providerID: "test", modelID: "model" },
      time: { created: 0 },
    }

    try {
      emit(
        global({ id: "evt_prune_session", type: "session.updated", properties: { sessionID: pruneSessionID, info } }),
      )
      emit(
        global({
          id: "evt_prune_message",
          type: "message.updated",
          properties: { sessionID: pruneSessionID, info: message },
        }),
      )
      emit(
        global({
          id: "evt_prune_part",
          type: "message.part.updated",
          properties: {
            sessionID: pruneSessionID,
            time: 1,
            part: { id: prunePartID, sessionID: pruneSessionID, messageID: pruneMessageID, type: "text", text: "hi" },
          },
        }),
      )
      emit(global({ id: "evt_prune_todo", type: "todo.updated", properties: { sessionID: pruneSessionID, todos: [] } }))
      emit(global({ id: "evt_prune_diff", type: "session.diff", properties: { sessionID: pruneSessionID, diff: [] } }))

      await wait(
        () =>
          sync.data.message[pruneSessionID] !== undefined &&
          sync.data.part[pruneMessageID] !== undefined &&
          sync.data.todo[pruneSessionID] !== undefined &&
          sync.data.session_diff[pruneSessionID] !== undefined,
      )

      emit(
        global({ id: "evt_prune_deleted", type: "session.deleted", properties: { sessionID: pruneSessionID, info } }),
      )

      await wait(() => sync.data.message[pruneSessionID] === undefined)
      expect(sync.data.message[pruneSessionID]).toBeUndefined()
      expect(sync.data.part[pruneMessageID]).toBeUndefined()
      expect(sync.data.todo[pruneSessionID]).toBeUndefined()
      expect(sync.data.session_diff[pruneSessionID]).toBeUndefined()
      expect(sync.data.session.some((item) => item.id === pruneSessionID)).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })
})
