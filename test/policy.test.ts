import { expect, it } from "bun:test"
import { agentRules, evaluate, mayEdit, readOnlyViolations, wildcard } from "../src/policy.js"
import type { WorkflowSpec } from "../src/types.js"

/** The rules core gives its plan agent: deny every edit, then allow the plan folder back. */
const PLAN = [
  { action: "edit", resource: "*", effect: "deny" as const },
  { action: "edit", resource: "~/.opencode/plan/*", effect: "allow" as const },
]

/** The rules core gives its explore agent. */
const EXPLORE = [{ action: "edit", resource: "*", effect: "deny" as const }]

/** What `Agent.Info.default` starts from: allow everything. */
const BUILD = [{ action: "*", resource: "*", effect: "allow" as const }]

function spec(tasks: Record<string, unknown>[]): WorkflowSpec {
  return {
    specVersion: 1,
    name: "demo",
    goal: "do the thing",
    phases: [
      {
        id: "one",
        strategy: "sequential",
        tasks: tasks.map((task) => ({ kind: "agent", keep: false, retries: 0, ...task })),
      },
    ],
  } as WorkflowSpec
}

it("matches a wildcard pattern the way core does", () => {
  expect(wildcard("edit", "edit")).toBe(true)
  expect(wildcard("edit", "*")).toBe(true)
  expect(wildcard("edit", "ed")).toBe(false)
  expect(wildcard("editor", "edit")).toBe(false)
  expect(wildcard("~/.opencode/plan/a.md", "~/.opencode/plan/*")).toBe(true)
  expect(wildcard("~/x.md", "~/.opencode/plan/*")).toBe(false)
  // A dot is literal, not "any character".
  expect(wildcard("axb", "a.b")).toBe(false)
})

it("lets the last rule that matches win, and defaults to ask", () => {
  expect(evaluate("edit", "*", [])).toBe("ask")
  expect(evaluate("edit", "*", PLAN)).toBe("deny")
  expect(evaluate("edit", "~/.opencode/plan/a.md", PLAN)).toBe("allow")
  expect(evaluate("bash", "ls", PLAN)).toBe("ask")
  expect(evaluate("edit", "src/a.ts", BUILD)).toBe("allow")
})

it("reads the plan and explore agents as read-only and the build default as editing", () => {
  expect(mayEdit(PLAN)).toBe(false)
  expect(mayEdit(EXPLORE)).toBe(false)
  expect(mayEdit(BUILD)).toBe(true)
  expect(mayEdit([])).toBe(true)
  // No rules at all means no policy, so the run is not refused.
  expect(mayEdit(undefined)).toBe(true)
})

it("finds the rules of an agent by id or by name, and none for one the host does not list", () => {
  const agents = [{ id: "plan", name: "plan", permissions: PLAN }]
  expect(agentRules(agents, "plan")).toEqual(PLAN)
  expect(agentRules(agents, "build")).toBeUndefined()
  expect(agentRules(undefined, "plan")).toBeUndefined()
  // An agent with no permissions field reads as no rules, not as a policy.
  expect(agentRules([{ id: "x", name: "x" }], "x")).toEqual([])
})

it("names every task that can change files, and how to fix it", () => {
  const agents = [
    { id: "general", name: "general", permissions: BUILD },
    { id: "researcher", name: "researcher", permissions: EXPLORE },
  ]
  const violations = readOnlyViolations(
    spec([
      { id: "build", isolation: "worktree" },
      { id: "run", kind: "shell", command: "ls" },
      { id: "think" },
      { id: "read", agent: "researcher" },
      { id: "guess", agent: "nobody" },
    ]),
    agents,
    "general",
  )
  expect(violations).toHaveLength(5)
  expect(violations[0]).toContain("one/build")
  expect(violations[0]).toContain("worktree")
  expect(violations[1]).toContain("one/run")
  expect(violations[1]).toContain("shell")
  expect(violations[2]).toContain('agent "general" may edit')
  // An agent the host does not list counts as may-edit, so it is named too.
  expect(violations[3]).toContain('agent "nobody" may edit')
  expect(violations[4]).toContain("researcher")
  expect(violations[4]).toContain("explore")
  expect(violations.join("\n")).not.toContain("one/read")
})

it("finds nothing to refuse in a spec of read-only roles", () => {
  const agents = [{ id: "researcher", name: "researcher", permissions: EXPLORE }]
  const violations = readOnlyViolations(
    spec([{ id: "a", agent: "researcher" }, { id: "b", agent: "researcher" }]),
    agents,
    "general",
  )
  expect(violations).toEqual([])
})

it("refuses an editing synthesizer when the phase has a synthesis prompt", () => {
  const workflow = spec([{ id: "research", agent: "researcher" }])
  workflow.phases[0]!.synthesisPrompt = "Summarise the research"
  const violations = readOnlyViolations(
    workflow,
    [
      { id: "researcher", name: "researcher", permissions: EXPLORE },
      { id: "summary-agent", name: "summary-agent", permissions: BUILD },
    ],
    "general",
    "summary-agent",
  )
  expect(violations[0]).toBe('synthesis: agent "summary-agent" may edit')
  expect(violations[1]).toContain("synthesizer")
})
