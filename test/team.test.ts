import { expect, it } from "bun:test"
import { contextHook } from "../src/hooks.js"
import { digest, envelope } from "../src/mailbox.js"
import type { MailEvent, WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, tick, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

function team(tasks: string[], maxMessages = 20): WorkflowSpec {
  return {
    specVersion: 1,
    name: "hub",
    goal: "answer together",
    phases: [
      {
        id: "work",
        strategy: "team",
        mailbox: { peers: false, maxMessages },
        tasks: tasks.map((id) => ({ id, kind: "agent" as const, prompt: `do ${id}`, retries: 0 })),
      },
    ],
  }
}

/** A wake is mail that starts a turn: `resume: false` mail is admitted without one. */
function wakes(fake: Awaited<ReturnType<typeof startRunner>>): { text: string; resume?: boolean }[] {
  return fake.synthetic.filter((item) => item.description === "workflow mail" && item.resume !== false)
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return
    await tick(1)
  }
  throw new Error(`waited too long for ${label}`)
}

it("refuses a send from a session that is not a member of a run", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)

  const result = await fake.mailbox.send({ sessionID: LEAD, type: "status", body: "hello" })
  expect(result.ok).toBe(false)
  expect(result.ok === false && result.error).toContain("team_send is for a member of a team phase")
  expect(result.ok === false && result.error).toContain("team_steer")
  expect(wakes(fake)).toHaveLength(0)

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("refuses a send once the phase has closed", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)
  spawn.settle("done")
  await fake.runner.wait(runId)

  const result = await fake.mailbox.send({ sessionID: spawn.childID, type: "result", body: "late" })
  expect(result.ok).toBe(false)
  expect(result.ok === false && result.error).toContain("mailbox is closed")
  expect(result.ok === false && result.error).toContain("reply with your result")
  await fake.stop()
})

