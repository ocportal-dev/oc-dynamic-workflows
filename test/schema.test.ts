import { expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { buildSchema, render, SCHEMA_PATH } from "../scripts/schema.js"
import { parseSpec, type SpecLimits } from "../src/spec.js"

const LIMITS: SpecLimits = { maxAgents: 100, shellTasks: true, worktrees: true }

const schema = buildSchema() as {
  $id: string
  required: string[]
  additionalProperties: boolean
  properties: Record<string, Record<string, unknown>>
}

/** A copy of the example in the README, which an editor has to accept. */
const README_EXAMPLE = {
  specVersion: 1,
  name: "survey",
  goal: "Survey the three client apps and compare them.",
  budget: { usd: 2 },
  phases: [
    {
      id: "read",
      title: "Read the clients",
      strategy: "parallel",
      synthesisPrompt: "Compare the three reports.",
      tasks: [
        { id: "ios", prompt: "Summarise the iOS client.", agent: "general" },
        { id: "android", prompt: "Summarise the Android client." },
        { id: "count", kind: "shell", command: "git ls-files | wc -l" },
      ],
    },
    {
      id: "write",
      strategy: "sequential",
      tasks: [{ id: "report", prompt: "Write the comparison.", retries: 1, timeoutMs: 300000 }],
    },
  ],
} as Record<string, unknown>

it("the committed asset is what the generator produces", async () => {
  const text = await readFile(SCHEMA_PATH, "utf8")
  expect(JSON.parse(text)).toEqual(schema)
  expect(text).toBe(render(buildSchema()))
})

it("accepts a spec that carries $schema and drops it from the normalized spec", () => {
  const result = parseSpec({ ...README_EXAMPLE, $schema: "./workflow.schema.json" }, LIMITS)
  if (!result.ok) throw new Error(`expected the spec to be accepted: ${result.errors.join("; ")}`)
  expect(result.spec).not.toHaveProperty("$schema")
  expect(JSON.stringify(result.spec)).not.toContain("$schema")
})

it("closes the root object and allows the $schema key", () => {
  expect(schema.additionalProperties).toBe(false)
  expect(schema.$id).toBe("https://github.com/velazcod/oc-dynamic-workflows/assets/workflow.schema.json")
  expect(schema.properties.$schema).toEqual({ type: "string" })
})

it("pins specVersion to 1", () => {
  expect(schema.properties.specVersion).toEqual({ type: "number", const: 1 })
})

it("carries the strategy enum with its default and the isolation literal", () => {
  const phase = (schema.properties.phases as { items: { properties: Record<string, unknown> } }).items
  expect(phase.properties.strategy).toEqual({
    default: "parallel",
    type: "string",
    enum: ["sequential", "parallel", "team"],
  })
  const task = (phase.properties.tasks as { items: { properties: Record<string, unknown> } }).items
  expect(task.properties.isolation).toEqual({ type: "string", const: "worktree" })
})

it("accepts the README example: every required key is set and no key is unknown", () => {
  for (const key of schema.required) expect(README_EXAMPLE).toHaveProperty(key)
  for (const key of Object.keys(README_EXAMPLE)) expect(Object.keys(schema.properties)).toContain(key)
  expect(parseSpec(README_EXAMPLE, LIMITS).ok).toBe(true)
})
