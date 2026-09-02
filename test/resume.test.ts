import { expect, it } from "bun:test"
import { renderStatus } from "../src/report.js"
import type { RunRecord, WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, PROJECT, startRunner, tick, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }
const NEW_LEAD = "ses_lead2"
const NEW_AGENT = "plan"

/** Three tasks in order, so the third one can fail with two results behind it. */
const CHAIN: WorkflowSpec = {
  specVersion: 1,
  name: "chain",
  goal: "do it in order",
  phases: [
    {
      id: "p",
      strategy: "sequential",
      tasks: ["a", "b", "c"].map((id) => ({ id, kind: "agent" as const, prompt: id, retries: 0, keep: false })),
    },
  ],
}

/** Runs the chain until the third task fails, which leaves the run `partial`. */
async function partialRun(fake: ReturnType<typeof startRunner>): Promise<string> {
  const runId = await fake.runner.start(CHAIN, START)
  ;(await waitForSpawn(fake, 1)).settle("ALPHA RESULT")
  ;(await waitForSpawn(fake, 2)).settle("BETA RESULT")
  ;(await waitForSpawn(fake, 3)).fail("the member blew up")
  await fake.runner.wait(runId)
  return runId
}

it("re-sends only the task that did not complete and rebuilds its context", async () => {
  const fake = startRunner()
  const runId = await partialRun(fake)
  expect((await fake.store.get(runId))?.status).toBe("partial")

  const resumed = await fake.runner.resume(runId, { lead: NEW_LEAD, leadAgent: NEW_AGENT })
  expect(resumed.ok).toBe(true)

  const again = await waitForSpawn(fake, 4)
  expect(fake.spawns).toHaveLength(4)
  expect(again.input.description).toBe(`wf:${runId}:c`)
  // The two completed tasks are read back out of the record, not run again.
  expect(again.input.prompt).toContain("ALPHA RESULT")
  expect(again.input.prompt).toContain("BETA RESULT")
  // The resume caller is the new lead, so the spawn context and the report follow it.
  expect(again.context.sessionID).toBe(NEW_LEAD)
  expect(again.context.agent).toBe(NEW_AGENT)

  again.settle("GAMMA RESULT")
  await fake.runner.wait(runId)
  const run = await fake.store.get(runId)
  expect(run?.runId).toBe(runId)
  expect(run?.resumes).toBe(1)
  expect(run?.status).toBe("completed")
  expect(run!.phases[0]!.tasks.map((task) => task.output)).toEqual([
    "ALPHA RESULT",
    "BETA RESULT",
    "GAMMA RESULT",
  ])
  expect(fake.synthetic.at(-1)!.sessionID).toBe(NEW_LEAD)
  expect(fake.synthetic.at(-1)!.text).toContain("resumed 1 times")
  await fake.stop()
})

it("carries the spend of the completed tasks over to the resumed run", async () => {
  const fake = startRunner()
  const runId = await partialRun(fake)
  const before = (await fake.store.get(runId))!.budget.spentUsd
  expect(before).toBeCloseTo(0.03, 5)

  const resumed = await fake.runner.resume(runId, START)
  expect(resumed.ok).toBe(true)
  if (!resumed.ok) throw new Error("unreachable")
  // The reset writes the record before the loop starts, and it keeps every earlier cost.
  expect(resumed.run.budget.spentUsd).toBeCloseTo(before, 5)
  expect(resumed.run.phases[0]!.tasks.map((task) => task.usage.usd)).toEqual([0.01, 0.01, 0.01])
  expect(resumed.run.phases[0]!.tasks.map((task) => task.status)).toEqual(["completed", "completed", "pending"])

  ;(await waitForSpawn(fake, 4)).settle("GAMMA RESULT")
  await fake.runner.wait(runId)
  // The failed attempt of "c" was billed too, so the second attempt adds to it.
  expect((await fake.store.get(runId))!.budget.spentUsd).toBeCloseTo(0.04, 5)
  expect((await fake.store.get(runId))!.phases[0]!.tasks[2]!.usage.usd).toBeCloseTo(0.02, 5)
  await fake.stop()
})

