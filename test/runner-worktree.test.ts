import { afterEach, expect, it } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RunRecord, TaskSpec, WorkflowSpec } from "../src/types.js"
import { create, exists, patchPath, worktreePath } from "../src/worktree.js"
import { LEAD, LEAD_AGENT, PROJECT, repository, startRunner, tick, until, waitForSpawn } from "./fake.js"

const START = { lead: LEAD, leadAgent: LEAD_AGENT }
const WARMUP = "Reply with the single word ready and call no tools."
const made: string[] = []

function spec(task: Partial<TaskSpec>): WorkflowSpec {
  return {
    specVersion: 1,
    name: "isolated",
    goal: "edit in a worktree",
    phases: [
      {
        id: "p",
        strategy: "sequential",
        tasks: [
          { id: "a", kind: "agent", prompt: "edit", retries: 0, isolation: "worktree", keep: false, ...task },
        ],
      },
    ],
  }
}

afterEach(async () => {
  for (const directory of made.splice(0)) await rm(directory, { recursive: true, force: true })
})

it("warms the member up, moves it while it is idle, then gives it the task", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(spec({}), START)
  const warm = await waitForSpawn(fake, 1)
  const path = worktreePath(home, runId, "a")

  // Step one: a cheap turn in the directory the child was created in.
  expect(await exists(path)).toBe(true)
  expect(warm.input.prompt).toBe(WARMUP)
  expect(warm.input.sessionID).toBeUndefined()
  expect(warm.input.description).toBe(`wf:${runId}:a`)
  warm.settle("ready")

  // Step two: the move, asked for only once the member is idle.
  await until(() => fake.moves.length === 1, "the move")
  expect(fake.moves[0]).toEqual({ sessionID: warm.childID, directory: path })
  expect(fake.spawns).toHaveLength(1)
  fake.move(warm.childID, path)

  // Step three: the real prompt, in the same session.
  const real = await waitForSpawn(fake, 2)
  expect(real.input.sessionID).toBe(warm.childID)
  expect(real.childID).toBe(warm.childID)
  expect(real.input.prompt).toContain(`Your working directory is ${path}, a git worktree. Work only there.`)
  expect(real.input.prompt).toContain("edit")

  await writeFile(join(path, "added.txt"), "new\n", "utf8")
  real.settle("EDITED")
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))?.phases[0]!.tasks[0]!
  expect(task?.status).toBe("completed")
  expect(task?.output).toBe("EDITED")
  expect(task?.sessionID).toBe(warm.childID)
  expect(fake.interruptCalls).toEqual([])
  expect(task?.worktree?.stat).toContain("1 file changed")
  expect(await readFile(task!.worktree!.patch!, "utf8")).toContain("added.txt")
  expect(await exists(path)).toBe(false)
  await fake.stop()
})

it("fails the attempt when the warm-up does not answer, and retries with a fresh worktree", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(spec({ retries: 1 }), START)
  const first = await waitForSpawn(fake, 1)
  const path = worktreePath(home, runId, "a")
  await writeFile(join(path, "half.txt"), "work\n", "utf8")
  first.fail("the model refused")

  const second = await waitForSpawn(fake, 2)
  expect(second.input.prompt).toBe(WARMUP)
  expect(second.input.sessionID).toBeUndefined()
  expect(second.childID).not.toBe(first.childID)
  // The second attempt starts from HEAD again, so nothing of the first one is there.
  expect(await exists(path)).toBe(true)
  expect(await exists(join(path, "half.txt"))).toBe(false)
  second.fail("again")
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))?.phases[0]!.tasks[0]!
  expect(task?.status).toBe("failed")
  expect(task?.error).toBe("worktree: the member did not answer the warm-up")
  expect(task?.attempts).toBe(2)
  expect(fake.moves).toEqual([])
  expect(await exists(path)).toBe(false)
  await fake.stop()
})

it("fails the attempt when the member never arrives, and interrupts nothing", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home, moveTimeoutMs: 30 })
  const runId = await fake.runner.start(spec({}), START)
  const warm = await waitForSpawn(fake, 1)
  const path = worktreePath(home, runId, "a")
  warm.settle("ready")
  await until(() => fake.moves.length === 1, "the move")

  // No `session.moved` ever comes.
  await fake.runner.wait(runId)
  const task = (await fake.store.get(runId))?.phases[0]!.tasks[0]!
  expect(task?.status).toBe("failed")
  expect(task?.error).toBe(`worktree: the member did not arrive in ${path}`)
  expect(fake.interruptCalls).toEqual([])
  expect(fake.spawns).toHaveLength(1)
  expect(await exists(path)).toBe(false)
  await fake.stop()
})

