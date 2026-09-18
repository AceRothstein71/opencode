import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import type * as SDK from "@opencode-ai/sdk/v2"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Exit, Layer, Option, Schema, Scope, Context, Cause } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Account } from "@/account/account"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { Config } from "@/config/config"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2 } from "@opencode-ai/core/event"

const disabled = process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"

// A failed sync keeps its entries queued and retries a bounded number of times with a
// growing delay; after that the next event-driven flush picks the batch back up.
const MAX_FLUSH_ATTEMPTS = 3
const FLUSH_RETRY_DELAY = 1000

// A share sync POST must fit the enterprise server's 2000-item `data` cap, and a
// stalled endpoint must not grow the per-session queue without bound (O-16/O-28).
const SHARE_REQUEST_TIMEOUT = "15 seconds"
const MAX_QUEUE_ITEMS = 2_000
const FULL_PAGE_SIZE = 50

export function trimQueue<T>(queue: Map<string, T>) {
  const over = queue.size - MAX_QUEUE_ITEMS
  if (over <= 0) return 0
  // `full()` inserts pages newest-first, so insertion order is not chronological. Order
  // part keys by their message id (ascending for both live and full syncs) and drop the
  // oldest; the insertion index breaks ties within one message.
  const parts: Array<{ key: string; message: string; index: number }> = []
  let index = 0
  for (const key of queue.keys()) {
    if (key.startsWith("part/")) parts.push({ key, message: key.split("/")[1] ?? "", index })
    index++
  }
  parts.sort((a, b) => (a.message === b.message ? a.index - b.index : a.message < b.message ? -1 : 1))
  let dropped = 0
  for (const part of parts) {
    if (dropped >= over) break
    queue.delete(part.key)
    dropped++
  }
  // Fewer part keys than the overflow: fall back to the oldest remaining keys, while
  // session/message/diff/model keys (which self-overwrite) are kept whenever possible.
  for (const key of queue.keys()) {
    if (dropped >= over) break
    queue.delete(key)
    dropped++
  }
  return dropped
}

// A negative share lookup is cached only briefly: another process can create a share
// out-of-band, and a permanent null would hide it forever (F-119).
const NEGATIVE_CACHE_TTL = 30_000

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

const ShareSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
})
export type Share = typeof ShareSchema.Type

type State = {
  queue: Map<SessionID, Map<string, Data>>
  inflight: Set<SessionID>
  scheduled: Set<SessionID>
  scope: Scope.Closeable
  shared: Map<SessionID, Share>
  misses: Map<SessionID, number>
}

type Data =
  | {
      type: "session"
      data: SDK.Session
    }
  | {
      type: "message"
      data: SDK.Message
    }
  | {
      type: "part"
      data: SDK.Part
    }
  | {
      type: "session_diff"
      data: SDK.SnapshotFileDiff[]
    }
  | {
      type: "model"
      data: SDK.Model[]
    }

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")

