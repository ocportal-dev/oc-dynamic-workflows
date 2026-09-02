import { budgetExceeded, overrideFor } from "./budget.js"
import type { ModelRef, WorkflowConfig } from "./config.js"
import { countTokens } from "./events.js"
import { swallow } from "./log.js"
import type { Mailbox } from "./mailbox.js"
import { extractJson, validateJson } from "./output-schema.js"
import { findTask, RunStore } from "./persistence.js"
import { describePermission, renderFinalReport, wrapUntrusted } from "./report.js"
import { describeTask, Roster } from "./roster.js"
import { type ShellHandle, startShell } from "./shell.js"
import { parseSpec } from "./spec.js"
import type { Spawner } from "./spawner.js"
import * as worktree from "./worktree.js"
import type {
  PhaseRecord,
  PhaseSpec,
  RepeatSpec,
  RoundRecord,
  RunRecord,
  TaskRecord,
  TaskSpec,
  WorkflowSpec,
} from "./types.js"

/** `ctx.session`, reduced to the calls the runner makes. */
export interface RunnerSession {
  get: (input: { sessionID: string }) => Promise<{ cost?: number; tokens?: unknown; outcome?: unknown } | undefined>
  interrupt: (input: { sessionID: string; continue: boolean }) => Promise<unknown>
  /** Moves a session to another directory. The move lands at its next step boundary. */
  move: (input: { sessionID: string; directory: string }) => Promise<unknown>
  synthetic: (input: {
    sessionID: string
    text: string
    description?: string
    delivery?: "steer" | "queue"
  }) => Promise<unknown>
  context: (input: { sessionID: string }) => Promise<unknown>
}

export interface RunnerDeps {
  session: RunnerSession
  store: RunStore
  roster: Roster
  spawner: Spawner
  config: WorkflowConfig
  /** The hub mailbox. Without it a `team` phase runs like a `parallel` one. */
  mailbox?: Mailbox
  /** The fallback home, used by a run whose record names no directory of its own. */
  directory: string
  /** The run ids this process has a loop for. Shared by every instance of the engine. */
  activeRuns?: Set<string>
  /** `ctx.generate.text`. Without it a phase cannot be synthesised. */
  generate?: (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>
  /** The clock the run limit reads. A test can move it. */
  now?: () => number
  /** How often a backgrounded member is asked whether it finished. */
  pollIntervalMs?: number
  /** How often the roster is asked for a child that timed out before it was named. */
  childPollMs?: number
  /** How long the move of an idle worktree member gets. */
  moveTimeoutMs?: number
}

export interface StartOptions {
  lead: string
  leadAgent: string
  /** The directory of the calling session. Becomes the home of the run. */
  directory?: string
  overrides?: { maxCostUsd?: number; maxTokens?: number; concurrency?: number }
  /** Resume only: task id → what the lead wants that task to do differently. */
  guidance?: Record<string, string>
}

export type CancelResult = { ok: true; runId: string; note?: string } | { ok: false; error: string }
export type ResumeResult = { ok: true; run: RunRecord; ignoredGuidance?: string[] } | { ok: false; error: string }

/** In-phase context is clipped harder than the raw member output. */
const CONTEXT_LIMIT = 4000
const CROSS_PHASE_LIMIT = 1000
const OUTPUT_LIMIT = 8000
const POLL_MS = 2000
/**
 * How long a member may look interrupted after a forced steer.
 *
 * The interrupt ends the running execution, so `Session.Info.outcome` reads
 * `interrupted` until the steered items start the next one. The member is given this long
 * to come back before the task is called cancelled.
 */
const FORCE_GRACE_MS = 30_000
/** How long a timed-out task waits for the roster to name its child, and how often. */
const CHILD_WAIT_POLLS = 20
const CHILD_POLL_MS = 500
/** The cheap turn that leaves a worktree member idle, so `#warmUpAndMove` can move it. */
const WARMUP_PROMPT = "Reply with the single word ready and call no tools."
/** How long that turn gets. Independent of the task clock, but counted against it. */
const WARMUP_TIMEOUT_MS = 60_000
/** How long the move of an idle member gets: the boot of the destination instance. */
const MOVE_TIMEOUT_MS = 60_000
/** How long a cancel waits for the run loop to settle before it answers anyway. */
const CANCEL_WAIT_MS = 15_000
/** One guidance text of a resume. It lands in a member prompt, so it is capped like mail. */
const GUIDANCE_LIMIT = 2000
/** One finding of a gate. It is kept on the record and read by the next round. */
const FINDING_LIMIT = 1000

/**
 * A task that is in flight, so a cancel, a budget stop, or the run clock can end it.
 *
 * An agent task is ended through its child session; a shell task has no session and is
 * ended by killing its process group.
 */
type Live =
  | { kind: "agent"; cancel: (childSessionID: string) => Promise<void>; sessionID?: string }
  | { kind: "shell"; cancel: () => void }

/**
 * Runs a workflow away from the tool call that started it.
 *
 * A tool call happens inside one step of the lead's turn, so the lead cannot read
 * anything until the call returns. `start` therefore returns a run id at once and the
 * phases run on their own. The lead learns the result from a synthetic message.
 *
 * A `sequential` phase stops at its first failed task. A `parallel` phase runs a worker
 * pool over a shared cursor and a failed task does not stop the other workers. A `team`
 * phase is that same pool with the mailbox open for its tasks.
 */
export class Runner {
  #deps: RunnerDeps
  #cancelled = new Set<string>()
  #expired = new Set<string>()
  /** Runs that hit their budget cap. Like `#expired`, but the report names the cap. */
  #overspent = new Set<string>()
  /** `runId:taskId` of a member the lead force-steered. Its spawn promise is doomed. */
  #forced = new Set<string>()
  #loops = new Map<string, Promise<void>>()
  /** The runs this process is driving right now. A second loop over one run is refused. */
  #active: Set<string>
  /** run id → task id → the task in flight, so `cancel` can end it. */
  #live = new Map<string, Map<string, Live>>()
  #disposed = false
  /** Aborted by `dispose`, so every sleep this runner is parked in returns at once. */
  #aborter = new AbortController()
  /** member session id → the waiter of the move into its worktree. */
  #moves = new Map<string, () => void>()

  constructor(deps: RunnerDeps) {
    this.#deps = deps
    this.#active = deps.activeRuns ?? new Set<string>()
  }

