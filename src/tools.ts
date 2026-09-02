import type { Info } from "@opencode-ai/plugin/promise/tool"
import { z } from "zod"
import type { WorkflowConfig } from "./config.js"
import { envelope, type Mailbox } from "./mailbox.js"
import type { RunStore } from "./persistence.js"
import { renderErrors, renderSpecTree, renderStatus } from "./report.js"
import type { Roster } from "./roster.js"
import type { Runner } from "./runner.js"
import type { Spawner } from "./spawner.js"
import { DSL, parseSpec } from "./spec.js"
import * as store from "./spec-store.js"
import type { MailEvent } from "./types.js"

export interface ToolDeps {
  config: WorkflowConfig
  /** The warnings `resolveConfig` produced. `workflow_doctor` reports them. */
  warnings: string[]
  /**
   * The directory of this instance.
   *
   * Saved specs live under `<directory>/.opencode/workflows/`, and a run started here is
   * anchored to it, so it never writes into the worktree of another instance.
   */
  directory: string
  spawner: Spawner
  runner: Runner
  runs: RunStore
  roster: Roster
  mailbox: Mailbox
  /** `ctx.agent.list`. Missing means the agent cannot be checked. */
  agents?: () => Promise<unknown>
  /** `ctx.plugin.list`. Missing means the permission classifier cannot be checked. */
  plugins?: () => Promise<unknown>
}

/** The sibling plugin that reviews a permission ask. It registers nothing else to look for. */
const CLASSIFIER_ID = "opencode-permissions-classifier"

export type WorkflowTool = Info

const DETACHED = [
  "The run keeps going after this call returns, so do not wait for it and do not poll it.",
  "A message with the final report arrives in this session when the run ends.",
].join("\n")

const Overrides = z
  .object({
    maxCostUsd: z.number().optional(),
    maxTokens: z.number().optional(),
    concurrency: z.number().optional(),
  })
  .optional()

/**
 * Once a tool declares an output schema the host requires `output` on every result,
 * including error paths. Every tool shares this shape so each path can satisfy it.
 */
const Outcome = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  errors: z.array(z.string()).optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
  /** The fields the loader filled in. A start sets it, empty when the spec was complete. */
  warnings: z.array(z.string()).optional(),
  names: z.array(z.string()).optional(),
  /** Whether the built-in subagent executor was captured. Members cannot be spawned without it. */
  executor: z.enum(["available", "missing"]).optional(),
  runId: z.string().optional(),
  status: z.string().optional(),
  report: z.string().optional(),
  /** The `guidance` keys of a resume that name no task of the run. */
  ignoredGuidance: z.array(z.string()).optional(),
  /** The `workflow_doctor` findings. */
  doctor: z.record(z.string(), z.unknown()).optional(),
  /** The mail one team call sent, or the mail the lead read. */
  mail: z
    .array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        direction: z.enum(["member_to_lead", "lead_to_member"]),
        type: z.enum(["status", "question", "result", "steer"]),
        body: z.string(),
        ref: z.string().optional(),
        createdAt: z.string(),
        delivered: z.boolean(),
      }),
    )
    .optional(),
  /** Every task of the run: which session it got and where it stands. */
  roster: z
    .array(z.object({ taskId: z.string(), sessionID: z.string().optional(), status: z.string() }))
    .optional(),
})
type Outcome = z.infer<typeof Outcome>
type Result = { content: string; output: Outcome }
type Caller = { sessionID: string; agent: string }

const fail = (error: string): Result => ({ content: `error: ${error}`, output: { ok: false, error } })

/**
 * Every executor catches its own errors. The host turns a rejected tool promise into a
 * fiber defect instead of a tool error, so these functions must always resolve.
 */
