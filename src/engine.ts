import type { Mailbox } from "./mailbox.js"
import type { RunStore } from "./persistence.js"
import type { Roster } from "./roster.js"
import type { Runner } from "./runner.js"
import type { Spawner } from "./spawner.js"

/**
 * The one engine every plugin instance of a project shares.
 *
 * A worktree task is moved into another directory, and core serves a session from the
 * plugin instance of its current directory. That instance has to see the same roster, the
 * same mailbox, and the same run records as the one that started the run, or it does not
 * know that the session is a member of a run.
 *
 * The plugin module is imported once per process, so this map is shared by every location
 * instance. It is keyed by the storage prefix, which is the same for a repository and its
 * worktrees, and counted, so the engine is disposed only when the last instance goes.
 *
 * A run is anchored to the directory of the session that started it, kept on its record.
 * The directory of the instance that built the engine is only the fallback for old records.
 */
export interface Engine {
  runs: RunStore
  roster: Roster
  spawner: Spawner
  mailbox: Mailbox
  runner: Runner
  /** The runs this process has a live loop for. The runner owns it. */
  live: Set<string>
}

interface Entry {
  engine: Engine
  refs: number
}

const engines = new Map<string, Entry>()

/** The engine of this prefix, plus whether this call built it. */
export function attach(prefix: string, build: () => Engine): { engine: Engine; first: boolean } {
  const entry = engines.get(prefix)
  if (entry) {
    entry.refs += 1
    return { engine: entry.engine, first: false }
  }
  const engine = build()
  engines.set(prefix, { engine, refs: 1 })
  return { engine, first: true }
}

/** Drops one reference. The last one disposes the engine. Never throws. */
export async function detach(prefix: string): Promise<void> {
  const entry = engines.get(prefix)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  engines.delete(prefix)
  entry.engine.mailbox.dispose()
  await entry.engine.runner.dispose()
}

/** Test hook: forgets every engine without disposing it. */
export function resetEngines(): void {
  engines.clear()
}
