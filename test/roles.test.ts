import { expect, it } from "bun:test"
import { resolveConfig } from "../src/config.js"
import { applyRole, type MutableAgent, READ_ONLY_RULES, ROLE_NAMES, roleAgentId, roleAgents } from "../src/roles.js"

/** What `draft.update` hands out for an agent that does not exist yet: primary, allow-all. */
function blank(id: string): MutableAgent {
  return { id, name: id, mode: "primary", permissions: [{ action: "edit", resource: "**", effect: "allow" }] }
}

it("names the five roles", () => {
  expect([...ROLE_NAMES]).toEqual(["reviewer", "security-reviewer", "researcher", "stakeholder", "synthesizer"])
})

it("registers every role that names no agent of its own", () => {
  const { config } = resolveConfig({ roles: { reviewer: { model: "anthropic/opus" }, researcher: { agent: "explore" } } })
  expect(roleAgents(config)).toEqual([
    { id: "reviewer", model: { providerID: "anthropic", id: "opus" } },
    { id: "security-reviewer" },
    { id: "stakeholder" },
    { id: "synthesizer" },
  ])
})

it("uses the agent the options name for a role, and the role name otherwise", () => {
  const { config } = resolveConfig({ roles: { researcher: { agent: "explore" } } })
  expect(roleAgentId(config, "researcher")).toBe("explore")
  expect(roleAgentId(config, "reviewer")).toBe("reviewer")
  expect(roleAgentId(config, "synthesizer")).toBe("synthesizer")
})

it("makes a role a read-only subagent with a prompt", () => {
  const agent = blank("reviewer")
  applyRole(agent, { id: "reviewer" })
  expect(agent.mode).toBe("subagent")
  expect(agent.name).toBe("reviewer")
  expect(agent.description).toContain("Read-only")
  expect(agent.system).toContain('"approved"')
  expect(agent.model).toBeUndefined()
  expect(agent.permissions).toEqual([
    { action: "edit", resource: "**", effect: "allow" },
    ...READ_ONLY_RULES,
  ])
})

it("sets the model of a role only when the options name one", () => {
  const agent = blank("reviewer")
  applyRole(agent, { id: "reviewer", model: { providerID: "anthropic", id: "opus", variant: "thinking" } })
  expect(agent.model).toEqual({ providerID: "anthropic", id: "opus", variant: "thinking" })
})

it("changes nothing on a replay", () => {
  const agent = blank("stakeholder")
  applyRole(agent, { id: "stakeholder" })
  const once = JSON.stringify(agent)
  applyRole(agent, { id: "stakeholder" })
  expect(JSON.stringify(agent)).toBe(once)
  expect(agent.permissions.filter((rule) => rule.action === "edit")).toHaveLength(2)
})

it("gives every role a read-only prompt", () => {
  for (const role of ROLE_NAMES) {
    const agent: MutableAgent = { ...blank(role), permissions: [] }
    applyRole(agent, { id: role })
    if (role === "synthesizer") {
      expect(agent.system, role).toContain("Call no tools")
      expect(agent.system, role).toContain("synthesis text only")
    } else {
      expect(agent.system, role).toContain("JSON object")
    }
    expect(agent.system!.split("\n").length, role).toBeLessThan(40)
    expect(agent.permissions, role).toEqual([...READ_ONLY_RULES])
  }
})
