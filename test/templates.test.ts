import { expect, it } from "bun:test"
import { resolveConfig, ROLE_NAMES } from "../src/config.js"
import { readOnlyViolations } from "../src/policy.js"
import { applyRole, type MutableAgent } from "../src/roles.js"
import { DSL, parseSpec, type SpecLimits } from "../src/spec.js"
import { isTemplate, template, TEMPLATE_NAMES, type TemplateName } from "../src/templates.js"
import type { WorkflowSpec } from "../src/types.js"

const LIMITS: SpecLimits = { maxAgents: 100, shellTasks: true, worktrees: true }
const CONFIG = resolveConfig({}).config
const GOAL = "Add a --json flag to the CLI."

/** The agents the plugin registers, so a policy check reads the real rules of a role. */
const ROLE_AGENTS: MutableAgent[] = ROLE_NAMES.map((role) => {
  const agent: MutableAgent = { id: role, name: role, mode: "primary", permissions: [] }
  applyRole(agent, { id: role })
  return agent
})

function parsed(name: TemplateName, config = CONFIG): WorkflowSpec {
  const result = parseSpec(template(name, config, GOAL), LIMITS)
  if (!result.ok) throw new Error(`${name}: ${result.errors.join("; ")}`)
  // A template writes every id itself, so the loader has nothing to fill in.
  expect(result.warnings, name).toEqual([])
  return result.spec
}

it("every built-in workflow parses, carries the goal, and sets no budget", () => {
  for (const name of TEMPLATE_NAMES) {
    const spec = parsed(name)
    expect(spec.name).toBe(name)
    expect(spec.goal).toBe(GOAL)
    expect(spec.budget).toBeUndefined()
    for (const phase of spec.phases) for (const task of phase.tasks) expect(task.retries, task.id).toBe(1)
  }
})

it("puts a reviewer gate behind the worktree task of build-review", () => {
  const [phase] = parsed("build-review").phases
  expect(phase!.strategy).toBe("sequential")
  expect(phase!.repeat).toEqual({ gate: "review", maxRounds: 3 })
  expect(phase!.tasks.map((task) => task.id)).toEqual(["impl", "review"])
  expect(phase!.tasks[0]!.isolation).toBe("worktree")
  expect(phase!.tasks[1]!.agent).toBe("reviewer")
  expect(phase!.tasks[1]!.outputSchema?.required).toEqual(["approved"])
})

it("makes the security review the gate of secure-build, after the completeness one", () => {
  const [phase] = parsed("secure-build").phases
  expect(phase!.repeat).toEqual({ gate: "security", maxRounds: 3 })
  expect(phase!.tasks.map((task) => task.agent)).toEqual([undefined, "reviewer", "security-reviewer"])
  // The gate is the last task, and it reads the verdict of the review in front of it.
  expect(phase!.tasks.at(-1)!.id).toBe("security")
  expect(phase!.tasks.at(-1)!.prompt).toContain("task review")
})

it("researches in parallel and gates the plan of plan-research on the stakeholder", () => {
  const spec = parsed("plan-research")
  const [research, plan] = spec.phases
  expect(research!.strategy).toBe("parallel")
  expect(research!.synthesisPrompt).toBeTruthy()
  expect(research!.tasks.map((task) => task.id)).toEqual(["codebase", "docs", "risks"])
  for (const task of research!.tasks) expect(task.agent).toBe("researcher")
  expect(plan!.repeat).toEqual({ gate: "check", maxRounds: 2 })
  expect(plan!.tasks.map((task) => task.agent)).toEqual(["researcher", "stakeholder"])
})

it("refuses the build templates when the options turn worktrees off", () => {
  for (const name of ["build-review", "secure-build"] as const) {
    const result = parseSpec(template(name, CONFIG, GOAL), { ...LIMITS, worktrees: false })
    expect(result.ok, name).toBe(false)
    if (result.ok) continue
    expect(result.errors.join("\n"), name).toContain('isolation: "worktree" is disabled')
  }
})

it("leaves plan-research free of anything a read-only lead may not run", () => {
  expect(readOnlyViolations(parsed("plan-research"), ROLE_AGENTS, "general")).toEqual([])
  // The build ones edit, so a read-only lead is refused.
  expect(readOnlyViolations(parsed("build-review"), ROLE_AGENTS, "general").length).toBeGreaterThan(0)
})

it("uses the agent the options point a role at", () => {
  const { config } = resolveConfig({ roles: { reviewer: { agent: "my-reviewer" } } })
  const [phase] = parsed("build-review", config).phases
  expect(phase!.tasks[1]!.agent).toBe("my-reviewer")
  expect(phase!.repeat).toEqual({ gate: "review", maxRounds: 3 })
})

it("knows only the names it ships", () => {
  for (const name of TEMPLATE_NAMES) expect(isTemplate(name)).toBe(true)
  expect(isTemplate("build")).toBe(false)
  expect(isTemplate("")).toBe(false)
})

it("names every built-in in the grammar the tools and the commands carry", () => {
  for (const name of TEMPLATE_NAMES) expect(DSL).toContain(name)
})
