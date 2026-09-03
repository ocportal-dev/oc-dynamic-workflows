import { expect, it } from "bun:test"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, tick, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

function sequential(tasks: WorkflowSpec["phases"][number]["tasks"]): WorkflowSpec {
  return {
    specVersion: 1,
    name: "chain",
    goal: "do it in order",
    phases: [{ id: "p", strategy: "sequential", tasks }],
  }
}

const WORD_SCHEMA = {
  type: "object",
  properties: { word: { type: "string" }, count: { type: "integer" } },
  required: ["word"],
  additionalProperties: false,
}

it("uses defaultTaskTimeoutMs when the task names no timeout", async () => {
  const fake = startRunner({ config: { defaultTaskTimeoutMs: 30 } })
  const runId = await fake.runner.start(sequential([{ id: "a", kind: "agent", prompt: "slow", retries: 0, keep: false }]), START)
  const spawn = await waitForSpawn(fake, 1)
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.status).toBe("timeout")
  expect(task.error).toBe("the task did not finish within 30 ms")
  expect(fake.interrupts).toEqual([spawn.childID])
  await fake.stop()
})

it("stops the run and ends it partial when it passes maxRunMinutes", async () => {
  let now = Date.now()
  const fake = startRunner({ now: () => now, config: { maxRunMinutes: 5 } })
  const runId = await fake.runner.start(
    sequential([
      { id: "a", kind: "agent", prompt: "first", retries: 0, keep: false },
      { id: "b", kind: "agent", prompt: "second", retries: 0, keep: false },
    ]),
    START,
  )

  const first = await waitForSpawn(fake, 1)
  now += 6 * 60_000
  first.settle("done in time")
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(fake.spawns).toHaveLength(1)
  expect(run?.status).toBe("partial")
  expect(run?.error).toBe("the run passed its limit of 5 minutes and was stopped")
  expect(run?.phases[0]!.tasks[1]!.status).toBe("skipped")
  expect(fake.synthetic[0]!.text).toContain("the run passed its limit of 5 minutes")
  await fake.stop()
})

it("stores the JSON object of a task that has an outputSchema", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([{ id: "a", kind: "agent", prompt: "reply in json", retries: 0, keep: false, outputSchema: WORD_SCHEMA }]),
    START,
  )
  ;(await waitForSpawn(fake, 1)).settle('Here you go:\n```json\n{"word": "alpha", "count": 1}\n```\nThat is all.')
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.status).toBe("completed")
  expect(task.data).toEqual({ word: "alpha", count: 1 })
  await fake.stop()
})

it("burns a retry on an output that does not match the schema", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([{ id: "a", kind: "agent", prompt: "reply in json", retries: 1, keep: false, outputSchema: WORD_SCHEMA }]),
    START,
  )
  ;(await waitForSpawn(fake, 1)).settle('{"count": 2}')
  const second = await waitForSpawn(fake, 2)
  expect(second.input.description).toBe(`wf:${runId}:a#2`)
  second.settle('{"word": "beta"}')
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.attempts).toBe(2)
  expect(task.status).toBe("completed")
  expect(task.data).toEqual({ word: "beta" })
  await fake.stop()
})

it("fails a task whose output has no JSON object at all", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([{ id: "a", kind: "agent", prompt: "reply in json", retries: 0, keep: false, outputSchema: WORD_SCHEMA }]),
    START,
  )
  ;(await waitForSpawn(fake, 1)).settle("alpha")
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.status).toBe("failed")
  expect(task.error).toContain("the output holds no JSON object")
  expect(task.data).toBeUndefined()
  await fake.stop()
})

it("names the field that does not match the schema", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([{ id: "a", kind: "agent", prompt: "reply in json", retries: 0, keep: false, outputSchema: WORD_SCHEMA }]),
    START,
  )
  ;(await waitForSpawn(fake, 1)).settle('{"word": 7, "extra": true}')
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.status).toBe("failed")
  expect(task.error).toContain("$.word: must be string, not number")
  expect(task.error).toContain("$.extra: not allowed")
  // The candidate is quoted as the member wrote it, spacing and all, not re-serialized:
  // `JSON.stringify` of the same value would read `{"word":7,"extra":true}`.
  expect(task.error).toContain('the JSON object read was: {"word": 7, "extra": true}')
  await fake.stop()
})

it("quotes at most the first 200 characters of the object it read", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([{ id: "a", kind: "agent", prompt: "reply in json", retries: 0, keep: false, outputSchema: WORD_SCHEMA }]),
    START,
  )
  const answer = JSON.stringify({ count: 1, filler: "y".repeat(400) })
  ;(await waitForSpawn(fake, 1)).settle(answer)
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.status).toBe("failed")
  const quoted = task.error!.slice(task.error!.indexOf("the JSON object read was: ") + "the JSON object read was: ".length)
  expect(quoted).toBe(answer.slice(0, 200))
  // A plain slice, so no cut marker is appended the way `clip` would.
  expect(quoted).not.toContain("[cut at")
  await fake.stop()
})

