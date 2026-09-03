import { expect, it } from "bun:test"
import { parseModel, resolveConfig } from "../src/config.js"

const NO_ROLES = { reviewer: {}, "security-reviewer": {}, researcher: {}, stakeholder: {}, synthesizer: {} }

const DEFAULTS = {
  defaultAgent: "general",
  roles: NO_ROLES,
  concurrency: 4,
  maxAgents: 100,
  mailboxMaxMessages: 20,
  shellTasks: true,
  worktrees: true,
  defaultTaskTimeoutMs: 900_000,
  maxRunMinutes: 120,
}

it("applies the defaults to an empty options object", () => {
  const { config, warnings } = resolveConfig({})
  expect(config).toEqual(DEFAULTS)
  expect(warnings).toEqual([])
})

it("applies the defaults when options are missing or not an object", () => {
  for (const options of [undefined, null, "nope", 7, ["a"]]) {
    expect(resolveConfig(options).config).toEqual(DEFAULTS)
  }
})

it("keeps valid values", () => {
  const { config, warnings } = resolveConfig({
    defaultAgent: "executor",
    concurrency: 8,
    maxAgents: 12,
    mailboxMaxMessages: 5,
    shellTasks: false,
    worktrees: false,
    defaultTaskTimeoutMs: 60_000,
    maxRunMinutes: 30,
  })
  expect(config).toEqual({
    defaultAgent: "executor",
    roles: NO_ROLES,
    concurrency: 8,
    maxAgents: 12,
    mailboxMaxMessages: 5,
    shellTasks: false,
    worktrees: false,
    defaultTaskTimeoutMs: 60_000,
    maxRunMinutes: 30,
  })
  expect(warnings).toEqual([])
})

it("reads the worktrees option", () => {
  expect(resolveConfig({}).config.worktrees).toBe(true)
  expect(resolveConfig({ worktrees: false }).config.worktrees).toBe(false)
  const bad = resolveConfig({ worktrees: "no" })
  expect(bad.config.worktrees).toBe(true)
  expect(bad.warnings).toContain("options.worktrees must be true or false; using true")
})

it("trims the default agent", () => {
  expect(resolveConfig({ defaultAgent: "  executor  " }).config.defaultAgent).toBe("executor")
})

it("clamps the numbers to their range and warns", () => {
  const low = resolveConfig({ concurrency: 0, maxAgents: 0, mailboxMaxMessages: 0 })
  expect(low.config.concurrency).toBe(1)
  expect(low.config.maxAgents).toBe(1)
  expect(low.config.mailboxMaxMessages).toBe(1)
  expect(low.warnings).toHaveLength(3)

  const high = resolveConfig({ concurrency: 99, maxAgents: 99999, mailboxMaxMessages: 999 })
  expect(high.config.concurrency).toBe(16)
  expect(high.config.maxAgents).toBe(1000)
  expect(high.config.mailboxMaxMessages).toBe(50)
  expect(high.warnings).toHaveLength(3)

  const clocks = resolveConfig({ defaultTaskTimeoutMs: 1, maxRunMinutes: 9999 })
  expect(clocks.config.defaultTaskTimeoutMs).toBe(5_000)
  expect(clocks.config.maxRunMinutes).toBe(1440)
  expect(clocks.warnings).toHaveLength(2)
})

it("floors a fractional number without a warning when it stays in range", () => {
  const { config, warnings } = resolveConfig({ concurrency: 3.9 })
  expect(config.concurrency).toBe(3)
  expect(warnings).toEqual([])
})

it("falls back and warns on garbage values", () => {
  const { config, warnings } = resolveConfig({
    defaultAgent: "   ",
    concurrency: "four",
    maxAgents: Number.NaN,
    mailboxMaxMessages: {},
    shellTasks: "yes",
    worktrees: "no",
  })
  expect(config).toEqual(DEFAULTS)
  expect(warnings).toEqual([
    "options.defaultAgent must be a non-empty string; using general",
    "options.concurrency must be a number; using 4",
    "options.maxAgents must be a number; using 100",
    "options.mailboxMaxMessages must be a number; using 20",
    "options.shellTasks must be true or false; using true",
    "options.worktrees must be true or false; using true",
  ])
})

