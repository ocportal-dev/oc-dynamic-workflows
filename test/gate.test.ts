import { afterEach, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderFinalReport } from "../src/report.js"
import { GATE_SCHEMA } from "../src/spec.js"
import { patchPath, worktreePath } from "../src/worktree.js"
import type { WorkflowSpec } from "../src/types.js"
import { LEAD, LEAD_AGENT, startRunner, until, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }
const WARMUP = "Reply with the single word ready and call no tools."
const made: string[] = []

/** A sequential phase of one worker and one gate, run again until the gate approves. */
function gated(maxRounds = 3, worktree = false): WorkflowSpec {
  return {
    specVersion: 1,
    name: "gated",
    goal: "build it and have it reviewed",
    phases: [
      {
        id: "build",
        strategy: "sequential",
        repeat: { gate: "review", maxRounds },
        tasks: [
          {
            id: "impl",
            kind: "agent",
            prompt: "implement it",
            retries: 0,
            keep: false,
            ...(worktree ? { isolation: "worktree" as const } : {}),
          },
          {
            id: "review",
            kind: "agent",
            agent: "reviewer",
            prompt: "review it",
            retries: 0,
            keep: false,
            outputSchema: GATE_SCHEMA,
          },
        ],
      },
    ],
  }
}

/** A repository with one commit, which is what a worktree of HEAD needs. */
async function repository(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "wf-gate-"))
  made.push(home)
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ]) {
    await Bun.spawn(["git", ...args], { cwd: home, stdout: "pipe", stderr: "pipe" }).exited
  }
  await writeFile(join(home, "kept.txt"), "one\n", "utf8")
  await Bun.spawn(["git", "add", "-A"], { cwd: home, stdout: "pipe", stderr: "pipe" }).exited
  await Bun.spawn(["git", "commit", "-q", "-m", "first"], { cwd: home, stdout: "pipe", stderr: "pipe" }).exited
  return home
}

afterEach(async () => {
  for (const directory of made.splice(0)) await rm(directory, { recursive: true, force: true })
})

it("runs one round when the gate approves it", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(gated(), START)
  ;(await waitForSpawn(fake, 1)).settle("implemented")
  ;(await waitForSpawn(fake, 2)).settle('{"approved": true, "findings": []}')
  await fake.runner.wait(runId)

  expect(fake.spawns).toHaveLength(2)
  const phase = (await fake.store.get(runId))!.phases[0]!
  expect(phase.round).toBe(1)
  expect(phase.rounds).toHaveLength(1)
  expect(phase.rounds![0]).toMatchObject({ round: 1, approved: true, findings: [] })
  expect(phase.rounds![0]!.tasks.map((task) => task.taskId)).toEqual(["impl", "review"])
  expect(phase.status).toBe("completed")
  expect((await fake.store.get(runId))?.status).toBe("completed")
  await fake.stop()
})

it("runs the phase again with the findings of the round the gate refused", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(gated(), START)
  ;(await waitForSpawn(fake, 1)).settle("first try")
  ;(await waitForSpawn(fake, 2)).settle('{"approved": false, "findings": ["the flag is not read anywhere"]}')

  const again = await waitForSpawn(fake, 3)
  expect(again.input.description).toBe(`wf:${runId}:impl`)
  expect(again.input.prompt).toContain("Round 2 of 3.")
  expect(again.input.prompt).toContain("did not approve round 1")
  expect(again.input.prompt).toContain('<untrusted source="agent" id="review">')
  expect(again.input.prompt).toContain("the flag is not read anywhere")
  again.settle("fixed it")
  ;(await waitForSpawn(fake, 4)).settle('{"approved": true}')
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(fake.spawns).toHaveLength(4)
  expect(run?.status).toBe("completed")
  const phase = run!.phases[0]!
  expect(phase.round).toBe(2)
  expect(phase.rounds!.map((round) => round.approved)).toEqual([false, true])
  expect(phase.rounds![0]!.findings).toEqual(["the flag is not read anywhere"])
  // The second round is a new attempt of every task, so the spend sums four sessions.
  expect(run?.budget.spentUsd).toBeCloseTo(0.04, 5)
  expect(run?.budget.spentTokens).toBe(500)
  await fake.stop()
})

