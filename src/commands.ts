import { ROLE_NAMES } from "./config.js"
import { DSL } from "./spec.js"
import { TEMPLATE_NAMES } from "./templates.js"

/** `ctx.command.transform` draft entry, reduced to what this module builds. */
export interface CommandDefinition {
  name: string
  description?: string
  execute: (input: CommandInvocation) => Promise<void>
}

export interface CommandInvocation {
  sessionID: string
  prompt: { text: string }
  delivery: unknown
}

/** `ctx.session.prompt`, reduced to the one call a command makes. */
export interface CommandSession {
  prompt: (input: { sessionID: string; text: string; delivery: never }) => Promise<unknown>
}

const DETACHED = [
  "The run keeps going after the call returns, so do not wait for it and do not poll it.",
  "Report the runId and stop. A message with the final report arrives here when the run ends.",
].join("\n")

const DEFAULTS = [
  'Use a "parallel" phase for tasks that do not need each other, a "sequential" phase when a task needs',
  'the result of the one before it, and a "team" phase only when the members have to ask you questions',
  'while they work. Set "retries": 1 on every task. Do not set "model". Set "isolation": "worktree"',
  'only when a task edits files and has to stay out of the main checkout.',
  'Put a reviewer gate after an editing task: give the phase "repeat": { "gate": "review", "maxRounds": 3 }',
  'and make the last task a "reviewer" with an "outputSchema" that requires "approved".',
  'When your own agent may not edit files, use only the read-only roles',
  `(${ROLE_NAMES.join(", ")}), no shell task, and no worktree.`,
  `For a build or a plan goal, prefer a built-in workflow (${TEMPLATE_NAMES.join(", ")}):`,
  'call workflow_run_saved with that "name" and the goal as "goal" instead of writing a spec.',
].join("\n")

/**
 * The slash commands.
 *
 * A command cannot answer with text: it acts by putting a prompt into the same session,
 * and the model reads that prompt and calls the tool. Each command therefore builds one
 * envelope, which is the instruction plus what the user typed.
 *
 * A command must never throw. A rejected `session.prompt` is swallowed, because the host
 * has nowhere to show the error.
 */
export function workflowCommands(deps: { session: CommandSession }): CommandDefinition[] {
  const send = async (input: CommandInvocation, text: string): Promise<void> => {
    try {
      await deps.session.prompt({ sessionID: input.sessionID, text, delivery: input.delivery as never })
    } catch {
      // The session may be gone, and a command has no way to report an error.
    }
  }

  return [
    {
      name: "workflow",
      description:
        "Run several tasks in parallel or as a pipeline. Args: a goal in plain English, or a JSON spec. Example: /workflow review each SDK client and compare them",
      execute: (input) => send(input, workflowEnvelope(input.prompt.text ?? "")),
    },
    {
      name: "workflow-status",
      description: "Show where a workflow run stands. Args: a runId, or nothing for the latest run.",
      execute: (input) => send(input, statusEnvelope((input.prompt.text ?? "").trim())),
    },
    {
      name: "workflow-resume",
      description:
        "Restart what a workflow run has left, keeping the finished tasks. Args: a runId, and what a task should do differently.",
      execute: (input) => send(input, resumeEnvelope((input.prompt.text ?? "").trim())),
    },
    {
      name: "workflow-cancel",
      description: "Stop a workflow run and its agents. Args: a runId, or nothing for the latest run.",
      execute: (input) => send(input, cancelEnvelope((input.prompt.text ?? "").trim())),
    },
  ]
}

/** The text a spec passed to `/workflow` is run with, or the one a goal is authored with. */
export function workflowEnvelope(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) {
    return [
      "The user asked for a workflow but named no goal.",
      "Ask what the workflow should do, in one question, and do not call any tool yet.",
    ].join("\n")
  }
  const spec = asSpec(trimmed)
  if (spec) {
    return [
      "The user asked to run this workflow spec.",
      "Call workflow_run with exactly this spec, unchanged:",
      spec,
      "Do not edit it. If workflow_run answers with errors, show them and ask what to change.",
      "The tool result lists any field the loader filled in; repeat that list to the user.",
      DETACHED,
    ].join("\n")
  }
  return [
    "The user asked for a workflow with this goal:",
    trimmed,
    "",
    "1. Write a workflow spec for that goal.",
    DSL,
    DEFAULTS,
    "2. Show the spec.",
    "3. Call workflow_run with it.",
    DETACHED,
  ].join("\n")
}

export function statusEnvelope(runId: string): string {
  const call = runId ? `Call workflow_status with runId "${runId}".` : "Call workflow_status with no runId, which reads the most recent run of this project."
  return [
    call,
    "Then summarise it in three lines: the status, what is done and what is left, and the next action it names.",
    "Do not poll it.",
  ].join("\n")
}

export function cancelEnvelope(runId: string): string {
  const call = runId
    ? [`Call workflow_cancel with runId "${runId}".`]
    : [
        "The user asked to stop a workflow run but named no runId.",
        "Call workflow_status with no runId to read the most recent run of this project,",
        "then call workflow_cancel with that run id.",
      ]
  return [
    ...call,
    "It interrupts the member sessions and marks the run cancelled. Only the session that leads the run can cancel it.",
    "Then say which run was stopped, in one line. Do not start it again unless the user asks.",
  ].join("\n")
}

export function resumeEnvelope(runId: string): string {
  if (!runId) {
    return [
      "The user asked to resume a workflow run but named no runId.",
      "Call workflow_status to see the most recent run, show its id and status, and ask whether to resume it.",
    ].join("\n")
  }
  return [
    `Call workflow_resume with runId "${runId}".`,
    "It keeps every task that already completed and starts what is left.",
    'If the user says what a task should do differently, pass it as guidance: { "taskId": "the text" }.',
    "If it answers that the budget is spent, say so and ask whether to raise it with overrides.maxCostUsd or overrides.maxTokens.",
    DETACHED,
  ].join("\n")
}

/** The argument text, when it is a JSON object that names a spec version or its phases. */
function asSpec(text: string): string | undefined {
  if (!text.startsWith("{")) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return "specVersion" in parsed || Array.isArray((parsed as { phases?: unknown }).phases) ? text : undefined
  } catch {
    return undefined
  }
}
