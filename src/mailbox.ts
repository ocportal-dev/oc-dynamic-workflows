import type { WorkflowConfig } from "./config.js"
import { countTokens } from "./events.js"
import { swallow } from "./log.js"
import { findTask, type RunStore } from "./persistence.js"
import { escapeAttribute, escapeText } from "./report.js"
import type { Member, Roster } from "./roster.js"
import type { MailEvent, PhaseSpec, RunRecord, TaskRecord } from "./types.js"

/** `ctx.session`, reduced to the calls the mailbox makes. */
export interface MailboxSession {
  get: (input: { sessionID: string }) => Promise<{ cost?: number; tokens?: unknown } | undefined>
  synthetic: (input: {
    sessionID: string
    text: string
    description?: string
    delivery?: "steer" | "queue"
    resume?: boolean
  }) => Promise<unknown>
  prompt: (input: { sessionID: string; text: string; delivery?: "steer" | "queue" }) => Promise<unknown>
  interrupt: (input: { sessionID: string; continue: boolean }) => Promise<unknown>
}

export interface MailboxDeps {
  session: MailboxSession
  store: RunStore
  roster: Roster
  config: WorkflowConfig
  /** How long a burst of questions is collected before the lead is woken once. */
  debounceMs?: number
  /** Told before a forced steer, because the interrupt also rejects the spawn promise. */
  onForcedSteer?: (runId: string, taskId: string) => void
  /** Told after a wake was charged, so the runner can read the budget cap again. */
  onSpend?: (runId: string) => Promise<void>
}

export type MailResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface RosterEntry {
  taskId: string
  sessionID?: string
  status: TaskRecord["status"]
}

export interface SteerResult {
  mail: MailEvent
  /** Whether the member session was there to take the steer at once. */
  delivered: boolean
  interrupted: boolean
}

/** A message body never travels longer than this. */
const BODY_LIMIT = 2000
/** The digest the lead reads, and the mail a member reads, are capped together. */
const DIGEST_LIMIT = 16_384
const DEBOUNCE_MS = 2000
/** The ceiling on a phase mailbox, whatever the spec or the options ask for. */
const MAX_MESSAGES = 50

/**
 * The hub mailbox of a `team` phase.
 *
 * A member sends to the lead, the lead steers one member, and the lead reads its unread
 * mail. The mailbox is open only while its phase runs: a send that arrives before the
 * phase starts, after it ended, or past the message cap is refused with what to do
 * instead.
 *
 * A `question` wakes the lead, but a burst of questions is collected for two seconds and
 * becomes one wake. A `status` or a `result` is admitted with `resume: false`, so it lands
 * in the lead's transcript without starting a turn. One more wake carries the digest of
 * the unread mail when the phase joins.
 */
export class Mailbox {
  #deps: MailboxDeps
  /** run id → the team phase that is open right now. */
  #open = new Map<string, { phaseId: string; taskIds: Set<string> }>()
  /** run id → the mail of that run, newest last. Memory is the fast path. */
  #mail = new Map<string, MailEvent[]>()
  /** run id → the questions waiting for the debounce to end. */
  #pending = new Map<string, { ids: string[]; timer: ReturnType<typeof setTimeout> }>()
  /** inbox item id → the mail it carried, so `session.inbox.delivered` can mark it. */
  #inbox = new Map<string, { runId: string; mailId: string }>()
  /**
   * run id → the lead's usage when the mailbox opened, and the phase that opened it.
   *
   * Every wake is billed against the baseline. A second team phase takes a new baseline,
   * so the spend is kept per phase and the run adds them up.
   */
  #baseline = new Map<string, { usd: number; tokens: number; phaseId: string }>()
  #counter = 0

  constructor(deps: MailboxDeps) {
    this.#deps = deps
  }

