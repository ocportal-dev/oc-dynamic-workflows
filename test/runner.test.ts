import { expect, it } from "bun:test"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, PROJECT, startRunner, tick, waitForSpawn } from "./fake.js"

function sequential(tasks: WorkflowSpec["phases"][number]["tasks"]): WorkflowSpec {
  return {
    specVersion: 1,
    name: "chain",
    goal: "do it in order",
    phases: [{ id: "p", strategy: "sequential", tasks }],
  }
}

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

it("forges the spawn context and learns the child from session.created", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(sequential([{ id: "a", kind: "agent", prompt: "first", retries: 0, keep: false }]), START)
  const spawn = await waitForSpawn(fake, 1)

  expect(spawn.context.sessionID).toBe(LEAD)
  expect(spawn.context.agent).toBe(LEAD_AGENT)
  expect(spawn.context.messageID).toBe("msg_lead")
  expect(spawn.input.background).toBe(false)
  expect(spawn.input.agent).toBe("general")
  expect(spawn.input.description).toBe(`wf:${runId}:a`)
  expect(fake.roster.member(spawn.childID)).toEqual({ runId, taskId: "a", sessionID: spawn.childID })

  spawn.settle("first output")
  await fake.runner.wait(runId)
  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.tasks[0]!.sessionID).toBe(spawn.childID)
  expect(run?.status).toBe("completed")
  await fake.stop()
})

it("runs a sequential phase in order and passes the earlier output on", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([
      { id: "a", kind: "agent", prompt: "first", retries: 0, keep: false },
      { id: "b", kind: "agent", prompt: "second", retries: 0, keep: false },
    ]),
    START,
  )

  const first = await waitForSpawn(fake, 1)
  expect(fake.spawns).toHaveLength(1)
  first.settle("ALPHA RESULT")

  const second = await waitForSpawn(fake, 2)
  expect(second.input.prompt).toContain("ALPHA RESULT")
  expect(second.input.prompt).toContain("second")
  second.settle("BETA RESULT")

  await fake.runner.wait(runId)
  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.tasks.map((task) => task.status)).toEqual(["completed", "completed"])
  expect(run?.status).toBe("completed")
  // Usage comes from the child session, summed over input, output, and reasoning.
  expect(run?.budget.spentUsd).toBeCloseTo(0.02, 5)
  expect(run?.budget.spentTokens).toBe(250)
  await fake.stop()
})

it("interrupts a task that runs out of time and does not send it again", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([{ id: "a", kind: "agent", prompt: "slow", retries: 0, keep: false, timeoutMs: 30 }]),
    START,
  )
  const spawn = await waitForSpawn(fake, 1)
  await fake.runner.wait(runId)

  expect(fake.interrupts).toEqual([spawn.childID])
  expect(fake.spawns).toHaveLength(1)
  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.tasks[0]!.status).toBe("timeout")
  expect(run?.phases[0]!.tasks[0]!.attempts).toBe(1)
  expect(run?.status).toBe("failed")
  await fake.stop()
})

it("starts a new child for a retry", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([{ id: "a", kind: "agent", prompt: "flaky", retries: 1, keep: false }]),
    START,
  )

  const first = await waitForSpawn(fake, 1)
  first.fail("Subagent failed")
  const second = await waitForSpawn(fake, 2)
  expect(second.input.description).toBe(`wf:${runId}:a#2`)
  expect(second.childID).not.toBe(first.childID)
  second.settle("recovered")

  await fake.runner.wait(runId)
  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.tasks[0]!.attempts).toBe(2)
  expect(run?.phases[0]!.tasks[0]!.output).toBe("recovered")
  expect(run?.status).toBe("completed")
  await fake.stop()
})

it("cancels a run: the child is interrupted and the run is marked cancelled", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([
      { id: "a", kind: "agent", prompt: "long", retries: 2, keep: false },
      { id: "b", kind: "agent", prompt: "later", retries: 0, keep: false },
    ]),
    START,
  )
  const spawn = await waitForSpawn(fake, 1)

  const result = await fake.runner.cancel({ runId })
  expect(result).toEqual({ ok: true, runId })
  expect(fake.interrupts).toEqual([spawn.childID])

  await fake.runner.wait(runId)
  const run = await fake.store.get(runId)
  expect(run?.status).toBe("cancelled")
  expect(run?.phases[0]!.tasks[0]!.status).toBe("cancelled")
  expect(run?.phases[0]!.tasks[1]!.status).toBe("skipped")
  // A retry must not start after a cancel.
  expect(fake.spawns).toHaveLength(1)
  await fake.stop()
})

