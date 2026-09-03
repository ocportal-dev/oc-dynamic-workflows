import { expect, it } from "bun:test"
import { ROLE_NAMES } from "../src/config.js"
import { TEMPLATE_NAMES } from "../src/templates.js"
import { startPlugin } from "./fake.js"

it("registers the workflow skill with a listing entry short enough to carry", async () => {
  const fake = await startPlugin()
  expect(fake.skills.map((skill) => skill.id)).toEqual(["workflow"])
  const [skill] = fake.skills
  expect(skill!.description.length).toBeLessThan(200)
  expect(skill!.description).toContain("parallel")
  // A location that ends in SKILL.md makes the host scan a sibling directory instead.
  expect(skill!.location.endsWith("SKILL.md")).toBe(false)
  // A `slash` flag would be shadowed by the command of the same name.
  expect("slash" in skill!).toBe(false)
})

it("builds the skill body from the resolved options", async () => {
  const fake = await startPlugin({ options: { defaultAgent: "researcher", concurrency: 7, maxAgents: 12 } })
  const [skill] = fake.skills
  expect(skill!.content).toContain("It falls back to `researcher`")
  expect(skill!.content).toContain("7 tasks of one phase run at a time")
  expect(skill!.content).toContain("The ceiling is 12 tasks in one workflow")
  expect(skill!.content).toContain("15 minutes per task")
  expect(skill!.content).toContain("120 minutes for the whole run")
  // The grammar has one owner, so the body carries the same summary the tools carry.
  expect(skill!.content).toContain('"specVersion": 1')
})

it("says shell tasks are off when the options turn them off", async () => {
  const fake = await startPlugin({ options: { shellTasks: false } })
  expect(fake.skills[0]!.content).toContain("turned off in this project")
})

it("carries the roles, the review gates, the built-in workflows, and plan mode", async () => {
  const fake = await startPlugin()
  const body = fake.skills[0]!.content
  for (const heading of ["## Roles", "## Review gates", "## Built-in workflows", "## Plan mode"]) {
    expect(body, heading).toContain(heading)
  }
  for (const name of TEMPLATE_NAMES) expect(body, name).toContain(name)
  for (const role of ROLE_NAMES) expect(body, role).toContain(`\`${role}\``)
  expect(body).toContain("Set a role's model in the plugin options, not in the spec")
  expect(body).toContain("The synthesizer instead follows\n`options.synthesisModel`")
  expect(body).toContain('"repeat": { "gate": "<task id>", "maxRounds": 3 }')
})
