import { expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseSpec, type SpecLimits } from "../src/spec.js"

const LIMITS: SpecLimits = { maxAgents: 100, shellTasks: true, worktrees: true }

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

const warnings = (input: unknown, limits: SpecLimits = LIMITS): string[] => {
  const result = parseSpec(input, limits)
  if (!result.ok) throw new Error(`expected the spec to be accepted: ${result.errors.join("; ")}`)
  return result.warnings
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

it("fills in a missing specVersion", () => {
  const input = spec()
  delete input.specVersion
  expect(parsed(input).specVersion).toBe(1)
  expect(warnings(input)).toEqual(["specVersion: missing, set to 1"])
})

it("fills in a missing phase id and the missing task ids", () => {
  const input = spec({
    phases: [
      { tasks: [{ prompt: "one" }, { prompt: "two" }] },
      { id: "second", tasks: [{ id: "kept", prompt: "three" }] },
    ],
  })
  const workflow = parsed(input)
  expect(workflow.phases[0]!.id).toBe("phase-1")
  expect(workflow.phases[0]!.tasks.map((task) => task.id)).toEqual(["task-1", "task-2"])
  expect(workflow.phases[1]!.id).toBe("second")
  expect(workflow.phases[1]!.tasks[0]!.id).toBe("kept")
  expect(warnings(input)).toEqual([
    'phases[0].id: missing, set to "phase-1"',
    'phases[0].tasks[0].id: missing, set to "task-1"',
    'phases[0].tasks[1].id: missing, set to "task-2"',
  ])
})

it("skips a generated task id an explicit task already uses", () => {
  const input = spec({
    phases: [
      { id: "one", tasks: [{ prompt: "one" }] },
      { id: "two", tasks: [{ id: "task-1", prompt: "two" }] },
    ],
  })
  expect(parsed(input).phases[0]!.tasks[0]!.id).toBe("task-2")
  expect(warnings(input)).toEqual(['phases[0].tasks[0].id: missing, set to "task-2"'])
})

it("reports no warning for a complete spec", () => {
  expect(warnings(spec())).toEqual([])
})

it("maps the task name alias to the id with no warning", () => {
  const input = spec({ phases: [{ id: "one", tasks: [{ name: "look", prompt: "go" }] }] })
  expect(parsed(input).phases[0]!.tasks[0]!.id).toBe("look")
  expect(warnings(input)).toEqual([])
})

it("rejects specVersion 2, an empty id, and a null id", () => {
  expect(errors(spec({ specVersion: 2 })).join("\n")).toContain("specVersion:")
  expect(errors(spec({ phases: [{ id: "", tasks: [{ id: "a", prompt: "go" }] }] })).join("\n")).toContain(
    "phases[0].id:",
  )
  expect(errors(spec({ phases: [{ id: null, tasks: [{ id: "a", prompt: "go" }] }] })).join("\n")).toContain(
    "phases[0].id:",
  )
})

it("reports the error of a spec that also has a field to fill in", () => {
  const messages = errors(spec({ phases: [{ tasks: [{ prompt: "go", timeout: 60_000 }] }] }))
  expect(messages).toEqual(['phases[0].tasks[0]: unknown key "timeout"; did you mean "timeoutMs"?'])
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

it("accepts worktree isolation and keep", () => {
  const workflow = parsed(
    spec({ phases: [{ id: "one", tasks: [{ id: "a", prompt: "go", isolation: "worktree", keep: true }] }] }),
  )
  expect(workflow.phases[0]!.tasks[0]!.isolation).toBe("worktree")
  expect(workflow.phases[0]!.tasks[0]!.keep).toBe(true)
})

it("defaults keep to false", () => {
  const workflow = parsed(spec({ phases: [{ id: "one", tasks: [{ id: "a", prompt: "go", isolation: "worktree" }] }] }))
  expect(workflow.phases[0]!.tasks[0]!.keep).toBe(false)
})

it("rejects keep on a task that is not isolated", () => {
  const messages = errors(spec({ phases: [{ id: "one", tasks: [{ id: "a", prompt: "go", keep: true }] }] }))
  expect(messages).toEqual(['phases[0].tasks[0].keep: task.keep needs isolation: "worktree"'])
})

it("names keep among the task keys of an unknown one", () => {
  const messages = errors(spec({ phases: [{ id: "one", tasks: [{ id: "a", prompt: "go", nonsense: 1 }] }] }))
  expect(messages.join("\n")).toContain("keep")
})

it("rejects worktree isolation when the option turns it off", () => {
  const messages = errors(
    spec({ phases: [{ id: "one", tasks: [{ id: "a", prompt: "go", isolation: "worktree" }] }] }),
    { maxAgents: 100, shellTasks: true, worktrees: false },
  )
  expect(messages).toEqual([
    'phases[0].tasks[0].isolation: isolation: "worktree" is disabled in the plugin options (worktrees: false)',
  ])
})

it("rejects a shell task when shell tasks are disabled", () => {
  const messages = errors(
    spec({ phases: [{ id: "one", tasks: [{ id: "a", kind: "shell", command: "ls" }] }] }),
    { maxAgents: 100, shellTasks: false, worktrees: true },
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
    { maxAgents: 1, shellTasks: true, worktrees: true },
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

/** The gate task of the example: an agent task whose schema requires "approved". */
const gateTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "review",
  agent: "reviewer",
  prompt: "review it",
  outputSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } },
  ...overrides,
})

/** A sequential phase with a work task and a gate, which is what `repeat` allows. */
const gateSpec = (phase: Record<string, unknown> = {}): Record<string, unknown> =>
  spec({
    phases: [
      {
        id: "build",
        strategy: "sequential",
        repeat: { gate: "review", maxRounds: 3 },
        tasks: [{ id: "impl", prompt: "build it" }, gateTask()],
        ...phase,
      },
    ],
  })

it("accepts a repeat gate", async () => {
  const workflow = parsed(await fixture("gate"))
  expect(workflow.phases[0]!.repeat).toEqual({ gate: "review", maxRounds: 3 })
})

it("rejects a repeat on a phase that is not sequential", () => {
  expect(errors(gateSpec({ strategy: "parallel" }))).toEqual([
    'phases[0].repeat: only a phase with strategy "sequential" can repeat',
  ])
})

it("rejects a gate that names no task of the phase", () => {
  expect(errors(gateSpec({ repeat: { gate: "nope", maxRounds: 2 } }))).toEqual([
    'phases[0].repeat.gate: no task "nope" in this phase',
  ])
})

it("rejects a gate that is not the last task of the phase", () => {
  expect(errors(gateSpec({ tasks: [gateTask(), { id: "impl", prompt: "build it" }] }))).toEqual([
    "phases[0].repeat.gate: the gate has to be the last task of the phase",
  ])
})

it("rejects a phase whose only task is the gate", () => {
  expect(errors(gateSpec({ tasks: [gateTask()] }))).toEqual([
    "phases[0].repeat.gate: the phase needs at least one task before the gate",
  ])
})

it("rejects a gate that does not answer with an approved flag", () => {
  expect(errors(gateSpec({ tasks: [{ id: "impl", prompt: "build it" }, gateTask({ outputSchema: undefined })] }))).toEqual(
    ['phases[0].repeat.gate: the gate has to be an agent task whose outputSchema requires "approved"'],
  )
  expect(
    errors(gateSpec({ tasks: [{ id: "impl", prompt: "build it" }, { id: "review", kind: "shell", command: "true" }] })),
  ).toEqual(['phases[0].repeat.gate: the gate has to be an agent task whose outputSchema requires "approved"'])
})

it("rejects a maxRounds outside the range", () => {
  expect(errors(gateSpec({ repeat: { gate: "review", maxRounds: 6 } })).join("\n")).toContain(
    "phases[0].repeat.maxRounds:",
  )
})

it("names maxRounds for an unknown key of a repeat", () => {
  expect(errors(gateSpec({ repeat: { gate: "review", maxRound: 3 } })).join("\n")).toContain(
    'unknown key "maxRound"; did you mean "maxRounds"?',
  )
})

it("names repeat among the phase keys of an unknown one", () => {
  expect(errors(spec({ phases: [{ id: "one", repeatt: {}, tasks: [{ id: "a", prompt: "go" }] }] })).join("\n")).toContain(
    'did you mean "repeat"?',
  )
})