it("fails the attempt when the move itself is refused", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(spec({}), START)
  const warm = await waitForSpawn(fake, 1)
  const path = worktreePath(home, runId, "a")
  fake.setMoveFails(true)
  warm.settle("ready")
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))?.phases[0]!.tasks[0]!
  expect(task?.status).toBe("failed")
  expect(task?.error).toBe(`worktree: the member did not arrive in ${path}`)
  expect(fake.interruptCalls).toEqual([])
  expect(await exists(path)).toBe(false)
  await fake.stop()
})

it("ends the wait for the move when the run is cancelled", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home, moveTimeoutMs: 20_000 })
  const runId = await fake.runner.start(spec({}), START)
  const warm = await waitForSpawn(fake, 1)
  const path = worktreePath(home, runId, "a")
  warm.settle("ready")
  await until(() => fake.moves.length === 1, "the move")

  const cancelled = await fake.runner.cancel({ runId, sessionID: LEAD })
  expect(cancelled.ok).toBe(true)
  await fake.runner.wait(runId)

  const run = await fake.store.get(runId)
  expect(run?.status).toBe("cancelled")
  expect(run?.phases[0]!.tasks[0]!.status).toBe("cancelled")
  expect(fake.interrupts).toContain(warm.childID)
  expect(await exists(path)).toBe(false)
  await fake.stop()
})

it("removes the worktree of a task that runs out of time", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(spec({ timeoutMs: 300 }), START)
  const warm = await waitForSpawn(fake, 1)
  const path = worktreePath(home, runId, "a")
  warm.settle("ready")
  await until(() => fake.moves.length === 1, "the move")
  fake.move(warm.childID, path)
  // The real prompt is never answered.
  await waitForSpawn(fake, 2)

  await fake.runner.wait(runId)
  const task = (await fake.store.get(runId))?.phases[0]!.tasks[0]!
  expect(task?.status).toBe("timeout")
  expect(task?.worktree?.path).toBe(path)
  expect(await exists(path)).toBe(false)
  await fake.stop()
})

it("runs an isolated shell task in its worktree and moves no session", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(
    spec({ kind: "shell", command: "echo hi > made.txt", prompt: undefined }),
    START,
  )
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))?.phases[0]!.tasks[0]!
  expect(task?.status).toBe("completed")
  expect(fake.moves).toEqual([])
  expect(fake.spawns).toEqual([])
  expect(task?.worktree?.stat).toContain("made.txt")
  expect(await readFile(task!.worktree!.patch!, "utf8")).toContain("made.txt")
  // The command wrote in the worktree, not in the checkout it was started from.
  expect(await exists(join(home, "made.txt"))).toBe(false)
  await fake.stop()
})

it("gives a retry a fresh worktree and overwrites the patch", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(spec({ retries: 1 }), START)
  const path = worktreePath(home, runId, "a")

  const firstWarm = await waitForSpawn(fake, 1)
  firstWarm.settle("ready")
  await until(() => fake.moves.length === 1, "the first move")
  fake.move(firstWarm.childID, path)
  const first = await waitForSpawn(fake, 2)
  await writeFile(join(path, "first.txt"), "one\n", "utf8")
  first.fail("boom")

  const secondWarm = await waitForSpawn(fake, 3)
  secondWarm.settle("ready")
  await until(() => fake.moves.length === 2, "the second move")
  fake.move(secondWarm.childID, path)
  const second = await waitForSpawn(fake, 4)
  expect(await exists(join(path, "first.txt"))).toBe(false)
  await writeFile(join(path, "second.txt"), "two\n", "utf8")
  second.settle("done")
  await fake.runner.wait(runId)

  const task = (await fake.store.get(runId))?.phases[0]!.tasks[0]!
  expect(task?.status).toBe("completed")
  expect(task?.attempts).toBe(2)
  const patch = await readFile(task!.worktree!.patch!, "utf8")
  expect(patch).toContain("second.txt")
  expect(patch).not.toContain("first.txt")
  await fake.stop()
})

