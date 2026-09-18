import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const registerDisposerScoped = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(disposer)),
    (off) => Effect.sync(off),
  )

describe("InstanceStore", () => {
  it.live("loads instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
    }),
  )

  it.live("disposes instances beyond the cache bound", () =>
    Effect.gen(function* () {
      yield* setBootstrap(Effect.void)
      const disposed: string[] = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        return Promise.resolve()
      })
      const store = yield* InstanceStore.Service
      const directories = yield* Effect.forEach(
        Array.from({ length: 17 }, (_, index) => index),
        () => tmpdirScoped({ git: true }),
      )
      yield* Effect.forEach(directories, (directory) => store.load({ directory }), { discard: true })

      expect(disposed).toEqual([directories[0]])
    }),
  )

  it.live("skips an instance held by provide when evicting", () =>
    Effect.gen(function* () {
      yield* setBootstrap(Effect.void)
      const disposed: string[] = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        return Promise.resolve()
      })
      const store = yield* InstanceStore.Service
      const directories = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, index) => index),
        () => tmpdirScoped({ git: true }),
      )
      yield* Effect.forEach(directories, (directory) => store.load({ directory }), { discard: true })

      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = yield* store
        .provide(
          { directory: directories[0]! },
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(held)

      const extra = yield* tmpdirScoped({ git: true })
      yield* store.load({ directory: extra })

      // The leased directory survives; the next idle entry is evicted instead.
      expect(disposed).toEqual([directories[1]])

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
    }),
    // 17 real git worktrees; under concurrent load the default 5 s budget is too tight, so
    // give the setup an explicit budget instead of flaking (v9 F4b). The ordering itself is
    // deterministic: `held` guards the lease and `store.load` awaits the eviction.
    { timeout: 15_000 },
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      yield* setBootstrap(
        Effect.gen(function* () {
          initializedDirectory = (yield* InstanceRef)?.directory
        }),
      )
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      yield* Deferred.succeed(release, undefined)

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
          throw new Error("init failed")
        }),
      )
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
        }),
      )
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(attempts).toBe(2)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloading, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(reloading)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReload, undefined)

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const release = yield* Deferred.await(releaseDispose)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([dir])
      yield* Effect.sync(release)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1, dir2])
    }),
  )

  it.live("defers dispose while a provide lease is held", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })
      const ctx = yield* store.load({ directory: dir })
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(held)

      const disposing = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* Effect.sleep("50 millis")
      expect(disposed).toEqual([])

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
      yield* Fiber.join(disposing)
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("defers reload teardown while the previous instance is leased", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })
      yield* store.load({ directory: dir })
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(held)

      const reloading = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      yield* Effect.sleep("50 millis")
      expect(disposed).toEqual([])

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
      yield* Fiber.join(reloading)
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("defers disposeAll while a provide lease is held", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })
      yield* store.load({ directory: dir })
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(held)

      const disposing = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Effect.sleep("50 millis")
      expect(disposed).toEqual([])

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
      yield* Fiber.join(disposing)
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("reloads instead of leasing an instance that is already being disposed", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      const ctx = yield* store.load({ directory: dir })
      const disposingFiber = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)

      let captured: unknown
      const provided = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            captured = yield* InstanceRef
          }),
        )
        .pipe(Effect.forkScoped)

      const release = yield* Deferred.await(releaseDispose)
      yield* Effect.sync(release)
      yield* Fiber.join(disposingFiber)
      yield* Fiber.join(provided)

      expect(disposed).toEqual([dir])
      expect(captured).toBeDefined()
      expect(captured).not.toBe(ctx)
    }),
  )

  it.live(
    "an interrupted dispose during the drain does not strand later provides (REGRESSION-2)",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const store = yield* InstanceStore.Service

        for (let round = 0; round < 3; round++) {
          const ctx = yield* store.load({ directory: dir })
          const leased = yield* Deferred.make<void>()
          const held = yield* store
            .provide(
              { directory: dir },
              Effect.gen(function* () {
                yield* Deferred.succeed(leased, undefined)
                yield* Effect.never
              }),
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(leased)

          // The claim is set synchronously, then dispose blocks in the bounded drain while the
          // lease is held; interrupt it inside that window. Before the fix the `ensuring` lived on
          // `disposeContext`, which is never reached, so `closed` stayed pending forever.
          const interrupted = yield* store.dispose(ctx).pipe(Effect.timeoutOption("300 millis"))
          expect(Option.isNone(interrupted)).toBe(true)

          // A later provide must resolve to a fresh, live context instead of awaiting `closed`.
          let captured: unknown
          const provided = yield* store
            .provide(
              { directory: dir },
              Effect.gen(function* () {
                captured = yield* InstanceRef
              }),
            )
            .pipe(Effect.timeoutOption("4 seconds"))
          expect(Option.isSome(provided)).toBe(true)
          expect(captured).toBeDefined()
          expect(captured).not.toBe(ctx)

          yield* Fiber.interrupt(held)
        }
      }),
    30_000,
  )

  it.live(
    "reload waits for a draining dispose before booting the replacement (NEW-V11-07)",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const store = yield* InstanceStore.Service
        const events: string[] = []
        yield* registerDisposerScoped(async (directory) => {
          events.push("dispose")
        })
        yield* setBootstrap(
          Effect.sync(() => {
            events.push("boot")
          }),
        )

        const first = yield* store.load({ directory: dir })
        const leased = yield* Deferred.make<void>()
        const held = yield* store
          .provide(
            { directory: dir },
            Effect.gen(function* () {
              yield* Deferred.succeed(leased, undefined)
              yield* Effect.never
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(leased)

        const disposing = yield* store.dispose(first).pipe(Effect.forkScoped)
        yield* Effect.sleep("300 millis")
        const reloaded = yield* store.reload({ directory: dir }).pipe(Effect.timeoutOption("10 seconds"))
        yield* Fiber.join(disposing)

        // boot (first) -> dispose (the claimed entry's late teardown) -> boot (replacement):
        // the replacement is only booted after the directory-global disposers have run.
        expect(Option.isSome(reloaded)).toBe(true)
        expect(events).toEqual(["boot", "dispose", "boot"])

        yield* Fiber.interrupt(held)
      }),
    30_000,
  )

  it.live(
    "a reload racing a dispose never tears down the fresh entry (NEW-V11-07)",
    () =>
      Effect.gen(function* () {
        const store = yield* InstanceStore.Service
        const events: string[] = []
        yield* registerDisposerScoped(async (directory) => {
          events.push("dispose")
        })
        yield* setBootstrap(
          Effect.sync(() => {
            events.push("boot")
          }),
        )

        for (let round = 0; round < 4; round++) {
          events.length = 0
          const dir = yield* tmpdirScoped({ git: true })
          const first = yield* store.load({ directory: dir })
          const leased = yield* Deferred.make<void>()
          const held = yield* store
            .provide(
              { directory: dir },
              Effect.gen(function* () {
                yield* Deferred.succeed(leased, undefined)
                yield* Effect.never
              }),
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(leased)

          const disposing = yield* store.dispose(first).pipe(Effect.forkScoped)
          // Alternate the head start so both the dispose-claims-first and reload-first orderings
          // are exercised; the odd rounds deterministically open the claimed-but-not-closed window.
          if (round % 2 === 1) yield* Effect.sleep("50 millis")
          const reloaded = yield* store.reload({ directory: dir }).pipe(Effect.timeoutOption("10 seconds"))
          yield* Fiber.join(disposing)
          expect(Option.isSome(reloaded)).toBe(true)
          if (Option.isSome(reloaded)) expect(reloaded.value).not.toBe(first)

          // Whichever side wins the race, the last lifecycle event is the replacement's boot:
          // the old teardown ran before it, never after.
          expect(events.at(-1)).toBe("boot")
          expect(events.filter((event) => event === "dispose")).toHaveLength(1)

          const alive = yield* store
            .provide({ directory: dir }, Effect.succeed("alive" as const))
            .pipe(Effect.timeoutOption("4 seconds"))
          expect(Option.isSome(alive)).toBe(true)

          yield* Fiber.interrupt(held)
        }
      }),
    60_000,
  )

  it.live(
    "reload waits for an interrupted teardown's in-flight disposers (NEW-V12-06)",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const store = yield* InstanceStore.Service
        const events: string[] = []
        yield* registerDisposerScoped(async () => {
          events.push("dispose-start")
          await new Promise((resolve) => setTimeout(resolve, 700))
          events.push("dispose-end")
        })
        yield* setBootstrap(
          Effect.sync(() => {
            events.push("boot")
          }),
        )

        const first = yield* store.load({ directory: dir })
        const disposing = yield* store.dispose(first).pipe(Effect.forkScoped)
        // Interrupt while `runDisposers` is already executing. `releaseClaim` still resolves
        // `closed` (REGRESSION-2), but the disposers keep running; a reload must not boot the
        // replacement until they settle, or the old directory-global teardown tears the fresh
        // entry down afterwards.
        yield* Effect.sleep("100 millis")
        yield* Fiber.interrupt(disposing)

        const reloaded = yield* store.reload({ directory: dir }).pipe(Effect.timeoutOption("10 seconds"))
        expect(Option.isSome(reloaded)).toBe(true)

        // The replacement's boot is the last lifecycle event; the old teardown finished first.
        expect(events).toEqual(["boot", "dispose-start", "dispose-end", "boot"])
        expect(events.lastIndexOf("dispose-end")).toBeLessThan(events.lastIndexOf("boot"))

        const alive = yield* store
          .provide({ directory: dir }, Effect.succeed("alive" as const))
          .pipe(Effect.timeoutOption("4 seconds"))
        expect(Option.isSome(alive)).toBe(true)
      }),
    30_000,
  )

  it.live(
    "reload after an interrupted drain still boots immediately (NEW-V12-06 control)",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const store = yield* InstanceStore.Service
        const events: string[] = []
        yield* registerDisposerScoped(async () => {
          events.push("dispose")
        })
        yield* setBootstrap(
          Effect.sync(() => {
            events.push("boot")
          }),
        )

        const first = yield* store.load({ directory: dir })
        const leased = yield* Deferred.make<void>()
        const held = yield* store
          .provide(
            { directory: dir },
            Effect.gen(function* () {
              yield* Deferred.succeed(leased, undefined)
              yield* Effect.never
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(leased)

        // Interrupt inside the drain: the disposers never started, so there is nothing for a
        // reload to wait for and the replacement boots straight away.
        yield* store.dispose(first).pipe(Effect.timeoutOption("300 millis"))
        const reloaded = yield* store.reload({ directory: dir }).pipe(Effect.timeoutOption("10 seconds"))
        expect(Option.isSome(reloaded)).toBe(true)
        expect(events).toEqual(["boot", "boot"])
        expect(events.at(-1)).toBe("boot")

        yield* Fiber.interrupt(held)
      }),
    30_000,
  )

  it.live(
    "never uses a disposed context under concurrent provide/dispose (W5/F4a)",
    () =>
      Effect.gen(function* () {
        yield* setBootstrap(Effect.void)
        const dir = yield* tmpdirScoped()
        const store = yield* InstanceStore.Service
        const input = {
          directory: dir,
          worktree: dir,
          project: { id: "concurrency" },
        } as unknown as InstanceStore.LoadInput
        const ROUNDS = 80
        let teardowns = 0
        let leaseWins = 0
        let disposeWins = 0
        let violations = 0

        for (let round = 0; round < ROUNDS; round++) {
          const base = yield* store.load(input)
          let disposeCompleted = false
          const records: Array<{ ctx: unknown; afterDispose: boolean }> = []
          const startProvides = () =>
            Effect.forEach(
              Array.from({ length: 4 }, (_, index) => index),
              () =>
                store
                  .provide(
                    input,
                    Effect.gen(function* () {
                      const ctx = yield* InstanceRef
                      records.push({ ctx, afterDispose: disposeCompleted })
                      yield* Effect.sleep("0 millis")
                    }),
                  )
                  .pipe(Effect.forkScoped),
              { concurrency: "unbounded" },
            )
          const startDispose = () =>
            store.dispose(base).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  disposeCompleted = true
                }),
              ),
              Effect.forkScoped,
            )
          // Alternate which side gets the head start so both orderings (dispose claims
          // first → fresh context, lease lands first → same context) are exercised.
          const leaseFirst = round % 2 === 1
          const provides = leaseFirst ? yield* startProvides() : undefined
          if (leaseFirst) yield* Effect.sleep("1 millis")
          const disposing = yield* startDispose()
          if (!leaseFirst) yield* Effect.sleep("0 millis")
          const all = provides ?? (yield* startProvides())
          yield* Fiber.join(disposing)
          yield* Effect.forEach(all, Fiber.join, { discard: true })
          const after = yield* store.load(input)
          const wasTornDown = after !== base
          if (wasTornDown) teardowns++
          for (const record of records) {
            if (record.ctx !== base) {
              disposeWins++
              continue
            }
            leaseWins++
            if (wasTornDown && record.afterDispose) violations++
          }
        }

        expect(violations).toBe(0)
        expect(teardowns).toBe(ROUNDS)
        expect(leaseWins).toBeGreaterThan(0)
        expect(disposeWins).toBeGreaterThan(0)
      }),
    60_000,
  )
})
