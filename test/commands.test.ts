import { expect, it } from "bun:test"
import { LEAD, startPlugin } from "./fake.js"

const SPEC = '{"specVersion": 1, "name": "demo", "goal": "do the thing", "phases": []}'

it("registers the four slash commands with the argument shape in the description", async () => {
  const fake = await startPlugin()
  expect(fake.commands.map((command) => command.name)).toEqual([
    "workflow",
    "workflow-status",
    "workflow-resume",
    "workflow-cancel",
  ])
  // The palette prints `/name` itself and fuzzy-matches the description, so the description
  // carries the argument shape instead of repeating the name.
  for (const command of fake.commands) expect(command.description).toContain("Args:")
})

it("turns a goal into an instruction to author a spec and run it", async () => {
  const fake = await startPlugin()
  await fake.slash("workflow", "compare the three clients")

  expect(fake.prompts).toHaveLength(1)
  const [sent] = fake.prompts
  expect(sent!.sessionID).toBe(LEAD)
  expect(sent!.delivery).toBe("steer")
  expect(sent!.text).toContain("compare the three clients")
  expect(sent!.text).toContain("Write a workflow spec")
  expect(sent!.text).toContain('"specVersion": 1')
  expect(sent!.text).toContain("workflow_run")
  expect(sent!.text).toContain('Set "retries": 1 on every task')
  expect(sent!.text).toContain("do not poll it")
})

it("passes a JSON spec through unchanged", async () => {
  const fake = await startPlugin()
  await fake.slash("workflow", ` ${SPEC} `)

  const [sent] = fake.prompts
  expect(sent!.text).toContain(SPEC)
  expect(sent!.text).toContain("Call workflow_run with exactly this spec, unchanged")
  expect(sent!.text).not.toContain("Write a workflow spec")
})

it("asks for a goal when the command carries no argument", async () => {
  const fake = await startPlugin()
  await fake.slash("workflow", "")
  expect(fake.prompts[0]!.text).toContain("named no goal")
  expect(fake.prompts[0]!.text).not.toContain("workflow_run")
})

it("builds the status and resume envelopes around the run id", async () => {
  const fake = await startPlugin()
  await fake.slash("workflow-status", " wf_123 ")
  await fake.slash("workflow-resume", "wf_123")

  expect(fake.prompts[0]!.text).toContain('Call workflow_status with runId "wf_123"')
  expect(fake.prompts[0]!.text).toContain("three lines")
  expect(fake.prompts[1]!.text).toContain('Call workflow_resume with runId "wf_123"')
  expect(fake.prompts[1]!.text).toContain("overrides.maxCostUsd")
})

it("reads the most recent run when workflow-status carries no run id", async () => {
  const fake = await startPlugin()
  await fake.slash("workflow-status", "")
  expect(fake.prompts[0]!.text).toContain("with no runId")
})

it("builds the cancel envelope around the run id", async () => {
  const fake = await startPlugin()
  await fake.slash("workflow-cancel", " wf_123 ")
  expect(fake.prompts[0]!.text).toContain('Call workflow_cancel with runId "wf_123"')
  expect(fake.prompts[0]!.text).toContain("Only the session that leads the run can cancel it")
})

it("looks the latest run up when workflow-cancel carries no run id", async () => {
  const fake = await startPlugin()
  await fake.slash("workflow-cancel", "")
  expect(fake.prompts[0]!.text).toContain("Call workflow_status with no runId")
  expect(fake.prompts[0]!.text).toContain("then call workflow_cancel with that run id")
})

it("swallows a session.prompt that rejects", async () => {
  const fake = await startPlugin()
  fake.setPromptFails(true)
  for (const name of ["workflow", "workflow-status", "workflow-resume", "workflow-cancel"]) {
    expect(await fake.slash(name, "wf_123")).toBeUndefined()
    expect(await fake.slash(name, "")).toBeUndefined()
  }
  expect(fake.prompts).toHaveLength(0)
})
