import { ROLE_NAMES } from "./config.js"
import { z } from "zod"
import type { WorkflowSpec } from "./types.js"

export interface SpecLimits {
  maxAgents: number
  shellTasks: boolean
  worktrees: boolean
}

export type ParseResult =
  | { ok: true; spec: WorkflowSpec; warnings: string[] }
  | { ok: false; errors: string[] }

/** The summary of the DSL that every tool and every command that reads a spec carries. */
export const DSL = [
  'A spec is JSON with "specVersion": 1, "name", "goal", and "phases".',
  'A phase has "id", "strategy" ("sequential", "parallel", or "team"), "tasks", and an optional "synthesisPrompt".',
  'A task has "id", "kind" ("agent" with a "prompt", or "shell" with a "command"), and optional "agent", "retries" (0-3), "timeoutMs", "outputSchema", "isolation", and "keep".',
  'Set the model on the agent: "model" on a task is rejected. A role takes its model from the plugin options.',
  `The plugin registers one read-only agent per role: ${ROLE_NAMES.join(", ")}. Name one with "agent" on a task; it reads and reports and never edits.`,
  '"isolation": "worktree" runs the task in its own git worktree of HEAD; edits are saved as a patch and the worktree is removed unless "keep": true.',
  'A "sequential" phase can carry "repeat": { "gate": <task id>, "maxRounds": 1-5 }: the gate is the last task of the phase and answers one JSON object with "approved" and "findings"; a round the gate refuses runs the whole phase again with the findings in the prompt.',
  'A "team" phase runs like "parallel" and opens the mailbox: its members use team_send, and you use team_steer and team_inbox.',
  'Three workflows are built in: build-review, secure-build, and plan-research. Run one with workflow_run_saved, a "name" and a "goal", instead of writing a spec for a build or a plan.',
].join("\n")

const Budget = z
  .strictObject({
    usd: z.number().min(0.01).max(1000).optional(),
    tokens: z.number().int().min(1000).max(50_000_000).optional(),
  })
  .refine((budget) => budget.usd !== undefined || budget.tokens !== undefined, {
    message: 'set "usd", "tokens", or both',
  })

const Task = z.strictObject({
  id: z.string().min(1),
  description: z.string().optional(),
  kind: z.enum(["agent", "shell"]).default("agent"),
  prompt: z.string().optional(),
  command: z.string().optional(),
  agent: z.string().optional(),
  // Kept so the v1 rejection can name the field instead of reporting an unknown key.
  model: z.string().optional(),
  retries: z.number().int().min(0).max(3).default(0),
  timeoutMs: z.number().int().min(5_000).max(1_800_000).optional(),
  isolation: z.literal("worktree").optional(),
  keep: z.boolean().default(false),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
})

const Mailbox = z.strictObject({
  peers: z.literal(false).default(false),
  maxMessages: z.number().int().min(1).max(50).default(20),
})

const Repeat = z.strictObject({
  gate: z.string().min(1),
  maxRounds: z.number().int().min(1).max(5),
})

const Phase = z.strictObject({
  id: z.string().min(1),
  title: z.string().optional(),
  strategy: z.enum(["sequential", "parallel", "team"]).default("parallel"),
  tasks: z.array(Task).min(1),
  synthesisPrompt: z.string().optional(),
  mailbox: Mailbox.optional(),
  repeat: Repeat.optional(),
})

/**
 * What the gate of a `repeat` phase has to answer with.
 *
 * Exported so a spec that is built in code uses the same schema the runner reads the
 * verdict out of: `approved`, plus the findings a round that was refused has to fix.
 */
export const GATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["approved"],
  properties: {
    approved: { type: "boolean" },
    findings: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
}

/**
 * The base object, exported so `scripts/schema.ts` can generate the JSON Schema asset.
 * `workflowSchema` wraps it with the cross-field rules, which JSON Schema cannot carry.
 */
export const WorkflowObject = z.strictObject({
  /** Accepted so an editor can validate a saved spec, and dropped by `normalize`. */
  $schema: z.string().optional(),
  specVersion: z.literal(1),
  name: z.string().min(1),
  goal: z.string().min(1),
  budget: Budget.optional(),
  phases: z.array(Phase).min(1),
})

