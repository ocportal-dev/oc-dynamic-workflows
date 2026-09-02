import { expect, it } from "bun:test"
import { resolveConfig } from "../src/config.js"

const DEFAULTS = {
  defaultAgent: "general",
  concurrency: 4,
  maxAgents: 100,
  mailboxMaxMessages: 20,
  shellTasks: true,
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
    defaultTaskTimeoutMs: 60_000,
    maxRunMinutes: 30,
  })
  expect(config).toEqual({
    defaultAgent: "executor",
    concurrency: 8,
    maxAgents: 12,
    mailboxMaxMessages: 5,
    shellTasks: false,
    defaultTaskTimeoutMs: 60_000,
    maxRunMinutes: 30,
  })
  expect(warnings).toEqual([])
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
  })
  expect(config).toEqual(DEFAULTS)
  expect(warnings).toEqual([
    "options.defaultAgent must be a non-empty string; using general",
    "options.concurrency must be a number; using 4",
    "options.maxAgents must be a number; using 100",
    "options.mailboxMaxMessages must be a number; using 20",
    "options.shellTasks must be true or false; using true",
  ])
})
