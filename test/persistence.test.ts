import { expect, it } from "bun:test"
import { RunStore, type RunIndexEntry } from "../src/persistence.js"
import type { RunRecord } from "../src/types.js"

const PROJECT = "proj1"

function storage(): { store: RunStore; writes: string[]; index: () => RunIndexEntry[] } {
  const values = new Map<string, unknown>()
  const writes: string[] = []
  const domain = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      writes.push(key)
      values.set(key, JSON.parse(JSON.stringify(value)))
    },
  }
  return {
    store: new RunStore(domain, PROJECT),
    writes,
    index: () => (values.get(`${PROJECT}:idx:runs`) as RunIndexEntry[]) ?? [],
  }
}

function record(runId: string, status: RunRecord["status"]): RunRecord {
  const now = new Date().toISOString()
  return {
    runId,
    specVersion: 1,
    projectID: PROJECT,
    spec: { specVersion: 1, name: "demo", goal: "do it", phases: [] },
    status,
    concurrency: 1,
    leadSessionID: "ses_lead",
    leadAgent: "build",
    createdAt: now,
    updatedAt: now,
    budget: { spentUsd: 0, spentTokens: 0 },
    phases: [],
    mailbox: { maxMessages: 0, used: 0 },
  }
}

it("rewrites the index only when the status of a run changed", async () => {
  const world = storage()
  const run = record("wf_1", "running")
  await world.store.put(run)
  const afterFirst = world.writes.filter((key) => key.endsWith("idx:runs")).length
  expect(afterFirst).toBe(1)

  // A task write is a record write, not an index write.
  await world.store.put(run)
  await world.store.put(run)
  expect(world.writes.filter((key) => key.endsWith("idx:runs"))).toHaveLength(1)
  expect(world.writes.filter((key) => key.endsWith("run:wf_1"))).toHaveLength(3)

  run.status = "completed"
  await world.store.put(run)
  expect(world.writes.filter((key) => key.endsWith("idx:runs"))).toHaveLength(2)
  expect(world.index()[0]!.status).toBe("completed")
})

it("caps the index at 200 entries and keeps every running one", async () => {
  const world = storage()
  const oldest = record("wf_old", "running")
  await world.store.put(oldest)
  for (let count = 0; count < 210; count += 1) {
    const run = record(`wf_${count}`, "running")
    await world.store.put(run)
    run.status = "completed"
    await world.store.put(run)
  }

  const index = world.index()
  // 200 entries, plus the one run that is still going and may never be dropped.
  expect(index).toHaveLength(201)
  expect(index.filter((entry) => entry.status !== "running")).toHaveLength(200)
  expect(index.filter((entry) => entry.runId === "wf_old")).toHaveLength(1)
  expect(index[0]!.runId).toBe("wf_209")
  // The oldest terminal runs were dropped to make room.
  expect(index.some((entry) => entry.runId === "wf_0")).toBe(false)
})

it("counts visible synthesis usage in the run budget", async () => {
  const world = storage()
  const run = record("wf_synthesis", "running")
  run.phases = [
    {
      id: "phase",
      strategy: "sequential",
      status: "running",
      tasks: [],
      synthesis: { status: "running" },
    },
  ]
  await world.store.put(run)
  await world.store.recordSynthesisUsage("wf_synthesis", "phase", "ses_summary", {
    input: 10,
    output: 20,
    reasoning: 30,
    cache: 40,
    cost: 0.75,
  })
  expect(run.phases[0]!.synthesis).toMatchObject({ sessionID: "ses_summary" })
  expect(run.budget).toEqual({ spentUsd: 0.75, spentTokens: 60 })
})