export function workflowTools(deps: ToolDeps): WorkflowTool[] {
  const limits = {
    maxAgents: deps.config.maxAgents,
    shellTasks: deps.config.shellTasks,
    worktrees: deps.config.worktrees,
  }

  /**
   * A member session is a task of a run. It may not drive the engine that started it.
   * This is the only lock under Code Mode, where the tool namespace comes from the registry
   * and the context hook's deletion does not reach it, and the backup for the direct path.
   * Every tool of `MEMBER_TOOLS` this plugin owns calls it first, and a test walks that list.
   */
  const denyMember = async (context: Caller, action: string, instead: string): Promise<Result | undefined> => {
    const member = await deps.roster.resolveMember(context.sessionID).catch(() => undefined)
    if (!member) return undefined
    return fail(
      `you are task "${member.taskId}" of workflow run ${member.runId}, and a task cannot ${action}. ${instead}`,
    )
  }

  const startRun = async (source: unknown, context: Caller, overrides: z.infer<typeof Overrides>): Promise<Result> => {
    const parsed = parseSpec(source, limits)
    if (!parsed.ok) return { content: renderErrors(parsed.errors), output: { ok: false, errors: parsed.errors } }
    const executor = deps.spawner.available() ? "available" : "missing"
    const runId = await deps.runner.start(parsed.spec, {
      lead: context.sessionID,
      leadAgent: context.agent,
      directory: deps.directory,
      overrides,
    })
    const spec = { ...parsed.spec }
    const filled = parsed.warnings.length
      ? [
          `filled in ${parsed.warnings.length} missing ${parsed.warnings.length === 1 ? "field" : "fields"}:`,
          ...parsed.warnings.map((warning) => `  - ${warning}`),
        ]
      : []
    return {
      content: [
        `started run ${runId}`,
        ...filled,
        DETACHED,
        `subagent executor: ${executor}`,
        renderSpecTree(parsed.spec),
      ].join("\n"),
      output: { ok: true, runId, spec, executor, warnings: parsed.warnings },
    }
  }

  const startSaved = async (name: unknown, context: Caller, overrides: z.infer<typeof Overrides>): Promise<Result> => {
    const loaded = await store.load(deps.directory, name)
    if (!loaded.ok) return fail(loaded.error)
    return startRun(loaded.value, context, overrides)
  }

  const guarded =
    <I>(run: (input: I, context: Caller) => Promise<Result>) =>
    async (input: I, context: Caller): Promise<Result> => {
      try {
        return await run(input, context)
      } catch (error) {
        return fail(describe(error))
      }
    }

  return [
    {
      name: "workflow_run",
      description: [
        "Run several tasks at once in separate agent sessions, or run a chain of tasks where each one",
        "needs the result of the one before it. Use when the user asks to do multiple pieces of work in",
        "parallel, to fan out research across files or repos, to run a pipeline of steps, or to have",
        "several agents work as a team while you supervise. You write the spec from what the user asked",
        "for; the user does not have to write it.",
        'Triggers: "in parallel", "at the same time", "fan out", "spawn agents", "several agents",',
        '"one per file", "pipeline", "then feed that into", "have a team".',
        'Pass "spec" as an object or a JSON string, or pass "specRef" to use a saved workflow.',
        "Prefer the subagent tool instead for a single task, and prefer doing it yourself for anything",
        "under about two minutes of work.",
        DETACHED,
        DSL,
      ].join("\n"),
      input: z.object({
        spec: z.unknown().optional(),
        specRef: z.string().optional(),
        overrides: Overrides,
      }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const denied = await denyMember(context, "start a workflow", "Do your own task and reply with the result.")
        if (denied) return denied
        if (input.spec !== undefined) return startRun(input.spec, context, input.overrides)
        if (input.specRef !== undefined) return startSaved(input.specRef, context, input.overrides)
        return fail('pass either "spec" or "specRef"')
      }),
    },
    {
      name: "workflow_run_saved",
      description: [
        "Use when the user asks to run a workflow this project already has, by name.",
        "Start a workflow saved under .opencode/workflows/.",
        'Use workflow_list to see the names. The saved file must set "specVersion": 1.',
        DETACHED,
        DSL,
      ].join("\n"),
      input: z.object({ name: z.string(), overrides: Overrides }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const denied = await denyMember(context, "start a workflow", "Do your own task and reply with the result.")
        if (denied) return denied
        return startSaved(input.name, context, input.overrides)
      }),
    },
    {
      name: "workflow_status",
      description: [
        'Use when the user asks "how is it going", "is it done yet", or "what are the agents doing".',
        "Show the progress of a run: phase and task status, elapsed time, and usage.",
        'Pass "runId", or leave it out for the most recent run of this project.',
      ].join("\n"),
      input: z.object({ runId: z.string().optional() }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const denied = await denyMember(context, "read a run", "Reply with your result; the lead reads the report.")
        if (denied) return denied
        const run = input.runId ? await deps.runs.get(input.runId) : await deps.runs.latest()
        if (!run) return fail(input.runId ? `no run named ${input.runId}` : "this project has no runs yet")
        const report = renderStatus(run)
        return { content: report, output: { ok: true, runId: run.runId, status: run.status, report } }
      }),
    },
    {
      name: "workflow_cancel",
      description: [
        'Use when the user says "stop it", "kill the agents", or "cancel that".',
        "Stop a run. Its member sessions are interrupted and the run is marked cancelled.",
        'Pass "runId", or "taskId" to name a task of a run that is still going.',
        "Only the session that leads the run can cancel it.",
      ].join("\n"),
      input: z.object({ runId: z.string().optional(), taskId: z.string().optional() }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const denied = await denyMember(context, "cancel a run", "Reply with what went wrong; the lead decides.")
        if (denied) return denied
        const result = await deps.runner.cancel({
          runId: input.runId,
          taskId: input.taskId,
          sessionID: context.sessionID,
        })
        if (!result.ok) return fail(result.error)
        return {
          content: result.note ?? `cancelled run ${result.runId}`,
          output: { ok: true, runId: result.runId, status: "cancelled" },
        }
      }),
    },
    {
      name: "workflow_resume",
      description: [
        'Use when the user says "pick that back up", "keep going", or "finish the rest" for a run that stopped part-way.',
        "Start what a run has left, under the same run id.",
        "Every task that already completed keeps its output and is not sent again; the rest is run once more.",
        "You become the lead of the run, so the final report arrives in this session.",
        'A run that spent its budget needs "overrides" with a higher "maxCostUsd" or "maxTokens".',
        'Pass "guidance" as { taskId: text } to tell a task what to do differently this time; it is put in that task\'s prompt, and a task keeps the guidance of the earlier resume when you name none.',
        DETACHED,
      ].join("\n"),
      input: z.object({
        runId: z.string(),
        overrides: Overrides,
        guidance: z.record(z.string(), z.string()).optional(),
      }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const denied = await denyMember(context, "resume a run", "Do your own task and reply with the result.")
        if (denied) return denied
        const resumed = await deps.runner.resume(input.runId, {
          lead: context.sessionID,
          leadAgent: context.agent,
          overrides: input.overrides,
          guidance: input.guidance,
        })
        if (!resumed.ok) return fail(resumed.error)
        const report = renderStatus(resumed.run)
        const ignored = resumed.ignoredGuidance ?? []
        // A guidance key that names no task is a typo, so it is said instead of dropped.
        const note = ignored.length ? `guidance ignored for unknown task(s): ${ignored.join(", ")}` : undefined
        return {
          content: [`resumed run ${resumed.run.runId}`, note, DETACHED, report].filter(Boolean).join("\n"),
          output: {
            ok: true,
            runId: resumed.run.runId,
            status: resumed.run.status,
            report,
            ignoredGuidance: ignored,
          },
        }
      }),
    },
    {
      name: "workflow_list",
      description: [
        "List the workflows this project has saved under .opencode/workflows/.",
        "Use when the user asks what workflows exist, or before workflow_run_saved when the name is not certain.",
      ].join("\n"),
      input: z.object({}),
      output: Outcome,
      execute: guarded(async () => {
        const names = await store.list(deps.directory)
        const content = names.length ? names.join("\n") : "no saved workflows"
        return { content, output: { ok: true, names } }
      }),
    },
    {
      name: "workflow_show",
      description: [
        "Use when the user asks to see a saved workflow before running or editing it.",
        "Show the JSON of one workflow saved under .opencode/workflows/.",
        'Every saved spec sets "specVersion": 1.',
        DSL,
      ].join("\n"),
      input: z.object({ name: z.string() }),
      output: Outcome,
      execute: guarded(async (input) => {
        const loaded = await store.load(deps.directory, input.name)
        if (!loaded.ok) return fail(loaded.error)
        const spec = loaded.value as Record<string, unknown>
        return { content: JSON.stringify(spec, null, 2), output: { ok: true, spec } }
      }),
    },
    {
      name: "workflow_doctor",
      description: [
        "Use when a run will not start, or when the user asks why workflows are not working. Call it first.",
        "Check the workflow engine before a run: the subagent executor, the default agent,",
        "the permission classifier, the plugin options, the saved specs that do not parse,",
        "and the runs still marked running.",
      ].join("\n"),
      input: z.object({}),
      output: Outcome,
      execute: guarded(async (_input, context) => {
        const denied = await denyMember(
          context,
          "check the engine",
          "Reply with your result; the lead reads the report.",
        )
        if (denied) return denied
        const doctor = await diagnose(deps)
        return { content: renderDoctor(doctor), output: { ok: true, doctor } }
      }),
    },
    {
      name: "team_send",
      description: [
        "Use when you are a workflow member and you need the lead to answer, or to tell it where you stand.",
        "Send one message to the lead of the workflow run you are a task of.",
        'Use "question" when you need an answer before you can go on: it wakes the lead.',
        'Use "status" for progress and "result" for a finding: the lead reads them on its next turn.',
        "Keep working after a question; the lead's answer arrives as a steer at your next step.",
      ].join("\n"),
      input: z.object({
        type: z.enum(["status", "question", "result"]),
        body: z.string(),
        ref: z.string().optional(),
        runId: z.string().optional(),
      }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const sent = await deps.mailbox.send({ ...input, sessionID: context.sessionID })
        if (!sent.ok) return fail(sent.error)
        const note =
          input.type === "question"
            ? "the lead is woken; go on with what you can do meanwhile"
            : "the lead reads it on its next turn; it was not woken"
        return {
          content: `sent ${input.type} ${sent.value.id} to the lead of run ${sent.value.runId}: ${note}`,
          output: { ok: true, runId: sent.value.runId, mail: [mailOut(sent.value)] },
        }
      }),
    },
    {
      name: "team_steer",
      description: [
        "Use when a member of your team phase asked a question, or is going the wrong way.",
        "Send one instruction to a member of your team phase.",
        "A steer lands at the member's next step; it does not interrupt the step it is in.",
        'Pass "force": true to interrupt the member first, then deliver the steer.',
        "A task that is completed, cancelled, or out of time cannot be steered.",
      ].join("\n"),
      input: z.object({
        taskId: z.string(),
        body: z.string(),
        force: z.boolean().optional(),
        runId: z.string().optional(),
      }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const denied = await denyMember(context, "steer a member", "Use team_send to reach the lead.")
        if (denied) return denied
        const steered = await deps.mailbox.steer({ ...input, sessionID: context.sessionID })
        if (!steered.ok) return fail(steered.error)
        const { mail, delivered, interrupted } = steered.value
        const note = delivered
          ? interrupted
            ? "the member was interrupted and takes it now"
            : "the member takes it at its next step"
          : "the member session does not exist yet, so it is queued until it starts"
        return {
          content: `steered ${input.taskId} of run ${mail.runId}: ${note}`,
          output: { ok: true, runId: mail.runId, mail: [mailOut(mail)] },
        }
      }),
    },
    {
      name: "team_inbox",
      description: [
        "Use when a team member woke you, or when you want to see what your team has said so far.",
        "Read the mail your team members sent and see where every task stands.",
        "The messages it returns are marked read, so a second call shows only what is new.",
      ].join("\n"),
      input: z.object({ runId: z.string().optional() }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const denied = await denyMember(context, "read the mail of a run", "Use team_send to reach the lead.")
        if (denied) return denied
        const read = await deps.mailbox.inbox({ runId: input.runId, sessionID: context.sessionID })
        if (!read.ok) return fail(read.error)
        const { mail, roster, run } = read.value
        const lines = [`run ${run.runId}: ${mail.length} unread message(s)`]
        for (const item of mail) lines.push(envelope(run.runId, item))
        lines.push("Roster:")
        for (const entry of roster) lines.push(`  - ${entry.taskId} ${entry.status} ${entry.sessionID ?? "no session"}`)
        return {
          content: lines.join("\n"),
          output: { ok: true, runId: run.runId, status: run.status, mail: mail.map(mailOut), roster },
        }
      }),
    },
  ]
}

