import { ROLE_NAMES, type WorkflowConfig } from "./config.js"
import { DSL } from "./spec.js"
import { TEMPLATE_NAMES } from "./templates.js"

/**
 * `ctx.skill.transform` draft entry, reduced to what this module builds.
 *
 * `@opencode-ai/schema` is a transitive dependency, not a declared one, and its
 * `Skill.Info` brands `id`, `name`, and `location`, so the call site casts once.
 */
export interface SkillDefinition {
  id: string
  name: string
  description: string
  /** A synthetic path. It must not end in `SKILL.md`, or the host scans a sibling directory. */
  location: string
  content: string
}

/** Kept under 200 characters: the host shows it in the skill listing of every session. */
const DESCRIPTION = [
  "Run many agent tasks at once, or as a pipeline, from one JSON spec you write.",
  "Use when work goes in parallel, fans out over files or repos, chains into stages, or needs a team.",
].join(" ")

/**
 * The `workflow` skill, built from the resolved options so the model reads the real
 * defaults instead of guessing them.
 *
 * No `slash` flag: a command named `workflow` already exists, and a same-named command
 * shadows the skill in the palette.
 */
export function workflowSkill(config: WorkflowConfig): SkillDefinition {
  return {
    id: "workflow",
    name: "workflow",
    description: DESCRIPTION,
    location: "/builtin/oc-dynamic-workflows/workflow.md",
    content: body(config),
  }
}

