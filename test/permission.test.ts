import { expect, it } from "bun:test"
import { renderFinalReport, renderStatus } from "../src/report.js"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, until, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

function onePhase(strategy: WorkflowSpec["phases"][number]["strategy"], retries = 0): WorkflowSpec {
  return {
    specVersion: 1,
    name: "probe",
    goal: "ask for a permission",
    phases: [
      {
        id: "p",
        strategy,
        mailbox: strategy === "team" ? { peers: false, maxMessages: 20 } : undefined,
        tasks: [{ id: "probe", kind: "agent", prompt: "look", retries }],
      },
    ],
  }
}

/** A wake is mail that starts a turn: `resume: false` mail is admitted without one. */
function wakes(fake: ReturnType<typeof startRunner>): { text: string; resume?: boolean }[] {
  return fake.synthetic.filter((item) => item.description === "workflow mail" && item.resume !== false)
}

/** Rejects the permission of the one member and lets core interrupt it. */
async function reject(
  fake: ReturnType<typeof startRunner>,
  runId: string,
  requestID: string,
  ask?: { action: string; resource: string },
): Promise<void> {
  const spawn = await waitForSpawn(fake, 1)
  if (ask) fake.ask(spawn.childID, requestID, ask.action, ask.resource)
  fake.reply(spawn.childID, requestID, "reject")
  await until(
    async () => Boolean((await fake.store.get(runId))!.phases[0]!.tasks[0]!.rejected),
    "the rejection to be recorded",
  )
  // Core interrupts the member, so the captured executor promise rejects.
  spawn.fail(`Subagent cancelled (sessionID: ${spawn.childID})`)
  await fake.runner.wait(runId)
}

it("names what the user rejected instead of the cancel, and does not try the task again", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(onePhase("sequential", 1), START)
  await reject(fake, runId, "perm_1", { action: "bash", resource: "rm -rf /" })

  const run = (await fake.store.get(runId))!
  const task = run.phases[0]!.tasks[0]!
  expect(task.status).toBe("failed")
  expect(task.error).toContain("permission rejected by the user: bash rm -rf /")
  expect(task.error).not.toContain("Subagent cancelled")
  expect(task.attempts).toBe(1)
  expect(fake.spawns).toHaveLength(1)
  await fake.stop()
})

it("falls back to the request id when no ask was seen", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(onePhase("sequential"), START)
  await reject(fake, runId, "perm_9")

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.error).toContain("permission rejected by the user: request perm_9")
  await fake.stop()
})

it("says to resume with guidance in the status and in the report", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(onePhase("sequential"), START)
  await reject(fake, runId, "perm_1", { action: "bash", resource: "rm -rf /" })

  const run = (await fake.store.get(runId))!
  const next = `Use workflow_resume with runId ${runId} and guidance for task probe.`
  expect(renderStatus(run)).toContain(next)
  expect(renderFinalReport(run)).toContain(`probe (failed): permission rejected by the user: bash rm -rf /`)
  expect(renderFinalReport(run)).toContain(next)
  expect(fake.synthetic[0]!.text).toContain(next)
  await fake.stop()
})

it("shows what the running task waits for between the ask and the reply", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(onePhase("sequential"), START)
  const spawn = await waitForSpawn(fake, 1)

  fake.ask(spawn.childID, "perm_2", "bash", "git push")
  await until(async () => {
    const run = await fake.store.get(runId)
    return run ? renderStatus(run).includes("waiting for permission: bash git push") : false
  }, "the waiting note")

  fake.reply(spawn.childID, "perm_2", "once")
  await until(async () => {
    const run = await fake.store.get(runId)
    return run ? !renderStatus(run).includes("waiting for permission") : false
  }, "the waiting note to clear")

  spawn.settle("pushed")
  await fake.runner.wait(runId)
  expect((await fake.store.get(runId))!.phases[0]!.tasks[0]!.status).toBe("completed")
  await fake.stop()
})

it("asks the lead of a team phase what to do about the rejection", async () => {
  const fake = startRunner({ debounceMs: 5 })
  const runId = await fake.runner.start(onePhase("team"), START)
  await reject(fake, runId, "perm_3", { action: "bash", resource: "git push" })

  const mail = fake.mailbox.list(runId)
  expect(mail).toHaveLength(1)
  expect(mail[0]!.direction).toBe("member_to_lead")
  expect(mail[0]!.type).toBe("question")
  expect(mail[0]!.taskId).toBe("probe")
  expect(mail[0]!.body).toBe(
    "Permission for bash git push was rejected by the user. Resume this run with guidance for task probe, or cancel.",
  )
  // A question wakes the lead, and the mail counts against the cap of the phase.
  expect(wakes(fake).some((wake) => wake.text.includes("was rejected by the user"))).toBe(true)
  expect((await fake.store.get(runId))!.mailbox.used).toBe(1)
  await fake.stop()
})

it("sends no mail when the rejected task is not in a team phase", async () => {
  const fake = startRunner({ debounceMs: 5 })
  const runId = await fake.runner.start(onePhase("parallel"), START)
  await reject(fake, runId, "perm_4", { action: "bash", resource: "git push" })

  expect(fake.mailbox.list(runId)).toEqual([])
  expect(wakes(fake)).toHaveLength(0)
  expect((await fake.store.get(runId))!.mailbox.used).toBe(0)
  await fake.stop()
})
