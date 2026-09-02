import { swallow } from "./log.js"
import { findTask, type RunStore } from "./persistence.js"
import type { Roster } from "./roster.js"

/** `ctx.event.subscribe`, reduced to what the consumer needs. */
export type Subscribe = (options: { signal: AbortSignal }) => AsyncIterable<unknown>

export interface EventDeps {
  subscribe: Subscribe
  roster: Roster
  store: RunStore
  signal: AbortSignal
  /** Marks a steer delivered once the member's inbox took it. */
  mailbox?: { observeDelivered: (inboxID: string) => void }
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]

/**
 * Reads the event stream for as long as the plugin is loaded.
 *
 * `session.created` names the child of a spawn. `session.usage.updated` keeps the run
 * record's spend current between task settles. `session.execution.failed` records why a
 * member stopped. `session.inbox.delivered` marks a steer as taken. The permission events
 * say what a member waits for and whether the user refused it. The stream can end on its
 * own, so the loop resubscribes with a backoff.
 */
export async function consumeEvents(deps: EventDeps): Promise<void> {
  let failures = 0
  while (!deps.signal.aborted) {
    try {
      for await (const event of deps.subscribe({ signal: deps.signal })) {
        failures = 0
        // One event that fails must not end the stream: the next `session.created` still
        // has to name its child.
        try {
          await route(event, deps)
        } catch (error) {
          swallow("an event handler")(error)
        }
      }
    } catch {
      // An aborted or broken stream is expected; the loop below decides what to do next.
    }
    if (deps.signal.aborted) return
    const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!
    failures += 1
    await sleep(delay, deps.signal)
  }
}

async function route(event: unknown, deps: EventDeps): Promise<void> {
  if (!event || typeof event !== "object") return
  const { type, data } = event as { type?: unknown; data?: unknown }
  if (typeof type !== "string" || !data || typeof data !== "object") return
  const payload = data as Record<string, unknown>
  const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : undefined
  if (!sessionID) return

  if (type === "session.created") {
    deps.roster.observeCreated({
      sessionID,
      parentID: typeof payload.parentID === "string" ? payload.parentID : undefined,
      title: typeof payload.title === "string" ? payload.title : undefined,
    })
    return
  }

  if (type === "session.inbox.delivered") {
    const inboxID = payload.inboxID
    if (typeof inboxID === "string") deps.mailbox?.observeDelivered(inboxID)
    return
  }

  if (type === "session.usage.updated") {
    const member = deps.roster.member(sessionID)
    if (!member) return
    await deps.store.recordUsage(member.runId, member.taskId, sessionID, {
      usd: typeof payload.cost === "number" ? payload.cost : 0,
      tokens: countTokens(payload.tokens),
    })
    return
  }

  // A member cannot answer a permission itself, so the user did. The task line says what
  // it waits for, and a refusal is recorded, because it stops the member right after.
  if (type === "permission.asked" || type === "permission.replied") {
    const member = deps.roster.member(sessionID)
    if (!member) return
    const run = await deps.store.get(member.runId)
    const task = run && findTask(run, member.taskId)
    if (!run || !task) return
    if (type === "permission.asked") {
      const resource = Array.isArray(payload.resources) ? payload.resources.join(" ") : ""
      task.asked = { requestID: String(payload.id ?? ""), action: String(payload.action ?? ""), resource }
    } else {
      const asked = task.asked
      task.asked = undefined
      const requestID = String(payload.requestID ?? "")
      if (payload.reply === "reject") {
        // The ask names what was refused; a reply without one leaves only the id.
        const named = asked?.requestID === requestID ? asked : undefined
        task.rejected = { requestID, action: named?.action, resource: named?.resource, at: new Date().toISOString() }
      }
    }
    await deps.store.put(run)
    return
  }

  if (type === "session.execution.failed") {
    const member = deps.roster.member(sessionID)
    if (!member) return
    const run = await deps.store.get(member.runId)
    if (!run) return
    const task = findTask(run, member.taskId)
    if (!task || task.error) return
    task.error = describeError(payload.error)
    await deps.store.put(run)
  }
}

/** The budget counts every token the model was billed for. */
export function countTokens(value: unknown): number {
  if (!value || typeof value !== "object") return 0
  const tokens = value as { input?: unknown; output?: unknown; reasoning?: unknown }
  return number(tokens.input) + number(tokens.output) + number(tokens.reasoning)
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function describeError(value: unknown): string {
  if (typeof value === "string") return value
  const message = (value as { message?: unknown } | undefined)?.message
  return typeof message === "string" ? message : "the member session failed"
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
