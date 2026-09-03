import type { Info } from "@opencode-ai/plugin/promise/tool"
import { z } from "zod"
import { formatModel, ROLE_NAMES, type ModelRef, type RoleName, type WorkflowConfig } from "./config.js"
import { envelope, type Mailbox } from "./mailbox.js"
import type { RunStore } from "./persistence.js"
import { agentRules, mayEdit, readOnlyViolations } from "./policy.js"
import { renderErrors, renderSpecTree, renderStatus } from "./report.js"
import { roleAgentId } from "./roles.js"
import type { Roster } from "./roster.js"
import type { Runner } from "./runner.js"
import type { Spawner } from "./spawner.js"
import { DSL, parseSpec } from "./spec.js"
import * as store from "./spec-store.js"
import { isTemplate, template, TEMPLATE_NAMES, type TemplateName } from "./templates.js"
import type { MailEvent, WorkflowSpec } from "./types.js"

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
  /** `ctx.catalog.model.list`. Missing means a role model cannot be checked. */
  models?: () => Promise<unknown>
  /** `ctx.plugin.list`. Missing means the permission classifier cannot be checked. */
  plugins?: () => Promise<unknown>
}

/** The sibling plugin that reviews a permission ask. It registers nothing else to look for. */
const CLASSIFIER_ID = "opencode-permissions-classifier"

