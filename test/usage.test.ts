import { expect, it } from "bun:test"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, tick, until, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

/** One task that may run twice, so the two attempts have two child sessions. */
const RETRIED: WorkflowSpec = {
  specVersion: 1,
  name: "retry",
  goal: "try again",
  phases: [{ id: "p", strategy: "sequential", tasks: [{ id: "a", kind: "agent", prompt: "go", retries: 1, keep: false }] }],
}

/** Two team phases, so each one opens the mailbox with its own baseline. */
const TWO_PHASES: WorkflowSpec = {
  specVersion: 1,
  name: "two",
  goal: "answer twice",
  phases: ["one", "two"].map((id) => ({
    id,
    strategy: "team" as const,
    mailbox: { peers: false as const, maxMessages: 20 },
    tasks: [{ id: `t${id}`, kind: "agent" as const, prompt: `do ${id}`, retries: 0, keep: false }],
  })),
}

it("adds the spend of a retry to the spend of the attempt before it", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(RETRIED, START)
  const first = await waitForSpawn(fake, 1)
  first.fail("the member blew up")
  await until(async () => (await fake.store.get(runId))!.phases[0]!.tasks[0]!.usage.usd > 0, "the first attempt")
  const afterFirst = (await fake.store.get(runId))!.budget.spentUsd
  expect(afterFirst).toBeCloseTo(0.01, 5)

  const second = await waitForSpawn(fake, 2)
  second.settle("done")
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  // Both children were billed, so the task carries the sum and the spend never went down.
  expect(run!.phases[0]!.tasks[0]!.usage.usd).toBeCloseTo(0.02, 5)
  expect(run!.budget.spentUsd).toBeGreaterThanOrEqual(afterFirst)
  expect(run!.budget.spentUsd).toBeCloseTo(0.02, 5)

  // A late event of the first child replaces its own entry only.
  fake.emit({
    type: "session.usage.updated",
    data: { sessionID: first.childID, cost: 0.01, tokens: { input: 100, output: 20, reasoning: 5 } },
  })
  await tick(6)
  expect((await fake.store.get(runId))!.budget.spentUsd).toBeCloseTo(0.02, 5)
  await fake.stop()
})

it("keeps the mail spend of every team phase of a run", async () => {
  const fake = startRunner({ debounceMs: 5 })
  fake.sessions.set(LEAD, {
    cost: 1,
    tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const runId = await fake.runner.start(TWO_PHASES, START)

  const first = await waitForSpawn(fake, 1)
  fake.sessions.get(LEAD)!.cost = 1.5
  await fake.mailbox.send({ sessionID: first.childID, type: "question", body: "which word?" })
  await until(async () => (await fake.store.get(runId))?.mailUsage !== undefined, "the first phase spend")
  expect((await fake.store.get(runId))!.mailUsage!.usd).toBeCloseTo(0.5, 5)
  first.settle("done")

  const second = await waitForSpawn(fake, 2)
  fake.sessions.get(LEAD)!.cost = 2.5
  await fake.mailbox.send({ sessionID: second.childID, type: "question", body: "and now?" })
  await until(async () => (await fake.store.get(runId))!.mailUsage!.usd > 0.5, "the second phase spend")

  const run = await fake.store.get(runId)
  // The second phase took its own baseline, so its wake must not drop the first one's.
  expect(Object.keys(run!.mailUsageByPhase ?? {})).toEqual(["one", "two"])
  expect(run!.mailUsage!.usd).toBeCloseTo(1.5, 5)
  expect(run!.budget.spentUsd).toBeGreaterThanOrEqual(1.5)

  second.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})
