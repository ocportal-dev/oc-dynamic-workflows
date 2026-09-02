import type { Mailbox } from "./mailbox.js"
import type { RunStore } from "./persistence.js"
import { renderProgress } from "./report.js"
import type { Roster } from "./roster.js"

/** The `context` hook event, reduced to the two fields this hook touches. */
export interface ContextEvent {
  sessionID: string
  tools: Record<string, unknown>
  system: { type: "text"; text: string }[]
}

export interface HookDeps {
  roster: Roster
  store: RunStore
  /** Reads the mail a member has not been given yet. This hook never writes to it. */
  mailbox?: Mailbox
}

/**
 * The tools a member session may not call.
 *
 * A member is a workflow task. It answers its prompt and stops. Starting another
 * workflow, cancelling one, or spawning further children is the lead's work. Deleting a
 * name here covers the direct path, where core rejects a call to a tool that was not in the
 * request. Under Code Mode the tool namespace is built from the registry instead, so this
 * map does not reach it, and every tool named here that this plugin owns refuses a member
 * in its own executor. `subagent` is core's tool, and it is not in that namespace.
 */
export const MEMBER_TOOLS = [
  "workflow_run",
  "workflow_run_saved",
  "workflow_resume",
  "workflow_cancel",
  "workflow_status",
  "workflow_doctor",
  "team_steer",
  "team_inbox",
  "subagent",
]

/** How many lines of the progress tree the lead carries on every request. */
const PROGRESS_LINES = 40

/**
 * Shapes the request of a session that belongs to a run.
 *
 * It fires on every model request, including a retry, so it reads state and never
 * writes any. It also never throws: a hook that rejects would break the request.
 */
export function contextHook(deps: HookDeps): (event: ContextEvent) => Promise<void> {
  return async (event) => {
    try {
      // A lead is known from memory, so only an unknown session pays for the lookup.
      const runId = deps.roster.runOf(event.sessionID)
      if (runId) {
        const run = await deps.store.get(runId)
        if (run?.status === "running") event.system.push({ type: "text", text: renderProgress(run, PROGRESS_LINES) })
        return
      }
      const member = await deps.roster.resolveMember(event.sessionID)
      if (!member) return
      for (const name of MEMBER_TOOLS) delete event.tools[name]
      // Mail the lead sent before this session existed. Reading it marks nothing.
      for (const part of deps.mailbox?.pendingSystemParts(member) ?? []) event.system.push(part)
    } catch {
      // A model request must not fail because the progress could not be read.
    }
  }
}