it("stops at maxRounds and says so in the report", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(gated(2), START)
  for (const round of [1, 2]) {
    ;(await waitForSpawn(fake, round * 2 - 1)).settle(`try ${round}`)
    ;(await waitForSpawn(fake, round * 2)).settle('{"approved": false, "findings": ["still missing the test"]}')
  }
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(fake.spawns).toHaveLength(4)
  expect(run!.phases[0]!.round).toBe(2)
  expect(run!.phases[0]!.rounds).toHaveLength(2)
  // Every task completed, so the phase joins; the report is how the lead learns the verdict.
  expect(run!.phases[0]!.status).toBe("completed")
  expect(run?.status).toBe("completed")
  const report = renderFinalReport(run!)
  expect(report).toContain("Gate review of phase build: not approved (1 findings) after 2 of 2 rounds.")
  expect(report).toContain("still missing the test")
  await fake.stop()
})

it("starts no new round when the gate misses its own schema", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(gated(), START)
  ;(await waitForSpawn(fake, 1)).settle("implemented")
  ;(await waitForSpawn(fake, 2)).settle("looks fine to me")
  await fake.runner.wait(runId)

  expect(fake.spawns).toHaveLength(2)
  const phase = (await fake.store.get(runId))!.phases[0]!
  expect(phase.tasks[1]!.status).toBe("failed")
  expect(phase.rounds).toHaveLength(1)
  expect(phase.rounds![0]!.approved).toBeUndefined()
  expect((await fake.store.get(runId))?.status).toBe("partial")
  await fake.stop()
})

it("cancels between two rounds and records only the round that finished", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start(gated(), START)
  ;(await waitForSpawn(fake, 1)).settle("first try")
  ;(await waitForSpawn(fake, 2)).settle('{"approved": false, "findings": ["do it again"]}')
  await fake.runner.cancel({ runId })
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run?.status).toBe("cancelled")
  expect(run!.phases[0]!.rounds).toHaveLength(1)
  expect(run!.phases[0]!.rounds![0]!.approved).toBe(false)
  await fake.stop()
})

it("lets the budget stop the next round and names the cap", async () => {
  const fake = startRunner()
  const runId = await fake.runner.start({ ...gated(), budget: { usd: 0.015 } }, START)
  ;(await waitForSpawn(fake, 1)).settle("first try")
  ;(await waitForSpawn(fake, 2)).settle('{"approved": false, "findings": ["do it again"]}')
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(fake.spawns).toHaveLength(2)
  expect(run?.status).toBe("partial")
  expect(run?.error).toContain("budget exceeded")
  expect(run!.phases[0]!.round).toBe(1)
  expect(run!.phases[0]!.rounds).toHaveLength(1)
  await fake.stop()
})

it("tells a worktree task of the next round to apply the patch of the last one", async () => {
  const home = await repository()
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(gated(3, true), START)
  const path = worktreePath(home, runId, "impl")

  const warm = await waitForSpawn(fake, 1)
  expect(warm.input.prompt).toBe(WARMUP)
  warm.settle("ready")
  await until(() => fake.moves.length === 1, "the move of round 1")
  fake.move(warm.childID, path)
  const real = await waitForSpawn(fake, 2)
  await writeFile(join(path, "added.txt"), "new\n", "utf8")
  real.settle("EDITED")
  ;(await waitForSpawn(fake, 3)).settle('{"approved": false, "findings": ["the file needs a test"]}')

  // Round two: a fresh worktree of HEAD, so the member is told to apply what it wrote.
  const warmAgain = await waitForSpawn(fake, 4)
  warmAgain.settle("ready")
  await until(() => fake.moves.length === 2, "the move of round 2")
  fake.move(warmAgain.childID, path)
  const realAgain = await waitForSpawn(fake, 5)
  expect(realAgain.input.prompt).toContain(`git apply ${patchPath(home, runId, "impl")}`)
  expect(realAgain.input.prompt).toContain("Round 2 of 3.")
  realAgain.settle("EDITED AGAIN")
  ;(await waitForSpawn(fake, 6)).settle('{"approved": true}')
  await fake.runner.wait(runId)

  const phase = (await fake.store.get(runId))!.phases[0]!
  expect(phase.rounds![0]!.tasks[0]!.patch).toBe(patchPath(home, runId, "impl"))
  expect((await fake.store.get(runId))?.status).toBe("completed")
  await fake.stop()
})