  /** Writes the run record, starts the loop, and returns without waiting for it. */
  async start(spec: WorkflowSpec, options: StartOptions): Promise<string> {
    const concurrency = clamp(options.overrides?.concurrency ?? this.#deps.config.concurrency, 1, 16)
    const run = newRun(spec, options, concurrency)
    this.#deps.roster.registerLead(run.runId, options.lead)
    await this.#deps.store.put(run)
    this.#launch(run)
    return run.runId
  }

  /**
   * Starts what a run has left, under the same run id.
   *
   * A completed task keeps its stored output and is not sent again, so the context of a
   * re-spawned task is rebuilt from the record. The caller becomes the new lead, which is
   * where the final report goes. The record is written before this returns.
   */
  async resume(runId: string, options: StartOptions): Promise<ResumeResult> {
    // A cancel can return before the parked loop has settled, so the record reads
    // `cancelled` while the loop still owns the run. The reservation is taken before the
    // first await, so two resumes of one run cannot both get past it.
    if (this.#active.has(runId) || this.#loops.has(runId)) {
      // The record turns terminal a moment before the loop lets go of the run, so a
      // resume that follows a report closely waits briefly for the loop to settle.
      const loop = this.#loops.get(runId)
      if (loop) await Promise.race([loop, new Promise((resolve) => setTimeout(resolve, 2000))])
      if (this.#active.has(runId) || this.#loops.has(runId)) {
        return {
          ok: false,
          error: `run ${runId} is already active in this process; it is still going, so wait for the report, or use workflow_status to look in and workflow_cancel to stop it`,
        }
      }
    }
    this.#active.add(runId)
    let launched = false
    try {
      const result = await this.#resume(runId, options)
      launched = result.ok
      return result
    } finally {
      if (!launched) this.#active.delete(runId)
    }
  }

  async #resume(runId: string, options: StartOptions): Promise<ResumeResult> {
    const run = await this.#deps.store.get(runId)
    if (!run) return { ok: false, error: `no run named ${runId}` }
    if (run.status === "running") return { ok: false, error: stillGoing(runId) }
    if (run.status === "completed") return { ok: false, error: `run ${runId} completed, so it has nothing left to do` }

    run.budget.maxUsd = options.overrides?.maxCostUsd ?? run.budget.maxUsd
    run.budget.maxTokens = options.overrides?.maxTokens ?? run.budget.maxTokens
    const stop = budgetExceeded(run)
    if (stop) {
      return {
        ok: false,
        error: `run ${runId} already spent its budget (${stop.message}), so it would stop again at once; resume it with ${overrideFor(stop)} set higher`,
      }
    }
    // The options may have changed since the run started, so the stored spec is checked
    // again before anything is spawned.
    const checked = parseSpec(run.spec, {
      maxAgents: this.#deps.config.maxAgents,
      shellTasks: this.#deps.config.shellTasks,
      worktrees: this.#deps.config.worktrees,
    })
    if (!checked.ok) {
      return { ok: false, error: `the spec of run ${runId} is no longer valid: ${checked.errors.join("; ")}` }
    }

    run.concurrency = clamp(options.overrides?.concurrency ?? run.concurrency ?? this.#deps.config.concurrency, 1, 16)
    // The caller becomes the lead, but the home of the run does not move with it: the
    // patches and the mirror of the earlier phases are already there.
    run.leadSessionID = options.lead
    run.leadAgent = options.leadAgent
    run.resumes = (run.resumes ?? 0) + 1
    run.error = undefined
    run.status = "running"
    resetForResume(run)
    const ignoredGuidance = applyGuidance(run, options.guidance)
    this.#cancelled.delete(runId)
    this.#expired.delete(runId)
    this.#overspent.delete(runId)
    this.#deps.roster.registerLead(runId, options.lead)
    await this.#deps.store.put(run)
    this.#launch(run)
    return { ok: true, run, ignoredGuidance }
  }

  /** Runs the loop away from the call that started it. A failed loop fails the run. */
  #launch(run: RunRecord): void {
    this.#active.add(run.runId)
    const loop = this.#execute(run)
      .catch(async (error) => {
        if (this.#disposed) return
        run.status = "failed"
        run.error = describe(error)
        await this.#deps.store.put(run).catch(swallow("a run record write"))
      })
      .finally(() => {
        this.#active.delete(run.runId)
        this.#loops.delete(run.runId)
      })
    // Nothing on the tool path awaits the loop, so it carries its own catch.
    this.#loops.set(run.runId, loop.catch(swallow("a run loop")))
  }

  /**
   * Records that a member was force-steered.
   *
   * `interrupt({ continue: true })` ends the member's current step, and that rejects the
   * spawn promise the same way a cancel does. The member goes on with the steered items,
   * so the task is watched through its session instead of being called failed.
   */
  noteForcedSteer(runId: string, taskId: string): void {
    this.#forced.add(`${runId}:${taskId}`)
  }

  /**
   * `session.moved` says a member arrived in its worktree.
   *
   * Both the old and the new location publish it, so a second call finds no waiter and
   * does nothing.
   */
  observeMoved(sessionID: string): void {
    const waiter = this.#moves.get(sessionID)
    if (!waiter) return
    this.#moves.delete(sessionID)
    waiter()
  }

  /** Resolves when the run loop has finished. Nothing on the tool path waits for it. */
  async wait(runId: string): Promise<void> {
    await this.#loops.get(runId)
  }

  /**
   * Stops a run. A task id identifies the run it belongs to.
   *
   * Only the session that leads the run may cancel it. The call waits for the run loop to
   * settle, so a resume that follows it cannot meet a loop that is still parked.
   */
  async cancel(target: { runId?: string; taskId?: string; sessionID?: string }): Promise<CancelResult> {
    const runId = target.runId ?? (await this.#findRun(target.taskId, target.sessionID))
    if (!runId) return { ok: false, error: 'pass "runId", or a "taskId" of a run that is still going' }
    const run = await this.#deps.store.get(runId)
    if (!run) return { ok: false, error: `no run named ${runId}` }
    if (target.sessionID && run.leadSessionID !== target.sessionID) {
      return { ok: false, error: `run ${runId} is led by another session, so only its lead can cancel it` }
    }

    this.#cancelled.add(runId)
    await this.#stopLive(run, target.taskId)
    run.status = "cancelled"
    await this.#deps.store.put(run)
    const settled = await this.#awaitLoop(runId)
    if (!settled) return { ok: true, runId, note: "cancel requested, children interrupted, loop still settling" }
    return { ok: true, runId }
  }

  /** Waits for the run loop, but never longer than the cap. */
  async #awaitLoop(runId: string): Promise<boolean> {
    const loop = this.#loops.get(runId)
    if (!loop) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CANCEL_WAIT_MS)
      timer.unref?.()
    })
    try {
      return await Promise.race([loop.then(() => true), capped])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * A run left `running` by a restart has no loop behind it any more.
   *
   * Core resurrects a suspended child on its own, so a member can still be busy with
   * nobody watching it. Such a member is interrupted; a member that already ended, which
   * is what a set `outcome` means, is left alone. The lead is not woken: the run is marked
   * `orphaned` and `workflow_status` says to resume it.
   */
  async recoverOrphans(): Promise<void> {
    for (const entry of await this.#deps.store.list()) {
      if (entry.status !== "running") continue
      const run = await this.#deps.store.get(entry.runId)
      if (!run || run.status !== "running") continue
      const resurrected = run.phases.flatMap((phase) => phase.tasks).filter((task) => task.status === "running")
      markOrphaned(run, "OpenCode restarted during the run")
      for (const task of resurrected) {
        if (task.sessionID) await this.#interruptResurrected(task.sessionID)
      }
      // The member's edits are the only thing the restart would otherwise lose.
      await this.#settleWorktrees(run)
      await this.#deps.store.put(run)
    }
  }

  /**
   * Saves the edits of every worktree of a run that is still on disk, and takes it down.
   *
   * A task records its worktree when it is created, so a run the loop no longer watches
   * still names them. A worktree the task already settled is gone, and is skipped.
   */
  async #settleWorktrees(run: RunRecord): Promise<void> {
    for (const phase of run.phases) {
      for (const task of phase.tasks) {
        const found = task.worktree
        if (!found || !(await worktree.exists(found.path).catch(() => false))) continue
        task.worktree = await worktree.settle({
          home: this.#home(run),
          runId: run.runId,
          taskId: task.taskId,
          path: found.path,
          keep: found.kept,
        })
      }
    }
  }

