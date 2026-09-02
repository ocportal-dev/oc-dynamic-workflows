import { expect, it } from "bun:test"
import { consumeEvents } from "../src/events.js"
import type { RunStore } from "../src/persistence.js"
import { Roster } from "../src/roster.js"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, tick, until, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

const TEAM: WorkflowSpec = {
  specVersion: 1,
  name: "hub",
  goal: "answer together",
  phases: [
    {
      id: "work",
      strategy: "team",
      mailbox: { peers: false, maxMessages: 20 },
      tasks: [{ id: "a", kind: "agent", prompt: "do a", retries: 0 }],
    },
  ],
}

/** Collects what the process would report as an unhandled rejection while the body runs. */
async function withRejectionWatch(body: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = []
  const watch = (reason: unknown): void => {
    rejections.push(reason)
  }
  // The bun-types declaration of `process.on` knows a few events only.
  const events = process as unknown as NodeJS.EventEmitter
  events.on("unhandledRejection", watch)
  try {
    await body()
    // An unhandled rejection is reported a turn after the promise settled.
    await tick(20)
  } finally {
    events.off("unhandledRejection", watch)
  }
  return rejections
}

it("survives a storage that refuses the write the debounce timer starts", async () => {
  const rejections = await withRejectionWatch(async () => {
    const fake = startRunner({ debounceMs: 50 })
    const runId = await fake.runner.start(TEAM, START)
    const spawn = await waitForSpawn(fake, 1)

    // The question schedules the wake; the writes that wake makes are then refused.
    const sent = await fake.mailbox.send({ sessionID: spawn.childID, type: "question", body: "which one?" })
    expect(sent.ok).toBe(true)
    fake.setStorageFails((key) => key.includes(":run:") || key.includes(":mail:"))
    await new Promise((resolve) => setTimeout(resolve, 150))

    fake.setStorageFails(undefined)
    spawn.settle("done")
    await fake.runner.wait(runId)
    await fake.stop()
  })

  expect(rejections).toEqual([])
})

it("keeps the event stream after a handler that throws", async () => {
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  const emit = (event: unknown): void => {
    queue.push(event)
    wake?.()
    wake = undefined
  }
  const subscribe = async function* (request: { signal: AbortSignal }) {
    while (!request.signal.aborted) {
      if (queue.length > 0) {
        yield queue.shift()
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        request.signal.addEventListener("abort", () => resolve(), { once: true })
      })
    }
  }

  const roster = new Roster(async () => undefined)
  roster.registerLead("wf_1", LEAD)
  roster.bind("wf_1", "a", "ses_child1")
  const store = {
    recordUsage: async () => {
      throw new Error("the storage is gone")
    },
  } as unknown as RunStore

  const aborter = new AbortController()
  const events = consumeEvents({ subscribe, roster, store, signal: aborter.signal })

  emit({ type: "session.usage.updated", data: { sessionID: "ses_child1", cost: 1, tokens: { input: 1 } } })
  emit({ type: "session.created", data: { sessionID: "ses_child2", parentID: LEAD, title: "wf:wf_1:b" } })

  // The failed usage event must not take the stream, so the later child is still named.
  await until(() => roster.member("ses_child2") !== undefined, "the second child")
  expect(roster.member("ses_child2")?.taskId).toBe("b")

  aborter.abort()
  await events.catch(() => {})
})
