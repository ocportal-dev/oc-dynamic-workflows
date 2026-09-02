import process from "node:process"

/**
 * Runs a `kind: "shell"` task.
 *
 * The plugin runs inside the opencode process, so this is a plain child process. It does
 * NOT go through the permission rules, the classifier, or the shell hooks. The plugin
 * option `shellTasks` rejects shell tasks for people who do not want that.
 *
 * The command runs in its own process group, so a stop kills the grandchildren with it.
 * A grandchild that keeps the pipe open can otherwise hold the read open forever, so the
 * read races the stop and is dropped a moment after it.
 */
export interface ShellResult {
  exitCode: number
  /** Standard output and standard error, in that order, capped. */
  output: string
  timedOut: boolean
}

export interface ShellHandle {
  result: Promise<ShellResult>
  /** Kills the whole process group. Never throws, and may be called more than once. */
  cancel: () => void
}

export const SHELL_TIMEOUT_MS = 600_000
const MAX_OUTPUT = 8000
/** How long the output of a killed group is still collected. */
const DRAIN_MS = 1000

/** Starts the command and hands back the reader plus a stop that covers the group. */
export function startShell(options: { command: string; cwd: string; timeoutMs?: number }): ShellHandle {
  const child = Bun.spawn(["sh", "-c", options.command], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Its own process group, so a stop reaches every grandchild.
    detached: true,
  })

  let stopped = false
  let drain: (() => void) | undefined
  // Once the group was killed the read gets one moment to finish, then it is dropped.
  const dropped = new Promise<undefined>((resolve) => {
    drain = () => {
      const timer = setTimeout(() => resolve(undefined), DRAIN_MS)
      timer.unref?.()
    }
  })
  const cancel = (): void => {
    if (stopped) return
    stopped = true
    killGroup(child)
    drain?.()
  }

  const result = (async (): Promise<ShellResult> => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      cancel()
    }, options.timeoutMs ?? SHELL_TIMEOUT_MS)
    timer.unref?.()
    try {
      // A grandchild can hold the pipe open, so the read never waits past the stop.
      const read = Promise.all([text(child.stdout), text(child.stderr)])
      const collected = await Promise.race([read, dropped])
      const [stdout, stderr] = collected ?? ["", ""]
      const exitCode = collected ? await child.exited : -1
      return { exitCode, output: clip([stdout, stderr].filter(Boolean).join("").trim()), timedOut }
    } finally {
      clearTimeout(timer)
    }
  })()

  return { result, cancel }
}

/** The one-shot form. The caller that needs a stop uses `startShell` instead. */
export async function runShell(options: { command: string; cwd: string; timeoutMs?: number }): Promise<ShellResult> {
  return startShell(options).result
}

/**
 * Kills the process group, so a backgrounded grandchild goes with the shell.
 *
 * A negative pid names the group. The process may already be gone, and a platform may
 * refuse the group, so the child itself is the fallback and neither call throws.
 */
function killGroup(child: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): void {
  try {
    process.kill(-child.pid, "SIGKILL")
    return
  } catch {
    // No such group any more, or the platform refused it.
  }
  try {
    child.kill("SIGKILL")
  } catch {
    // The child already ended.
  }
}

function text(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
  if (!stream || typeof stream === "number") return Promise.resolve("")
  return new Response(stream).text().catch(() => "")
}

function clip(text: string): string {
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} characters]`
}
