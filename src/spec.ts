import { z } from "zod"
import type { WorkflowSpec } from "./types.js"

export interface SpecLimits {
  maxAgents: number
  shellTasks: boolean
}

export type ParseResult = { ok: true; spec: WorkflowSpec } | { ok: false; errors: string[] }

/** The summary of the DSL that every tool and every command that reads a spec carries. */
export const DSL = [
  'A spec is JSON with "specVersion": 1, "name", "goal", and "phases".',
  'A phase has "id", "strategy" ("sequential", "parallel", or "team"), "tasks", and an optional "synthesisPrompt".',
  'A task has "id", "kind" ("agent" with a "prompt", or "shell" with a "command"), and optional "agent", "retries" (0-3), "timeoutMs", and "outputSchema".',
  'Set the model on the agent: "model" and "isolation" on a task are rejected.',
  'A "team" phase runs like "parallel" and opens the mailbox: its members use team_send, and you use team_steer and team_inbox.',
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
  outputSchema: z.record(z.string(), z.unknown()).optional(),
})

const Mailbox = z.strictObject({
  peers: z.literal(false).default(false),
  maxMessages: z.number().int().min(1).max(50).default(20),
})

const Phase = z.strictObject({
  id: z.string().min(1),
  title: z.string().optional(),
  strategy: z.enum(["sequential", "parallel", "team"]).default("parallel"),
  tasks: z.array(Task).min(1),
  synthesisPrompt: z.string().optional(),
  mailbox: Mailbox.optional(),
})

const Workflow = z.strictObject({
  specVersion: z.literal(1),
  name: z.string().min(1),
  goal: z.string().min(1),
  budget: Budget.optional(),
  phases: z.array(Phase).min(1),
})

/** The schema depends on the resolved options, so it is built per call. */
function workflowSchema(limits: SpecLimits) {
  return Workflow.superRefine((workflow, ctx) => {
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
        if (task.isolation !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: at("isolation"),
            message: 'isolation: "worktree" is not supported in v1',
          })
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

/**
 * Parses a workflow spec. Accepts an object or a JSON string. Never throws: an invalid
 * spec comes back as a list of one-line messages.
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

  const result = workflowSchema(limits).safeParse(normalize(value))
  if (!result.success) return { ok: false, errors: result.error.issues.map(formatIssue) }
  return { ok: true, spec: result.data }
}

/** Accepts the aliases `name` (for `id`) and `type` (for `strategy`) before the parse. */
function normalize(workflow: Record<string, unknown>): Record<string, unknown> {
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
  return { ...workflow, phases }
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
  phase: ["id", "title", "strategy", "tasks", "synthesisPrompt", "mailbox"],
  task: ["id", "description", "kind", "prompt", "command", "agent", "retries", "timeoutMs", "outputSchema"],
  mailbox: ["peers", "maxMessages"],
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
