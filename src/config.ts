/** A model reference in the form OpenCode agents take. */
export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/** The roles the plugin registers one subagent for. */
export const ROLE_NAMES = ["reviewer", "security-reviewer", "researcher", "stakeholder", "synthesizer"] as const
export type RoleName = (typeof ROLE_NAMES)[number]

export interface RoleConfig {
  /** The model that role runs on. Without one it inherits the lead's model. */
  model?: ModelRef
  /** The agent to use instead of the one the plugin registers. */
  agent?: string
}

export interface WorkflowConfig {
  /** The agent a task uses when it names none. Must be a subagent-mode agent. */
  defaultAgent: string
  /** The model and the agent of every role. Every role has an entry. */
  roles: Record<RoleName, RoleConfig>
  /** The model a phase synthesis runs on. Without one it inherits the lead's model. */
  synthesisModel?: ModelRef
  /** How many tasks of one phase run at the same time. */
  concurrency: number
  /** The ceiling on the number of tasks in one workflow. */
  maxAgents: number
  /** The ceiling on the number of mail messages in one run. */
  mailboxMaxMessages: number
  /** Whether `kind: "shell"` tasks are accepted. Shell tasks bypass the permission rules. */
  shellTasks: boolean
  /** Whether `isolation: "worktree"` is accepted. A worktree task runs in its own checkout. */
  worktrees: boolean
  /** The time one task gets when its spec sets no `timeoutMs`. */
  defaultTaskTimeoutMs: number
  /** The time one whole run gets. Past it the run stops and ends as `partial`. */
  maxRunMinutes: number
}

const DEFAULTS: WorkflowConfig = {
  defaultAgent: "general",
  roles: { reviewer: {}, "security-reviewer": {}, researcher: {}, stakeholder: {}, synthesizer: {} },
  concurrency: 4,
  maxAgents: 100,
  mailboxMaxMessages: 20,
  shellTasks: true,
  worktrees: true,
  defaultTaskTimeoutMs: 900_000,
  maxRunMinutes: 120,
}

/**
 * Reads the plugin options. Never throws: an invalid option becomes a warning and the
 * default value, so a typo cannot stop the plugin from loading.
 */
export function resolveConfig(options: unknown): { config: WorkflowConfig; warnings: string[] } {
  const warnings: string[] = []
  const raw = recordValue(options) ?? {}
  const synthesisModel = modelOption(raw.synthesisModel, "options.synthesisModel", warnings)
  return {
    config: {
      defaultAgent: stringOption(raw.defaultAgent, DEFAULTS.defaultAgent, "options.defaultAgent", warnings),
      roles: rolesOption(raw.roles, warnings),
      // The key is left out when there is no model, so the config equals the defaults.
      ...(synthesisModel ? { synthesisModel } : {}),
      concurrency: numberOption(raw.concurrency, DEFAULTS.concurrency, 1, 16, "options.concurrency", warnings),
      maxAgents: numberOption(raw.maxAgents, DEFAULTS.maxAgents, 1, 1000, "options.maxAgents", warnings),
      mailboxMaxMessages: numberOption(
        raw.mailboxMaxMessages,
        DEFAULTS.mailboxMaxMessages,
        1,
        50,
        "options.mailboxMaxMessages",
        warnings,
      ),
      shellTasks: booleanOption(raw.shellTasks, DEFAULTS.shellTasks, "options.shellTasks", warnings),
      worktrees: booleanOption(raw.worktrees, DEFAULTS.worktrees, "options.worktrees", warnings),
      defaultTaskTimeoutMs: numberOption(
        raw.defaultTaskTimeoutMs,
        DEFAULTS.defaultTaskTimeoutMs,
        5_000,
        1_800_000,
        "options.defaultTaskTimeoutMs",
        warnings,
      ),
      maxRunMinutes: numberOption(raw.maxRunMinutes, DEFAULTS.maxRunMinutes, 5, 1440, "options.maxRunMinutes", warnings),
    },
    warnings,
  }
}

/**
 * Reads a `provider/model` or `provider/model#variant` string, the form core takes.
 * Returns undefined for anything else, so no caller has to catch.
 */
export function parseModel(text: string): ModelRef | undefined {
  if (!/^[^/#]+\/[^#]+(?:#[^#]+)?$/.test(text)) return undefined
  const slash = text.indexOf("/")
  const providerID = text.slice(0, slash)
  const [id, variant] = text.slice(slash + 1).split("#")
  return variant ? { providerID, id: id!, variant } : { providerID, id: id! }
}

/** The string form of a model, which is what the doctor and the warnings print. */
export function formatModel(model: ModelRef): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

function modelOption(value: unknown, name: string, warnings: string[]): ModelRef | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === "string" ? parseModel(value.trim()) : undefined
  if (parsed) return parsed
  warnings.push(`${name} must be a "provider/model" string; ignoring it`)
  return undefined
}

function agentOption(value: unknown, name: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string" && value.trim()) return value.trim()
  warnings.push(`${name} must be a non-empty string; ignoring it`)
  return undefined
}

/** Every role gets an entry, so a reader never has to check for one. */
function rolesOption(value: unknown, warnings: string[]): Record<RoleName, RoleConfig> {
  const roles = Object.fromEntries(ROLE_NAMES.map((role) => [role, {}])) as Record<RoleName, RoleConfig>
  if (value === undefined) return roles
  const raw = recordValue(value)
  if (!raw) {
    warnings.push("options.roles must be an object; ignoring it")
    return roles
  }
  for (const [key, entry] of Object.entries(raw)) {
    if (!(ROLE_NAMES as readonly string[]).includes(key)) {
      warnings.push(`options.roles.${key} is not a role; the roles are ${ROLE_NAMES.join(", ")}`)
      continue
    }
    const role = key as RoleName
    const fields = recordValue(entry)
    if (!fields) {
      warnings.push(`options.roles.${role} must be an object; ignoring it`)
      continue
    }
    // Synthesis has one model source of truth. Do not retain this value: otherwise the
    // doctor could report a model different from the one its child session uses.
    const model =
      role === "synthesizer" && fields.model !== undefined
        ? (warnings.push("options.roles.synthesizer.model is ignored; use options.synthesisModel instead"), undefined)
        : modelOption(fields.model, `options.roles.${role}.model`, warnings)
    const agent = agentOption(fields.agent, `options.roles.${role}.agent`, warnings)
    roles[role] = { ...(model ? { model } : {}), ...(agent ? { agent } : {}) }
  }
  return roles
}

function stringOption(value: unknown, fallback: string, name: string, warnings: string[]): string {
  if (value === undefined) return fallback
  if (typeof value === "string" && value.trim()) return value.trim()
  warnings.push(`${name} must be a non-empty string; using ${fallback}`)
  return fallback
}

function numberOption(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`${name} must be a number; using ${fallback}`)
    return fallback
  }
  const rounded = Math.floor(value)
  const clamped = Math.min(Math.max(rounded, min), max)
  if (clamped !== rounded) warnings.push(`${name} must be between ${min} and ${max}; using ${clamped}`)
  return clamped
}

function booleanOption(value: unknown, fallback: boolean, name: string, warnings: string[]): boolean {
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  warnings.push(`${name} must be true or false; using ${fallback}`)
  return fallback
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
