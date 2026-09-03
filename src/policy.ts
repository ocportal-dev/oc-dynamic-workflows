import { ROLE_NAMES } from "./config.js"
import type { WorkflowSpec } from "./types.js"

/** One rule of an agent, the shape `Agent.Info.permissions` holds. */
export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** Core's `Wildcard.match`: everything is literal except `*`, and the pattern is anchored. */
export function wildcard(input: string, pattern: string): boolean {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${source}$`).test(input)
}

/** Core's `Permission.evaluate`: the last rule that matches wins, and the default is `ask`. */
export function evaluate(action: string, resource: string, rules: PermissionRule[]): PermissionRule["effect"] {
  let effect: PermissionRule["effect"] = "ask"
  for (const rule of rules) {
    if (wildcard(action, rule.action) && wildcard(resource, rule.resource)) effect = rule.effect
  }
  return effect
}

/**
 * Whether an agent may change files at all.
 *
 * No rules means no policy, which reads as may-edit, because a run is refused only when
 * the lead is provably read-only.
 */
export function mayEdit(rules: PermissionRule[] | undefined): boolean {
  return rules === undefined || evaluate("edit", "*", rules) !== "deny"
}

/**
 * The rules of one agent of `ctx.agent.list`. Undefined when the host listed nothing or
 * does not have that agent.
 */
export function agentRules(agents: unknown[] | undefined, id: string): PermissionRule[] | undefined {
  if (!agents) return undefined
  const found = agents
    .map((entry) => entry as { id?: unknown; name?: unknown; permissions?: unknown })
    .find((entry) => entry.id === id || entry.name === id)
  if (!found) return undefined
  return Array.isArray(found.permissions) ? (found.permissions as PermissionRule[]) : []
}

/** What a read-only lead can run instead. The roles this plugin registers, plus core's. */
const FIX = `use a read-only role (${ROLE_NAMES.join(", ")}) or explore, and drop the shell and worktree tasks`

/**
 * The tasks of a spec that can change files: one line each, and a last line with the fix.
 *
 * An agent the host does not list counts as may-edit, because under a read-only lead the
 * unknown case is refused rather than waved through.
 */
export function readOnlyViolations(
  spec: WorkflowSpec,
  agents: unknown[] | undefined,
  defaultAgent: string,
  synthesizerAgent = "synthesizer",
): string[] {
  const lines: string[] = []
  for (const phase of spec.phases) {
    for (const task of phase.tasks) {
      const reasons: string[] = []
      if (task.kind === "shell") reasons.push('kind: "shell" runs a command outside the permission rules')
      if (task.isolation === "worktree") reasons.push('isolation: "worktree" checks the repository out to edit it')
      if (task.kind === "agent") {
        const agent = task.agent ?? defaultAgent
        if (mayEdit(agentRules(agents, agent))) reasons.push(`agent "${agent}" may edit`)
      }
      if (reasons.length) lines.push(`${phase.id}/${task.id}: ${reasons.join("; ")}`)
    }
  }
  if (spec.phases.some((phase) => phase.synthesisPrompt !== undefined) && mayEdit(agentRules(agents, synthesizerAgent))) {
    lines.push(`synthesis: agent "${synthesizerAgent}" may edit`)
  }
  if (lines.length) lines.push(FIX)
  return lines
}
