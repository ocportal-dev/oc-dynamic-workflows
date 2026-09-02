/**
 * Maps a run to its lead session and its member sessions.
 *
 * A member is discovered from `session.created`, which carries `parentID` and `title`.
 * The title is the spawn description, so it also carries the run and the task. Memory is
 * lost on reload, so a lookup that misses falls back to `ctx.session.get`.
 */
export interface Member {
  runId: string
  taskId: string
  sessionID: string
}

export interface SessionCreated {
  sessionID: string
  parentID?: string
  title?: string
}

/** `ctx.session.get`, reduced to the two fields the roster reads. */
export type SessionLookup = (sessionID: string) => Promise<{ parentID?: string; title?: string } | undefined>

const PREFIX = "wf:"

/** The child session title. Unique per attempt, so a retry gets its own child. */
export function describeTask(runId: string, taskId: string, attempt: number): string {
  return attempt > 1 ? `${PREFIX}${runId}:${taskId}#${attempt}` : `${PREFIX}${runId}:${taskId}`
}

/** Reads a run and a task back out of a child session title. */
export function parseDescription(title: string | undefined): { runId: string; taskId: string } | undefined {
  if (!title || !title.startsWith(PREFIX)) return undefined
  const rest = title.slice(PREFIX.length)
  const split = rest.indexOf(":")
  if (split <= 0) return undefined
  const taskId = rest.slice(split + 1).replace(/#\d+$/, "")
  if (!taskId) return undefined
  return { runId: rest.slice(0, split), taskId }
}

export class Roster {
  /** lead session id → run id. */
  #leads = new Map<string, string>()
  /** child session id → member. */
  #members = new Map<string, Member>()
  /** spawn description → child session id. */
  #children = new Map<string, string>()
  /** spawn description → the waiter that `expect` is holding. */
  #waiting = new Map<string, (sessionID: string) => void>()
  #lookup: SessionLookup

  constructor(lookup: SessionLookup) {
    this.#lookup = lookup
  }

  registerLead(runId: string, leadSessionID: string): void {
    this.#leads.set(leadSessionID, runId)
  }

  /** The run a lead session started, or nothing when it leads none. */
  runOf(sessionID: string): string | undefined {
    return this.#leads.get(sessionID)
  }

  /** Resolves as soon as the matching `session.created` arrives. */
  expect(description: string): Promise<string> {
    const known = this.#children.get(description)
    if (known) return Promise.resolve(known)
    return new Promise((resolve) => this.#waiting.set(description, resolve))
  }

  /** Drops a waiter whose task settled without a `session.created`. */
  forget(description: string): void {
    this.#waiting.delete(description)
    this.#children.delete(description)
  }

  observeCreated(event: SessionCreated): void {
    if (!event.title || !event.parentID) return
    if (!this.#leads.has(event.parentID)) return
    const parsed = parseDescription(event.title)
    if (!parsed) return
    this.#children.set(event.title, event.sessionID)
    this.#members.set(event.sessionID, { ...parsed, sessionID: event.sessionID })
    const waiter = this.#waiting.get(event.title)
    if (waiter) {
      this.#waiting.delete(event.title)
      waiter(event.sessionID)
    }
  }

  /** Records a child the executor reported but no event announced. */
  bind(runId: string, taskId: string, sessionID: string): void {
    this.#members.set(sessionID, { runId, taskId, sessionID })
  }

  member(sessionID: string): Member | undefined {
    return this.#members.get(sessionID)
  }

  /** The same lookup, but it asks the server when memory has no answer. */
  async resolveMember(sessionID: string): Promise<Member | undefined> {
    const known = this.#members.get(sessionID)
    if (known) return known
    const info = await this.#lookup(sessionID).catch(() => undefined)
    if (!info?.parentID || !this.#leads.has(info.parentID)) return undefined
    const parsed = parseDescription(info.title)
    if (!parsed) return undefined
    const member = { ...parsed, sessionID }
    this.#members.set(sessionID, member)
    return member
  }
}
