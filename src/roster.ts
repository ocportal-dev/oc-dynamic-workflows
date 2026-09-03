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

/** A visible phase synthesis child, distinct from task members. */
export interface SynthesisMember {
  runId: string
  phaseId: string
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

/** The child session title for synthesis. Unique per run and phase, so concurrent runs never collide. */
export function describeSynthesis(runId: string, phaseId: string): string {
  return `workflow synthesis: ${runId}:${phaseId}`
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
  /** Synthesis descriptions cannot use the task-title grammar, so they have their own map. */
  #expectedSyntheses = new Map<string, { runId: string; phaseId: string }>()
  #synthesisWaiting = new Map<string, (sessionID: string) => void>()
  /** child session id → visible synthesis. Kept apart from task members. */
  #syntheses = new Map<string, SynthesisMember>()
  /** session id → the time its miss expires. A session with no run costs one lookup per interval. */
  #misses = new Map<string, number>()
  #lookup: SessionLookup
  #missTtlMs: number
  #now: () => number

  constructor(lookup: SessionLookup, options: { missTtlMs?: number; now?: () => number } = {}) {
    this.#lookup = lookup
    this.#missTtlMs = options.missTtlMs ?? 10_000
    this.#now = options.now ?? Date.now
  }

  registerLead(runId: string, leadSessionID: string): void {
    this.#leads.set(leadSessionID, runId)
    // A miss can be a child whose parent was not a lead yet, and a resume re-homes the lead.
    this.#misses.clear()
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

  /** Waits for a synthesis child announced under its human-readable title. */
  expectSynthesis(runId: string, phaseId: string, description: string): Promise<string> {
    this.#expectedSyntheses.set(description, { runId, phaseId })
    const known = this.#children.get(description)
    if (known) return Promise.resolve(known)
    return new Promise((resolve) => this.#synthesisWaiting.set(description, resolve))
  }

  /** Drops a synthesis waiter once its spawn has settled. */
  forgetSynthesis(description: string): void {
    this.#expectedSyntheses.delete(description)
    this.#synthesisWaiting.delete(description)
    this.#children.delete(description)
  }

  observeCreated(event: SessionCreated): void {
    if (!event.title || !event.parentID) return
    if (!this.#leads.has(event.parentID)) return
    const synthesis = this.#expectedSyntheses.get(event.title)
    if (synthesis) {
      this.#children.set(event.title, event.sessionID)
      this.#misses.delete(event.sessionID)
      this.#syntheses.set(event.sessionID, { ...synthesis, sessionID: event.sessionID })
      const waiter = this.#synthesisWaiting.get(event.title)
      if (waiter) {
        this.#synthesisWaiting.delete(event.title)
        waiter(event.sessionID)
      }
      return
    }
    const parsed = parseDescription(event.title)
    if (!parsed) return
    this.#children.set(event.title, event.sessionID)
    this.#misses.delete(event.sessionID)
    this.#members.set(event.sessionID, { ...parsed, sessionID: event.sessionID })
    const waiter = this.#waiting.get(event.title)
    if (waiter) {
      this.#waiting.delete(event.title)
      waiter(event.sessionID)
    }
  }

  /** Records a child the executor reported but no event announced. */
  bind(runId: string, taskId: string, sessionID: string): void {
    this.#misses.delete(sessionID)
    this.#members.set(sessionID, { runId, taskId, sessionID })
  }

  /** Records a synthesis session the executor returned before its create event was observed. */
  bindSynthesis(runId: string, phaseId: string, sessionID: string): void {
    this.#misses.delete(sessionID)
    this.#syntheses.set(sessionID, { runId, phaseId, sessionID })
  }

  member(sessionID: string): Member | undefined {
    return this.#members.get(sessionID)
  }

  synthesis(sessionID: string): SynthesisMember | undefined {
    return this.#syntheses.get(sessionID)
  }

  /**
   * The same lookup, but it asks the server when memory has no answer.
   *
   * A miss is remembered for `missTtlMs`, because the context hook calls this on every
   * model request of every session. A lookup that failed while the server was busy is
   * therefore answered again once that time has passed.
   */
  async resolveMember(sessionID: string): Promise<Member | undefined> {
    const known = this.#members.get(sessionID)
    if (known) return known
    const expires = this.#misses.get(sessionID)
    if (expires !== undefined && expires > this.#now()) return undefined
    const info = await this.#lookup(sessionID).catch(() => undefined)
    const parsed = info?.parentID && this.#leads.has(info.parentID) ? parseDescription(info.title) : undefined
    if (!parsed) {
      this.#misses.set(sessionID, this.#now() + this.#missTtlMs)
      return undefined
    }
    this.#misses.delete(sessionID)
    const member = { ...parsed, sessionID }
    this.#members.set(sessionID, member)
    return member
  }
}