  /** Stops a member that survived the restart. A member that ended is left untouched. */
  async #interruptResurrected(sessionID: string): Promise<void> {
    const info = await this.#deps.session.get({ sessionID }).catch(() => undefined)
    if (!info || info.outcome) return
    await this.#deps.session.interrupt({ sessionID, continue: false }).catch(() => {})
  }

  /**
   * Stops this runner, because the plugin is being unloaded.
   *
   * The loops of this instance are dropped, every sleep they are parked in returns at
   * once, and the members they were watching are interrupted, so no child is left without
   * a watcher. Their runs are marked `orphaned`, which is the state `workflow_resume`
   * picks up. It never throws: the cleanup path calls it.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#aborter.abort()
    const runIds = [...this.#live.keys()]
    this.#loops.clear()
    this.#active.clear()
    this.#forced.clear()
    for (const runId of runIds) {
      const run = await this.#deps.store.get(runId).catch(() => undefined)
      // The handles have to be read before they are dropped, or nothing is interrupted.
      if (run) await this.#stopLive(run).catch(swallow("a member interrupt on dispose"))
      if (run) await this.#settleWorktrees(run).catch(swallow("a worktree settle on dispose"))
      this.#live.delete(runId)
      if (!run || run.status !== "running") continue
      markOrphaned(run, "plugin reloaded during the run")
      await this.#deps.store.put(run).catch(swallow("a run record write on dispose"))
    }
  }

  /** A sleep the dispose ends, so a poll never keeps the plugin loaded. */
  #sleep(ms: number): Promise<void> {
    const signal = this.#aborter.signal
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      function done(): void {
        clearTimeout(timer)
        signal.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      signal.addEventListener("abort", done, { once: true })
    })
  }

  /** Called after the mailbox charged a lead wake, because that spend counts too. */
  async checkBudget(runId: string): Promise<void> {
    const run = await this.#deps.store.get(runId).catch(() => undefined)
    if (!run || run.status !== "running") return
    await this.#overBudget(run).catch(() => {})
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  /**
   * Where this run writes.
   *
   * The engine is shared by every instance of the project, and the first one to attach may
   * be a worktree, so the instance that built it is not the anchor. The session that
   * started the run is, and its directory is on the record. A record from before the field
   * existed falls back to the directory of this instance.
   */
  #home(run: RunRecord): string {
    return run.directory ?? this.#deps.directory
  }

  /** A bare task id is looked up in the runs the caller leads, not in every run. */
  async #findRun(taskId: string | undefined, sessionID: string | undefined): Promise<string | undefined> {
    if (!taskId) return undefined
    for (const [runId, tasks] of this.#live) {
      if (!tasks.has(taskId)) continue
      if (!sessionID) return runId
      const run = await this.#deps.store.get(runId).catch(() => undefined)
      if (run?.leadSessionID === sessionID) return runId
    }
    return undefined
  }

  /** Interrupts the member sessions of the run, so no child is left without a watcher. */
  async #stopLive(run: RunRecord, taskId?: string): Promise<void> {
    for (const [id, live] of this.#live.get(run.runId) ?? []) {
      if (taskId !== undefined && taskId !== id) continue
      if (live.kind === "shell") {
        live.cancel()
        continue
      }
      const sessionID = live.sessionID ?? findTask(run, id)?.sessionID
      if (sessionID) await live.cancel(sessionID).catch(swallow("a member interrupt"))
    }
  }

  async #execute(run: RunRecord): Promise<void> {
    // A run whose loop is still settling keeps its handles, or the cancel loses them.
    if (!this.#live.has(run.runId)) this.#live.set(run.runId, new Map())
    const messageID = await this.#leadMessage(run.leadSessionID)
    const deadline = this.#now() + this.#deps.config.maxRunMinutes * 60_000

    for (const [index, phase] of run.phases.entries()) {
      if (this.#cancelled.has(run.runId)) break
      if (await this.#outOfTime(run, deadline)) break
      if (await this.#overBudget(run)) break
      // A phase the resume kept whole is not sent again.
      if (phase.status === "completed") continue
      const spec = run.spec.phases[index]!
      phase.status = "running"
      await this.#deps.store.put(run)
      // A team phase is a parallel phase with the mailbox open, so a member can reach the
      // lead while it works and the lead can steer it back.
      if (phase.strategy === "team") await this.#deps.mailbox?.open(run, spec)
      try {
        await this.#runPhase(run, phase, spec, messageID, deadline)
      } finally {
        if (phase.strategy === "team") await this.#deps.mailbox?.close(run.runId).catch(() => {})
      }

      for (const task of phase.tasks) if (task.status === "pending") task.status = "skipped"
      phase.status = phaseStatus(phase)
      await this.#deps.store.put(run)
      await this.#synthesize(run, phase, spec)
      // A sequential phase stops at its first failed task, so the run stops with it. A
      // parallel phase goes on unless every one of its tasks failed.
      const stopped = phase.strategy === "sequential" ? phase.status !== "completed" : phase.status === "failed"
      if (stopped) break
    }

    this.#skipRemaining(run)
    await this.#finish(run)
  }

  /** The strategy of the phase, plus the gate loop a `sequential` phase can carry. */
  async #runPhase(
    run: RunRecord,
    phase: PhaseRecord,
    spec: PhaseSpec,
    messageID: string | undefined,
    deadline: number,
  ): Promise<void> {
    if (phase.strategy !== "sequential") return this.#parallelPhase(run, phase, spec, messageID, deadline)
    if (!spec.repeat) return this.#sequentialPhase(run, phase, spec, messageID, deadline)
    return this.#repeatPhase(run, phase, spec, spec.repeat, messageID, deadline)
  }

  /**
   * Runs a phase again until its gate approves the round.
   *
   * The gate is the last task of the phase and answers with `approved`. A round the gate
   * refuses resets every task of the phase and runs it again with the findings in the
   * prompt. The loop ends when the gate approves, when it does not complete, at
   * `maxRounds`, and when the run is cancelled, out of time, or out of budget.
   */
  async #repeatPhase(
    run: RunRecord,
    phase: PhaseRecord,
    spec: PhaseSpec,
    repeat: RepeatSpec,
    messageID: string | undefined,
    deadline: number,
  ): Promise<void> {
    phase.round ??= 1
    while (true) {
      await this.#sequentialPhase(run, phase, spec, messageID, deadline)
      const gate = phase.tasks.find((task) => task.taskId === repeat.gate)
      const verdict = readVerdict(gate)
      recordRound(phase, verdict)
      await this.#deps.store.put(run)

      if (verdict.approved === true || gate?.status !== "completed") return
      if (phase.round >= repeat.maxRounds) return
      // A cancel that lands between two rounds ends the loop with the round it recorded.
      if (this.#halted(run.runId)) return
      if (await this.#outOfTime(run, deadline)) return
      if (await this.#roundBudget(run)) return

      phase.round += 1
      resetRound(phase)
      await this.#deps.store.put(run)
    }
  }

  /**
   * The budget between two rounds.
   *
   * Nothing is pending or running there, so `#overBudget` finds nothing to stop and lets
   * the run pass. The cap is read here instead: past it no new round starts, the rest of
   * the run is skipped, and the run ends `partial` with the cap named.
   */
  async #roundBudget(run: RunRecord): Promise<boolean> {
    if (this.#overspent.has(run.runId)) return true
    const stop = budgetExceeded(run)
    if (!stop) return false
    this.#overspent.add(run.runId)
    run.error = stop.message
    this.#skipRemaining(run)
    await this.#deps.store.put(run)
    return true
  }

  /** Tasks in order. The first task that does not complete stops the phase. */
  async #sequentialPhase(
    run: RunRecord,
    phase: PhaseRecord,
    spec: PhaseSpec,
    messageID: string | undefined,
    deadline: number,
  ): Promise<void> {
    for (const task of phase.tasks) {
      if (this.#cancelled.has(run.runId)) return
      if (await this.#outOfTime(run, deadline)) return
      if (await this.#overBudget(run)) return
      await this.#runTask(run, phase, spec, task, messageID)
      if (task.status !== "completed") return
    }
  }

  /**
   * A worker pool over one shared cursor: at most `run.concurrency` tasks are in flight,
   * every worker takes the next index, and a failed task does not stop the others.
   */
  async #parallelPhase(
    run: RunRecord,
    phase: PhaseRecord,
    spec: PhaseSpec,
    messageID: string | undefined,
    deadline: number,
  ): Promise<void> {
    let cursor = 0
    // A record written before the field existed falls back to the configured value.
    const workers = Math.min(clamp(run.concurrency ?? this.#deps.config.concurrency, 1, 16), phase.tasks.length)
    const work = async (): Promise<void> => {
      while (true) {
        const index = cursor
        cursor += 1
        const task = phase.tasks[index]
        if (!task) return
        if (this.#cancelled.has(run.runId)) return
        if (await this.#outOfTime(run, deadline)) return
        if (await this.#overBudget(run)) return
        await this.#runTask(run, phase, spec, task, messageID)
      }
    }
    await Promise.all(Array.from({ length: workers }, work))
  }

  /** One text that joins the outputs of a phase, written by a transient generation. */
  async #synthesize(run: RunRecord, phase: PhaseRecord, spec: PhaseSpec): Promise<void> {
    // A run stopped by a cancel or by its budget must not buy one more generation.
    if (!spec.synthesisPrompt || this.#halted(run.runId)) return
    const outputs = phase.tasks.filter((task) => task.output)
    if (outputs.length === 0) return

    phase.synthesis = { status: "running" }
    await this.#deps.store.put(run)
    const generate = this.#deps.generate
    if (!generate) {
      phase.synthesis = { status: "failed", error: "text generation is not available in this plugin context" }
      await this.#deps.store.put(run)
      return
    }

    const prompt = [
      spec.synthesisPrompt,
      ...specHeader(run),
      ...outputs.map((task) => wrapUntrusted(task.kind, task.taskId, clip(task.output ?? "", CONTEXT_LIMIT))),
    ].join("\n\n")
    try {
      // The key is left out without a model, so the catalog default is used.
      const model = this.#deps.config.synthesisModel
      const { text } = await generate(model ? { prompt, model } : { prompt })
      // An empty summary must not travel to the next phase as if it said something.
      phase.synthesis = text.trim()
        ? { status: "completed", output: text }
        : { status: "failed", error: "the generation returned no text" }
    } catch (error) {
      phase.synthesis = { status: "failed", error: describe(error) }
    }
    await this.#deps.store.put(run)
  }

  /** Nothing is left `pending` in a run that has ended. */
  #skipRemaining(run: RunRecord): void {
    for (const phase of run.phases) {
      for (const task of phase.tasks) if (task.status === "pending") task.status = "skipped"
      if (phase.status === "pending") phase.status = "skipped"
    }
  }

  /** The run clock. Past it the remaining work is dropped and the run ends `partial`. */
  async #outOfTime(run: RunRecord, deadline: number): Promise<boolean> {
    if (this.#now() < deadline) return false
    if (this.#expired.has(run.runId)) return true
    this.#expired.add(run.runId)
    run.error = `the run passed its limit of ${this.#deps.config.maxRunMinutes} minutes and was stopped`
    this.#skipRemaining(run)
    await this.#stopLive(run)
    await this.#deps.store.put(run)
    return true
  }

  /**
   * The budget. Checked before a task starts, after one settles, and after a lead wake.
   *
   * Past the cap no new task starts, the members that are still going are interrupted, and
   * what is left is skipped, so the run ends `partial` with the cap named. A run whose
   * work is already done is not stopped this way, because there is nothing to stop.
   */
  async #overBudget(run: RunRecord): Promise<boolean> {
    if (this.#overspent.has(run.runId)) return true
    const stop = budgetExceeded(run)
    if (!stop) return false
    const left = run.phases.some((phase) =>
      phase.tasks.some((task) => task.status === "pending" || task.status === "running"),
    )
    if (!left) return false
    this.#overspent.add(run.runId)
    run.error = stop.message
    this.#skipRemaining(run)
    await this.#stopLive(run)
    await this.#deps.store.put(run)
    return true
  }

  /** Whether the run stopped itself: a cancel or a budget stop, not a failed task. */
  #halted(runId: string): boolean {
    return this.#cancelled.has(runId) || this.#overspent.has(runId)
  }

  async #finish(run: RunRecord): Promise<void> {
    // `dispose` already marked the run, so the loop must not write a status over it.
    if (this.#disposed) return
    const tasks = run.phases.flatMap((phase) => phase.tasks)
    if (this.#cancelled.has(run.runId)) run.status = "cancelled"
    else if (this.#expired.has(run.runId) || this.#overspent.has(run.runId)) run.status = "partial"
    else if (tasks.every((task) => task.status === "completed")) run.status = "completed"
    else if (tasks.some((task) => task.status === "completed")) run.status = "partial"
    else run.status = "failed"
    await this.#deps.store.put(run)
    this.#live.delete(run.runId)
    // The record is terminal now, so a resume must not be refused while the report is sent.
    this.#active.delete(run.runId)
    this.#loops.delete(run.runId)

    await this.#deps.session
      .synthetic({
        sessionID: run.leadSessionID,
        delivery: "steer",
        description: "workflow",
        text: renderFinalReport(run),
      })
      .catch(() => {
        // The lead may be gone. The run record still holds the report.
      })
  }

  /** A retry is a new attempt, which means a new child session. */
  async #runTask(
    run: RunRecord,
    phase: PhaseRecord,
    phaseSpec: PhaseSpec,
    task: TaskRecord,
    messageID: string | undefined,
  ): Promise<void> {
    // A resume keeps every completed task, so its child is not sent again.
    if (task.status === "completed") return
    const spec = phaseSpec.tasks.find((candidate) => candidate.id === task.taskId)
    if (!spec) {
      task.status = "failed"
      task.error = "the task is missing from the spec"
      await this.#deps.store.put(run)
      return
    }

    for (let attempt = 1; attempt <= spec.retries + 1; attempt += 1) {
      if (this.#halted(run.runId)) {
        task.status = "cancelled"
        await this.#deps.store.put(run)
        return
      }
      task.attempts = attempt
      task.status = "running"
      task.error = undefined
      task.asked = undefined
      task.rejected = undefined
      task.startedAt ??= new Date().toISOString()
      task.worktree = undefined
      await this.#deps.store.put(run)

      // The worktree is recorded before the task starts, so a restart still finds it.
      let isolated: string | undefined
      if (spec.isolation === "worktree") {
        const home = this.#home(run)
        const created = await worktree.create({ home, runId: run.runId, taskId: task.taskId })
        if (!created.ok) {
          task.status = "failed"
          task.error = `worktree: ${created.error}`
          task.endedAt = new Date().toISOString()
          await this.#deps.store.put(run)
          continue
        }
        isolated = created.path
        task.worktree = { path: created.path, kept: spec.keep, stat: "" }
        await this.#deps.store.put(run)
      }

      const outcome =
        spec.kind === "shell"
          ? await this.#shellTask(run, spec, task, isolated)
          : await this.#agentTask(run, phase, phaseSpec, spec, task, attempt, messageID, isolated)

      task.status = this.#halted(run.runId) && outcome !== "completed" ? "cancelled" : outcome
      task.endedAt = new Date().toISOString()
      // However the attempt ended, what the member changed is saved before the worktree goes.
      if (isolated) {
        task.worktree = await worktree.settle({
          home: this.#home(run),
          runId: run.runId,
          taskId: task.taskId,
          path: isolated,
          keep: spec.keep,
        })
      }
      // The user refused the member's permission ask, so say so and do not send it again:
      // a new attempt would ask the same question. The cast is needed because the reset
      // above narrows the property to `undefined`, while the event consumer writes it.
      const rejected = task.rejected as TaskRecord["rejected"]
      if (rejected && (task.status === "failed" || task.status === "cancelled")) {
        const named = describePermission(rejected)
        task.status = "failed"
        task.error = `permission rejected by the user: ${named}${
          attempt <= spec.retries ? "; the remaining attempts were not tried" : ""
        }`
        await this.#rejectionMail(run, phase, task, named)
      }
      await this.#deps.store.put(run)
      // The settle brought the member's usage in, so the cap is read again here.
      await this.#overBudget(run)
      if (task.status === "completed" || task.status === "cancelled" || rejected) return
    }
  }

  /**
   * Tells the lead of a team phase that the user refused a permission of one member.
   *
   * The lead is the only one who can act on it, and only while its phase is open, so the
   * mail goes through the same gate, cap, and wake policy as any other question. A phase
   * with no mailbox refuses it, which is why nothing is sent outside a team phase.
   */
  async #rejectionMail(run: RunRecord, phase: PhaseRecord, task: TaskRecord, named: string): Promise<void> {
    if (phase.strategy !== "team" || !task.sessionID) return
    await this.#deps.mailbox
      ?.send({
        sessionID: task.sessionID,
        type: "question",
        body: `Permission for ${named} was rejected by the user. Resume this run with guidance for task ${task.taskId}, or cancel.`,
      })
      .catch(swallow("a rejection mail"))
  }

  /**
   * Runs one shell task.
   *
   * The option is read here as well as in the spec, because a saved spec can be resumed
   * after the option was turned off. The command is registered as live, so a cancel, the
   * budget, and the run clock reach it the same way they reach a member session.
   */
  async #shellTask(
    run: RunRecord,
    spec: TaskSpec,
    task: TaskRecord,
    isolated: string | undefined,
  ): Promise<TaskRecord["status"]> {
    if (!this.#deps.config.shellTasks) {
      task.error = "shell tasks are disabled by the shellTasks option"
      return "failed"
    }
    let handle: ShellHandle
    try {
      // An isolated shell task runs in its worktree; there is no session to move.
      handle = startShell({
        command: spec.command ?? "",
        cwd: isolated ?? this.#home(run),
        timeoutMs: spec.timeoutMs,
      })
    } catch (error) {
      // A command that cannot even start fails its task, not the whole run loop.
      task.error = describe(error)
      return "failed"
    }
    this.#live.get(run.runId)?.set(task.taskId, { kind: "shell", cancel: handle.cancel })
    try {
      const result = await handle.result
      task.output = clip(result.output, OUTPUT_LIMIT)
      if (result.timedOut) {
        task.error = "the command was stopped before it finished"
        return "timeout"
      }
      if (result.exitCode === 0) return "completed"
      task.error = `the command exited with code ${result.exitCode}`
      return "failed"
    } finally {
      this.#live.get(run.runId)?.delete(task.taskId)
    }
  }

  async #agentTask(
    run: RunRecord,
    phase: PhaseRecord,
    phaseSpec: PhaseSpec,
    spec: TaskSpec,
    task: TaskRecord,
    attempt: number,
    messageID: string | undefined,
    isolated: string | undefined,
  ): Promise<TaskRecord["status"]> {
    const timeoutMs = spec.timeoutMs ?? this.#deps.config.defaultTaskTimeoutMs
    const startedAt = this.#now()
    const description = describeTask(run.runId, task.taskId, attempt)
    const live: Live = { kind: "agent", cancel: async () => {}, sessionID: undefined }
    this.#live.get(run.runId)?.set(task.taskId, live)

    // A child inherits the directory of the lead, so an isolated member is warmed up,
    // moved while it is idle, and only then given its real task in the same session.
    let moved: string | undefined
    if (isolated) {
      const prepared = await this.#warmUpAndMove(run, spec, task, description, messageID, isolated, live)
      if (!prepared.ok) {
        this.#deps.roster.forget(description)
        this.#live.get(run.runId)?.delete(task.taskId)
        await this.#readUsage(run, task)
        return "failed"
      }
      moved = prepared.sessionID
    }

    const expected = moved ? undefined : this.#deps.roster.expect(description)
    const handle = this.#deps.spawner.spawn({
      lead: run.leadSessionID,
      leadAgent: run.leadAgent,
      messageID,
      agent: spec.agent ?? this.#deps.config.defaultAgent,
      description,
      prompt: buildPrompt(run, phase, phaseSpec, spec, task.guidance, isolated),
      sessionID: moved,
    })
    live.cancel = handle.cancel
    // A continued session was announced by its first spawn, so only a fresh one is awaited.
    expected
      ?.then((sessionID) => {
        live.sessionID = sessionID
        task.sessionID = sessionID
      })
      .catch(swallow("a child session lookup"))

    // The warm-up and the move come out of the task's own clock.
    const settled = await race(handle.promise, Math.max(timeoutMs - (this.#now() - startedAt), 0))
    let status: TaskRecord["status"]
    if (settled.type === "timeout") {
      const sessionID = live.sessionID ?? task.sessionID ?? (await this.#waitForChild(live, task))
      if (sessionID) {
        await handle.cancel(sessionID).catch(swallow("a member interrupt"))
        // The promise has to settle, or the child keeps running with nobody watching it.
        await handle.promise.catch(() => {})
        task.error = `the task did not finish within ${timeoutMs} ms`
      } else {
        // Nothing can be interrupted, so the promise is abandoned instead of awaited: a
        // spawn that never announced its child would park the loop forever.
        handle.promise.catch(swallow("an abandoned child"))
        task.error = "child session never registered"
      }
      status = "timeout"
    } else if (settled.type === "error") {
      const sessionID = live.sessionID ?? task.sessionID
      if (this.#forced.delete(`${run.runId}:${task.taskId}`) && sessionID) {
        // The steer ended the step, not the member. Watch the session out.
        status = await this.#awaitBackground(
          sessionID,
          timeoutMs - (this.#now() - startedAt),
          task,
          this.#now() + FORCE_GRACE_MS,
        )
      } else {
        task.error = describe(settled.error)
        status = "failed"
      }
    } else if (settled.value.status === "running") {
      // The lead backgrounded the job, so the executor returned before the child did.
      task.sessionID = settled.value.sessionID
      live.sessionID = settled.value.sessionID
      this.#deps.roster.bind(run.runId, task.taskId, settled.value.sessionID)
      status = await this.#awaitBackground(settled.value.sessionID, timeoutMs - (this.#now() - startedAt), task)
    } else {
      task.sessionID = settled.value.sessionID
      this.#deps.roster.bind(run.runId, task.taskId, settled.value.sessionID)
      task.output = clip(settled.value.output, OUTPUT_LIMIT)
      status = "completed"
    }

    if (status === "completed" && spec.outputSchema) status = this.#checkSchema(spec.outputSchema, task)

    this.#deps.roster.forget(description)
    this.#live.get(run.runId)?.delete(task.taskId)
    await this.#readUsage(run, task)
    return status
  }

  /**
   * Gives a worktree member a cheap turn, then moves it while it is idle.
   *
   * A move is applied at the session's next step boundary. A member that is spawned with
   * its real task starts that task in the directory it was created in, and the boot of the
   * destination location instance takes longer than the step does, so the work would
   * happen in the wrong checkout. The member is therefore spawned with a warm-up prompt
   * first. The executor comes back when that turn ends, which leaves the session idle, and
   * an idle session applies a move with no model request.
   *
   * Nothing is interrupted here. A warm-up or a move that does not come back fails the
   * attempt, and a retry gets a new session and a fresh worktree.
   */
  async #warmUpAndMove(
    run: RunRecord,
    spec: TaskSpec,
    task: TaskRecord,
    description: string,
    messageID: string | undefined,
    directory: string,
    live: Extract<Live, { kind: "agent" }>,
  ): Promise<{ ok: true; sessionID: string } | { ok: false }> {
    const expected = this.#deps.roster.expect(description)
    const warm = this.#deps.spawner.spawn({
      lead: run.leadSessionID,
      leadAgent: run.leadAgent,
      messageID,
      agent: spec.agent ?? this.#deps.config.defaultAgent,
      description,
      prompt: WARMUP_PROMPT,
    })
    live.cancel = warm.cancel
    expected
      .then((sessionID) => {
        live.sessionID = sessionID
        task.sessionID = sessionID
      })
      .catch(swallow("a child session lookup"))

    const settled = await race(warm.promise, WARMUP_TIMEOUT_MS)
    if (settled.type !== "value") {
      const sessionID = live.sessionID ?? task.sessionID
      if (sessionID) {
        // A warm-up that hangs still owns a child, so it is ended before the attempt fails.
        await warm.cancel(sessionID).catch(swallow("a member interrupt"))
        await warm.promise.catch(() => {})
      } else {
        warm.promise.catch(swallow("an abandoned child"))
      }
      task.error = "worktree: the member did not answer the warm-up"
      return { ok: false }
    }

    const sessionID = settled.value.sessionID
    live.sessionID = sessionID
    task.sessionID = sessionID
    this.#deps.roster.bind(run.runId, task.taskId, sessionID)
    // The child is known, so the second spawn does not wait for a `session.created`.
    this.#deps.roster.forget(description)

    const watch = this.#watchMoved(sessionID)
    const asked = await this.#deps.session.move({ sessionID, directory }).then(
      () => true,
      () => false,
    )
    if (asked && (await watch.wait(this.#deps.moveTimeoutMs ?? MOVE_TIMEOUT_MS, run.runId))) {
      return { ok: true, sessionID }
    }
    this.#moves.delete(sessionID)
    task.error = `worktree: the member did not arrive in ${directory}`
    return { ok: false }
  }

  /**
   * Watches for the `session.moved` of one member.
   *
   * The waiter is live from this call on, and `wait` starts the clock, because the move
   * has to be asked for between the two and `session.moved` can arrive before that call
   * comes back. A cancel, a budget stop, or a reload ends the wait as well, so a run is
   * never parked here.
   */
  #watchMoved(sessionID: string): { wait: (ms: number, runId: string) => Promise<boolean> } {
    let arrived = false
    let answer: ((value: boolean) => void) | undefined
    this.#moves.set(sessionID, () => {
      arrived = true
      answer?.(true)
    })
    return {
      wait: (ms: number, runId: string): Promise<boolean> => {
        if (arrived) return Promise.resolve(true)
        return new Promise<boolean>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          let watchdog: ReturnType<typeof setInterval> | undefined
          const done = (value: boolean): void => {
            clearTimeout(timer)
            clearInterval(watchdog)
            this.#moves.delete(sessionID)
            resolve(value)
          }
          timer = setTimeout(() => done(false), ms)
          timer.unref?.()
          watchdog = setInterval(() => {
            if (this.#halted(runId) || this.#disposed) done(false)
          }, this.#deps.pollIntervalMs ?? POLL_MS)
          watchdog.unref?.()
          answer = done
        })
      },
    }
  }

  /**
   * Gives the roster a moment to name a child that timed out before it was announced.
   *
   * `session.created` may still be on its way, and without the child id nothing can be
   * interrupted. The wait is bounded, so the loop goes on either way.
   */
  async #waitForChild(live: Extract<Live, { kind: "agent" }>, task: TaskRecord): Promise<string | undefined> {
    for (let poll = 0; poll < CHILD_WAIT_POLLS && !this.#disposed; poll += 1) {
      await this.#sleep(this.#deps.childPollMs ?? CHILD_POLL_MS)
      const sessionID = live.sessionID ?? task.sessionID
      if (sessionID) return sessionID
    }
    return live.sessionID ?? task.sessionID
  }

  /**
   * Watches a member the lead moved to the background.
   *
   * The executor resolves with `status: "running"` in that case, so the child is still
   * going. `Session.Info.outcome` is the end marker, and the text is read from the
   * session afterwards. A forced steer uses the same watch, and until
   * `ignoreInterruptedUntil` an `interrupted` outcome is the interrupt itself, not the end
   * of the member.
   */
  async #awaitBackground(
    sessionID: string,
    timeoutMs: number,
    task: TaskRecord,
    ignoreInterruptedUntil = 0,
  ): Promise<TaskRecord["status"]> {
    const interval = this.#deps.pollIntervalMs ?? POLL_MS
    const until = this.#now() + Math.max(timeoutMs, 0)
    while (!this.#disposed && this.#now() < until) {
      const info = await this.#deps.session.get({ sessionID }).catch(() => undefined)
      const outcome = typeof info?.outcome === "string" ? info.outcome : undefined
      if (outcome === "interrupted" && this.#now() < ignoreInterruptedUntil) {
        await this.#sleep(interval)
        continue
      }
      if (outcome) {
        const answer = await this.#lastAssistantText(sessionID)
        task.output = clip(answer, OUTPUT_LIMIT)
        if (outcome === "succeeded") {
          // A member interrupted before its first answer ends succeeded with nothing to
          // say, and an empty output must not travel on as a result.
          if (answer.trim()) return "completed"
          task.error = "the member ended without an answer"
          return "failed"
        }
        task.error = `the member session ended: ${outcome}`
        return outcome === "interrupted" ? "cancelled" : "failed"
      }
      await this.#sleep(interval)
    }
    if (this.#disposed) return "cancelled"
    await this.#deps.session.interrupt({ sessionID, continue: false }).catch(() => {})
    task.error = `the task did not finish within ${timeoutMs} ms`
    return "timeout"
  }

  /** A task with an `outputSchema` has to answer with JSON. A miss burns an attempt. */
  #checkSchema(schema: Record<string, unknown>, task: TaskRecord): TaskRecord["status"] {
    const found = extractJson(task.output ?? "")
    if (!found.ok) {
      task.error = `${found.error}; the task has an outputSchema, so it has to reply with one JSON object`
      return "failed"
    }
    const errors = validateJson(schema, found.value)
    if (errors.length > 0) {
      task.error = `the output does not match outputSchema: ${errors.join("; ")}`
      return "failed"
    }
    task.data = found.value
    return "completed"
  }

  /** The child session carries the authoritative cost and token counts. */
  async #readUsage(run: RunRecord, task: TaskRecord): Promise<void> {
    if (!task.sessionID) return
    const info = await this.#deps.session.get({ sessionID: task.sessionID }).catch(() => undefined)
    if (!info) return
    await this.#deps.store.recordUsage(run.runId, task.taskId, task.sessionID, {
      usd: typeof info.cost === "number" ? info.cost : 0,
      tokens: countTokens(info.tokens),
    })
  }

  /** A forged tool context needs a real assistant message id, or a permission ask throws. */
  async #leadMessage(sessionID: string): Promise<string | undefined> {
    for (const message of await this.#messages(sessionID)) {
      if (isAssistant(message) && typeof message.id === "string") return message.id
    }
    return undefined
  }

  /** The text of the newest assistant message of a session. */
  async #lastAssistantText(sessionID: string): Promise<string> {
    for (const message of await this.#messages(sessionID)) {
      if (!isAssistant(message)) continue
      const content = Array.isArray(message.content) ? message.content : []
      const text = content
        .filter((part): part is { type: string; text: string } => isTextPart(part))
        .map((part) => part.text)
        .join("")
      if (text) return text
    }
    return ""
  }

  /** The session history, newest first. */
  async #messages(sessionID: string): Promise<Record<string, unknown>[]> {
    const messages = await this.#deps.session.context({ sessionID }).catch(() => undefined)
    if (!Array.isArray(messages)) return []
    return [...messages].reverse().filter((message): message is Record<string, unknown> => !!message)
  }
}