/** The schema depends on the resolved options, so it is built per call. */
function workflowSchema(limits: SpecLimits) {
  return WorkflowObject.superRefine((workflow, ctx) => {
    const seen = new Map<string, string>()
    let total = 0

    for (const [phaseIndex, phase] of workflow.phases.entries()) {
      if (phase.mailbox && phase.strategy !== "team") {
        ctx.addIssue({
          code: "custom",
          path: ["phases", phaseIndex, "mailbox"],
          message: 'only a phase with strategy "team" can have a mailbox',
        })
      }
      if (phase.repeat) checkRepeat(phase, phase.repeat, phaseIndex, ctx)

      for (const [taskIndex, task] of phase.tasks.entries()) {
        total += 1
        const at = (field: string): (string | number)[] => ["phases", phaseIndex, "tasks", taskIndex, field]

        const owner = seen.get(task.id)
        if (owner !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: at("id"),
            message: `duplicate task id; "${task.id}" is already used in phase "${owner}"`,
          })
        } else {
          seen.set(task.id, phase.id)
        }

        if (task.kind === "agent" && !task.prompt) {
          ctx.addIssue({ code: "custom", path: at("prompt"), message: 'required for kind "agent"' })
        }
        if (task.kind === "shell") {
          if (!task.command) {
            ctx.addIssue({ code: "custom", path: at("command"), message: 'required for kind "shell"' })
          }
          if (!limits.shellTasks) {
            ctx.addIssue({
              code: "custom",
              path: at("kind"),
              message: 'shell tasks are disabled; set the plugin option "shellTasks" to true to allow them',
            })
          }
        }
        if (task.model !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: at("model"),
            message: "task.model is not supported in v1: set the model on the agent",
          })
        }
        if (task.isolation !== undefined && !limits.worktrees) {
          ctx.addIssue({
            code: "custom",
            path: at("isolation"),
            message: 'isolation: "worktree" is disabled in the plugin options (worktrees: false)',
          })
        }
        if (task.keep && task.isolation !== "worktree") {
          ctx.addIssue({ code: "custom", path: at("keep"), message: 'task.keep needs isolation: "worktree"' })
        }
      }
    }

    if (total > limits.maxAgents) {
      ctx.addIssue({
        code: "custom",
        path: ["phases"],
        message: `the workflow has ${total} tasks; the limit is ${limits.maxAgents} (option "maxAgents")`,
      })
    }
  })
}

/** The issue sink of `superRefine`, reduced to the one call the checks below make. */
interface IssueSink {
  addIssue: (issue: { code: "custom"; path: (string | number)[]; message: string }) => void
}

/**
 * The rules of a `repeat` phase.
 *
 * The loop only means something when the last task of the phase judges the work before
 * it: the gate has to be that task, it has to answer with `approved`, and there has to be
 * work in front of it to run again.
 */
function checkRepeat(
  phase: z.infer<typeof Phase>,
  repeat: z.infer<typeof Repeat>,
  phaseIndex: number,
  ctx: IssueSink,
): void {
  const at = (field?: string): (string | number)[] =>
    field ? ["phases", phaseIndex, "repeat", field] : ["phases", phaseIndex, "repeat"]

  if (phase.strategy !== "sequential") {
    ctx.addIssue({ code: "custom", path: at(), message: 'only a phase with strategy "sequential" can repeat' })
  }

  const index = phase.tasks.findIndex((task) => task.id === repeat.gate)
  if (index < 0) {
    ctx.addIssue({ code: "custom", path: at("gate"), message: `no task "${repeat.gate}" in this phase` })
    return
  }
  if (index !== phase.tasks.length - 1) {
    ctx.addIssue({ code: "custom", path: at("gate"), message: "the gate has to be the last task of the phase" })
    return
  }
  if (index === 0) {
    ctx.addIssue({ code: "custom", path: at("gate"), message: "the phase needs at least one task before the gate" })
    return
  }

  const gate = phase.tasks[index]!
  const required = gate.outputSchema?.required
  if (gate.kind !== "agent" || !Array.isArray(required) || !required.includes("approved")) {
    ctx.addIssue({
      code: "custom",
      path: at("gate"),
      message: 'the gate has to be an agent task whose outputSchema requires "approved"',
    })
  }
}

/**
 * Parses a workflow spec. Accepts an object or a JSON string. Never throws: an invalid
 * spec comes back as a list of one-line messages, and a spec that was filled in comes
 * back with one warning per filled field.
 */
export function parseSpec(input: unknown, limits: SpecLimits): ParseResult {
  let value = input
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch (error) {
      return { ok: false, errors: [`spec: invalid JSON: ${describe(error)}`] }
    }
  }
  if (!isRecord(value)) return { ok: false, errors: ["spec: must be an object or a JSON object string"] }

  const normalized = normalize(value)
  const result = workflowSchema(limits).safeParse(normalized.value)
  if (!result.success) return { ok: false, errors: result.error.issues.map(formatIssue) }
  return { ok: true, spec: result.data, warnings: normalized.warnings }
}

/**
 * Accepts the aliases `name` (for `id`) and `type` (for `strategy`) before the parse, and
 * drops `$schema`, so the parsed spec never carries the editor hint.
 *
 * Then fills in a missing `specVersion`, phase `id`, and task `id`, and reports each one
 * as a warning. Only an absent key is filled: an empty string, a `null`, and a wrong type
 * stay errors from the parse.
 */