/** The goal `workflow_show` gives a built-in, which carries none until it is run. */
const SHOWN_GOAL = "<the goal you pass to workflow_run_saved>"

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
  /** The built-in names of `names` that no saved file of the project shadows. */
  builtin: z.array(z.string()).optional(),
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

  /**
   * A lead in plan mode may not have its members edit for it.
   *
   * The lead's agent comes with the tool call, so only the agent list is fetched. An agent
   * the host does not list has no rules, which reads as no policy, and the run goes ahead.
   */
  const denyEdits = async (spec: WorkflowSpec, context: Caller): Promise<Result | undefined> => {
    const agents = await listAgents(deps)
    if (mayEdit(agentRules(agents, context.agent))) return undefined
    const violations = readOnlyViolations(
      spec,
      agents,
      deps.config.defaultAgent,
      roleAgentId(deps.config, "synthesizer"),
    )
    if (!violations.length) return undefined
    const error = `your agent "${context.agent}" cannot edit, so this run may not edit either:`
    return {
      content: [error, ...violations.map((line) => `  - ${line}`)].join("\n"),
      output: { ok: false, error, errors: violations },
    }
  }

  const startRun = async (source: unknown, context: Caller, overrides: z.infer<typeof Overrides>): Promise<Result> => {
    const parsed = parseSpec(source, limits)
    if (!parsed.ok) return { content: renderErrors(parsed.errors), output: { ok: false, errors: parsed.errors } }
    const refused = await denyEdits(parsed.spec, context)
    if (refused) return refused
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

  /** The built-in a name points at, or undefined when a saved file of the project shadows it. */
  const builtin = async (name: unknown): Promise<TemplateName | undefined> => {
    if (typeof name !== "string" || !isTemplate(name)) return undefined
    return (await store.list(deps.directory)).includes(name) ? undefined : name
  }

  /**
   * The spec behind a name: the saved file of the project first, then a built-in.
   *
   * A built-in carries no goal of its own, so it needs one. A goal passed with a saved
   * file replaces the goal that file holds, which is how one spec serves several asks.
   */
  const resolveSpec = async (name: unknown, goal: string | undefined): Promise<store.LoadResult> => {
    const wanted = goal?.trim()
    const found = await builtin(name)
    if (found) {
      if (!wanted) {
        return { ok: false, error: `the built-in workflow "${found}" needs a goal; pass "goal" with what it should do` }
      }
      return { ok: true, value: template(found, deps.config, wanted) }
    }
    const loaded = await store.load(deps.directory, name)
    if (!loaded.ok || !wanted || !isRecord(loaded.value)) return loaded
    return { ok: true, value: { ...loaded.value, goal: wanted } }
  }

  const startSaved = async (
    name: unknown,
    goal: string | undefined,
    context: Caller,
    overrides: z.infer<typeof Overrides>,
  ): Promise<Result> => {
    const resolved = await resolveSpec(name, goal)
    if (!resolved.ok) return fail(resolved.error)
    return startRun(resolved.value, context, overrides)
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
        'Pass "spec" as an object or a JSON string, or pass "specRef" to use a saved or a built-in workflow.',
        'With "specRef", "goal" says what to work on: a built-in needs one, and a saved workflow takes it in place of its own goal.',
        "Prefer the subagent tool instead for a single task, and prefer doing it yourself for anything",
        "under about two minutes of work.",
        DETACHED,
        DSL,
      ].join("\n"),
      input: z.object({
        spec: z.unknown().optional(),
        specRef: z.string().optional(),
        goal: z.string().optional(),
        overrides: Overrides,
      }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const denied = await denyMember(context, "start a workflow", "Do your own task and reply with the result.")
        if (denied) return denied
        if (input.spec !== undefined) return startRun(input.spec, context, input.overrides)
        if (input.specRef !== undefined) return startSaved(input.specRef, input.goal, context, input.overrides)
        return fail('pass either "spec" or "specRef"')
      }),
    },
    {
      name: "workflow_run_saved",
      description: [
        "Use when the user asks to run a workflow this project already has, by name, and when a build",
        "or a plan goal fits one of the built-in workflows.",
        "Start a workflow saved under .opencode/workflows/, or one of the built-in ones.",
        `The built-in names are ${TEMPLATE_NAMES.join(", ")}, and each one needs "goal".`,
        'A saved file of the same name is used instead, and a "goal" replaces the goal it holds.',
        'Use workflow_list to see the names. The saved file must set "specVersion": 1.',
        DETACHED,
        DSL,
      ].join("\n"),
      input: z.object({ name: z.string(), goal: z.string().optional(), overrides: Overrides }),
      output: Outcome,
      execute: guarded(async (input, context) => {
        const denied = await denyMember(context, "start a workflow", "Do your own task and reply with the result.")
        if (denied) return denied
        return startSaved(input.name, input.goal, context, input.overrides)
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
        // The spec of the stored run, because a resume re-homes the lead to this session.
        const stored = await deps.runs.get(input.runId)
        const refused = stored ? await denyEdits(stored.spec, context) : undefined
        if (refused) return refused
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
        "List the workflows this project has saved under .opencode/workflows/, plus the built-in ones.",
        "Use when the user asks what workflows exist, or before workflow_run_saved when the name is not certain.",
        'A built-in is marked "(built-in)" and needs a "goal" when it is run.',
      ].join("\n"),
      input: z.object({}),
      output: Outcome,
      execute: guarded(async () => {
        const saved = await store.list(deps.directory)
        // A saved file shadows the built-in of the same name, so it is listed only once.
        const builtins = TEMPLATE_NAMES.filter((name) => !saved.includes(name))
        const content = [...saved, ...builtins.map((name) => `${name} (built-in)`)].join("\n")
        return { content, output: { ok: true, names: [...saved, ...builtins], builtin: [...builtins] } }
      }),
    },
    {
      name: "workflow_show",
      description: [
        "Use when the user asks to see a saved or a built-in workflow before running or editing it.",
        "Show the JSON of one workflow saved under .opencode/workflows/, or of one of the built-in ones.",
        'Every saved spec sets "specVersion": 1.',
        DSL,
      ].join("\n"),
      input: z.object({ name: z.string() }),
      output: Outcome,
      execute: guarded(async (input) => {
        const found = await builtin(input.name)
        const loaded = found
          ? { ok: true as const, value: template(found, deps.config, SHOWN_GOAL) }
          : await store.load(deps.directory, input.name)
        if (!loaded.ok) return fail(loaded.error)
        const spec = loaded.value as Record<string, unknown>
        // A built-in has no goal of its own, so the one shown is a stand-in for the real ask.
        const note = found ? `built-in workflow "${found}"; pass your own "goal" when you run it` : undefined
        return { content: [note, JSON.stringify(spec, null, 2)].filter(Boolean).join("\n"), output: { ok: true, spec } }
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

type AgentState = "subagent" | "primary" | "all" | "missing" | "unknown"
/** Whether the catalog lists the model a role names. `inherited` means the role names none. */
type ModelState = "listed" | "unlisted" | "unknown" | "inherited"

type Doctor = {
  executor: "available" | "missing"
  defaultAgent: { name: string; state: AgentState }
  roles: { role: RoleName; agent: string; state: AgentState; model?: string; modelState: ModelState }[]
  synthesisModel?: string
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

  const agents = await listAgents(deps)
  const models = await listModels(deps)
  const synthesisModel = deps.config.synthesisModel

  return {
    executor: deps.spawner.available() ? "available" : "missing",
    defaultAgent: { name: deps.config.defaultAgent, state: agentState(agents, deps.config.defaultAgent) },
    roles: ROLE_NAMES.map((role) => {
      const model = role === "synthesizer" ? deps.config.synthesisModel : deps.config.roles[role].model
      const agent = roleAgentId(deps.config, role)
      return {
        role,
        agent,
        state: agentState(agents, agent),
        ...(model ? { model: formatModel(model) } : {}),
        modelState: modelState(models, model),
      }
    }),
    ...(synthesisModel ? { synthesisModel: formatModel(synthesisModel) } : {}),
    classifier: await classifierState(deps),
    warnings: deps.warnings,
    invalidSpecs,
    runningRuns,
    storagePrefix: deps.runs.prefix(),
  }
}

/**
 * `ctx.agent.list` resolves to `{ location, data }` on the pinned beta. A plain array is
 * accepted as well, and any other shape reads as undefined, which reports "unknown"
 * instead of a wrong answer.
 */
async function listAgents(deps: ToolDeps): Promise<unknown[] | undefined> {
  if (!deps.agents) return undefined
  return unwrapList(await deps.agents().catch(() => undefined))
}

/** `ctx.catalog.model.list` answers in the same shape. */
async function listModels(deps: ToolDeps): Promise<unknown[] | undefined> {
  if (!deps.models) return undefined
  return unwrapList(await deps.models().catch(() => undefined))
}

function unwrapList(listed: unknown): unknown[] | undefined {
  const data = (listed as { data?: unknown } | undefined)?.data
  return Array.isArray(listed) ? listed : Array.isArray(data) ? data : undefined
}

function agentState(agents: unknown[] | undefined, name: string): AgentState {
  if (!agents) return "unknown"
  const found = agents
    .map((entry) => entry as { id?: unknown; name?: unknown; mode?: unknown })
    .find((entry) => entry.name === name || entry.id === name)
  if (!found) return "missing"
  if (found.mode === "subagent" || found.mode === "primary" || found.mode === "all") return found.mode
  return "unknown"
}

/** A model the catalog does not list fails at spawn, so the doctor is the early warning. */
function modelState(models: unknown[] | undefined, model: ModelRef | undefined): ModelState {
  if (!model) return "inherited"
  if (!models) return "unknown"
  const found = models
    .map((entry) => entry as { id?: unknown; modelID?: unknown; providerID?: unknown })
    .some((entry) => entry.providerID === model.providerID && (entry.id === model.id || entry.modelID === model.id))
  return found ? "listed" : "unlisted"
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

  for (const role of doctor.roles) {
    const model = role.model ? `${role.model} (${role.modelState})` : "inherited from the lead"
    lines.push(`role ${role.role}: agent ${role.agent} (${role.state}), model ${model}`)
    if (role.state === "missing") lines.push(`  no agent has that name; set options.roles.${role.role}.agent`)
    if (role.state === "primary") lines.push("  a primary agent cannot be a member; pick a subagent")
    if (role.modelState === "unlisted") lines.push("  the catalog does not list that model; the task fails at spawn")
  }
  if (doctor.synthesisModel) lines.push(`synthesis model: ${doctor.synthesisModel}`)

  lines.push(`option warnings: ${doctor.warnings.length}`)
  for (const warning of doctor.warnings) lines.push(`  - ${warning}`)
  lines.push(`saved specs that do not parse: ${doctor.invalidSpecs.length}`)
  for (const spec of doctor.invalidSpecs) lines.push(`  - ${spec.name}: ${spec.error}`)
  lines.push(`runs still marked running: ${doctor.runningRuns.length}`)
  for (const run of doctor.runningRuns) lines.push(`  - ${run.runId} (${run.name}) ${run.ageMinutes} minutes old`)
  return lines.join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