  /** Opens the mailbox for one team phase and resets the message count. */
  async open(run: RunRecord, phase: PhaseSpec): Promise<void> {
    const asked = phase.mailbox?.maxMessages ?? this.#deps.config.mailboxMaxMessages
    run.mailbox = { maxMessages: Math.min(Math.max(Math.floor(asked), 1), MAX_MESSAGES), used: 0 }
    this.#open.set(run.runId, { phaseId: phase.id, taskIds: new Set(phase.tasks.map((task) => task.id)) })
    this.#baseline.set(run.runId, { ...(await this.#leadUsage(run)), phaseId: phase.id })
    await this.#deps.store.put(run)
  }

  /** Closes the mailbox and wakes the lead once with the mail it has not read. */
  async close(runId: string): Promise<void> {
    const open = this.#open.get(runId)
    if (!open) return
    this.#open.delete(runId)
    this.#cancelPending(runId)
    const run = await this.#deps.store.get(runId)
    if (!run) return
    const unread = this.#unread(runId)
    if (unread.length === 0) return
    await this.#wake(run, unread, `unread mail of the team phase ${open.phaseId}`)
  }

  /** Stops the debounce timers. The cleanup path calls it and it never throws. */
  dispose(): void {
    for (const runId of [...this.#pending.keys()]) this.#cancelPending(runId)
  }

  /** A member sends to the lead. The gate names what to do instead of every refusal. */
  async send(input: {
    sessionID: string
    type: "status" | "question" | "result"
    body: string
    ref?: string
    runId?: string
  }): Promise<MailResult<MailEvent>> {
    const member = await this.#deps.roster.resolveMember(input.sessionID).catch(() => undefined)
    if (!member) {
      return {
        ok: false,
        error:
          "team_send is for a member of a team phase. If you lead a run, use team_steer to reach a member and team_inbox to read your mail.",
      }
    }
    if (input.runId && input.runId !== member.runId) {
      return { ok: false, error: `you belong to run ${member.runId}, not to ${input.runId}; leave "runId" out` }
    }
    const gate = await this.#openRun(member.runId, member.taskId)
    if (!gate.ok) return gate
    const run = gate.value
    if (run.mailbox.used >= run.mailbox.maxMessages) {
      return {
        ok: false,
        error: `the mailbox of run ${run.runId} is full at ${run.mailbox.maxMessages} messages; put what is left in your final reply instead`,
      }
    }

    const mail = this.#record(run, {
      taskId: member.taskId,
      direction: "member_to_lead",
      type: input.type,
      body: input.body,
      ref: input.ref,
    })
    await this.#persist(run, mail)
    if (input.type === "question") this.#schedule(run, mail)
    else await this.#admit(run, mail)
    return { ok: true, value: mail }
  }