/** The tool answer keeps the fields a lead can act on, not the bookkeeping ones. */
function mailOut(mail: MailEvent): {
  id: string
  taskId: string
  direction: MailEvent["direction"]
  type: MailEvent["type"]
  body: string
  ref?: string
  createdAt: string
  delivered: boolean
} {
  return {
    id: mail.id,
    taskId: mail.taskId,
    direction: mail.direction,
    type: mail.type,
    body: mail.body,
    ref: mail.ref,
    createdAt: mail.createdAt,
    delivered: mail.deliveredAt !== undefined,
  }
}

type Doctor = {
  executor: "available" | "missing"
  defaultAgent: { name: string; state: "subagent" | "primary" | "all" | "missing" | "unknown" }
  classifier: { state: "active" | "failed" | "absent" | "unknown"; error?: string }
  warnings: string[]
  invalidSpecs: { name: string; error: string }[]
  runningRuns: { runId: string; name: string; ageMinutes: number }[]
  storagePrefix: string
}

async function diagnose(deps: ToolDeps): Promise<Doctor> {
  const invalidSpecs: Doctor["invalidSpecs"] = []
  for (const name of await store.list(deps.directory)) {
    const loaded = await store.load(deps.directory, name)
    if (!loaded.ok) {
      invalidSpecs.push({ name, error: loaded.error })
      continue
    }
    const parsed = parseSpec(loaded.value, {
      maxAgents: deps.config.maxAgents,
      shellTasks: deps.config.shellTasks,
      worktrees: deps.config.worktrees,
    })
    if (!parsed.ok) invalidSpecs.push({ name, error: parsed.errors[0] ?? "invalid" })
  }

  const now = Date.now()
  const runningRuns = (await deps.runs.list())
    .filter((entry) => entry.status === "running")
    .map((entry) => ({
      runId: entry.runId,
      name: entry.name,
      ageMinutes: Math.max(0, Math.round((now - Date.parse(entry.updatedAt)) / 60_000)),
    }))

  return {
    executor: deps.spawner.available() ? "available" : "missing",
    defaultAgent: { name: deps.config.defaultAgent, state: await agentState(deps) },
    classifier: await classifierState(deps),
    warnings: deps.warnings,
    invalidSpecs,
    runningRuns,
    storagePrefix: deps.runs.prefix(),
  }
}

