import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { MailEvent, RunRecord, TaskRecord } from "./types.js"

type SynthesisUsage = { input: number; output: number; reasoning: number; cache: number; cost: number }

/** `ctx.storage`, reduced to the calls the store makes. */
export interface Storage {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: never) => Promise<void>
}

export interface RunIndexEntry {
  runId: string
  name: string
  status: RunRecord["status"]
  updatedAt: string
}

/** The index keeps the newest runs only. A `running` run is never dropped from it. */
const INDEX_LIMIT = 200

/**
 * Reads and writes run records. `ctx.storage` is one key-value store for every project,
 * so every key starts with the project id.
 *
 * A run record is written on every transition. The store keeps the live record in memory
 * so the runner and the event consumer mutate one object instead of two copies.
 */
export class RunStore {
  #storage: Storage
  #projectID: string
  #directory: string | undefined
  #live = new Map<string, RunRecord>()
  /** run id → the status the index was last written with. */
  #indexed = new Map<string, RunRecord["status"]>()
  /** Index writes are read-modify-write, so they go one after the other. */
  #indexChain: Promise<void> = Promise.resolve()

  /** `directory` enables a JSON mirror under `<directory>/.opencode/workflows/runs/`. */
  constructor(storage: Storage, projectID: string, directory?: string) {
    this.#storage = storage
    this.#projectID = projectID
    this.#directory = directory
  }

  /** The string every key of this project starts with. `workflow_doctor` reports it. */
  prefix(): string {
    return this.#projectID
  }

  #runKey(runId: string): string {
    return `${this.#projectID}:run:${runId}`
  }

  #indexKey(): string {
    return `${this.#projectID}:idx:runs`
  }

  #mailKey(mail: MailEvent): string {
    return `${this.#projectID}:mail:${mail.runId}:${mail.id}`
  }

  /** Writes one mail event. The mailbox keeps the live list, so nothing is read back. */
  async putMail(mail: MailEvent): Promise<void> {
    await this.#storage.set(this.#mailKey(mail), mail as never)
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const live = this.#live.get(runId)
    if (live) return live
    const stored = await this.#storage.get(this.#runKey(runId))
    if (!stored || typeof stored !== "object") return undefined
    const run = stored as RunRecord
    this.#live.set(runId, run)
    return run
  }

  /**
   * Writes the record and mirrors the JSON. Every transition writes the record.
   *
   * The index is rewritten only when the status changed, because it is a read-modify-write
   * over one key and a task write happens far more often than a transition.
   */
  async put(run: RunRecord): Promise<void> {
    run.projectID = this.#projectID
    run.updatedAt = new Date().toISOString()
    this.#live.set(run.runId, run)
    await this.#storage.set(this.#runKey(run.runId), run as never)
    if (this.#indexed.get(run.runId) !== run.status) {
      await this.#reindex({ runId: run.runId, name: run.spec.name, status: run.status, updatedAt: run.updatedAt })
      // Marked only once the write went through, so a refused write is tried again.
      this.#indexed.set(run.runId, run.status)
    }
    await this.#mirror(run)
  }

  /** One in-memory chain, so two runs cannot interleave their read-modify-write. */
  #reindex(entry: RunIndexEntry): Promise<void> {
    const next = this.#indexChain.then(async () => {
      const index = (await this.list()).filter((candidate) => candidate.runId !== entry.runId)
      index.unshift(entry)
      await this.#storage.set(this.#indexKey(), capIndex(index) as never)
    })
    this.#indexChain = next.catch(() => {})
    return next
  }

  async list(): Promise<RunIndexEntry[]> {
    const stored = await this.#storage.get(this.#indexKey())
    return Array.isArray(stored) ? (stored as RunIndexEntry[]) : []
  }

  /** The most recently written run, or nothing when this project has none. */
  async latest(): Promise<RunRecord | undefined> {
    const [first] = await this.list()
    return first ? this.get(first.runId) : undefined
  }

  /**
   * Records what one member session spent on its task.
   *
   * A retry is a new child session, and a late event of an older child must not replace
   * what the newer one spent, so the entry is kept per session and `task.usage` is their
   * sum. The spend of a run therefore never goes down.
   */
  async recordUsage(
    runId: string,
    taskId: string,
    sessionID: string,
    usage: { usd: number; tokens: number },
  ): Promise<void> {
    const run = await this.get(runId)
    const task = run && findTask(run, taskId)
    if (!run || !task) return
    task.attemptsUsage = { ...task.attemptsUsage, [sessionID]: usage }
    task.usage = taskUsage(task)
    recount(run)
    await this.put(run)
  }

  /** Adds what the lead spent on the wakes of one team phase to the same budget. */
  async recordMailUsage(runId: string, phaseId: string, usage: { usd: number; tokens: number }): Promise<void> {
    const run = await this.get(runId)
    if (!run) return
    run.mailUsageByPhase = { ...run.mailUsageByPhase, [phaseId]: usage }
    run.mailUsage = totalUsage(Object.values(run.mailUsageByPhase))
    recount(run)
    await this.put(run)
  }

  /** Records the authoritative usage of a phase's visible synthesis child session. */
  async recordSynthesisUsage(runId: string, phaseId: string, sessionID: string, usage: SynthesisUsage): Promise<void> {
    const run = await this.get(runId)
    const phase = run?.phases.find((candidate) => candidate.id === phaseId)
    if (!run || !phase) return
    phase.synthesisAttemptsUsage = { ...phase.synthesisAttemptsUsage, [sessionID]: usage }
    phase.synthesisUsage = sumSynthesisUsages(Object.values(phase.synthesisAttemptsUsage))
    if (phase.synthesis) {
      phase.synthesis.sessionID = sessionID
      phase.synthesis.usage = usage
    }
    recount(run)
    await this.put(run)
  }

  /**
   * A mirror is a convenience for debugging, so a write failure is ignored.
   *
   * It lands in the home of the run, which is the directory of the session that started
   * it, not the directory of the instance that built this store.
   */
  async #mirror(run: RunRecord): Promise<void> {
    const home = run.directory ?? this.#directory
    if (!home) return
    const directory = join(home, ".opencode", "workflows", "runs")
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8")
    } catch {
      // A read-only or missing project directory must not stop a run.
    }
  }
}