function body(config: WorkflowConfig): string {
  const shell = config.shellTasks
    ? '- `kind: "shell"` is allowed, but a shell task bypasses the permission rules. Use it only for a\n  short read-only command, and never for one the user did not ask for.'
    : '- `kind: "shell"` is turned off in this project. Every task is an agent task.'

  return `# Workflow

The workflow engine runs a JSON spec. Each task becomes its own agent session. You write the
spec; the user does not. The user says what they want in plain words, and you turn it into a
spec, show it, and start it.

A run is **detached**. \`workflow_run\` returns a run id at once and the work goes on behind it.
Report the id and stop. The final report arrives in this session by itself when the run ends.

## How to call the tools

The workflow tools are ordinary tools. When they are listed as top-level tools, call them
directly. When your session runs Code Mode, they live under \`tools\` inside the \`execute\` tool:

\`\`\`js
const result = await tools.workflow_run({ spec })
return result
\`\`\`

If the path is not in your catalog, run \`search({ query: "workflow_run" })\` **inside**
\`execute\`; \`search\` is not a top-level tool. Do not guess other paths. Every tool returns an
object with \`ok\` and, on failure, \`error\` or \`errors\`.

## When to use a workflow

Use one when the work splits into parts that a separate agent can do on its own:

- **Fan-out.** The same question over many files, modules, repos, or sources.
- **Pipeline.** Stage 2 needs the result of stage 1.
- **Team.** The members have to ask you questions while they work.

Do **not** use one for a single task. Call the \`subagent\` tool. Do not use one for work that
takes you under about two minutes. Do it yourself.

## Built-in workflows

Three workflows are built in. Prefer one over a spec you write yourself when the goal is a
build or a plan. Run one with \`workflow_run_saved\`, a \`name\`, and a \`goal\`:

\`\`\`js
await tools.workflow_run_saved({ name: "${TEMPLATE_NAMES[0]}", goal: "Add a --json flag to the CLI." })
\`\`\`

| Name | What it runs |
|------|--------------|
| \`build-review\` | \`impl\` in a worktree, then a \`reviewer\` gate. Up to 3 rounds. |
| \`secure-build\` | \`impl\` in a worktree, a \`reviewer\`, then a \`security-reviewer\` gate. Up to 3 rounds. |
| \`plan-research\` | Three \`researcher\` tasks side by side, then a plan and a \`stakeholder\` gate. Up to 2 rounds. It edits nothing. |

A built-in has no goal of its own, so the call is refused without one. \`workflow_list\` shows
them next to the saved workflows, marked \`(built-in)\`, and \`workflow_show\` prints one. A file
of the same name under \`.opencode/workflows/\` is used instead of the built-in.

## How to write a spec from a goal

1. Name the parts. One part is one task with one clear result.
2. Group the parts into phases. Parts that do not need each other go in one \`parallel\` phase.
   A part that needs an earlier result goes in a later phase, or in a \`sequential\` phase.
3. Give each task a prompt that stands alone. The member has never seen this conversation. Name
   the files, the paths, and the shape of the answer you want.
4. Add a \`synthesisPrompt\` to any phase whose outputs must be joined into one summary.
5. Show the spec to the user, then call \`workflow_run\`.

Only a \`sequential\` phase passes earlier task outputs on. A \`parallel\` phase does not, because
the order of its results is not fixed. Between phases, only the synthesis travels.

### Grammar

${DSL}
Task ids are unique across the whole workflow, not only inside one phase.

## Defaults

- Set \`"retries": 1\` on every task. Do not set \`model\`.
- Set \`"isolation": "worktree"\` only when a task edits files and has to stay out of the main
  checkout. The task gets its own checkout of \`HEAD\`, its edits are saved as a patch, and the
  worktree is removed unless the task sets \`"keep": true\`.
- Leave \`agent\` out unless the user names one, or unless a role fits the task.
  It falls back to \`${config.defaultAgent}\`. Set a role's model in the plugin options, not in the spec.
- Leave \`timeoutMs\` out unless a task is unusually long. The default is ${minutes(config.defaultTaskTimeoutMs)} per task,
  and ${config.maxRunMinutes} minutes for the whole run.
- ${config.concurrency} tasks of one phase run at a time. The ceiling is ${config.maxAgents} tasks in one workflow.
- Add \`"budget": { "usd": N }\` when the user names a cost limit, and only then.
${shell}

## Roles

The plugin registers one read-only subagent per role: ${ROLE_NAMES.join(", ")}. Name one
with \`"agent"\` on a task, the way you name any other agent.

| Role | What it does | What it answers with |
|------|--------------|----------------------|
| \`reviewer\` | Judges the edits of an earlier task against that task and the goal | \`{ "approved": boolean, "findings": string[] }\` |
| \`security-reviewer\` | Judges the same edits for injection, broken authorization, secrets, and path traversal | the same shape |
| \`researcher\` | Gathers facts and names a source for every claim | \`{ "findings": [{ "claim", "source" }], "open": string[] }\` |
| \`stakeholder\` | Checks a result against the goal, not against what the producers said about it | \`{ "approved": boolean, "gaps": string[] }\` |
| \`synthesizer\` | Joins the outputs of a phase into one coherent summary | synthesis text only |

A role edits nothing, spawns nothing, and never stops to ask a question. Its model comes from
\`roles.<role>.model\` in the plugin options. The synthesizer instead follows
\`options.synthesisModel\`.

## Review gates

A \`sequential\` phase can carry \`"repeat": { "gate": "<task id>", "maxRounds": 3 }\`. The gate is
the last task of the phase; it judges the tasks in front of it and answers one JSON object, so
it needs an \`outputSchema\` that requires \`approved\`. Put a gate after any task that edits files.

\`\`\`json
{
  "id": "build",
  "strategy": "sequential",
  "repeat": { "gate": "review", "maxRounds": 3 },
  "tasks": [
    { "id": "impl", "prompt": "Implement the goal. Reply with what you changed and how you verified it.", "isolation": "worktree", "retries": 1 },
    { "id": "review", "agent": "reviewer", "prompt": "Review the patch of task impl against the goal. Reply with one JSON object.", "retries": 1,
      "outputSchema": { "type": "object", "required": ["approved"], "properties": { "approved": { "type": "boolean" }, "findings": { "type": "array", "items": { "type": "string" } } } } }
  ]
}
\`\`\`

A round the gate refuses runs the whole phase again with the findings in the prompt. The loop
ends on an approval, at \`maxRounds\`, or when the gate did not complete. The synthesis of the
phase runs once, after the last round. \`maxAgents\` counts the tasks, not the rounds, so a
repeat phase can spawn up to \`maxRounds\` times its tasks.

## Plan mode

A lead that may not edit files may not have its members edit for it. \`workflow_run\`,
\`workflow_run_saved\`, and \`workflow_resume\` refuse a spec that holds a shell task, a worktree
task, or a task on an agent that may edit, and the refusal names every such task.

Under a read-only agent use only the read-only roles, no \`"kind": "shell"\`, and no
\`"isolation": "worktree"\`. \`plan-research\` is built for that case.

## Examples

### Parallel research fan-out

"Read each of the three SDK clients and tell me where they diverge."

\`\`\`json
{
  "specVersion": 1,
  "name": "client-survey",
  "goal": "Compare the three SDK clients and report where they diverge.",
  "phases": [
    {
      "id": "read",
      "strategy": "parallel",
      "synthesisPrompt": "Compare the three reports. List every divergence, with the file and the client that differs.",
      "tasks": [
        { "id": "ios", "prompt": "Read ios/OpenCodeSDK/. Report its endpoints, its error handling, and its auth flow. Cite file paths.", "retries": 1 },
        { "id": "android", "prompt": "Read android/app/src/main/java/.../sdk/. Report its endpoints, its error handling, and its auth flow. Cite file paths.", "retries": 1 },
        { "id": "web", "prompt": "Read web/src/sdk/. Report its endpoints, its error handling, and its auth flow. Cite file paths.", "retries": 1 }
      ]
    }
  ]
}
\`\`\`

### Sequential pipeline

"Migrate the Android app to Compose Navigation, in stages."

\`\`\`json
{
  "specVersion": 1,
  "name": "compose-nav",
  "goal": "Move the Android app from the Navigation Component to Compose Navigation.",
  "phases": [
    {
      "id": "survey",
      "strategy": "parallel",
      "synthesisPrompt": "Merge the two reports into one migration inventory.",
      "tasks": [
        { "id": "routes", "prompt": "List every destination in the current nav graph, with its arguments.", "retries": 1 },
        { "id": "callers", "prompt": "List every call site that navigates, with file and line.", "retries": 1 }
      ]
    },
    {
      "id": "plan",
      "strategy": "sequential",
      "tasks": [
        { "id": "design", "prompt": "Using the inventory above, write the target Compose Navigation graph and the route sealed class.", "retries": 1 },
        { "id": "steps", "prompt": "Using the design above, write the ordered migration steps, one screen per step, each with its verification command.", "retries": 1 }
      ]
    }
  ]
}
\`\`\`

### Team phase with questions

Use a \`team\` phase only when a member cannot finish without an answer from you.

\`\`\`json
{
  "specVersion": 1,
  "name": "flaky-tests",
  "goal": "Fix the three flaky tests, asking the lead when a fix changes behaviour.",
  "phases": [
    {
      "id": "fix",
      "strategy": "team",
      "mailbox": { "maxMessages": ${config.mailboxMaxMessages} },
      "synthesisPrompt": "Summarise each fix and every decision the lead made.",
      "tasks": [
        { "id": "auth", "prompt": "Fix the flake in AuthInterceptorTest. Use team_send with type \\"question\\" before you change any behaviour the test asserts.", "retries": 1 },
        { "id": "sync", "prompt": "Fix the flake in SyncWorkerTest. Use team_send with type \\"question\\" before you change any behaviour the test asserts.", "retries": 1 }
      ]
    }
  ]
}
\`\`\`

After you start a team run, stay available. A member's \`question\` wakes you. Read the mail with
\`team_inbox\`, answer with \`team_steer\` naming the \`taskId\`, and go on. A \`status\` or a \`result\`
does not wake you; you see it at your next turn. Add \`"force": true\` to a steer only to stop a
member that is going the wrong way.

## Check, resume, cancel

- **Check.** Call \`workflow_status\`. Leave \`runId\` out for the most recent run of this project.
  Summarise it in three lines: the status, what is done and what is left, and the next action.
- **Resume.** Call \`workflow_resume\` with the run id. Every task that already completed keeps its
  output and is not sent again. You become the lead, so the report arrives here. A run that spent
  its budget needs \`overrides\` with a higher \`maxCostUsd\` or \`maxTokens\`. When a task failed
  because the user rejected a permission, pass \`guidance\` (task id to text) with a different
  approach; the text is added to that task's prompt on the new attempt.
- **Cancel.** Call \`workflow_cancel\` with the run id, or with a \`taskId\` to stop one task. Only
  the session that leads the run can cancel it.
- **Nothing works.** Call \`workflow_doctor\` before you guess. It reports the subagent executor,
  the default agent, the options, the saved specs that do not parse, and the runs still marked
  running.
- **Saved specs.** \`workflow_list\` shows the names under \`.opencode/workflows/\` and the built-in
  ones, \`workflow_show\` prints one, and \`workflow_run_saved\` runs one.

## What not to do

- Do not poll. Never call \`workflow_status\` in a loop, and never wait for a run to end. The
  report comes to you.
- Do not start a workflow for one task. Call \`subagent\`.
- Do not set \`task.model\`. It is rejected. Set the model on the agent.
- Do not set \`"isolation": "worktree"\` on a read-only task. It buys a checkout for nothing.
- Do not use a \`team\` phase when the members need no answers. Use \`parallel\`.
- Do not write a prompt that says "as discussed above". The member has no context but its prompt.
- Do not save a spec to \`.opencode/workflows/\` unless the user asks for it.
- Do not repeat a rejected spec. \`workflow_run\` names the field and the fix; correct that field.
- Do not start a workflow from inside a workflow. A member session is refused.
- Do not put secrets, tokens, or \`.env\` contents into a prompt or a shell command.
`
}

function minutes(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`
  return `${Math.round(ms / 60_000)} minutes`
}