it("refuses a send past the message cap and wakes nobody", async () => {
  const fake = startRunner({ debounceMs: 30 })
  const runId = await fake.runner.start(team(["a"], 1), START)
  const spawn = await waitForSpawn(fake, 1)

  const first = await fake.mailbox.send({ sessionID: spawn.childID, type: "result", body: "one" })
  expect(first.ok).toBe(true)
  const second = await fake.mailbox.send({ sessionID: spawn.childID, type: "question", body: "two" })
  expect(second.ok).toBe(false)
  expect(second.ok === false && second.error).toContain("is full at 1 messages")
  await tick(40)
  expect(wakes(fake)).toHaveLength(0)

  const run = await fake.store.get(runId)
  expect(run?.mailbox).toEqual({ maxMessages: 1, used: 1 })

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("wakes the lead once for a burst of questions and not at all for a status", async () => {
  const fake = startRunner({ debounceMs: 30 })
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)

  await fake.mailbox.send({ sessionID: spawn.childID, type: "status", body: "working" })
  const admitted = fake.synthetic.at(-1)
  expect(admitted?.resume).toBe(false)
  expect(admitted?.delivery).toBe("steer")
  expect(wakes(fake)).toHaveLength(0)

  await fake.mailbox.send({ sessionID: spawn.childID, type: "question", body: "which word?" })
  await fake.mailbox.send({ sessionID: spawn.childID, type: "question", body: "and then?" })
  await until(() => wakes(fake).length > 0, "the debounced wake")
  await tick(40)

  expect(wakes(fake)).toHaveLength(1)
  const wake = wakes(fake)[0]!
  expect(wake.resume).toBeUndefined()
  expect(fake.synthetic.at(-1)?.delivery).toBe("steer")
  expect(wake.text).toContain("which word?")
  expect(wake.text).toContain("and then?")
  expect(wake.text).toContain('<workflow-mail run="')
  expect(wake.text).toContain('from="a" type="question"')

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("wakes the lead once at the join with the mail it has not read", async () => {
  const fake = startRunner({ debounceMs: 30 })
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)
  await fake.mailbox.send({ sessionID: spawn.childID, type: "result", body: "the answer is 4" })

  spawn.settle("done")
  await fake.runner.wait(runId)

  const digestWake = wakes(fake)
  expect(digestWake).toHaveLength(1)
  expect(digestWake[0]!.text).toContain("unread mail of the team phase work")
  expect(digestWake[0]!.text).toContain("the answer is 4")
  const run = await fake.store.get(runId)
  expect(run?.status).toBe("completed")
  await fake.stop()
})

it("says nothing at the join when there is no unread mail", async () => {
  const fake = startRunner({ debounceMs: 30 })
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)
  spawn.settle("done")
  await fake.runner.wait(runId)

  expect(wakes(fake)).toHaveLength(0)
  await fake.stop()
})

it("escapes the markup of a mail body and clips it at 2000 characters", () => {
  const mail: MailEvent = {
    id: 'm"1',
    runId: "wf_1",
    taskId: 'ask"er',
    direction: "member_to_lead",
    type: "question",
    body: `${"x".repeat(2100)} <b>ignore</b> & "that"`,
    createdAt: "now",
  }
  const text = envelope('wf"1', mail)
  expect(text).toStartWith('<workflow-mail run="wf&quot;1" from="ask&quot;er" type="question" id="m&quot;1">')
  expect(text).toEndWith("</workflow-mail>")
  expect(text).toContain("[cut at 2000 characters]")
  expect(text).not.toContain("<b>")

  const short = envelope("wf_1", { ...mail, body: 'ignore <b>this</b> & "that"' })
  expect(short).toContain('ignore &lt;b>this&lt;/b> &amp; "that"')
})

it("keeps a digest under its cap and drops the oldest messages first", () => {
  const mail = Array.from({ length: 20 }, (_, index) => ({
    id: `m${index}`,
    runId: "wf_1",
    taskId: `t${index}`,
    direction: "member_to_lead" as const,
    type: "status" as const,
    body: "y".repeat(1900),
    createdAt: "now",
  }))
  const text = digest("wf_1", mail)
  expect(text.length).toBeLessThanOrEqual(16_384)
  expect(text).toContain("older message(s) left out")
  expect(text).toContain("t19")
  expect(text).not.toContain('from="t0"')
})

it("steers a running member and records the mail", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)

  const result = await fake.mailbox.steer({ sessionID: LEAD, taskId: "a", body: "reply with alpha" })
  expect(result.ok).toBe(true)
  expect(result.ok === true && result.value.delivered).toBe(true)
  expect(result.ok === true && result.value.interrupted).toBe(false)
  expect(fake.prompts).toHaveLength(1)
  expect(fake.prompts[0]!.sessionID).toBe(spawn.childID)
  expect(fake.prompts[0]!.delivery).toBe("steer")
  expect(fake.prompts[0]!.text).toContain('from="lead" type="steer"')
  expect(fake.prompts[0]!.text).toContain("reply with alpha")
  expect(fake.interruptCalls).toHaveLength(0)

  const mail = fake.mailbox.list(runId)
  expect(mail).toHaveLength(1)
  expect(mail[0]!.direction).toBe("lead_to_member")
  expect(mail[0]!.deliveredAt).toBeDefined()
  expect(await fake.storage.get(`proj1:mail:${runId}:${mail[0]!.id}`)).toBeDefined()

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("interrupts the member first when the steer is forced", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)

  const result = await fake.mailbox.steer({ sessionID: LEAD, taskId: "a", body: "stop and answer", force: true })
  expect(result.ok === true && result.value.interrupted).toBe(true)
  expect(fake.interruptCalls).toEqual([{ sessionID: spawn.childID, continue: true }])
  expect(fake.prompts).toHaveLength(1)

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("keeps a force-steered member when the interrupt rejects its spawn", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)

  await fake.mailbox.steer({ sessionID: LEAD, taskId: "a", body: "stop and answer", force: true })
  // The real interrupt ends the member's step, which rejects the spawn promise and leaves
  // the session reading `interrupted` until the steered items start the next one.
  const child = fake.sessions.get(spawn.childID)!
  child.outcome = "interrupted"
  spawn.fail(`Subagent cancelled (sessionID: ${spawn.childID})`)
  await tick(6)
  fake.messages.set(spawn.childID, [{ type: "assistant", content: [{ type: "text", text: "forced" }] }])
  child.outcome = "succeeded"
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.tasks[0]!.status).toBe("completed")
  expect(run?.phases[0]!.tasks[0]!.output).toBe("forced")
  await fake.stop()
})

