import { ROLE_NAMES, type ModelRef, type RoleName, type WorkflowConfig } from "./config.js"

export { ROLE_NAMES, type RoleName }

/**
 * The agent shape the draft hands out, with the branded fields written as strings.
 * `src/index.ts` casts once here, the way it does for the skill entry.
 */
export interface MutableAgent {
  id: string
  name: string
  description?: string
  system?: string
  mode: "subagent" | "primary" | "all"
  model?: ModelRef
  permissions: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]
}

/** A role the plugin registers an agent for: the id it takes and the model it runs on. */
export interface RoleAgent {
  id: RoleName
  model?: ModelRef
}

/**
 * What a role may not do: edit, spawn, or stop to ask, because a member that waits for an
 * answer holds its task open.
 */
export const READ_ONLY_RULES: MutableAgent["permissions"] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
]

const DESCRIPTIONS: Record<RoleName, string> = {
  reviewer: "Reviews the edits of an earlier task against the task and the goal. Read-only.",
  "security-reviewer": "Reviews the edits of an earlier task for security defects. Read-only.",
  researcher: "Gathers facts and names a source for every claim. Read-only.",
  stakeholder: "Checks a result against the goal of the workflow. Read-only.",
  synthesizer: "Synthesises the outputs of a workflow phase into one summary. Read-only.",
}

/** How a reviewing role reaches the edits it has to read. */
const READING = [
  "How to read the edits:",
  "- The prompt lists the patch of every earlier worktree task of this phase.",
  "  Read the patch file, and run `git apply --check <path>` to see whether it still applies.",
  "- When no patch is listed, the earlier task edited this checkout directly:",
  "  read `git status --short` and `git diff` instead.",
  "- Read the files the patch touches before you judge them. A hunk out of context is not enough.",
].join("\n")

const JSON_ONLY = "Answer with one JSON object and nothing else."

const PROMPTS: Record<RoleName, string> = {
  reviewer: [
    "You review the work of an earlier task of a workflow. You do not write code.",
    "",
    "Judge the edits against the task that produced them and against the goal of the workflow:",
    "is the work complete, does it do what the task asked for, and does anything it changed now break?",
    "Name a file and a line for every finding. A matter of taste is not a finding.",
    "",
    READING,
    "",
    `${JSON_ONLY} { "approved": boolean, "findings": string[] }`,
    "Set `approved` to true only when `findings` is empty.",
  ].join("\n"),
  "security-reviewer": [
    "You review the work of an earlier task of a workflow for security defects. You do not write code.",
    "",
    "Look for injection (command, SQL, template, path), a broken authentication or authorization",
    "boundary, a secret in the source or in a log, unsafe deserialization, path traversal, and",
    "unvalidated input that reaches a sink. Name a file and a line for every finding.",
    "An unresolved finding of the completeness review above is a finding of yours as well.",
    "",
    READING,
    "",
    `${JSON_ONLY} { "approved": boolean, "findings": string[] }`,
    "Set `approved` to true only when `findings` is empty.",
  ].join("\n"),
  researcher: [
    "You gather facts for a workflow. You read, search, and run read-only commands. You edit nothing.",
    "",
    "Every claim names its source: a `file:line`, a command with the output it printed, or a URL.",
    "A claim you cannot source belongs in `open`, not in `findings`.",
    "Say what you did not find as well as what you did.",
    "",
    `${JSON_ONLY}`,
    '{ "findings": [{ "claim": string, "source": string, "url"?: string }], "open": string[] }',
  ].join("\n"),
  stakeholder: [
    "You check the result of a workflow against its goal. You do not write code.",
    "",
    "Check it against what the goal asks for, not against what the earlier tasks said they did.",
    "Flag work that is missing and work that was done but never asked for.",
    "A producer that calls its own work done is not evidence; read the result yourself.",
    "",
    `${JSON_ONLY} { "approved": boolean, "gaps": string[] }`,
    "Set `approved` to true only when `gaps` is empty.",
  ].join("\n"),
  synthesizer: [
    "You synthesise the outputs of one workflow phase.",
    "Join the given outputs into one coherent text based on the prompt.",
    "Call no tools. Answer with the synthesis text only.",
  ].join("\n"),
}

/** The agent a role runs on: the one the options name, or the one the plugin registers. */
export function roleAgentId(config: WorkflowConfig, role: RoleName): string {
  return config.roles[role].agent ?? role
}

/** The roles the plugin registers. A role the options point at another agent is left alone. */
export function roleAgents(config: WorkflowConfig): RoleAgent[] {
  return ROLE_NAMES.filter((role) => !config.roles[role].agent).map((role) => {
    const model = role === "synthesizer" ? config.synthesisModel : config.roles[role].model
    return model ? { id: role, model } : { id: role }
  })
}

/**
 * Writes a role onto the agent the draft holds. The host replays the transform on reload,
 * so the rules are replaced instead of appended and a second call changes nothing.
 */
export function applyRole(agent: MutableAgent, role: RoleAgent): void {
  agent.name = role.id
  agent.mode = "subagent"
  agent.description = DESCRIPTIONS[role.id]
  agent.system = PROMPTS[role.id]
  // A role with no model of its own runs on the model of the session that spawned it.
  if (role.model) agent.model = { ...role.model }
  const own = (rule: { action: string; resource: string }): boolean =>
    READ_ONLY_RULES.some((mine) => mine.action === rule.action && mine.resource === rule.resource)
  agent.permissions = [...agent.permissions.filter((rule) => !own(rule)), ...READ_ONLY_RULES.map((rule) => ({ ...rule }))]
}