function normalize(workflow: Record<string, unknown>): { value: Record<string, unknown>; warnings: string[] } {
  const phases = Array.isArray(workflow.phases)
    ? workflow.phases.map((phase) => {
        if (!isRecord(phase)) return phase
        const next = alias(phase, { name: "id", type: "strategy" })
        if (Array.isArray(next.tasks)) {
          next.tasks = next.tasks.map((task) => (isRecord(task) ? alias(task, { name: "id" }) : task))
        }
        return next
      })
    : workflow.phases
  const { $schema: _editorHint, ...rest } = workflow
  const value: Record<string, unknown> = { ...rest, phases }
  const warnings: string[] = []
  const filled = (path: (string | number)[], id: string): void => {
    warnings.push(`${formatPath(path)}: missing, set to "${id}"`)
  }

  if (value.specVersion === undefined) {
    value.specVersion = 1
    warnings.push("specVersion: missing, set to 1")
  }

  if (Array.isArray(phases)) {
    // A generated id may not take the id an explicit task already has, wherever it sits.
    const taken = new Set<string>()
    for (const phase of phases) {
      if (!isRecord(phase) || !Array.isArray(phase.tasks)) continue
      for (const task of phase.tasks) if (isRecord(task) && typeof task.id === "string") taken.add(task.id)
    }

    let counter = 0
    for (const [phaseIndex, phase] of phases.entries()) {
      if (!isRecord(phase)) continue
      if (phase.id === undefined) {
        const id = `phase-${phaseIndex + 1}`
        phase.id = id
        filled(["phases", phaseIndex, "id"], id)
      }
      if (!Array.isArray(phase.tasks)) continue
      for (const [taskIndex, task] of phase.tasks.entries()) {
        counter += 1
        if (!isRecord(task) || task.id !== undefined) continue
        while (taken.has(`task-${counter}`)) counter += 1
        const id = `task-${counter}`
        task.id = id
        taken.add(id)
        filled(["phases", phaseIndex, "tasks", taskIndex, "id"], id)
      }
    }
  }

  return { value, warnings }
}

/** Copies `from` to `to` when `to` is absent, and drops the alias key either way. */
function alias(source: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  const next = { ...source }
  for (const [from, to] of Object.entries(map)) {
    if (!(from in next)) continue
    if (next[to] === undefined) next[to] = next[from]
    delete next[from]
  }
  return next
}

/** The keys of every strict object, so an unknown one can be answered with the right list. */
const KEYS = {
  workflow: ["specVersion", "name", "goal", "budget", "phases"],
  budget: ["usd", "tokens"],
  phase: ["id", "title", "strategy", "tasks", "synthesisPrompt", "mailbox", "repeat"],
  task: [
    "id",
    "description",
    "kind",
    "prompt",
    "command",
    "agent",
    "retries",
    "timeoutMs",
    "isolation",
    "keep",
    "outputSchema",
  ],
  mailbox: ["peers", "maxMessages"],
  repeat: ["gate", "maxRounds"],
}

function formatIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") return formatUnknownKeys(issue.path, issue.keys)
  return `${formatPath(issue.path)}: ${issue.message}`
}

/** An unknown key names itself, and the key it was probably meant to be. */
function formatUnknownKeys(path: ReadonlyArray<PropertyKey>, keys: string[]): string {
  const valid = keysAt(path)
  const messages = keys.map((key) => {
    const near = nearest(key, valid)
    const hint = near ? `did you mean "${near}"?` : `the keys of this object are ${valid.join(", ")}`
    return `unknown key "${key}"; ${hint}`
  })
  return `${formatPath(path)}: ${messages.join("; ")}`
}

/** Which object a path points at. The shape is fixed, so the tail of the path names it. */
function keysAt(path: ReadonlyArray<PropertyKey>): string[] {
  const last = path[path.length - 1]
  if (path.length === 0) return KEYS.workflow
  if (last === "budget") return KEYS.budget
  if (last === "mailbox") return KEYS.mailbox
  if (last === "repeat") return KEYS.repeat
  if (path[path.length - 2] === "tasks") return KEYS.task
  if (path[path.length - 2] === "phases") return KEYS.phase
  return KEYS.workflow
}

/** The closest valid key, when it is close enough to be the one that was meant. */
function nearest(key: string, valid: string[]): string | undefined {
  let best: string | undefined
  let shortest = 3
  for (const candidate of valid) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase())
    if (distance < shortest) {
      shortest = distance
      best = candidate
    }
  }
  return best
}

function editDistance(from: string, to: string): number {
  let previous = Array.from({ length: to.length + 1 }, (_, index) => index)
  for (let row = 1; row <= from.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= to.length; column += 1) {
      const cost = from[row - 1] === to[column - 1] ? 0 : 1
      current[column] = Math.min(current[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + cost)
    }
    previous = current
  }
  return previous[to.length]!
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = ""
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`
    else out += out ? `.${String(segment)}` : String(segment)
  }
  return out || "spec"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