// No `additionalProperties: false`: the padding that pushes the answer past OUTPUT_LIMIT is
// an undeclared key, and that flag would fail it for a reason that has nothing to do with
// the clipping this pair of tests covers.
const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: { findings: { type: "array", items: { type: "string" } } },
}
/**
 * Longer than OUTPUT_LIMIT (8000), so a check that read `task.output` would see it cut.
 *
 * `detail` is the nested object the live failure hit: once the outer braces are unbalanced,
 * `extractJson` matches it instead and the task fails with `$.findings: required`, even
 * though the member answered correctly.
 */
const LONG_ANSWER = JSON.stringify({ findings: ["ok"], detail: { note: "nested" }, padding: "x".repeat(9000) })

it("validates the raw answer of a foreground task, not the clipped output", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(
    sequential([{ id: "a", kind: "agent", prompt: "reply in json", retries: 0, keep: false, outputSchema: FINDINGS_SCHEMA }]),
    START,
  )
  ;(await waitForSpawn(fake, 1)).settle(LONG_ANSWER)
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.attempts).toBe(1)
  expect(task.error).toBeUndefined()
  expect(task.status).toBe("completed")
  expect(task.data?.findings).toEqual(["ok"])
  expect(task.output!.length).toBeLessThan(LONG_ANSWER.length)
  await fake.stop()
})

it("validates the raw answer of a backgrounded task, not the clipped output", async () => {
  const fake = startRunner({ pollIntervalMs: 5 })
  const runId = await fake.runner.start(
    sequential([{ id: "a", kind: "agent", prompt: "reply in json", retries: 0, keep: false, outputSchema: FINDINGS_SCHEMA }]),
    START,
  )
  const spawn = await waitForSpawn(fake, 1)
  fake.messages.set(spawn.childID, [
    { id: "msg_1", type: "user", content: [] },
    { id: "msg_2", type: "assistant", content: [{ type: "text", text: LONG_ANSWER }] },
  ])

  spawn.background()
  await tick(2)
  fake.sessions.get(spawn.childID)!.outcome = "succeeded"
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.attempts).toBe(1)
  expect(task.error).toBeUndefined()
  expect(task.status).toBe("completed")
  expect(task.data?.findings).toEqual(["ok"])
  expect(task.output!.length).toBeLessThan(LONG_ANSWER.length)
  // A schema failure interrupts the member; an empty list proves that path was never taken.
  expect(fake.interrupts).toEqual([])
  await fake.stop()
})

it("waits for a member the lead moved to the background", async () => {
  const fake = startRunner({ pollIntervalMs: 5 })
  const runId = await fake.runner.start(sequential([{ id: "a", kind: "agent", prompt: "slow", retries: 0, keep: false }]), START)
  const spawn = await waitForSpawn(fake, 1)
  fake.messages.set(spawn.childID, [
    { id: "msg_1", type: "user", content: [] },
    { id: "msg_2", type: "assistant", content: [{ type: "text", text: "BACKGROUND ANSWER" }] },
  ])

  spawn.background()
  await tick(2)
  expect(fake.gets.filter((id) => id === spawn.childID).length).toBeGreaterThanOrEqual(1)
  fake.sessions.get(spawn.childID)!.outcome = "succeeded"
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.status).toBe("completed")
  expect(task.output).toBe("BACKGROUND ANSWER")
  expect(task.sessionID).toBe(spawn.childID)
  expect(fake.gets.filter((id) => id === spawn.childID).length).toBeGreaterThanOrEqual(2)
  expect(fake.interrupts).toEqual([])
  await fake.stop()
})

it("fails a member that ended with nothing to say", async () => {
  const fake = startRunner({ pollIntervalMs: 5 })
  const runId = await fake.runner.start(sequential([{ id: "a", kind: "agent", prompt: "slow", retries: 0, keep: false }]), START)
  const spawn = await waitForSpawn(fake, 1)
  // The transcript holds no assistant text, which is what a member interrupted before its
  // first answer leaves behind.
  fake.messages.set(spawn.childID, [{ id: "msg_1", type: "user", content: [] }])

  spawn.background()
  await tick(2)
  fake.sessions.get(spawn.childID)!.outcome = "succeeded"
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.status).toBe("failed")
  expect(task.error).toBe("the member ended without an answer")
  expect(task.output).toBe("")
  await fake.stop()
})

it("fails a backgrounded member that ends without success", async () => {
  const fake = startRunner({ pollIntervalMs: 5 })
  const runId = await fake.runner.start(sequential([{ id: "a", kind: "agent", prompt: "slow", retries: 0, keep: false }]), START)
  const spawn = await waitForSpawn(fake, 1)
  spawn.background()
  await tick(2)
  fake.sessions.get(spawn.childID)!.outcome = "failed"
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.status).toBe("failed")
  expect(task.error).toBe("the member session ended: failed")
  await fake.stop()
})
