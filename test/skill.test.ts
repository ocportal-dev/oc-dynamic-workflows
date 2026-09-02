import { expect, it } from "bun:test"
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