  /** The lead steers one member. A soft steer lands at the member's next step boundary. */
  async steer(input: {
    sessionID: string
    taskId: string
    body: string
    force?: boolean
    runId?: string
  }): Promise<MailResult<SteerResult>> {
    const lead = await this.#lead(input.sessionID, input.runId)
    if (!lead.ok) return lead
    const run = lead.value
    const task = findTask(run, input.taskId)
    if (!task) {
      const known = this.#taskIds(run).join(", ")
      return { ok: false, error: `run ${run.runId} has no task "${input.taskId}"; its tasks are ${known}` }
    }
    const gate = await this.#openRun(run.runId, input.taskId)
    if (!gate.ok) return gate
    if (run.mailbox.used >= run.mailbox.maxMessages) {
      return {
        ok: false,
        error: `the mailbox of run ${run.runId} is full at ${run.mailbox.maxMessages} messages; wait for the report instead`,
      }
    }
    const open = this.#reachable(run, task)
    if (!open.ok) return open

    const mail = this.#record(run, {
      taskId: task.taskId,
      direction: "lead_to_member",
      type: "steer",
      body: input.body,
      force: input.force,
    })
    let interrupted = false
    let delivered = false
    if (task.sessionID && task.status === "running") {
      if (input.force) {
        this.#deps.onForcedSteer?.(run.runId, task.taskId)
        await this.#deps.session.interrupt({ sessionID: task.sessionID, continue: true }).catch(() => {})
        interrupted = true
      }
      const admitted = await this.#deps.session
        .prompt({ sessionID: task.sessionID, text: envelope(run.runId, mail), delivery: "steer" })
        .catch(() => undefined)
      if (admitted) {
        delivered = true
        mail.deliveredAt = new Date().toISOString()
        const inboxID = (admitted as { id?: unknown }).id
        if (typeof inboxID === "string") this.#inbox.set(inboxID, { runId: run.runId, mailId: mail.id })
      }
    }
    await this.#persist(run, mail)
    await this.#chargeMember(run, task)
    return { ok: true, value: { mail, delivered, interrupted } }
  }

  /** The unread mail of the lead, marked read, plus the roster of the run. */
  async inbox(input: { sessionID: string; runId?: string }): Promise<
    MailResult<{ mail: MailEvent[]; roster: RosterEntry[]; run: RunRecord }>
  > {
    const lead = await this.#lead(input.sessionID, input.runId)
    if (!lead.ok) return lead
    const run = lead.value
    const mail = this.#unread(run.runId)
    const readAt = new Date().toISOString()
    for (const item of mail) {
      item.readAt = readAt
      item.deliveredAt ??= readAt
      await this.#deps.store.putMail(item)
    }
    const roster = run.phases.flatMap((phase) =>
      phase.tasks.map((task) => ({ taskId: task.taskId, sessionID: task.sessionID, status: task.status })),
    )
    return { ok: true, value: { mail, roster, run } }
  }

  /**
   * The mail a member has not been given yet, as one system part.
   *
   * The context hook calls this on every model request, so it only reads: mail queued
   * before the member session existed stays queued until the lead's steer is admitted or
   * `session.inbox.delivered` arrives.
   */
  pendingSystemParts(member: Member): { type: "text"; text: string }[] {
    const waiting = (this.#mail.get(member.runId) ?? []).filter(
      (mail) => mail.direction === "lead_to_member" && mail.taskId === member.taskId && !mail.deliveredAt,
    )
    if (waiting.length === 0) return []
    return [{ type: "text", text: ["Mail from the lead of your workflow run.", digest(member.runId, waiting)].join("\n") }]
  }

  /** `session.inbox.delivered` names the item, which names the mail it carried. */
  observeDelivered(inboxID: string): void {
    const found = this.#inbox.get(inboxID)
    if (!found) return
    this.#inbox.delete(inboxID)
    const mail = (this.#mail.get(found.runId) ?? []).find((candidate) => candidate.id === found.mailId)
    if (!mail || mail.deliveredAt) return
    mail.deliveredAt = new Date().toISOString()
    this.#deps.store.putMail(mail).catch(swallow("a mail write"))
  }

  /** Every mail of one run, oldest first. */
  list(runId: string): MailEvent[] {
    return [...(this.#mail.get(runId) ?? [])]
  }

  #taskIds(run: RunRecord): string[] {
    return run.phases.flatMap((phase) => phase.tasks.map((task) => task.taskId))
  }

  /** The send-side gate: the run runs, the phase is the open one, and the task is in it. */
  async #openRun(runId: string, taskId: string): Promise<MailResult<RunRecord>> {
    const run = await this.#deps.store.get(runId)
    if (!run) return { ok: false, error: `no run named ${runId}` }
    if (run.status !== "running") {
      return {
        ok: false,
        error: `run ${runId} is ${run.status}, so its mailbox is closed; reply with your result instead`,
      }
    }
    const open = this.#open.get(runId)
    if (!open) return { ok: false, error: `run ${runId} has no team phase open; reply with your result instead` }
    if (!open.taskIds.has(taskId)) {
      return {
        ok: false,
        error: `task "${taskId}" is not part of the open team phase ${open.phaseId}; only its tasks can use the mailbox`,
      }
    }
    return { ok: true, value: run }
  }

  /** Only the session that started a run may steer it or read its mail. */
  async #lead(sessionID: string, runId?: string): Promise<MailResult<RunRecord>> {
    const member = await this.#deps.roster.resolveMember(sessionID).catch(() => undefined)
    if (member) {
      return {
        ok: false,
        error: `you are task "${member.taskId}" of workflow run ${member.runId}, and a task cannot steer or read the mailbox; use team_send to reach the lead`,
      }
    }
    const id = runId ?? this.#deps.roster.runOf(sessionID)
    if (!id) return { ok: false, error: 'pass "runId": this session leads no workflow run' }
    const run = await this.#deps.store.get(id)
    if (!run) return { ok: false, error: `no run named ${id}` }
    if (run.leadSessionID !== sessionID) {
      return { ok: false, error: `run ${id} is led by another session, so it cannot be steered from here` }
    }
    return { ok: true, value: run }
  }

  /** A steer reaches a member that still has a turn left. */
  #reachable(run: RunRecord, task: TaskRecord): MailResult<true> {
    if (task.status === "running" || task.status === "pending") return { ok: true, value: true }
    const spec = run.spec.phases.flatMap((phase) => phase.tasks).find((candidate) => candidate.id === task.taskId)
    if (task.status === "failed" && task.attempts <= (spec?.retries ?? 0)) return { ok: true, value: true }
    return {
      ok: false,
      error: `task "${task.taskId}" is ${task.status}, so it has no turn left to take a steer; read its output in the run report or start a new run`,
    }
  }

  #record(run: RunRecord, fields: Omit<MailEvent, "id" | "runId" | "createdAt" | "body"> & { body: string }): MailEvent {
    this.#counter += 1
    const mail: MailEvent = {
      ...fields,
      id: `mail_${Date.now().toString(36)}${this.#counter.toString(36)}`,
      runId: run.runId,
      body: clip(fields.body, BODY_LIMIT),
      createdAt: new Date().toISOString(),
    }
    const list = this.#mail.get(run.runId) ?? []
    list.push(mail)
    this.#mail.set(run.runId, list)
    return mail
  }

  async #persist(run: RunRecord, mail: MailEvent): Promise<void> {
    run.mailbox.used += 1
    await this.#deps.store.putMail(mail)
    await this.#deps.store.put(run)
  }

  /** A status or a result is admitted without a wake, so the lead reads it next turn. */
  async #admit(run: RunRecord, mail: MailEvent): Promise<void> {
    await this.#deps.session
      .synthetic({
        sessionID: run.leadSessionID,
        delivery: "steer",
        resume: false,
        description: "workflow mail",
        text: envelope(run.runId, mail),
      })
      .catch(() => {
        // The lead may be gone. The mail is stored either way.
      })
    mail.deliveredAt = new Date().toISOString()
    await this.#deps.store.putMail(mail).catch(() => {})
  }

  #schedule(run: RunRecord, mail: MailEvent): void {
    const pending = this.#pending.get(run.runId)
    if (pending) {
      pending.ids.push(mail.id)
      return
    }
    // A timer callback cannot throw, so the flush ends in its own catch.
    const timer = setTimeout(() => {
      this.#flush(run.runId).catch(swallow("a mailbox flush"))
    }, this.#deps.debounceMs ?? DEBOUNCE_MS)
    timer.unref?.()
    this.#pending.set(run.runId, { ids: [mail.id], timer })
  }

  #cancelPending(runId: string): void {
    const pending = this.#pending.get(runId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(runId)
  }

  async #flush(runId: string): Promise<void> {
    const pending = this.#pending.get(runId)
    if (!pending) return
    this.#pending.delete(runId)
    const run = await this.#deps.store.get(runId).catch(() => undefined)
    if (!run) return
    const list = this.#mail.get(runId) ?? []
    const mail = pending.ids
      .map((id) => list.find((candidate) => candidate.id === id))
      .filter((item): item is MailEvent => item !== undefined)
    if (mail.length === 0) return
    await this.#wake(run, mail, `${mail.length} question(s) from the team`)
  }

  /** One synthetic, delivery "steer", so an idle lead starts a turn and a busy one waits. */
  async #wake(run: RunRecord, mail: MailEvent[], reason: string): Promise<void> {
    const text = [
      `Workflow run ${run.runId}: ${reason}.`,
      "Use team_inbox to read it, team_steer to answer a member, and workflow_status for the tree.",
      digest(run.runId, mail),
    ].join("\n")
    await this.#deps.session
      .synthetic({ sessionID: run.leadSessionID, delivery: "steer", description: "workflow mail", text })
      .catch(() => {
        // The lead may be gone. The mail is stored either way.
      })
    const deliveredAt = new Date().toISOString()
    for (const item of mail) {
      item.deliveredAt ??= deliveredAt
      await this.#deps.store.putMail(item).catch(() => {})
    }
    await this.#chargeLead(run)
  }

  #unread(runId: string): MailEvent[] {
    return (this.#mail.get(runId) ?? []).filter((mail) => mail.direction === "member_to_lead" && !mail.readAt)
  }

  async #leadUsage(run: RunRecord): Promise<{ usd: number; tokens: number }> {
    const info = await this.#deps.session.get({ sessionID: run.leadSessionID }).catch(() => undefined)
    return { usd: typeof info?.cost === "number" ? info.cost : 0, tokens: countTokens(info?.tokens) }
  }

  /** A wake buys a lead turn, so the run pays for what the lead spent since it opened. */
  async #chargeLead(run: RunRecord): Promise<void> {
    const baseline = this.#baseline.get(run.runId)
    if (!baseline) return
    const now = await this.#leadUsage(run)
    await this.#deps.store.recordMailUsage(run.runId, baseline.phaseId, {
      usd: Math.max(0, now.usd - baseline.usd),
      tokens: Math.max(0, now.tokens - baseline.tokens),
    })
    await this.#deps.onSpend?.(run.runId).catch(() => {})
  }

  /** A steer buys a member step, and the member session carries the whole count. */
  async #chargeMember(run: RunRecord, task: TaskRecord): Promise<void> {
    if (!task.sessionID) return
    const info = await this.#deps.session.get({ sessionID: task.sessionID }).catch(() => undefined)
    if (!info) return
    await this.#deps.store.recordUsage(run.runId, task.taskId, task.sessionID, {
      usd: typeof info.cost === "number" ? info.cost : 0,
      tokens: countTokens(info.tokens),
    })
  }
}