it("refuses to resume a run that is still going", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(CHAIN, START)
  const spawn = await waitForSpawn(fake, 1)

  const resumed = await fake.runner.resume(runId, START)
  expect(resumed.ok).toBe(false)
  if (resumed.ok) throw new Error("unreachable")
  expect(resumed.error).toContain("still going")
  expect(resumed.error).toContain("workflow_status")
  expect(resumed.error).toContain("workflow_cancel")
  expect(fake.spawns).toHaveLength(1)

  spawn.settle("A")
  await fake.runner.cancel({ runId })
  await fake.stop()
})

it("refuses a budget-stopped resume until an override raises the cap", async () => {
  const fake = startRunner({ config: { concurrency: 1 } })
  const spec: WorkflowSpec = { ...CHAIN, budget: { usd: 0.05 } }
  const runId = await fake.runner.start(spec, START)
  const first = await waitForSpawn(fake, 1)
  fake.sessions.get(first.childID)!.cost = 0.06
  first.settle("ALPHA RESULT")
  await fake.runner.wait(runId)
  expect((await fake.store.get(runId))?.error).toContain("budget exceeded")

  const refused = await fake.runner.resume(runId, START)
  expect(refused.ok).toBe(false)
  if (refused.ok) throw new Error("unreachable")
  expect(refused.error).toContain("already spent its budget")
  expect(refused.error).toContain("overrides.maxCostUsd")
  expect(fake.spawns).toHaveLength(1)

  const resumed = await fake.runner.resume(runId, { ...START, overrides: { maxCostUsd: 1 } })
  expect(resumed.ok).toBe(true)
  ;(await waitForSpawn(fake, 2)).settle("BETA RESULT")
  ;(await waitForSpawn(fake, 3)).settle("GAMMA RESULT")
  await fake.runner.wait(runId)
  const run = await fake.store.get(runId)
  expect(run?.status).toBe("completed")
  expect(run?.budget.maxUsd).toBe(1)
  await fake.stop()
})

it("keeps a phase that completed whole and does not synthesise it again", async () => {
  const fake = startRunner()
  const spec: WorkflowSpec = {
    specVersion: 1,
    name: "two",
    goal: "one phase then the next",
    phases: [
      { id: "one", strategy: "sequential", synthesisPrompt: "sum it up", tasks: [{ id: "a", kind: "agent", prompt: "a", retries: 0, keep: false }] },
      { id: "two", strategy: "sequential", tasks: [{ id: "b", kind: "agent", prompt: "b", retries: 0, keep: false }] },
    ],
  }
  const runId = await fake.runner.start(spec, START)
  ;(await waitForSpawn(fake, 1)).settle("ALPHA RESULT")
  ;(await waitForSpawn(fake, 2)).fail("the member blew up")
  await fake.runner.wait(runId)
  expect(fake.generated).toHaveLength(1)

  await fake.runner.resume(runId, START)
  const again = await waitForSpawn(fake, 3)
  expect(again.input.description).toBe(`wf:${runId}:b`)
  // The kept synthesis is what the second phase reads, and it is not written again.
  expect(again.input.prompt).toContain("SYNTHESIS")
  expect(fake.generated).toHaveLength(1)
  again.settle("BETA RESULT")
  await fake.runner.wait(runId)
  expect((await fake.store.get(runId))?.status).toBe("completed")
  await fake.stop()
})