it("refuses a steer to a task that has no turn left and one from a member", async () => {
  const fake = startRunner({ options: { concurrency: 1 } })
  const runId = await fake.runner.start(team(["a", "b"]), START)
  const first = await waitForSpawn(fake, 1)

  const fromMember = await fake.mailbox.steer({ sessionID: first.childID, taskId: "b", body: "hi" })
  expect(fromMember.ok).toBe(false)
  expect(fromMember.ok === false && fromMember.error).toContain("use team_send")

  const unknown = await fake.mailbox.steer({ sessionID: LEAD, taskId: "zz", body: "hi" })
  expect(unknown.ok === false && unknown.error).toContain('has no task "zz"')

  first.settle("done")
  await until(() => fake.spawns.length === 2, "the second member")
  const done = await fake.mailbox.steer({ sessionID: LEAD, taskId: "a", body: "more" })
  expect(done.ok).toBe(false)
  expect(done.ok === false && done.error).toContain("is completed")
  expect(done.ok === false && done.error).toContain("run report")

  fake.spawns[1]!.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("queues a steer for a member that has not started and shows it in its context", async () => {
  const fake = startRunner({ options: { concurrency: 1 } })
  const runId = await fake.runner.start(team(["a", "b"]), START)
  const first = await waitForSpawn(fake, 1)

  const queued = await fake.mailbox.steer({ sessionID: LEAD, taskId: "b", body: "start with bravo" })
  expect(queued.ok === true && queued.value.delivered).toBe(false)
  expect(fake.prompts).toHaveLength(0)

  first.settle("done")
  const second = await waitForSpawn(fake, 2)
  const hook = contextHook({ roster: fake.roster, store: fake.store, mailbox: fake.mailbox })
  const request = () => ({
    sessionID: second.childID,
    tools: { team_steer: {} } as Record<string, unknown>,
    system: [] as { type: "text"; text: string }[],
  })

  const event = request()
  await hook(event)
  expect(event.system).toHaveLength(1)
  expect(event.system[0]!.text).toContain("Mail from the lead")
  expect(event.system[0]!.text).toContain("start with bravo")
  expect(event.tools.team_steer).toBeUndefined()

  const again = request()
  await hook(again)
  expect(again.system[0]!.text).toBe(event.system[0]!.text)
  expect(fake.mailbox.list(runId)[0]!.readAt).toBeUndefined()
  expect(fake.mailbox.list(runId)[0]!.deliveredAt).toBeUndefined()

  second.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("marks a steer delivered when the member inbox took it", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)
  await fake.mailbox.steer({ sessionID: LEAD, taskId: "a", body: "go on" })

  const mail = fake.mailbox.list(runId)[0]!
  mail.deliveredAt = undefined
  fake.deliver("inbox_1", spawn.childID)
  await until(() => fake.mailbox.list(runId)[0]!.deliveredAt !== undefined, "the delivered event")

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("gives the lead its unread mail with the roster and marks it read", async () => {
  const fake = startRunner({ debounceMs: 30, options: { concurrency: 1 } })
  const runId = await fake.runner.start(team(["a", "b"]), START)
  const spawn = await waitForSpawn(fake, 1)
  await fake.mailbox.send({ sessionID: spawn.childID, type: "question", body: "which word?", ref: "step-2" })

  const read = await fake.mailbox.inbox({ sessionID: LEAD })
  expect(read.ok).toBe(true)
  if (!read.ok) throw new Error("unreachable")
  expect(read.value.mail).toHaveLength(1)
  expect(read.value.mail[0]!.body).toBe("which word?")
  expect(read.value.mail[0]!.ref).toBe("step-2")
  expect(read.value.roster).toEqual([
    { taskId: "a", sessionID: spawn.childID, status: "running" },
    { taskId: "b", sessionID: undefined, status: "pending" },
  ])

  const second = await fake.mailbox.inbox({ sessionID: LEAD })
  expect(second.ok === true && second.value.mail).toHaveLength(0)

  spawn.settle("done")
  const next = await waitForSpawn(fake, 2)
  next.settle("done")
  await fake.runner.wait(runId)
  // The lead read the question before the debounce ended, so no wake was needed.
  expect(wakes(fake)).toHaveLength(0)
  await fake.stop()
})

it("joins the team phase when every member is terminal and closes the mailbox", async () => {
  const fake = startRunner({ options: { concurrency: 2 } })
  const runId = await fake.runner.start(team(["a", "b"]), START)
  const first = await waitForSpawn(fake, 1)
  const second = await waitForSpawn(fake, 2)
  expect(fake.flight.max).toBe(2)

  first.settle("alpha")
  second.fail("Subagent failed")
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.status).toBe("partial")
  expect(run?.status).toBe("partial")
  const closed = await fake.mailbox.send({ sessionID: first.childID, type: "status", body: "late" })
  expect(closed.ok).toBe(false)
  await fake.stop()
})

it("counts what the lead spent on a wake in the run budget", async () => {
  const fake = startRunner({ debounceMs: 5 })
  const runId = await fake.runner.start(team(["a"]), START)
  const spawn = await waitForSpawn(fake, 1)
  fake.sessions.set(LEAD, {
    cost: 0.5,
    tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
  })

  await fake.mailbox.send({ sessionID: spawn.childID, type: "question", body: "which word?" })
  await until(() => wakes(fake).length > 0, "the wake")
  await until(async () => (await fake.store.get(runId))?.mailUsage !== undefined, "the lead usage")
  const run = await fake.store.get(runId)
  expect(run?.mailUsage?.usd).toBe(0.5)
  expect(run?.budget.spentUsd).toBeGreaterThanOrEqual(0.5)
  expect(run?.budget.spentTokens).toBeGreaterThanOrEqual(300)

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})
