import { expect, it } from "bun:test"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, tick, until, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

/** Two tasks side by side, so one that times out cannot stop the other. */
const PAIR: WorkflowSpec = {
  specVersion: 1,
  name: "pair",
  goal: "two at once",
  phases: [
    {
      id: "p",
      strategy: "parallel",
      tasks: [
        { id: "a", kind: "agent", prompt: "slow", retries: 0, keep: false, timeoutMs: 20 },
        { id: "b", kind: "agent", prompt: "quick", retries: 0, keep: false },
      ],
    },
  ],
}

const ONE: WorkflowSpec = {
  specVersion: 1,
  name: "one",
  goal: "do one thing",
  phases: [{ id: "p", strategy: "sequential", tasks: [{ id: "a", kind: "agent", prompt: "go", retries: 0, keep: false }] }],
}

it("marks a task that timed out before its child was named and goes on", async () => {
  // Without `session.created` the roster never learns the child of the spawn.
  const fake = startRunner({ childPollMs: 1 })
  fake.setAnnounceChildren(false)
  const runId = await fake.runner.start(PAIR, START)
  const second = await waitForSpawn(fake, 2)
  // The executor result carries the child of "b", so only "a" is left unnamed.
  second.settle("B RESULT")

  await fake.runner.wait(runId)
  const run = await fake.store.get(runId)
  const [a, b] = run!.phases[0]!.tasks
  expect(a!.status).toBe("timeout")
  expect(a!.error).toBe("child session never registered")
  expect(b!.status).toBe("completed")
  expect(run!.status).toBe("partial")
  await fake.stop()
})

it("refuses a second resume while the first one is still running", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(ONE, START)
  ;(await waitForSpawn(fake, 1)).fail("the member blew up")
  await fake.runner.wait(runId)

  const [first, second] = await Promise.all([fake.runner.resume(runId, START), fake.runner.resume(runId, START)])
  const denied = [first, second].filter((result) => !result.ok)
  expect(denied).toHaveLength(1)
  expect(denied[0]!.ok === false && denied[0]!.error).toContain("already active in this process")

  const again = await waitForSpawn(fake, 2)
  await tick(10)
  // One loop, so one new attempt.
  expect(fake.spawns).toHaveLength(2)
  again.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("waits for the loop to settle, so a cancel and a resume cannot both drive a run", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(ONE, START)
  await waitForSpawn(fake, 1)

  const cancelled = await fake.runner.cancel({ runId })
  expect(cancelled.ok).toBe(true)
  // The loop is settled by now, so the resume owns the run alone.
  const resumed = await fake.runner.resume(runId, START)
  expect(resumed.ok).toBe(true)

  const again = await waitForSpawn(fake, 2)
  await tick(10)
  expect(fake.spawns).toHaveLength(2)
  again.settle("done")
  await fake.runner.wait(runId)
  expect((await fake.store.get(runId))?.status).toBe("completed")
  expect(fake.spawns).toHaveLength(2)
  await fake.stop()
})

it("stops its loops and marks their runs orphaned when it is disposed", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(ONE, START)
  const spawn = await waitForSpawn(fake, 1)
  // The lead backgrounded the job, so the runner polls the child session for its outcome.
  spawn.background()
  await until(async () => (await fake.store.get(runId))?.phases[0]!.tasks[0]!.sessionID !== undefined, "the child")

  await fake.runner.dispose()
  await tick(10)

  const run = await fake.store.get(runId)
  expect(run?.status).toBe("orphaned")
  expect(run?.error).toBe("plugin reloaded during the run")
  expect(run?.phases[0]!.tasks[0]!.status).toBe("cancelled")
  expect(fake.interrupts).toContain(spawn.childID)
  await fake.stop()
})