/**
 * The string that keeps one project's runs apart from another's.
 *
 * `ctx.storage` is one key-value store for every project, so the project id is the
 * natural prefix. It resolves to `"global"` outside a project, which would mix every
 * such directory together, so the directory is hashed instead.
 */
export function storagePrefix(projectID: string | undefined, directory: string): string {
  if (projectID && projectID !== "global") return projectID
  return `dir_${createHash("sha1").update(directory).digest("hex").slice(0, 12)}`
}

/**
 * The newest 200 entries, plus every `running` one.
 *
 * The index is one value under one key, so it cannot grow without a bound. A run that is
 * still going is never dropped, because `recoverOrphans` reads it from here.
 */
function capIndex(index: RunIndexEntry[]): RunIndexEntry[] {
  if (index.length <= INDEX_LIMIT) return index
  return index.filter((entry, position) => entry.status === "running" || position < INDEX_LIMIT)
}

/** The spend of a task is the spend of every attempt it took. */
function taskUsage(task: TaskRecord): { usd: number; tokens: number } {
  return totalUsage(Object.values(task.attemptsUsage ?? {}))
}

function totalUsage(entries: { usd: number; tokens: number }[]): { usd: number; tokens: number } {
  let usd = 0
  let tokens = 0
  for (const entry of entries) {
    usd += entry.usd
    tokens += entry.tokens
  }
  return { usd, tokens }
}

export function findTask(run: RunRecord, taskId: string): TaskRecord | undefined {
  for (const phase of run.phases) {
    const task = phase.tasks.find((candidate) => candidate.taskId === taskId)
    if (task) return task
  }
  return undefined
}

/** The budget is the usage of tasks, visible synthesis children, and mailbox wakes. */
export function recount(run: RunRecord): void {
  run.budget.spentUsd = sum(run, (task) => task.usage.usd) + synthesisCost(run) + (run.mailUsage?.usd ?? 0)
  run.budget.spentTokens = sum(run, (task) => task.usage.tokens) + synthesisTokens(run) + (run.mailUsage?.tokens ?? 0)
}

function sum(run: RunRecord, read: (task: TaskRecord) => number): number {
  let total = 0
  for (const phase of run.phases) for (const task of phase.tasks) total += read(task)
  return total
}

function sumSynthesisUsages(usages: SynthesisUsage[]): SynthesisUsage {
  return usages.reduce(
    (total, u) => ({
      input: total.input + u.input,
      output: total.output + u.output,
      reasoning: total.reasoning + u.reasoning,
      cache: total.cache + u.cache,
      cost: total.cost + u.cost,
    }),
    { input: 0, output: 0, reasoning: 0, cache: 0, cost: 0 },
  )
}

function synthesisCost(run: RunRecord): number {
  return run.phases.reduce((total, phase) => total + (phase.synthesisUsage?.cost ?? phase.synthesis?.usage?.cost ?? 0), 0)
}

function synthesisTokens(run: RunRecord): number {
  return run.phases.reduce((total, phase) => {
    const usage = phase.synthesisUsage ?? phase.synthesis?.usage
    return total + (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.reasoning ?? 0)
  }, 0)
}