/**
 * The envelope every mail travels in.
 *
 * The body was written by a model, so its markup is escaped and every attribute value
 * with it. A member cannot close the envelope, forge a second one, or hide its task id.
 */
export function envelope(runId: string, mail: MailEvent): string {
  const attributes = [
    `run="${escapeAttribute(runId)}"`,
    `from="${escapeAttribute(mail.direction === "lead_to_member" ? "lead" : mail.taskId)}"`,
    `type="${escapeAttribute(mail.type)}"`,
    `id="${escapeAttribute(mail.id)}"`,
    mail.ref ? `ref="${escapeAttribute(mail.ref)}"` : undefined,
  ].filter((part): part is string => part !== undefined)
  return [`<workflow-mail ${attributes.join(" ")}>`, escapeText(clip(mail.body, BODY_LIMIT)), "</workflow-mail>"].join(
    "\n",
  )
}

/** The envelopes of several messages, oldest dropped first when they do not fit. */
export function digest(runId: string, mail: MailEvent[]): string {
  const parts: string[] = []
  let size = 0
  for (const item of [...mail].reverse()) {
    const text = envelope(runId, item)
    if (size + text.length > DIGEST_LIMIT) {
      parts.unshift(`[${mail.length - parts.length} older message(s) left out; use team_inbox]`)
      break
    }
    size += text.length + 1
    parts.unshift(text)
  }
  return parts.join("\n")
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[cut at ${limit} characters]`
}