it("marks a busy member of an orphaned run interrupted and leaves an ended one alone", async () => {
  const fake = startRunner()
  const record: RunRecord = {
    runId: "wf_orphan",
    specVersion: 1,
    projectID: PROJECT,
    spec: CHAIN,
    status: "running",
    concurrency: 2,
    leadSessionID: LEAD,
    leadAgent: LEAD_AGENT,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: { spentUsd: 0, spentTokens: 0 },
    mailbox: { maxMessages: 0, used: 0 },
    phases: [
      {
        id: "p",
        strategy: "sequential",
        status: "running",
        tasks: [
          { taskId: "a", kind: "agent", status: "running", sessionID: "ses_busy", attempts: 1, usage: { usd: 0, tokens: 0 } },
          { taskId: "b", kind: "agent", status: "running", sessionID: "ses_done", attempts: 1, usage: { usd: 0, tokens: 0 } },
          { taskId: "c", kind: "agent", status: "pending", attempts: 0, usage: { usd: 0, tokens: 0 } },
        ],
      },
    ],
  }
  await fake.store.put(record)
  const child = { parentID: LEAD, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  fake.sessions.set("ses_busy", { ...child })
  // A member that already ended carries an outcome, so nothing is sent to it.
  fake.sessions.set("ses_done", { ...child, outcome: "succeeded" })

  await fake.runner.recoverOrphans()
  await tick(2)

  const run = await fake.store.get("wf_orphan")
  expect(run?.status).toBe("orphaned")
  expect(run?.error).toBe("OpenCode restarted during the run")
  expect(run!.phases[0]!.tasks.map((task) => task.status)).toEqual(["cancelled", "cancelled", "pending"])
  expect(fake.interrupts).toEqual(["ses_busy"])
  expect(fake.synthetic).toHaveLength(0)
  await fake.stop()
})

it("resumes an orphaned run and tells the reader so", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(CHAIN, START)
  await waitForSpawn(fake, 1)
  await tick(2)

  const restarted = startRunner()
  for (const [key, value] of fake.storage) restarted.storage.set(key, value)
  await restarted.runner.recoverOrphans()
  const { renderStatus } = await import("../src/report.js")
  expect(renderStatus((await restarted.store.get(runId))!)).toContain("Use workflow_resume")

  const resumed = await restarted.runner.resume(runId, START)
  expect(resumed.ok).toBe(true)
  for (let index = 1; index <= 3; index += 1) (await waitForSpawn(restarted, index)).settle(`out ${index}`)
  await restarted.runner.wait(runId)
  expect((await restarted.store.get(runId))?.status).toBe("completed")

  await restarted.stop()
  await fake.runner.cancel({ runId })
  await fake.stop()
})

it("puts the guidance of a resume in the prompt of the task it names, and keeps it for the next one", async () => {
  const fake = startRunner()
  const runId = await partialRun(fake)

  const resumed = await fake.runner.resume(runId, { ...START, guidance: { c: "Read the notes file first" } })
  expect(resumed.ok).toBe(true)
  if (!resumed.ok) throw new Error("unreachable")
  expect(resumed.ignoredGuidance ?? []).toEqual([])

  const again = await waitForSpawn(fake, 4)
  expect(again.input.prompt).toContain("Guidance from the lead for this attempt:")
  expect(again.input.prompt).toContain('<untrusted source="lead" id="guidance">')
  expect(again.input.prompt).toContain("Read the notes file first")
  // The record keeps it, so the status line says which task carries guidance.
  expect((await fake.store.get(runId))!.phases[0]!.tasks[2]!.guidance).toBe("Read the notes file first")
  expect(renderStatus((await fake.store.get(runId))!)).toContain("guidance: Read the notes file first")

  again.fail("the member blew up again")
  await fake.runner.wait(runId)

  // A resume that names no guidance keeps what the earlier one gave the task.
  const second = await fake.runner.resume(runId, START)
  expect(second.ok).toBe(true)
  const third = await waitForSpawn(fake, 5)
  expect(third.input.prompt).toContain("Read the notes file first")
  third.settle("GAMMA RESULT")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("reports the guidance whose task id the run does not have", async () => {
  const fake = startRunner()
  const runId = await partialRun(fake)

  const resumed = await fake.runner.resume(runId, { ...START, guidance: { c: "go on", nope: "nobody" } })
  expect(resumed.ok).toBe(true)
  if (!resumed.ok) throw new Error("unreachable")
  expect(resumed.ignoredGuidance).toEqual(["nope"])

  const again = await waitForSpawn(fake, 4)
  expect(again.input.prompt).toContain("go on")
  again.settle("GAMMA RESULT")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("caps one guidance text at 2000 characters", async () => {
  const fake = startRunner()
  const runId = await partialRun(fake)

  const resumed = await fake.runner.resume(runId, { ...START, guidance: { c: "x".repeat(2500) } })
  expect(resumed.ok).toBe(true)
  const task = (await fake.store.get(runId))!.phases[0]!.tasks[2]!
  expect(task.guidance).toContain("[cut at 2000 characters]")
  expect(task.guidance!.startsWith("x".repeat(2000))).toBe(true)
  ;(await waitForSpawn(fake, 4)).settle("GAMMA RESULT")
  await fake.runner.wait(runId)
  await fake.stop()
})