function stillGoing(runId: string): string {
  return `run ${runId} is still going, so there is nothing to resume; use workflow_status to look in, or workflow_cancel to stop it`
}

/** A message is an assistant turn on either the v2 shape or the older `role` shape. */
function isAssistant(message: Record<string, unknown>): boolean {
  return message.type === "assistant" || message.role === "assistant"
}

function isTextPart(part: unknown): boolean {
  const candidate = part as { type?: unknown; text?: unknown } | undefined
  return candidate?.type === "text" && typeof candidate.text === "string"
}

/** What the gate of a `repeat` phase said about the round it closed. */
interface Verdict {
  /** Absent when the gate did not complete, so nothing was judged. */
  approved?: boolean
  findings: string[]
}

/**
 * Reads the verdict out of the gate's JSON answer.
 *
 * `outputSchema` already checked the shape, so this only takes what it can use: a
 * reviewer answers with `findings`, a stakeholder with `gaps`, and each line is clipped
 * because it travels into the prompt of the next round.
 */
function readVerdict(gate: TaskRecord | undefined): Verdict {
  const data = gate?.status === "completed" ? gate.data : undefined
  const approved = typeof data?.approved === "boolean" ? data.approved : undefined
  const listed = Array.isArray(data?.findings) ? data.findings : Array.isArray(data?.gaps) ? data.gaps : []
  const findings = listed
    .filter((finding): finding is string => typeof finding === "string")
    .map((finding) => clip(finding, FINDING_LIMIT))
  return { approved, findings }
}

