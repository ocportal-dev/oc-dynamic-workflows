import { afterEach, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exists, worktreePath } from "../src/worktree.js"
import { startPlugin, tick, until, waitForSpawn } from "./fake.js"

const made: string[] = []

/** A repository with one commit, which is what a worktree of HEAD needs. */
async function repository(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "wf-home-"))
  made.push(home)
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["commit", "-q", "--allow-empty", "-m", "first"],
  ]) {
    await Bun.spawn(["git", ...args], { cwd: home, stdout: "pipe", stderr: "pipe" }).exited
  }
  return home
}

afterEach(async () => {
  for (const directory of made.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One team phase, so the mailbox is open while the member is still going. */
const SPEC = {
  specVersion: 1,
  name: "shared",
  goal: "work in another directory",
  phases: [{ id: "one", strategy: "team", tasks: [{ id: "a", prompt: "go" }] }],
}

/** The instance a worktree directory boots: same project, another directory. */
const WORKTREE = { share: true, directory: "/project/.opencode/workflows/worktrees/wf/a" }

it("serves a member of one instance from the instance of its directory", async () => {
  const main = await startPlugin()
  const started = (await main.run("workflow_run", { spec: SPEC })).output as { runId: string }
  const spawn = await waitForSpawn(main, 1)
  const worktree = await startPlugin(WORKTREE)

  // The steer could not be admitted, so it waits for the hook to show it to the member.
  main.setPromptFails(true)
  await main.run("team_steer", { taskId: "a", body: "look at the test first" })
  main.setPromptFails(false)
  const request = await worktree.context(spawn.childID)
  expect(request.tools.workflow_run).toBeUndefined()
  expect(request.tools.subagent).toBeUndefined()
  expect(request.tools.read).toBeDefined()
  expect(request.system.map((part) => part.text).join("\n")).toContain("look at the test first")

  // A member call served by the worktree instance reaches the lead of the other one.
  const sent = await worktree.run("team_send", { type: "status", body: "halfway" }, { sessionID: spawn.childID })
  expect((sent.output as { ok: boolean }).ok).toBe(true)
  const read = await main.run("team_inbox", {})
  expect((read.output as { mail: { body: string }[] }).mail).toEqual([expect.objectContaining({ body: "halfway" })])

  spawn.settle("done")
  await until(async () => (await main.run("workflow_status", { runId: started.runId })).content !== undefined, "status")
  if (typeof worktree.cleanup === "function") await worktree.cleanup()
  if (typeof main.cleanup === "function") await main.cleanup()
})

it("recovers orphans on the first attach only", async () => {
  const main = await startPlugin()
  const started = (await main.run("workflow_run", { spec: SPEC })).output as { runId: string }
  await waitForSpawn(main, 1)
  expect((await main.run("workflow_status", { runId: started.runId })).output).toMatchObject({ status: "running" })

  const worktree = await startPlugin(WORKTREE)
  await tick(4)
  // A second recovery would call this live run orphaned and cancel its member.
  expect((await worktree.run("workflow_status", { runId: started.runId })).output).toMatchObject({ status: "running" })

  if (typeof worktree.cleanup === "function") await worktree.cleanup()
  if (typeof main.cleanup === "function") await main.cleanup()
})

it("keeps the engine until the last instance goes", async () => {
  const main = await startPlugin()
  await main.run("workflow_run", { spec: SPEC })
  const spawn = await waitForSpawn(main, 1)
  const worktree = await startPlugin(WORKTREE)

  // One instance leaves; the roster of the engine still knows the member.
  if (typeof worktree.cleanup === "function") await worktree.cleanup()
  const kept = await main.context(spawn.childID)
  expect(kept.tools.subagent).toBeUndefined()

  // The last one leaves, so the next attach builds an engine that knows nothing.
  if (typeof main.cleanup === "function") await main.cleanup()
  const fresh = await startPlugin({ share: true })
  const forgotten = await fresh.context(spawn.childID)
  expect(forgotten.tools.subagent).toBeDefined()
  if (typeof fresh.cleanup === "function") await fresh.cleanup()
})

it("anchors a run to the directory of the session that started it", async () => {
  const other = await mkdtemp(join(tmpdir(), "wf-other-"))
  made.push(other)
  const home = await repository()
  // The engine is built by the instance of `other`, but the run is started from `home`.
  const first = await startPlugin({ directory: other })
  const second = await startPlugin({ share: true, directory: home })

  const spec = {
    specVersion: 1,
    name: "isolated",
    goal: "write a file in a worktree",
    phases: [
      {
        id: "p",
        tasks: [{ id: "a", kind: "shell", command: "echo hi > made.txt", isolation: "worktree" }],
      },
    ],
  }
  const started = (await second.run("workflow_run", { spec })).output as { ok: boolean; runId: string }
  expect(started.ok).toBe(true)
  await until(
    async () => ((await second.run("workflow_status", { runId: started.runId })).output as { status: string }).status === "completed",
    "the run to end",
  )

  const mirror = JSON.parse(
    await readFile(join(home, ".opencode", "workflows", "runs", `${started.runId}.json`), "utf8"),
  ) as { directory: string; phases: { tasks: { worktree: { path: string; patch: string } }[] }[] }
  expect(mirror.directory).toBe(home)
  expect(mirror.phases[0]!.tasks[0]!.worktree.path).toBe(worktreePath(home, started.runId, "a"))
  expect(await readFile(mirror.phases[0]!.tasks[0]!.worktree.patch, "utf8")).toContain("made.txt")
  // Nothing of that run was written into the directory of the instance that built the engine.
  expect(await exists(join(other, ".opencode"))).toBe(false)

  if (typeof second.cleanup === "function") await second.cleanup()
  if (typeof first.cleanup === "function") await first.cleanup()
})
