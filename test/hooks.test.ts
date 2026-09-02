import { expect, it } from "bun:test"
import { contextHook, MEMBER_TOOLS } from "../src/hooks.js"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, waitForSpawn } from "./fake.js"

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
