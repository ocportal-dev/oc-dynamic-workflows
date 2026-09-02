import { afterEach, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { create, exists, patchPath, settle, worktreePath } from "../src/worktree.js"

const made: string[] = []

/** A repository with one commit, which is what a worktree of HEAD needs. */
async function repository(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "wf-repo-"))
  made.push(home)
  await run(home, ["init", "-q", "-b", "main"])
  await run(home, ["config", "user.email", "test@example.com"])
  await run(home, ["config", "user.name", "Test"])
  await writeFile(join(home, "kept.txt"), "one\n", "utf8")
  await run(home, ["add", "-A"])
  await run(home, ["commit", "-q", "-m", "first"])
  return home
}

async function run(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  await child.exited
}

afterEach(async () => {
  for (const directory of made.splice(0)) await rm(directory, { recursive: true, force: true })
})

it("creates a detached worktree and hides the base from the checkout", async () => {
  const home = await repository()
  const created = await create({ home, runId: "wf_1", taskId: "a" })
  if (!created.ok) throw new Error(created.error)

  expect(created.path).toBe(worktreePath(home, "wf_1", "a"))
  expect(await exists(join(created.path, "kept.txt"))).toBe(true)
  expect(await readFile(join(home, ".opencode", "workflows", "worktrees", ".gitignore"), "utf8")).toBe("*\n")

  const head = Bun.spawn(["git", "symbolic-ref", "-q", "HEAD"], { cwd: created.path, stdout: "pipe", stderr: "pipe" })
  expect(await head.exited).not.toBe(0)
})

it("writes the patch and the stat, then removes the worktree", async () => {
  const home = await repository()
  const created = await create({ home, runId: "wf_1", taskId: "a" })
  if (!created.ok) throw new Error(created.error)
  await writeFile(join(created.path, "kept.txt"), "two\n", "utf8")
  await writeFile(join(created.path, "added.txt"), "new\n", "utf8")

  const record = await settle({ home, runId: "wf_1", taskId: "a", path: created.path, keep: false })
  expect(record.patch).toBe(patchPath(home, "wf_1", "a"))
  const patch = await readFile(record.patch!, "utf8")
  expect(patch).toContain("added.txt")
  expect(patch).toContain("+two")
  expect(record.stat).toContain("2 files changed")
  expect(record.kept).toBe(false)
  expect(await exists(created.path)).toBe(false)
  // The run's own directory goes with the last worktree in it.
  expect(await exists(dirname(created.path))).toBe(false)
})

it("writes no patch when the member changed nothing", async () => {
  const home = await repository()
  const created = await create({ home, runId: "wf_1", taskId: "a" })
  if (!created.ok) throw new Error(created.error)

  const record = await settle({ home, runId: "wf_1", taskId: "a", path: created.path, keep: false })
  expect(record.patch).toBeUndefined()
  expect(record.stat).toBe("")
  expect(await exists(patchPath(home, "wf_1", "a"))).toBe(false)
  expect(await exists(created.path)).toBe(false)
})

it("leaves the worktree in place when the task asked to keep it", async () => {
  const home = await repository()
  const created = await create({ home, runId: "wf_1", taskId: "a" })
  if (!created.ok) throw new Error(created.error)
  await writeFile(join(created.path, "added.txt"), "new\n", "utf8")

  const record = await settle({ home, runId: "wf_1", taskId: "a", path: created.path, keep: true })
  expect(record.kept).toBe(true)
  expect(record.patch).toBeDefined()
  expect(await exists(created.path)).toBe(true)
})

it("removes a path an earlier attempt left behind before it creates the new one", async () => {
  const home = await repository()
  const first = await create({ home, runId: "wf_1", taskId: "a" })
  if (!first.ok) throw new Error(first.error)
  await writeFile(join(first.path, "stale.txt"), "old\n", "utf8")

  const second = await create({ home, runId: "wf_1", taskId: "a" })
  if (!second.ok) throw new Error(second.error)
  expect(second.path).toBe(first.path)
  expect(await exists(join(second.path, "stale.txt"))).toBe(false)
  expect(await exists(join(second.path, "kept.txt"))).toBe(true)
})

it("drops the patch of the attempt before it when the retry changed nothing", async () => {
  const home = await repository()
  const first = await create({ home, runId: "wf_1", taskId: "a" })
  if (!first.ok) throw new Error(first.error)
  await writeFile(join(first.path, "added.txt"), "new\n", "utf8")
  const before = await settle({ home, runId: "wf_1", taskId: "a", path: first.path, keep: false })
  expect(await exists(before.patch!)).toBe(true)

  const second = await create({ home, runId: "wf_1", taskId: "a" })
  if (!second.ok) throw new Error(second.error)
  const after = await settle({ home, runId: "wf_1", taskId: "a", path: second.path, keep: false })

  expect(after.patch).toBeUndefined()
  expect(await exists(patchPath(home, "wf_1", "a"))).toBe(false)
})
