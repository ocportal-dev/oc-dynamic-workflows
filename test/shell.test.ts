import { expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runShell } from "../src/shell.js"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, until, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }

function shellSpec(command: string): WorkflowSpec {
  return {
    specVersion: 1,
    name: "shell",
    goal: "run a command",
    phases: [{ id: "p", strategy: "sequential", tasks: [{ id: "a", kind: "shell", command, retries: 0 }] }],
  }
}

it("returns at its timeout even when a grandchild holds the pipe open", async () => {
  const started = Date.now()
  // `sleep` keeps the inherited stdout open long after `sh` itself has gone.
  const result = await runShell({ command: "(sleep 30 &) ; echo x", cwd: tmpdir(), timeoutMs: 300 })
  const elapsed = Date.now() - started

  expect(result.timedOut).toBe(true)
  expect(elapsed).toBeLessThan(5000)
})

it("kills the grandchildren of a command it stops", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wf-group-"))
  const marker = join(directory, "late")
  const result = await runShell({
    command: `(sleep 1 && touch ${marker}) & echo started`,
    cwd: directory,
    timeoutMs: 200,
  })
  expect(result.timedOut).toBe(true)

  // The whole group went with the shell, so the delayed write never happened.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(await Bun.file(marker).exists()).toBe(false)
})

it("stops a running shell task when the run is cancelled", async () => {
  const fake = startRunner({ directory: tmpdir() })
  const runId = await fake.runner.start(shellSpec("sleep 30"), START)
  await until(async () => (await fake.store.get(runId))?.phases[0]!.tasks[0]!.status === "running", "the command")

  const started = Date.now()
  const cancelled = await fake.runner.cancel({ runId })
  expect(cancelled.ok).toBe(true)
  expect(Date.now() - started).toBeLessThan(10_000)

  const run = await fake.store.get(runId)
  expect(run?.status).toBe("cancelled")
  expect(run?.phases[0]!.tasks[0]!.status).toBe("cancelled")
  await fake.stop()
})

it("refuses a shell task at run time when the option is off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wf-shell-"))
  const marker = join(directory, "ran")
  const fake = startRunner({ directory, config: { shellTasks: false } })
  const runId = await fake.runner.start(shellSpec(`touch ${marker}`), START)
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))!.phases[0]!.tasks[0]!
  expect(task.status).toBe("failed")
  expect(task.error).toBe("shell tasks are disabled by the shellTasks option")
  // Nothing was spawned, so the command left no trace.
  expect(await Bun.file(marker).exists()).toBe(false)
  await fake.stop()
})

it("refuses to resume a run whose spec no longer validates", async () => {
  const fake = startRunner({ directory: tmpdir(), config: { shellTasks: false } })
  const spec: WorkflowSpec = {
    specVersion: 1,
    name: "mixed",
    goal: "one agent then one command",
    phases: [
      {
        id: "p",
        strategy: "sequential",
        tasks: [
          { id: "a", kind: "agent", prompt: "go", retries: 0 },
          { id: "b", kind: "shell", command: "echo hi", retries: 0 },
        ],
      },
    ],
  }
  const runId = await fake.runner.start(spec, START)
  ;(await waitForSpawn(fake, 1)).fail("the member blew up")
  await fake.runner.wait(runId)

  const resumed = await fake.runner.resume(runId, START)
  expect(resumed.ok).toBe(false)
  expect(resumed.ok === false && resumed.error).toContain("no longer valid")
  expect(resumed.ok === false && resumed.error).toContain("shell tasks are disabled")
  expect(fake.spawns).toHaveLength(1)
  await fake.stop()
})