function key(item: Data) {
  switch (item.type) {
    case "session":
      return "session"
    case "message":
      return `message/${item.data.id}`
    case "part":
      return `part/${item.data.messageID}/${item.data.id}`
    case "session_diff":
      return "session_diff"
    case "model":
      return "model"
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const events = yield* EventV2Bridge.Service
    const cfg = yield* Config.Service
    const database = yield* Database.Service
    const { db } = database
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const provider = yield* Provider.Service
    const session = yield* Session.Service

    function sync(sessionID: SessionID, data: Data[]) {
      return Effect.gen(function* () {
        if (disabled) return
        const share = yield* getCached(sessionID)
        if (!share) return

        const s = yield* InstanceState.get(state)
        const existing = s.queue.get(sessionID)
        if (existing) {
          for (const item of data) {
            const k = key(item)
            const prev = existing.get(k)
            // Ordering: MessageUpdated and MessageDiffUpdated listeners can run in either
            // order for publishes from the same tick, so a plain user message must not
            // drop diffs already queued for it by the diff event.
            if (
              item.type === "message" &&
              item.data.role === "user" &&
              !item.data.summary &&
              prev?.type === "message" &&
              prev.data.role === "user" &&
              prev.data.summary
            ) {
              existing.set(k, { ...item, data: { ...item.data, summary: prev.data.summary } })
              continue
            }
            existing.set(k, item)
          }
        } else {
          s.queue.set(sessionID, new Map(data.map((item) => [key(item), item])))
        }

        const queued = s.queue.get(sessionID)
        if (queued) {
          const dropped = trimQueue(queued)
          if (dropped > 0) yield* Effect.logWarning("share queue capped", { sessionID: sessionID, dropped: dropped })
        }

        // One delayed flush per session; while one is scheduled or in flight the batch
        // is only merged so a stalled/failed POST cannot race a second one.
        if (s.scheduled.has(sessionID)) return
        s.scheduled.add(sessionID)
        yield* flush(sessionID).pipe(
          Effect.delay(1000),
          Effect.catchCause((cause) => Effect.logError("share flush failed", { sessionID: sessionID, cause: cause })),
          Effect.forkIn(s.scope),
        )
      })
    }

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* (_ctx) {
        const cache: State = {
          queue: new Map(),
          inflight: new Set(),
          scheduled: new Set(),
          scope: yield* Scope.make(),
          shared: new Map(),
          misses: new Map(),
        }

        yield* Effect.addFinalizer(() =>
          Scope.close(cache.scope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                cache.queue.clear()
                cache.inflight.clear()
                cache.scheduled.clear()
                cache.shared.clear()
                cache.misses.clear()
              }),
            ),
          ),
        )

        if (disabled) return cache
        // Config-disabled servers must not register the watchers either, or every event
        // pays the share gate forever.
        const conf = yield* cfg.get()
        if (conf.share === "disabled") return cache

        const unsubscribes: Array<Effect.Effect<void>> = []
        const watch = <D extends EventV2.Definition>(
          def: D,
          fn: (data: EventV2.Data<D>) => Effect.Effect<void, unknown>,
        ) =>
          Effect.gen(function* () {
            const unsubscribe = yield* events.listen((event) => {
              if (event.type !== def.type || event.location?.directory !== _ctx.directory) return Effect.void
              return fn(event.data as EventV2.Data<D>).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("share subscriber failed", { type: def.type, cause: cause }),
                ),
              )
            })
            unsubscribes.push(unsubscribe)
          })

        yield* watch(Session.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            const share = yield* getCached(info.id)
            if (!share) return
            yield* sync(info.id, [{ type: "session", data: structuredClone(info) as SDK.Session }])
          }),
        )
        yield* watch(MessageV2.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            const share = yield* getCached(info.sessionID)
            if (!share) return
            yield* sync(info.sessionID, [{ type: "message", data: structuredClone(info) as SDK.Message }])
            if (info.role !== "user") return
            // Provider lookup can stall on cold caches, and the event publish awaits every
            // listener, so keep it off the listener to leave event dispatch unblocked.
            const s = yield* InstanceState.get(state)
            yield* Effect.gen(function* () {
              const model = yield* provider.getModel(info.model.providerID, info.model.modelID)
              yield* sync(info.sessionID, [{ type: "model", data: [model] }])
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("share model sync failed", { sessionID: info.sessionID, cause: cause }),
              ),
              Effect.forkIn(s.scope),
            )
          }),
        )
        yield* watch(Session.Event.MessageDiffUpdated, (data) =>
          Effect.gen(function* () {
            // The publish path runs listeners inline, so avoid the hydrated list read
            // unless this session is actually being shared.
            const share = yield* getCached(data.sessionID)
            if (!share) return
            const message = yield* MessageV2.get({ sessionID: data.sessionID, messageID: data.messageID }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!message) return
            // The event carries the diffs this publish produced, while the projector may
            // not have persisted them yet on this inline path, so overlay them here
            // instead of relying on the hydrated read to include them.
            const info =
              message.info.role === "user" && data.diffs
                ? { ...message.info, summary: { ...message.info.summary, diffs: data.diffs } }
                : message.info
            yield* sync(info.sessionID, [{ type: "message", data: structuredClone(info) as SDK.Message }])
          }),
        )
        yield* watch(MessageV2.Event.PartUpdated, (data) =>
          Effect.gen(function* () {
            const share = yield* getCached(data.part.sessionID)
            if (!share) return
            yield* sync(data.part.sessionID, [{ type: "part", data: structuredClone(data.part) as SDK.Part }])
          }),
        )
        yield* watch(Session.Event.Diff, (data) =>
          Effect.gen(function* () {
            const share = yield* getCached(data.sessionID)
            if (!share) return
            yield* sync(data.sessionID, [
              { type: "session_diff", data: structuredClone(data.diff) as SDK.SnapshotFileDiff[] },
            ])
          }),
        )
        yield* watch(Session.Event.Deleted, (data) => remove(data.sessionID))

        // These listeners live in a process-global array; release them on instance
        // dispose so a reload cannot leave stale listeners matching the same directory.
        yield* Effect.addFinalizer(() => Effect.forEach(unsubscribes, (unsubscribe) => unsubscribe, { discard: true }))

        return cache
      }),
    )

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        const baseUrl = (yield* cfg.get()).enterprise?.url ?? "https://opncd.ai"
        return { headers, api: legacyApi, baseUrl } satisfies Req
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        throw new Error("No active account token available for sharing")
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: consoleApi, baseUrl: active.value.url } satisfies Req
    })

    const get = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { id: row.id, secret: row.secret, url: row.url } satisfies Share
    })

    const getCached = Effect.fnUntraced(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      const cached = s.shared.get(sessionID)
      if (cached) return cached
      const missAt = s.misses.get(sessionID)
      if (missAt !== undefined && Date.now() - missAt < NEGATIVE_CACHE_TTL) return undefined

      const share = yield* get(sessionID)
      if (!share) {
        s.misses.set(sessionID, Date.now())
        return undefined
      }
      s.shared.set(sessionID, share)
      s.misses.delete(sessionID)
      return share
    })

    const drain = (sessionID: SessionID, s: State) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < MAX_FLUSH_ATTEMPTS; attempt++) {
          const share = yield* getCached(sessionID)
          if (!share) {
            s.queue.delete(sessionID)
            return
          }
          const queued = s.queue.get(sessionID)
          if (!queued || queued.size === 0) return

          // Snapshot without deleting: entries queued while this POST is in flight must
          // survive and be sent by a later iteration.
          const sent = Array.from(queued.entries())
          const req = yield* request()
          const res = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(share.id)}`).pipe(
            HttpClientRequest.setHeaders(req.headers),
            HttpClientRequest.bodyJson({ secret: share.secret, data: sent.map((entry) => entry[1]) }),
            Effect.flatMap((r) => http.execute(r)),
            Effect.timeout(SHARE_REQUEST_TIMEOUT),
            Effect.catchCause((cause) =>
              Effect.logWarning("share sync request failed", {
                sessionID: sessionID,
                attempt: attempt + 1,
                cause,
              }).pipe(Effect.as(undefined)),
            ),
          )

          if (!res || res.status >= 400) {
            yield* Effect.logWarning("failed to sync share", {
              sessionID: sessionID,
              shareID: share.id,
              status: res?.status,
              attempt: attempt + 1,
            })
            if (attempt + 1 < MAX_FLUSH_ATTEMPTS) yield* Effect.sleep(FLUSH_RETRY_DELAY * (attempt + 1))
            continue
          }

          // Drop only what was actually sent; a newer value queued during the POST wins.
          const current = s.queue.get(sessionID)
          if (current) {
            for (const [k, item] of sent) if (current.get(k) === item) current.delete(k)
            if (current.size === 0) s.queue.delete(sessionID)
          }
          if (!s.queue.get(sessionID)) return
        }
      })

    const flush = Effect.fn("ShareNext.flush")(function* (sessionID: SessionID) {
      if (disabled) return
      const s = yield* InstanceState.get(state)
      if (s.inflight.has(sessionID)) return
      s.inflight.add(sessionID)
      yield* drain(sessionID, s).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            s.inflight.delete(sessionID)
            s.scheduled.delete(sessionID)
          }),
        ),
      )
    })

    const full = Effect.fn("ShareNext.full")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("full sync", { sessionID: sessionID })
      const info = yield* session.get(sessionID)
      const diffs = yield* session.diff(sessionID)
      yield* sync(sessionID, [
        { type: "session", data: info },
        { type: "session_diff", data: diffs },
      ])

      // Page newest-first so the queue cap retains the most recent history; the
      // remote merge is keyed and order-independent (D-20).
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID, limit: FULL_PAGE_SIZE, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        const models = yield* Effect.forEach(
          Array.from(
            new Map(
              page.items
                .filter((msg) => msg.info.role === "user")
                .map((msg) => (msg.info as SDK.UserMessage).model)
                .map((item) => [`${item.providerID}/${item.modelID}`, item] as const),
            ).values(),
          ),
          (item) => provider.getModel(ProviderV2.ID.make(item.providerID), ModelV2.ID.make(item.modelID)),
          { concurrency: 8 },
        )
        yield* sync(sessionID, [
          ...page.items.map((item) => ({ type: "message" as const, data: item.info })),
          ...page.items.flatMap((item) => item.parts.map((part) => ({ type: "part" as const, data: part }))),
          { type: "model", data: models },
        ])
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
    })

    const fullWithRetry = Effect.fnUntraced(function* (sessionID: SessionID) {
      for (let attempt = 0; attempt < MAX_FLUSH_ATTEMPTS; attempt++) {
        const result = yield* Effect.exit(full(sessionID))
        if (Exit.isSuccess(result)) return
        const cause = result.cause
        if (Cause.hasInterrupts(cause)) return
        if (attempt + 1 < MAX_FLUSH_ATTEMPTS) {
          yield* Effect.logWarning("share full sync failed, retrying", {
            sessionID: sessionID,
            attempt: attempt + 1,
            cause: cause,
          })
          yield* Effect.sleep(FLUSH_RETRY_DELAY * (attempt + 1))
          continue
        }
        yield* Effect.logError("share full sync failed", { sessionID: sessionID, cause: cause })
      }
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (disabled) return
      const conf = yield* cfg.get()
      if (conf.share === "disabled") return
      yield* InstanceState.get(state)
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      if (disabled) return { id: "", url: "", secret: "" }
      yield* Effect.logInfo("creating share", { sessionID: sessionID })
      const req = yield* request()
      const result = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ sessionID }),
        Effect.flatMap((r) => httpOk.execute(r)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ShareSchema)),
      )
      yield* db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run()
        .pipe(Effect.orDie)
      const s = yield* InstanceState.get(state)
      s.shared.set(sessionID, result)
      s.misses.delete(sessionID)
      yield* fullWithRetry(sessionID).pipe(Effect.forkIn(s.scope))
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      if (disabled) return
      yield* Effect.logInfo("removing share", { sessionID: sessionID })
      const s = yield* InstanceState.get(state)
      const share = yield* getCached(sessionID)

      yield* Effect.gen(function* () {
        if (!share) return
        const req = yield* request()
        yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
          HttpClientRequest.setHeaders(req.headers),
          HttpClientRequest.bodyJson({ secret: share.secret }),
          Effect.flatMap((r) => httpOk.execute(r)),
          Effect.timeout(SHARE_REQUEST_TIMEOUT),
        )
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("failed to remove share", { sessionID: sessionID, cause })),
        // Local state is dropped whether or not the remote delete succeeded, so a
        // dead endpoint cannot leave the session marked shared forever (O-16).
        Effect.ensuring(
          Effect.gen(function* () {
            yield* db
              .delete(SessionShareTable)
              .where(eq(SessionShareTable.session_id, sessionID))
              .run()
              .pipe(Effect.orDie)
            yield* Effect.sync(() => {
              s.shared.delete(sessionID)
              s.queue.delete(sessionID)
              s.misses.delete(sessionID)
              s.inflight.delete(sessionID)
              s.scheduled.delete(sessionID)
            })
          }),
        ),
      )
    })

    return Service.of({ init, url, request, create, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Account.node, EventV2Bridge.node, Config.node, Database.node, httpClient, Provider.node, Session.node],
})

export * as ShareNext from "./share-next"
