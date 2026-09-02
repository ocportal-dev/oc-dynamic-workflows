import { expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseSpec, type SpecLimits } from "../src/spec.js"

const LIMITS: SpecLimits = { maxAgents: 100, shellTasks: true }

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(import.meta.dir, "fixtures", `${name}.json`), "utf8"))

const spec = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  specVersion: 1,
  name: "demo",
  goal: "do the thing",
  phases: [{ id: "one", tasks: [{ id: "a", prompt: "go" }] }],
  ...overrides,
})

const errors = (input: unknown, limits: SpecLimits = LIMITS): string[] => {
  const result = parseSpec(input, limits)
  if (result.ok) throw new Error("expected the spec to be rejected")
  return result.errors
}

const parsed = (input: unknown, limits: SpecLimits = LIMITS) => {
  const result = parseSpec(input, limits)
  if (!result.ok) throw new Error(`expected the spec to be accepted: ${result.errors.join("; ")}`)
  return result.spec
}

it("accepts a sequential workflow with a shell task", async () => {
  const workflow = parsed(await fixture("sequential"))
  expect(workflow.phases[0]!.strategy).toBe("sequential")
  expect(workflow.phases[0]!.tasks[0]!.kind).toBe("shell")
  expect(workflow.phases[0]!.tasks[1]!.retries).toBe(1)
  expect(workflow.budget).toEqual({ usd: 2 })
})

it("accepts a parallel workflow and defaults the strategy, kind, and retries", async () => {
  const workflow = parsed(await fixture("parallel"))
  expect(workflow.phases[0]!.strategy).toBe("parallel")
  expect(workflow.phases[0]!.tasks[0]!.kind).toBe("agent")
  expect(workflow.phases[0]!.tasks[0]!.retries).toBe(0)
  expect(workflow.phases[0]!.synthesisPrompt).toBe("Compare the three reports.")
})

it("accepts a team workflow with a mailbox", async () => {
  const workflow = parsed(await fixture("team"))
  expect(workflow.phases[0]!.mailbox).toEqual({ peers: false, maxMessages: 8 })
})

it("accepts the name and type aliases", async () => {
  const workflow = parsed(await fixture("aliases"))
  expect(workflow.phases[0]!.id).toBe("explore")
  expect(workflow.phases[0]!.strategy).toBe("sequential")
  expect(workflow.phases[0]!.tasks[0]!.id).toBe("look")
})

it("keeps an explicit id over the alias", () => {
  const workflow = parsed(
    spec({ phases: [{ name: "alias", id: "explicit", tasks: [{ id: "a", prompt: "go" }] }] }),
  )
  expect(workflow.phases[0]!.id).toBe("explicit")
})

it("accepts a JSON string", async () => {
  const workflow = parsed(JSON.stringify(await fixture("parallel")))
  expect(workflow.name).toBe("survey")
})

it("reports a JSON string that does not parse", () => {
  expect(errors("{ not json")[0]).toStartWith("spec: invalid JSON:")
})

it("rejects a value that is not an object", () => {
  expect(errors(42)).toEqual(["spec: must be an object or a JSON object string"])
})

it("rejects a missing specVersion", () => {
  const spec2 = spec()
  delete spec2.specVersion
  expect(errors(spec2).join("\n")).toContain("specVersion:")
})

it("rejects more than three retries", () => {
  const messages = errors(spec({ phases: [{ id: "one", tasks: [{ id: "a", prompt: "go", retries: 4 }] }] }))
  expect(messages.join("\n")).toContain("phases[0].tasks[0].retries:")
})

it("rejects a timeout below the floor", () => {
  const messages = errors(spec({ phases: [{ id: "one", tasks: [{ id: "a", prompt: "go", timeoutMs: 1000 }] }] }))
  expect(messages.join("\n")).toContain("phases[0].tasks[0].timeoutMs:")
})

it("rejects a duplicate task id across phases", () => {
  const messages = errors(
    spec({
      phases: [
        { id: "one", tasks: [{ id: "a", prompt: "go" }] },
        { id: "two", tasks: [{ id: "a", prompt: "again" }] },
      ],
    }),
  )
  expect(messages).toEqual(['phases[1].tasks[0].id: duplicate task id; "a" is already used in phase "one"'])
})

