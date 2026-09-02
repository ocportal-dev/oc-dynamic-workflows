import { expect, it } from "bun:test"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

function parallel(count: number, synthesisPrompt?: string): WorkflowSpec {
  return {
    specVersion: 1,
    name: "fanout",
    goal: "collect the words",
    phases: [
      {
        id: "words",
        strategy: "parallel",
        synthesisPrompt,
        tasks: Array.from({ length: count }, (_, index) => ({
          id: `t${index + 1}`,
          kind: "agent" as const,
          prompt: `say word ${index + 1}`,
          retries: 0,
          keep: false,
        })),
      },
    ],
  }
}

it("keeps at most `concurrency` tasks in flight and runs every task", async () => {
  const fake = startRunner({ options: { concurrency: 2 } })
  const runId = await fake.runner.start(parallel(6), START)

  for (let index = 1; index <= 6; index += 1) {
    const spawn = await waitForSpawn(fake, index)
    expect(fake.flight.now).toBeLessThanOrEqual(2)
    spawn.settle(`word ${index}`)
  }
  await fake.runner.wait(runId)

  expect(fake.flight.max).toBe(2)
  expect(fake.spawns).toHaveLength(6)
  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.tasks.every((task) => task.status === "completed")).toBe(true)
  expect(run?.phases[0]!.status).toBe("completed")
  expect(run?.status).toBe("completed")
  await fake.stop()
})

it("lets the pool go on after a failed task and marks the phase partial", async () => {
  const fake = startRunner({ options: { concurrency: 2 } })
  const runId = await fake.runner.start(parallel(4), START)

  for (let index = 1; index <= 4; index += 1) {
    const spawn = await waitForSpawn(fake, index)
    if (index === 2) spawn.fail("Subagent failed")
    else spawn.settle(`word ${index}`)
  }
  await fake.runner.wait(runId)

  expect(fake.spawns).toHaveLength(4)
  const run = await fake.store.get(runId)
  const statuses = run!.phases[0]!.tasks.map((task) => task.status)
  expect(statuses.filter((status) => status === "completed")).toHaveLength(3)
  expect(statuses.filter((status) => status === "failed")).toHaveLength(1)
  expect(run?.phases[0]!.status).toBe("partial")
  expect(run?.status).toBe("partial")
  await fake.stop()
})

it("marks the phase failed when no task completes", async () => {
  const fake = startRunner({ options: { concurrency: 4 } })
  const runId = await fake.runner.start(parallel(2), START)
  for (let index = 1; index <= 2; index += 1) (await waitForSpawn(fake, index)).fail("Subagent failed")
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.status).toBe("failed")
  expect(run?.status).toBe("failed")
  await fake.stop()
})

it("goes on to the next phase after a partial parallel phase", async () => {
  const fake = startRunner({ options: { concurrency: 4 } })
  const spec = parallel(2)
  spec.phases.push({
    id: "write",
    strategy: "sequential",
    tasks: [{ id: "report", kind: "agent", prompt: "write the report", retries: 0, keep: false }],
  })

  const runId = await fake.runner.start(spec, START)
  ;(await waitForSpawn(fake, 1)).settle("kept")
  ;(await waitForSpawn(fake, 2)).fail("Subagent failed")
  ;(await waitForSpawn(fake, 3)).settle("written")
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.status).toBe("partial")
  expect(run?.phases[1]!.status).toBe("completed")
  expect(run?.status).toBe("partial")
  await fake.stop()
})

it("stops the run when a sequential phase loses a task", async () => {
  const fake = startRunner()
  const spec: WorkflowSpec = {
    specVersion: 1,
    name: "chain",
    goal: "in order",
    phases: [
      {
        id: "first",
        strategy: "sequential",
        tasks: [
          { id: "a", kind: "agent", prompt: "one", retries: 0, keep: false },
          { id: "b", kind: "agent", prompt: "two", retries: 0, keep: false },
        ],
      },
      { id: "second", strategy: "sequential", tasks: [{ id: "c", kind: "agent", prompt: "three", retries: 0, keep: false }] },
    ],
  }

  const runId = await fake.runner.start(spec, START)
  ;(await waitForSpawn(fake, 1)).fail("Subagent failed")
  await fake.runner.wait(runId)

  expect(fake.spawns).toHaveLength(1)
  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.tasks.map((task) => task.status)).toEqual(["failed", "skipped"])
  expect(run?.phases[1]!.status).toBe("skipped")
  expect(run?.phases[1]!.tasks[0]!.status).toBe("skipped")
  expect(run?.status).toBe("failed")
  await fake.stop()
})

it("takes the concurrency from the run overrides", async () => {
  const fake = startRunner({ options: { concurrency: 8 } })
  const runId = await fake.runner.start(parallel(3), { ...START, overrides: { concurrency: 1 } })

  for (let index = 1; index <= 3; index += 1) {
    const spawn = await waitForSpawn(fake, index)
    expect(fake.spawns).toHaveLength(index)
    spawn.settle("ok")
  }
  await fake.runner.wait(runId)
  expect(fake.flight.max).toBe(1)
  await fake.stop()
})

it("synthesises a phase and passes the summary, not the outputs, to the next phase", async () => {
  const fake = startRunner({ options: { concurrency: 2 } })
  fake.setGeneratedText("alpha, beta")
  const spec = parallel(2, "List the words you were given, comma separated")
  spec.phases.push({
    id: "write",
    strategy: "sequential",
    tasks: [{ id: "report", kind: "agent", prompt: "write the report", retries: 0, keep: false }],
  })

  const runId = await fake.runner.start(spec, START)
  ;(await waitForSpawn(fake, 1)).settle("ALPHA OUTPUT")
  ;(await waitForSpawn(fake, 2)).settle("BETA OUTPUT")
  const report = await waitForSpawn(fake, 3)

  const prompt = fake.generated[0]!.prompt
  expect(fake.generated).toHaveLength(1)
  expect(prompt).toContain("List the words you were given, comma separated")
  expect(prompt).toContain("collect the words")
  expect(prompt).toContain("ALPHA OUTPUT")
  expect(prompt).toContain("BETA OUTPUT")
  expect(prompt).toContain('<untrusted source="agent" id="t1">')

  expect(report.input.prompt).toContain("alpha, beta")
  expect(report.input.prompt).not.toContain("ALPHA OUTPUT")
  report.settle("written")

  await fake.runner.wait(runId)
  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.synthesis).toEqual({ status: "completed", output: "alpha, beta" })
  expect(fake.synthetic[0]!.text).toContain("Synthesis of phase words:")
  expect(fake.synthetic[0]!.text).toContain("alpha, beta")
  await fake.stop()
})

it("does not pass an empty summary on", async () => {
  const fake = startRunner()
  fake.setGeneratedText("   ")
  const runId = await fake.runner.start(parallel(1, "summarise"), START)
  ;(await waitForSpawn(fake, 1)).settle("only output")
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.synthesis).toEqual({ status: "failed", error: "the generation returned no text" })
  await fake.stop()
})

it("records a synthesis that cannot run without stopping the phase", async () => {
  const fake = startRunner({ generate: false })
  const runId = await fake.runner.start(parallel(1, "summarise"), START)
  ;(await waitForSpawn(fake, 1)).settle("only output")
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run?.phases[0]!.synthesis?.status).toBe("failed")
  expect(run?.status).toBe("completed")
  await fake.stop()
})
