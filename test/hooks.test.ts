import { expect, it } from "bun:test"
import { contextHook, MEMBER_TOOLS } from "../src/hooks.js"
import { Roster } from "../src/roster.js"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, until, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

const SPEC: WorkflowSpec = {
  specVersion: 1,
  name: "chain",
  goal: "do it in order",
  phases: [{ id: "p", strategy: "sequential", tasks: [{ id: "a", kind: "agent", prompt: "go", retries: 0, keep: false }] }],
}

function request(sessionID: string) {
  return {
    sessionID,
    tools: {
      workflow_run: { description: "", input: {} },
      workflow_status: { description: "", input: {} },
      subagent: { description: "", input: {} },
      read: { description: "", input: {} },
      bash: { description: "", input: {} },
    } as Record<string, unknown>,
    system: [] as { type: "text"; text: string }[],
  }
}

it("takes the engine tools out of a member request and leaves the rest", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(SPEC, START)
  const spawn = await waitForSpawn(fake, 1)
  const hook = contextHook({ roster: fake.roster, store: fake.store })

  const event = request(spawn.childID)
  await hook(event)
  expect(Object.keys(event.tools).sort()).toEqual(["bash", "read"])
  expect(event.system).toHaveLength(0)
  for (const name of MEMBER_TOOLS) expect(event.tools[name]).toBeUndefined()

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("gives the lead one system part with the progress tree", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(SPEC, START)
  const spawn = await waitForSpawn(fake, 1)
  const hook = contextHook({ roster: fake.roster, store: fake.store })

  const event = request(LEAD)
  await hook(event)
  expect(event.system).toHaveLength(1)
  expect(event.system[0]!.type).toBe("text")
  expect(event.system[0]!.text).toContain(`run ${runId} [running]`)
  expect(event.system[0]!.text).toContain("Waiting for the run to end")
  expect(Object.keys(event.tools).sort()).toEqual(["bash", "read", "subagent", "workflow_run", "workflow_status"])

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("changes nothing when it runs twice", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(SPEC, START)
  const spawn = await waitForSpawn(fake, 1)
  const hook = contextHook({ roster: fake.roster, store: fake.store })

  const writes: string[] = []
  const set = fake.storageDomain.set
  fake.storageDomain.set = async (key: string, value: unknown) => {
    writes.push(key)
    await set(key, value)
  }

  const first = request(spawn.childID)
  await hook(first)
  const second = request(spawn.childID)
  await hook(second)
  expect(second.tools).toEqual(first.tools)

  const lead = request(LEAD)
  await hook(lead)
  const leadAgain = request(LEAD)
  await hook(leadAgain)
  expect(leadAgain.system).toHaveLength(1)
  expect(leadAgain.system[0]!.text).toBe(lead.system[0]!.text)
  expect(writes).toEqual([])

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("leaves an unknown session alone and does not throw", async () => {
  const fake = startRunner()
  const hook = contextHook({ roster: fake.roster, store: fake.store })
  const event = request("ses_unknown")
  await hook(event)
  expect(Object.keys(event.tools).sort()).toEqual(["bash", "read", "subagent", "workflow_run", "workflow_status"])
  expect(event.system).toHaveLength(0)
  await fake.stop()
})

it("says nothing to a lead whose run has ended", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(SPEC, START)
  const spawn = await waitForSpawn(fake, 1)
  spawn.settle("done")
  await fake.runner.wait(runId)

  const hook = contextHook({ roster: fake.roster, store: fake.store })
  const event = request(LEAD)
  await hook(event)
  expect(event.system).toHaveLength(0)
  await fake.stop()
})

it("asks the server once per interval for a session with no run", async () => {
  let clock = 1000
  const fake = startRunner({ now: () => clock })
  const hook = contextHook({ roster: fake.roster, store: fake.store })

  for (let call = 0; call < 5; call += 1) await hook(request("ses_unknown"))
  expect(fake.gets.filter((id) => id === "ses_unknown")).toHaveLength(1)

  clock += 10_001
  await hook(request("ses_unknown"))
  expect(fake.gets.filter((id) => id === "ses_unknown")).toHaveLength(2)
  await fake.stop()
})

it("forgets the miss when the session is announced as a member", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(SPEC, START)
  const spawn = await waitForSpawn(fake, 1)
  const hook = contextHook({ roster: fake.roster, store: fake.store })

  await hook(request("ses_late"))
  expect(fake.gets.filter((id) => id === "ses_late")).toHaveLength(1)

  fake.emit({ type: "session.created", data: { sessionID: "ses_late", parentID: LEAD, title: `wf:${runId}:a` } })
  await until(() => fake.roster.member("ses_late") !== undefined, "the announced child")

  const event = request("ses_late")
  await hook(event)
  expect(Object.keys(event.tools).sort()).toEqual(["bash", "read"])
  expect(fake.gets.filter((id) => id === "ses_late")).toHaveLength(1)

  spawn.settle("done")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("forgets the miss when the child is bound", async () => {
  let lookups = 0
  const roster = new Roster(async () => {
    lookups += 1
    return undefined
  })
  roster.registerLead("wf_1", LEAD)

  expect(await roster.resolveMember("ses_child")).toBeUndefined()
  expect(await roster.resolveMember("ses_child")).toBeUndefined()
  expect(lookups).toBe(1)

  roster.bind("wf_1", "a", "ses_child")
  expect((await roster.resolveMember("ses_child"))?.taskId).toBe("a")
  expect(lookups).toBe(1)
})

it("asks again once the parent is a lead", async () => {
  let lookups = 0
  const roster = new Roster(async () => {
    lookups += 1
    return { parentID: LEAD, title: "wf:wf_1:a" }
  })

  expect(await roster.resolveMember("ses_child")).toBeUndefined()
  expect(await roster.resolveMember("ses_child")).toBeUndefined()
  expect(lookups).toBe(1)

  roster.registerLead("wf_1", LEAD)
  expect((await roster.resolveMember("ses_child"))?.runId).toBe("wf_1")
  expect(lookups).toBe(2)
})
