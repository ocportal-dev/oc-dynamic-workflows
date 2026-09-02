import { expect, it } from "bun:test"
import type { BudgetSpec, WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, tick, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

/** One parallel phase of four one-word tasks, so the cap can trip in the middle. */
function four(budget?: BudgetSpec): WorkflowSpec {
  return {
    specVersion: 1,
    name: "cheap",
    goal: "say four words",
    budget,
    phases: [
      {
        id: "p",
        strategy: "parallel",
        tasks: ["a", "b", "c", "d"].map((id) => ({ id, kind: "agent" as const, prompt: id, retries: 0, keep: false })),
      },
    ],
  }
}

it("stops a run that spends its dollar cap and skips what is left", async () => {
  const fake = startRunner({ config: { concurrency: 2 } })
  const runId = await fake.runner.start(four({ usd: 0.05 }), START)

  const first = await waitForSpawn(fake, 1)
  const second = await waitForSpawn(fake, 2)
  // The first member alone costs more than the run was given.
  fake.sessions.get(first.childID)!.cost = 0.06
  first.settle("A")
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  const status = Object.fromEntries(run!.phases[0]!.tasks.map((task) => [task.taskId, task.status]))
  expect(status).toEqual({ a: "completed", b: "cancelled", c: "skipped", d: "skipped" })
  // The member that was still going is interrupted rather than left without a watcher.
  expect(fake.interrupts).toContain(second.childID)
  expect(fake.spawns).toHaveLength(2)
  expect(run?.status).toBe("partial")
  expect(run?.phases[0]!.status).toBe("partial")
  expect(run?.error).toBe("budget exceeded: $0.0600 of $0.05")

  const report = fake.synthetic.at(-1)!.text
  expect(report).toContain("budget exceeded: $0.0600 of $0.05")
  expect(report).toContain(`Use workflow_resume with runId ${runId}`)
  expect(report).toContain("raise it with overrides.maxCostUsd")
  await fake.stop()
})

it("stops a run that spends its token cap", async () => {
  const fake = startRunner({ config: { concurrency: 1 } })
  // Every member of the fake reports 125 tokens, so the cap trips after the second one.
  const runId = await fake.runner.start(four({ tokens: 200 }), START)

  ;(await waitForSpawn(fake, 1)).settle("A")
  ;(await waitForSpawn(fake, 2)).settle("B")
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run!.phases[0]!.tasks.map((task) => task.status)).toEqual(["completed", "completed", "skipped", "skipped"])
  expect(run?.status).toBe("partial")
  expect(run?.error).toBe("budget exceeded: 250 of 200 tokens")
  await fake.stop()
})

it("does not stop a run that names no budget", async () => {
  const fake = startRunner({ config: { concurrency: 1 } })
  const runId = await fake.runner.start(four(), START)
  for (let index = 1; index <= 4; index += 1) (await waitForSpawn(fake, index)).settle(`out ${index}`)
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run!.phases[0]!.tasks.every((task) => task.status === "completed")).toBe(true)
  expect(run?.status).toBe("completed")
  expect(run?.error).toBeUndefined()
  await fake.stop()
})

it("reads the cap again after a lead wake was charged to the run", async () => {
  const fake = startRunner({ config: { concurrency: 1 }, debounceMs: 1 })
  const spec: WorkflowSpec = {
    specVersion: 1,
    name: "team",
    goal: "ask and answer",
    budget: { usd: 0.05 },
    phases: [
      {
        id: "p",
        strategy: "team",
        tasks: [
          { id: "a", kind: "agent", prompt: "ask", retries: 0, keep: false },
          { id: "b", kind: "agent", prompt: "later", retries: 0, keep: false },
        ],
      },
    ],
  }
  const runId = await fake.runner.start(spec, START)
  const first = await waitForSpawn(fake, 1)

  // The lead's own turn is what a wake buys, and it is billed against the run.
  fake.sessions.set(LEAD, {
    cost: 0.09,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  await fake.mailbox.send({ sessionID: first.childID, type: "question", body: "which word?" })
  await tick(20)

  const run = await fake.store.get(runId)
  expect(run?.error).toContain("budget exceeded")
  expect(run!.phases[0]!.tasks[1]!.status).toBe("skipped")
  await fake.runner.wait(runId)
  expect((await fake.store.get(runId))?.status).toBe("partial")
  await fake.stop()
})