it("settles the worktree a restart left behind", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const created = await create({ home, runId: "wf_orphan", taskId: "a" })
  if (!created.ok) throw new Error(created.error)
  await writeFile(join(created.path, "half.txt"), "work\n", "utf8")

  const record: RunRecord = {
    runId: "wf_orphan",
    specVersion: 1,
    projectID: PROJECT,
    spec: spec({}),
    status: "running",
    concurrency: 1,
    leadSessionID: LEAD,
    leadAgent: LEAD_AGENT,
    directory: home,
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
          {
            taskId: "a",
            kind: "agent",
            status: "running",
            attempts: 1,
            usage: { usd: 0, tokens: 0 },
            worktree: { path: created.path, kept: false, stat: "" },
          },
        ],
      },
    ],
  }
  await fake.store.put(record)
  await fake.runner.recoverOrphans()
  await tick(2)

  const run = await fake.store.get("wf_orphan")
  expect(run?.status).toBe("orphaned")
  const task = run?.phases[0]!.tasks[0]!
  expect(task?.worktree?.stat).toContain("half.txt")
  expect(await readFile(task!.worktree!.patch!, "utf8")).toContain("half.txt")
  expect(await exists(created.path)).toBe(false)
  await fake.stop()
})

/** `a` edits in its own worktree; `b` runs after it and reads what it left behind. */
function handOff(task: Partial<TaskSpec>): WorkflowSpec {
  return {
    specVersion: 1,
    name: "hand-off",
    goal: "pass the edits on",
    phases: [
      {
        id: "p",
        strategy: "sequential",
        tasks: [
          { id: "a", kind: "agent", prompt: "edit", retries: 0, isolation: "worktree", keep: false, ...task },
          { id: "b", kind: "agent", prompt: "review", retries: 0, keep: false },
        ],
      },
    ],
  }
}

/** Runs `a` to its end, with `edit` deciding whether it changes anything. */
async function runFirst(
  fake: ReturnType<typeof startRunner>,
  runId: string,
  path: string,
  edit?: () => Promise<void>,
): Promise<void> {
  const warm = await waitForSpawn(fake, 1)
  warm.settle("ready")
  await until(() => fake.moves.length === 1, "the move")
  fake.move(warm.childID, path)
  const real = await waitForSpawn(fake, 2)
  if (edit) await edit()
  real.settle("EDITED")
}

it("gives the next task of a sequential phase the patch of an earlier worktree task", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(handOff({}), START)
  const path = worktreePath(home, runId, "a")
  await runFirst(fake, runId, path, () => writeFile(join(path, "added.txt"), "new\n", "utf8"))

  const next = await waitForSpawn(fake, 3)
  const patch = patchPath(home, runId, "a")
  expect(next.input.prompt).toContain("Edits of the earlier worktree tasks of this phase, saved as patches:")
  expect(next.input.prompt).toContain('<untrusted source="worktree" id="a">')
  expect(next.input.prompt).toContain(`patch: ${patch}`)
  expect(next.input.prompt).toContain("1 file changed")
  expect(next.input.prompt).toContain("edited this checkout directly")
  expect(next.input.prompt).not.toContain("worktree kept at:")

  next.settle("REVIEWED")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("names the kept worktree of an earlier task as well as its patch", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(handOff({ keep: true }), START)
  const path = worktreePath(home, runId, "a")
  await runFirst(fake, runId, path, () => writeFile(join(path, "added.txt"), "new\n", "utf8"))

  const next = await waitForSpawn(fake, 3)
  expect(next.input.prompt).toContain(`patch: ${patchPath(home, runId, "a")}`)
  expect(next.input.prompt).toContain(`worktree kept at: ${path}`)

  next.settle("REVIEWED")
  await fake.runner.wait(runId)
  await fake.stop()
})

it("says an earlier worktree task changed nothing when it left no patch", async () => {
  const home = await repository(made)
  const fake = startRunner({ directory: home })
  const runId = await fake.runner.start(handOff({}), START)
  await runFirst(fake, runId, worktreePath(home, runId, "a"))

  const next = await waitForSpawn(fake, 3)
  expect(next.input.prompt).toContain('<untrusted source="worktree" id="a">')
  expect(next.input.prompt).toContain("no changes")
  expect(next.input.prompt).not.toContain("patch: ")

  next.settle("REVIEWED")
  await fake.runner.wait(runId)
  await fake.stop()
})
