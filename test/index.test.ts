import { expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index.js"
import { save } from "../src/spec-store.js"
import type { WorkflowSpec } from "../src/types.js"
import { startPlugin, tick, waitForSpawn } from "./fake.js"

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** One team phase with an agent task and a shell task. */
const SPEC = {
  specVersion: 1,
  name: "demo",
  goal: "do the thing",
  phases: [
    {
      id: "one",
      title: "Only phase",
      strategy: "team",
      tasks: [
        { id: "a", prompt: "go", agent: "general" },
        { id: "b", kind: "shell", command: "ls" },
      ],
    },
  ],
}

it("exposes the plugin id", () => {
  expect(plugin.id).toBe("oc-dynamic-workflows")
})

it("registers the workflow tools with valid names", async () => {
  const fake = await startPlugin()
  expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
    "team_inbox",
    "team_send",
    "team_steer",
    "workflow_cancel",
    "workflow_doctor",
    "workflow_list",
    "workflow_resume",
    "workflow_run",
    "workflow_run_saved",
    "workflow_show",
    "workflow_status",
  ])
  for (const tool of fake.tools) {
    expect(tool.name).toMatch(TOOL_NAME)
    expect(tool.description.length).toBeGreaterThan(0)
    // A description that leads with the mechanism is only reached for when the user names the
    // tool, so every one of them names the situation it belongs to.
    expect(tool.description, tool.name).toMatch(/Use when|Triggers:/)
  }
  // Every tool that reads a spec has to state the version and summarise the DSL.
  for (const name of ["workflow_run", "workflow_run_saved", "workflow_show"]) {
    const description = fake.tool(name).description
    expect(description).toContain('"specVersion": 1')
    expect(description.split("\n").length).toBeGreaterThanOrEqual(4)
  }
})

it("probes the draft for the subagent executor", async () => {
  const fake = await startPlugin()
  expect(fake.asked).toEqual(["subagent"])
})

it("still registers the tools when the subagent executor is missing", async () => {
  const fake = await startPlugin({ subagent: false })
  expect(fake.tools).toHaveLength(11)
})

it("starts a run and returns the tree", async () => {
  const fake = await startPlugin()
  const result = await fake.run("workflow_run", { spec: SPEC })
  const output = result.output as { ok: boolean; runId: string; spec: WorkflowSpec; executor: string }
  expect(output.ok).toBe(true)
  expect(output.runId).toStartWith("wf_")
  expect(output.executor).toBe("available")
  expect(output.spec.phases[0]!.tasks[0]!.kind).toBe("agent")
  expect(result.content).toContain(`started run ${output.runId}`)
  expect(result.content).toContain("workflow: demo")
  expect(result.content).toContain("  - a (agent, agent=general, retries=0)")
})

it("accepts a spec passed as a JSON string", async () => {
  const fake = await startPlugin()
  const result = await fake.run("workflow_run", { spec: JSON.stringify(SPEC) })
  expect(result.content).toContain("workflow: demo")
})

it("runs a team phase and opens its mailbox for the tasks of that phase", async () => {
  const fake = await startPlugin()
  const spec = {
    specVersion: 1,
    name: "team",
    goal: "talk while working",
    phases: [{ id: "one", strategy: "team", tasks: [{ id: "a", prompt: "go" }] }],
  }
  const started = (await fake.run("workflow_run", { spec })).output as { runId: string }
  const spawn = await waitForSpawn(fake, 1)
  expect(spawn.input.description).toBe(`wf:${started.runId}:a`)

  const sent = await fake.run("team_send", { type: "status", body: "working" }, { sessionID: spawn.childID })
  expect((sent.output as { ok: boolean }).ok).toBe(true)

  const read = await fake.run("team_inbox", {})
  const inbox = read.output as { mail: { body: string; type: string }[]; roster: { taskId: string }[] }
  expect(inbox.mail).toEqual([expect.objectContaining({ body: "working", type: "status" })])
  expect(inbox.roster).toEqual([expect.objectContaining({ taskId: "a", sessionID: spawn.childID })])
  expect(read.content).toContain("1 unread message(s)")

  spawn.settle("done")
  await tick(6)
  const status = await fake.run("workflow_status", { runId: started.runId })
  expect(status.content).toContain("one [")
})

it("returns the errors of a bad spec without throwing", async () => {
  const fake = await startPlugin()
  const result = await fake.run("workflow_run", { spec: { specVersion: 2 } })
  expect(result.content).toContain("the workflow spec is not valid:")
  const output = result.output as { ok: boolean; errors: string[] }
  expect(output.ok).toBe(false)
  expect(output.errors.length).toBeGreaterThan(0)
})

it("reports a call with neither a spec nor a reference", async () => {
  const fake = await startPlugin()
  expect((await fake.run("workflow_run", {})).content).toBe('error: pass either "spec" or "specRef"')
})

it("reads a saved workflow from the project directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflows-"))
  await save(directory, "demo", SPEC as unknown as WorkflowSpec)
  const fake = await startPlugin({ directory })

  expect((await fake.run("workflow_list", {})).content).toBe("demo")
  expect((await fake.run("workflow_show", { name: "demo" })).content).toContain('"specVersion": 1')
  expect((await fake.run("workflow_run_saved", { name: "demo" })).content).toContain("workflow: demo")
  expect((await fake.run("workflow_run", { specRef: "demo" })).content).toContain("workflow: demo")
})

it("reports a missing saved workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflows-"))
  const fake = await startPlugin({ directory })
  expect((await fake.run("workflow_list", {})).content).toBe("no saved workflows")
  expect((await fake.run("workflow_run_saved", { name: "gone" })).content).toStartWith("error: ")
  expect((await fake.run("workflow_show", { name: "../escape" })).content).toStartWith("error: ")
})

it("rejects a shell task when the option turns shell tasks off", async () => {
  const fake = await startPlugin({ options: { shellTasks: false } })
  const result = await fake.run("workflow_run", { spec: SPEC })
  expect(result.content).toContain("shell tasks are disabled")
})

it("returns an output on every error path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflows-"))
  const fake = await startPlugin({ directory })
  const calls: [string, unknown][] = [
    ["workflow_run", {}],
    ["workflow_run", { spec: { specVersion: 9 } }],
    ["workflow_run_saved", { name: "gone" }],
    ["workflow_show", { name: "gone" }],
    ["workflow_list", {}],
    ["workflow_status", {}],
    ["workflow_status", { runId: "wf_gone" }],
    ["workflow_cancel", {}],
    ["workflow_cancel", { runId: "wf_gone" }],
  ]
  for (const [name, input] of calls) {
    const result = await fake.run(name, input)
    expect(result.output, `${name} ${JSON.stringify(input)}`).toBeDefined()
    expect(typeof (result.output as { ok: boolean }).ok).toBe("boolean")
  }
})

it("disposes every registration on cleanup", async () => {
  const fake = await startPlugin()
  expect(typeof fake.cleanup).toBe("function")
  if (typeof fake.cleanup === "function") await fake.cleanup()
  expect(fake.disposed.sort()).toEqual(["command.transform", "session.hook", "skill.transform", "tool.transform"])
})
