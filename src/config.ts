export interface WorkflowConfig {
  /** The agent a task uses when it names none. Must be a subagent-mode agent. */
  defaultAgent: string
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
  return {
    config: {
      defaultAgent: stringOption(raw.defaultAgent, DEFAULTS.defaultAgent, "options.defaultAgent", warnings),
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