it("parses a model reference in every form core accepts", () => {
  expect(parseModel("anthropic/claude-sonnet-4-5")).toEqual({ providerID: "anthropic", id: "claude-sonnet-4-5" })
  expect(parseModel("anthropic/claude-opus-4-1#thinking")).toEqual({
    providerID: "anthropic",
    id: "claude-opus-4-1",
    variant: "thinking",
  })
  // A model id may carry a slash of its own; only the first one splits the provider off.
  expect(parseModel("openrouter/meta/llama-3.1")).toEqual({ providerID: "openrouter", id: "meta/llama-3.1" })
})

it("returns nothing for a model reference that is not provider/model", () => {
  for (const text of ["", "sonnet", "/sonnet", "anthropic/", "anthropic/sonnet#", "a/b#c#d", "a#b/c"]) {
    expect(parseModel(text), text).toBeUndefined()
  }
})

it("reads the model and the agent of a role", () => {
  const { config, warnings } = resolveConfig({
    roles: { reviewer: { model: "anthropic/claude-opus-4-1#thinking" }, researcher: { agent: "  explore  " } },
  })
  expect(config.roles.reviewer).toEqual({
    model: { providerID: "anthropic", id: "claude-opus-4-1", variant: "thinking" },
  })
  expect(config.roles.researcher).toEqual({ agent: "explore" })
  expect(config.roles.stakeholder).toEqual({})
  expect(config.roles.synthesizer).toEqual({})
  expect(warnings).toEqual([])
})

it("warns about an unknown role, a bad model, and a wrong type, and keeps every role", () => {
  const { config, warnings } = resolveConfig({
    roles: { auditor: {}, reviewer: { model: "sonnet" }, researcher: "explore", stakeholder: { agent: 7 } },
  })
  expect(config.roles).toEqual({ reviewer: {}, "security-reviewer": {}, researcher: {}, stakeholder: {}, synthesizer: {} })
  expect(warnings).toEqual([
    "options.roles.auditor is not a role; the roles are reviewer, security-reviewer, researcher, stakeholder, synthesizer",
    'options.roles.reviewer.model must be a "provider/model" string; ignoring it',
    "options.roles.researcher must be an object; ignoring it",
    "options.roles.stakeholder.agent must be a non-empty string; ignoring it",
  ])
})

it("warns when roles is not an object", () => {
  const { config, warnings } = resolveConfig({ roles: ["reviewer"] })
  expect(config.roles.reviewer).toEqual({})
  expect(warnings).toEqual(["options.roles must be an object; ignoring it"])
})

it("reads the synthesis model and warns about a bad one", () => {
  expect(resolveConfig({ synthesisModel: "openai/gpt-5" }).config.synthesisModel).toEqual({
    providerID: "openai",
    id: "gpt-5",
  })
  const bad = resolveConfig({ synthesisModel: 7 })
  expect(bad.config.synthesisModel).toBeUndefined()
  expect(bad.warnings).toEqual(['options.synthesisModel must be a "provider/model" string; ignoring it'])
})

it("uses synthesisModel rather than a synthesizer role model", () => {
  const { config, warnings } = resolveConfig({
    synthesisModel: "openai/gpt-5",
    roles: { synthesizer: { model: "anthropic/opus", agent: "summary-agent" } },
  })
  expect(config.synthesisModel).toEqual({ providerID: "openai", id: "gpt-5" })
  expect(config.roles.synthesizer).toEqual({ agent: "summary-agent" })
  expect(warnings).toEqual(["options.roles.synthesizer.model is ignored; use options.synthesisModel instead"])
})