/**
 * `ctx.agent.list` resolves to `{ location, data }` on the pinned beta. A plain array is
 * accepted as well, and any other shape reports "unknown" instead of a wrong answer.
 */
async function agentState(deps: ToolDeps): Promise<Doctor["defaultAgent"]["state"]> {
  if (!deps.agents) return "unknown"
  const listed = await deps.agents().catch(() => undefined)
  const data = (listed as { data?: unknown } | undefined)?.data
  const array = Array.isArray(listed) ? listed : Array.isArray(data) ? data : undefined
  if (!array) return "unknown"
  const found = array
    .map((entry) => entry as { id?: unknown; name?: unknown; mode?: unknown })
    .find((entry) => entry.name === deps.config.defaultAgent || entry.id === deps.config.defaultAgent)
  if (!found) return "missing"
  if (found.mode === "subagent" || found.mode === "primary" || found.mode === "all") return found.mode
  return "unknown"
}

/**
 * The classifier registers no tool, no command, and no event, so the plugin list is the only
 * place it shows. A host that lists nothing reports "unknown" instead of "absent".
 */
async function classifierState(deps: ToolDeps): Promise<Doctor["classifier"]> {
  if (!deps.plugins) return { state: "unknown" }
  const listed = await deps.plugins().catch(() => undefined)
  const data = (listed as { data?: unknown } | undefined)?.data
  const array = Array.isArray(listed) ? listed : Array.isArray(data) ? data : undefined
  if (!array) return { state: "unknown" }
  const found = array
    .map((entry) => entry as { id?: unknown; state?: { status?: unknown; error?: unknown } })
    .find((entry) => entry.id === CLASSIFIER_ID)
  if (!found) return { state: "absent" }
  if (found.state?.status === "failed") return { state: "failed", error: String(found.state.error ?? "") }
  return { state: "active" }
}