it("rejects an agent task without a prompt", () => {
  const messages = errors(spec({ phases: [{ id: "one", tasks: [{ id: "a" }] }] }))
  expect(messages).toEqual(['phases[0].tasks[0].prompt: required for kind "agent"'])
})

it("rejects a shell task without a command", () => {
  const messages = errors(spec({ phases: [{ id: "one", tasks: [{ id: "a", kind: "shell" }] }] }))
  expect(messages).toEqual(['phases[0].tasks[0].command: required for kind "shell"'])
})

it("rejects a mailbox on a phase that is not a team", () => {
  const messages = errors(
    spec({
      phases: [{ id: "one", strategy: "parallel", mailbox: {}, tasks: [{ id: "a", prompt: "go" }] }],
    }),
  )
  expect(messages).toEqual(['phases[0].mailbox: only a phase with strategy "team" can have a mailbox'])
})

it("rejects peer mail", () => {
  const messages = errors(
    spec({
      phases: [
        { id: "one", strategy: "team", mailbox: { peers: true }, tasks: [{ id: "a", prompt: "go" }] },
      ],
    }),
  )
  expect(messages.join("\n")).toContain("phases[0].mailbox.peers:")
})

it("rejects a task model with the v1 message", () => {
  const messages = errors(
    spec({ phases: [{ id: "one", tasks: [{ id: "a", prompt: "go", model: "openai/gpt-5.4" }] }] }),
  )
  expect(messages).toEqual([
    "phases[0].tasks[0].model: task.model is not supported in v1: set the model on the agent",
  ])
})

it("rejects worktree isolation with the v1 message", () => {
  const messages = errors(
    spec({ phases: [{ id: "one", tasks: [{ id: "a", prompt: "go", isolation: "worktree" }] }] }),
  )
  expect(messages).toEqual([
    'phases[0].tasks[0].isolation: isolation: "worktree" is not supported in v1',
  ])
})

it("rejects a shell task when shell tasks are disabled", () => {
  const messages = errors(
    spec({ phases: [{ id: "one", tasks: [{ id: "a", kind: "shell", command: "ls" }] }] }),
    { maxAgents: 100, shellTasks: false },
  )
  expect(messages).toEqual([
    'phases[0].tasks[0].kind: shell tasks are disabled; set the plugin option "shellTasks" to true to allow them',
  ])
})

it("rejects more tasks than maxAgents allows", () => {
  const messages = errors(
    spec({
      phases: [
        {
          id: "one",
          tasks: [
            { id: "a", prompt: "go" },
            { id: "b", prompt: "go" },
          ],
        },
      ],
    }),
    { maxAgents: 1, shellTasks: true },
  )
  expect(messages).toEqual(['phases: the workflow has 2 tasks; the limit is 1 (option "maxAgents")'])
})

it("rejects a budget with neither a cost nor a token cap", () => {
  expect(errors(spec({ budget: {} })).join("\n")).toContain("budget:")
})

it("rejects a phase without tasks", () => {
  expect(errors(spec({ phases: [{ id: "one", tasks: [] }] })).join("\n")).toContain("phases[0].tasks:")
})

it("rejects an unknown key and names the key it was probably meant to be", () => {
  const messages = errors(
    spec({
      phases: [{ id: "one", synthesisPromt: "sum it up", tasks: [{ id: "a", prompt: "go", timeout: 60_000 }] }],
    }),
  )
  expect(messages).toContain('phases[0]: unknown key "synthesisPromt"; did you mean "synthesisPrompt"?')
  expect(messages).toContain('phases[0].tasks[0]: unknown key "timeout"; did you mean "timeoutMs"?')
})

it("rejects an unknown key of the workflow and lists the valid ones", () => {
  const messages = errors(spec({ retries: 2 })).join("\n")
  expect(messages).toContain('unknown key "retries"')
  expect(messages).toContain("specVersion, name, goal, budget, phases")
})
