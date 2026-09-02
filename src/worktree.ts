import { mkdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { swallow } from "./log.js"

/**
 * The git worktree of an `isolation: "worktree"` task.
 *
 * The task gets its own checkout of `HEAD`, works only there, and its edits are saved as a
 * patch when the attempt settles. The worktree is then removed, unless the task set
 * `"keep": true`.
 *
 * Every call runs `git` through `Bun.spawn` from the engine's home directory, which is the
 * project directory of the instance that built the engine. Nothing here throws: a git
 * failure at create is reported to the caller, and one at remove is recorded in the stat.
 */
export interface WorktreeRecord {
  path: string
  kept: boolean
  /** The patch file, absent when the member changed nothing. */
  patch?: string
  stat: string
}

export type CreateResult = { ok: true; path: string } | { ok: false; error: string }

/** How much of `git diff --cached --stat` is kept on the task record. */
const STAT_LIMIT = 600

/** The directory every worktree of this project lives under. */
export function baseDirectory(home: string): string {
  return join(home, ".opencode", "workflows", "worktrees")
}

/** The worktree of one task. A retry of that task reuses the path. */
export function worktreePath(home: string, runId: string, taskId: string): string {
  return join(baseDirectory(home), runId, taskId)
}

/** The patch a settled worktree leaves behind, next to the run mirror. */
export function patchPath(home: string, runId: string, taskId: string): string {
  return join(home, ".opencode", "workflows", "runs", runId, `${taskId}.patch`)
}

/**
 * Creates the worktree of one task, detached at `HEAD`.
 *
 * A path left behind by an earlier attempt, or by a restart, is removed first. The base
 * directory carries a `.gitignore` of `*`, so the checkout it lives in does not see it.
 */
export async function create(options: { home: string; runId: string; taskId: string }): Promise<CreateResult> {
  const path = worktreePath(options.home, options.runId, options.taskId)
  try {
    const base = baseDirectory(options.home)
    await mkdir(base, { recursive: true })
    await writeFile(join(base, ".gitignore"), "*\n", "utf8")
    if (await exists(path)) await remove(options.home, path)
    const result = await git(options.home, ["worktree", "add", "--detach", "--", path, "HEAD"])
    if (result.code !== 0) return { ok: false, error: firstLine(result.stderr || result.stdout) }
    return { ok: true, path }
  } catch (error) {
    return { ok: false, error: firstLine(error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * Saves what the member changed and takes the worktree down.
 *
 * Everything is staged, so a new file counts as an edit, and the staged diff against
 * `HEAD` becomes the patch. An empty diff writes no file. The worktree is removed unless
 * the task asked to keep it, and a failed removal is recorded instead of thrown.
 */
export async function settle(options: {
  home: string
  runId: string
  taskId: string
  path: string
  keep: boolean
}): Promise<WorktreeRecord> {
  const record: WorktreeRecord = { path: options.path, kept: options.keep, stat: "" }
  try {
    await git(options.path, ["add", "-A"])
    const diff = await git(options.path, ["diff", "--cached", "HEAD"])
    const patch = patchPath(options.home, options.runId, options.taskId)
    if (diff.code === 0 && diff.stdout.trim()) {
      await mkdir(join(options.home, ".opencode", "workflows", "runs", options.runId), { recursive: true })
      await writeFile(patch, diff.stdout, "utf8")
      record.patch = patch
    } else {
      // A retry that changed nothing must not leave the patch of the attempt before it.
      await unlink(patch).catch(() => {})
    }
    const summary = await git(options.path, ["diff", "--cached", "--stat", "HEAD"])
    record.stat = clip(summary.stdout.trim(), STAT_LIMIT)
  } catch (error) {
    record.stat = clip(`patch failed: ${firstLine(error instanceof Error ? error.message : String(error))}`, STAT_LIMIT)
  }
  if (options.keep) return record
  const failure = await remove(options.home, options.path)
  if (failure) {
    swallow("a worktree removal")(failure)
    record.stat = clip([record.stat, `remove failed: ${failure}`].filter(Boolean).join("\n"), STAT_LIMIT)
  }
  return record
}

/**
 * Takes a worktree down and forgets it.
 *
 * Answers with the first line of the failure, or nothing when the path is gone. A path
 * that git does not know as a worktree is removed as a plain directory, so a half-created
 * one cannot block the next attempt.
 */
export async function remove(home: string, path: string): Promise<string | undefined> {
  try {
    const removed = await git(home, ["worktree", "remove", "--force", "--", path])
    await git(home, ["worktree", "prune"])
    if (await exists(path)) {
      await rm(path, { recursive: true, force: true })
      if (await exists(path)) return firstLine(removed.stderr || removed.stdout) || "the worktree is still there"
    }
    // The last worktree of a run leaves an empty directory of its own behind.
    await rmdir(dirname(path)).catch(() => {})
    return undefined
  } catch (error) {
    return firstLine(error instanceof Error ? error.message : String(error))
  }
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([text(child.stdout), text(child.stderr)])
  return { code: await child.exited, stdout, stderr }
}

function text(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
  if (!stream || typeof stream === "number") return Promise.resolve("")
  return new Response(stream).text().catch(() => "")
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? ""
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[cut at ${limit} characters]`
}