it("cancels through a task id", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(sequential([{ id: "a", kind: "agent", prompt: "long", retries: 0, keep: false }]), START)
  await waitForSpawn(fake, 1)
  expect(await fake.runner.cancel({ taskId: "a" })).toEqual({ ok: true, runId })
  await fake.runner.wait(runId)
  expect((await fake.store.get(runId))?.status).toBe("cancelled")
  await fake.stop()
})

it("reports a cancel that names nothing the runner knows", async () => {
  const fake = startRunner()
  expect(await fake.runner.cancel({})).toEqual({
    ok: false,
    error: 'pass "runId", or a "taskId" of a run that is still going',
  })
  expect(await fake.runner.cancel({ runId: "wf_gone" })).toEqual({ ok: false, error: "no run named wf_gone" })
  await fake.stop()
})

it("sends the final report to the lead as a steer", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(sequential([{ id: "a", kind: "agent", prompt: "first", retries: 0, keep: false }]), START)
  const spawn = await waitForSpawn(fake, 1)
  spawn.settle("the answer")
  await fake.runner.wait(runId)

  expect(fake.synthetic).toHaveLength(1)
  const message = fake.synthetic[0]!
  expect(message.sessionID).toBe(LEAD)
  expect(message.delivery).toBe("steer")
  expect(message.description).toBe("workflow")
  expect(message.text).toContain('Workflow "chain" finished: completed.')
  expect(message.text).toContain("the answer")
  await fake.stop()
})

it("writes the run record on every transition under the project prefix", async () => {
  const fake = startRunner()
  const writes: string[] = []
  const set = fake.storageDomain.set
  fake.storageDomain.set = async (key: string, value: unknown) => {
    writes.push(key)
    await set(key, value)
  }

  const runId = await fake.runner.start(sequential([{ id: "a", kind: "agent", prompt: "first", retries: 0, keep: false }]), START)
  const spawn = await waitForSpawn(fake, 1)
  spawn.settle("done")
  await fake.runner.wait(runId)

  expect(writes.filter((key) => key === `${PROJECT}:run:${runId}`).length).toBeGreaterThanOrEqual(5)
  expect(writes).toContain(`${PROJECT}:idx:runs`)
  expect([...fake.storage.keys()].sort()).toEqual([`${PROJECT}:idx:runs`, `${PROJECT}:run:${runId}`])
  expect((fake.storage.get(`${PROJECT}:run:${runId}`) as { projectID: string }).projectID).toBe(PROJECT)
  await fake.stop()
})

it("runs a shell task and keeps its output and exit code", async () => {
  const fake = startRunner({ directory: process.cwd() })
  const runId = await fake.runner.start(
    sequential([
      { id: "a", kind: "shell", command: "echo hello-shell", retries: 0, keep: false },
      { id: "b", kind: "shell", command: "exit 3", retries: 0, keep: false },
    ]),
    START,
  )
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  const [first, second] = run!.phases[0]!.tasks
  expect(first!.status).toBe("completed")
  expect(first!.output).toBe("hello-shell")
  expect(second!.status).toBe("failed")
  expect(second!.error).toBe("the command exited with code 3")
  expect(run?.status).toBe("partial")
  expect(fake.spawns).toHaveLength(0)
  await fake.stop()
})

it("marks a run left running by a restart as orphaned", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(sequential([{ id: "a", kind: "agent", prompt: "first", retries: 0, keep: false }]), START)
  await waitForSpawn(fake, 1)
  await tick(2)

  const restarted = startRunner()
  for (const [key, value] of fake.storage) restarted.storage.set(key, value)
  await restarted.runner.recoverOrphans()

  const run = await restarted.store.get(runId)
  expect(run?.status).toBe("orphaned")
  expect(run?.error).toBe("OpenCode restarted during the run")
  expect(run?.phases[0]!.tasks[0]!.status).toBe("cancelled")
  await restarted.stop()
  await fake.runner.cancel({ runId })
  await fake.stop()
})