/** What each classifier state means for a member's permission ask. */
const CLASSIFIER_NOTES: Record<Doctor["classifier"]["state"], string> = {
  active:
    "a member permission ask is reviewed before it is shown; an ask the classifier allows or denies" +
    " leaves no trace on the task, and one it escalates waits for the user on the lead's screen",
  absent: "every member permission ask waits for the user on the lead's screen",
  failed: "the classifier did not load, so every member permission ask waits for the user on the lead's screen",
  unknown: "the host did not list its plugins, so the classifier cannot be checked",
}

function renderDoctor(doctor: Doctor): string {
  const lines = [
    `subagent executor: ${doctor.executor}`,
    `default agent: ${doctor.defaultAgent.name} (${doctor.defaultAgent.state})`,
    `permission classifier: ${doctor.classifier.state}${doctor.classifier.error ? ` (${doctor.classifier.error})` : ""}`,
    `  ${CLASSIFIER_NOTES[doctor.classifier.state]}`,
    `storage key prefix: ${doctor.storagePrefix}`,
  ]
  if (doctor.executor === "missing") lines.push("  no member session can be started without the subagent tool")
  if (doctor.defaultAgent.state === "missing") lines.push("  no agent has that name; set options.defaultAgent")
  if (doctor.defaultAgent.state === "primary") lines.push("  a primary agent cannot be a member; pick a subagent")

  lines.push(`option warnings: ${doctor.warnings.length}`)
  for (const warning of doctor.warnings) lines.push(`  - ${warning}`)
  lines.push(`saved specs that do not parse: ${doctor.invalidSpecs.length}`)
  for (const spec of doctor.invalidSpecs) lines.push(`  - ${spec.name}: ${spec.error}`)
  lines.push(`runs still marked running: ${doctor.runningRuns.length}`)
  for (const run of doctor.runningRuns) lines.push(`  - ${run.runId} (${run.name}) ${run.ageMinutes} minutes old`)
  return lines.join("\n")
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