/** One entry per finished round. A round that was run again replaces its entry. */
function recordRound(phase: PhaseRecord, verdict: Verdict): void {
  const record: RoundRecord = {
    round: phase.round ?? 1,
    approved: verdict.approved,
    findings: verdict.findings,
    tasks: phase.tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      attempts: task.attempts,
      patch: task.worktree?.patch,
      usage: { ...task.usage },
    })),
  }
  const rounds = (phase.rounds ??= [])
  const index = rounds.findIndex((entry) => entry.round === record.round)
  if (index >= 0) rounds[index] = record
  else rounds.push(record)
}

/** `completed` when every task did, `failed` when none did, `partial` in between. */
function phaseStatus(phase: PhaseRecord): PhaseRecord["status"] {
  const completed = phase.tasks.filter((task) => task.status === "completed").length
  if (completed === phase.tasks.length) return "completed"
  if (completed === 0) return "failed"
  return "partial"
}

type Settled<T> = { type: "value"; value: T } | { type: "error"; error: unknown } | { type: "timeout" }

async function race<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<Settled<T>> {
  const wrapped = promise.then(
    (value): Settled<T> => ({ type: "value", value }),
    (error): Settled<T> => ({ type: "error", error }),
  )
  if (timeoutMs === undefined) return wrapped
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs)
  })
  try {
    return await Promise.race([wrapped, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The member starts with a fresh context, so the prompt carries everything it needs:
 * the goal, the synthesis of the earlier phases, and, in a sequential phase, what the
 * earlier tasks of the phase produced. Every borrowed text is marked as untrusted.
 */
export function buildPrompt(
  run: RunRecord,
  phase: PhaseRecord,
  phaseSpec: PhaseSpec,
  task: TaskSpec,
  guidance?: string,
  worktreePath?: string,
): string {
  const parts = specHeader(run)
  if (worktreePath) parts.push(`Your working directory is ${worktreePath}, a git worktree. Work only there.`)

  const summaries = run.phases
    .slice(0, run.phases.indexOf(phase))
    .filter((candidate) => candidate.synthesis?.status === "completed" && candidate.synthesis.output)
  if (summaries.length > 0) {
    parts.push("Summary of the earlier phases:")
    for (const candidate of summaries) {
      parts.push(wrapUntrusted("synthesis", candidate.id, clip(candidate.synthesis?.output ?? "", CROSS_PHASE_LIMIT)))
    }
  }

  if (phase.strategy === "sequential") {
    const earlier = phase.tasks.filter((candidate) => candidate.status === "completed" && candidate.output)
    if (earlier.length > 0) {
      parts.push("Results of the earlier tasks of this phase:")
      for (const candidate of earlier) {
        parts.push(wrapUntrusted(candidate.kind, candidate.taskId, clip(candidate.output ?? "", CONTEXT_LIMIT)))
      }
    }

    // The edits of an isolated task are not in this checkout, so the next task is given
    // the patch it left instead: enough to read it or to `git apply --check` it.
    const isolated = phase.tasks.flatMap((candidate) =>
      candidate.status === "completed" && candidate.worktree ? [{ taskId: candidate.taskId, ...candidate.worktree }] : [],
    )
    if (isolated.length > 0) {
      parts.push("Edits of the earlier worktree tasks of this phase, saved as patches:")
      for (const found of isolated) {
        const body = [found.patch ? `patch: ${found.patch}` : "no changes"]
        if (found.kept) body.push(`worktree kept at: ${found.path}`)
        if (found.stat) body.push(found.stat)
        parts.push(wrapUntrusted("worktree", found.taskId, body.join("\n")))
      }
      parts.push("A task of this phase that is not listed above edited this checkout directly.")
    }
  }

  parts.push(...roundContext(phase, phaseSpec, task))
  parts.push(task.prompt ?? "")
  // The lead wrote it for this attempt, but it still travels as data, not as instructions.
  if (guidance) parts.push("Guidance from the lead for this attempt:", wrapUntrusted("lead", "guidance", guidance))
  return parts.join("\n\n")
}

/**
 * What a task of the second or a later round of a `repeat` phase has to know.
 *
 * The tasks of the phase were reset, so nothing of the last round is in the record the
 * prompt is built from any more; the findings of the gate and the patch the task itself
 * left are what carry the work over.
 */
function roundContext(phase: PhaseRecord, phaseSpec: PhaseSpec, task: TaskSpec): string[] {
  const repeat = phaseSpec.repeat
  const round = phase.round ?? 1
  if (!repeat || round < 2) return []
  const previous = phase.rounds?.find((entry) => entry.round === round - 1)
  const findings = previous?.findings.join("\n") || "The gate named no finding."
  const parts = [
    `Round ${round} of ${repeat.maxRounds}. The gate task did not approve round ${round - 1}. Address every finding:`,
    wrapUntrusted("agent", repeat.gate, clip(findings, CONTEXT_LIMIT)),
  ]
  // A worktree of this round is a fresh one of HEAD, so the edits are only in the patch.
  const patch = previous?.tasks.find((entry) => entry.taskId === task.id)?.patch
  if (patch) parts.push(`Your edits of the last round are saved as a patch; apply it first: git apply ${patch}`)
  return parts
}

/**
 * The name and the goal of the spec, in the envelope every borrowed text travels in.
 *
 * Both were written by the model that authored the spec, so a goal that carries
 * `<workflow-mail` or `</untrusted>` must not be read as markup by the member.
 */
function specHeader(run: RunRecord): string[] {
  return [
    "Workflow:",
    wrapUntrusted("spec", "name", run.spec.name),
    "Goal:",
    wrapUntrusted("spec", "goal", run.spec.goal),
  ]
}

/** A run nobody watches any more, and the tasks that were still going with it. */
function markOrphaned(run: RunRecord, reason: string): void {
  run.status = "orphaned"
  run.error = reason
  for (const phase of run.phases) {
    if (phase.status === "running") phase.status = "partial"
    for (const task of phase.tasks) {
      if (task.status !== "running") continue
      task.status = "cancelled"
      task.error = reason
    }
  }
}

/**
 * Puts a run back into a state the loop can pick up.
 *
 * A completed task keeps its output, its usage, and its child session id, so the spend
 * carries over and the rebuilt context reads the same text as the first attempt. Every
 * other task goes back to `pending` with its attempts reset. A phase whose tasks all
 * completed, and whose synthesis completed with them, is kept whole and skipped; any other
 * phase is run again, and its synthesis is dropped because it would summarise a part.
 *
 * A `repeat` phase is the exception: one whose last round was refused and that has rounds
 * left is put back to the next round, because its work is not done either.
 */
function resetForResume(run: RunRecord): void {
  for (const [index, phase] of run.phases.entries()) {
    const spec = run.spec.phases[index]
    for (const task of phase.tasks) {
      if (task.status === "completed") continue
      resetTask(task)
    }
    const done = phase.tasks.every((task) => task.status === "completed")
    if (done && spec?.repeat && unapproved(phase, spec.repeat)) {
      phase.round = (phase.round ?? 1) + 1
      resetRound(phase)
      phase.status = "pending"
      phase.synthesis = undefined
      phase.error = undefined
      continue
    }
    const synthesised = spec?.synthesisPrompt === undefined || phase.synthesis?.status === "completed"
    const whole = done && synthesised
    phase.status = whole ? "completed" : "pending"
    if (!whole) phase.synthesis = undefined
    phase.error = undefined
  }
}

/** Whether the last round of a repeat phase was refused and the phase has rounds left. */
function unapproved(phase: PhaseRecord, repeat: RepeatSpec): boolean {
  const last = phase.rounds?.at(-1)
  if (!last || last.approved !== false) return false
  return (phase.round ?? 1) < repeat.maxRounds
}

/** Every task of a repeat phase goes back to pending, so the next round runs them again. */
function resetRound(phase: PhaseRecord): void {
  for (const task of phase.tasks) resetTask(task)
}

/** Puts one task back to pending. Its usage stays, so the spend of the run carries over. */
function resetTask(task: TaskRecord): void {
  task.status = "pending"
  task.attempts = 0
  task.error = undefined
  task.output = undefined
  task.data = undefined
  task.sessionID = undefined
  task.startedAt = undefined
  task.endedAt = undefined
  // The task runs again, so it gets a new worktree; the completed ones keep theirs.
  task.worktree = undefined
}

/**
 * Puts the guidance of a resume on the tasks it names and gives the rest back.
 *
 * The text is kept on the record, so a task that is sent again reads it, and a later
 * resume that names none keeps the one it already has. An id the run does not have is
 * reported instead of dropped, because it is usually a typo.
 */
function applyGuidance(run: RunRecord, guidance: Record<string, string> | undefined): string[] {
  const ignored: string[] = []
  for (const [taskId, text] of Object.entries(guidance ?? {})) {
    const task = findTask(run, taskId)
    if (task) task.guidance = clip(text, GUIDANCE_LIMIT)
    else ignored.push(taskId)
  }
  return ignored
}

function newRun(spec: WorkflowSpec, options: StartOptions, concurrency: number): RunRecord {
  const now = new Date().toISOString()
  return {
    runId: `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    specVersion: 1,
    projectID: "",
    spec,
    status: "running",
    concurrency,
    leadSessionID: options.lead,
    leadAgent: options.leadAgent,
    directory: options.directory,
    createdAt: now,
    updatedAt: now,
    budget: {
      maxUsd: options.overrides?.maxCostUsd ?? spec.budget?.usd,
      maxTokens: options.overrides?.maxTokens ?? spec.budget?.tokens,
      spentUsd: 0,
      spentTokens: 0,
    },
    phases: spec.phases.map(
      (phase): PhaseRecord => ({
        id: phase.id,
        strategy: phase.strategy,
        status: "pending",
        tasks: phase.tasks.map(
          (task): TaskRecord => ({
            taskId: task.id,
            kind: task.kind,
            status: "pending",
            attempts: 0,
            usage: { usd: 0, tokens: 0 },
          }),
        ),
      }),
    ),
    mailbox: { maxMessages: 0, used: 0 },
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max)
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[cut at ${limit} characters]`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
