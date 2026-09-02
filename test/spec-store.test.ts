import { expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { list, load, save, specDirectory } from "../src/spec-store.js"
import type { WorkflowSpec } from "../src/types.js"

const SPEC: WorkflowSpec = {
  specVersion: 1,
  name: "demo",
  goal: "do the thing",
  phases: [{ id: "one", strategy: "parallel", tasks: [{ id: "a", kind: "agent", prompt: "go", retries: 0, keep: false }] }],
}

const project = (): Promise<string> => mkdtemp(join(tmpdir(), "workflows-"))

it("returns an empty list when the directory does not exist", async () => {
  expect(await list(await project())).toEqual([])
})

it("saves a spec and lists it by name", async () => {
  const directory = await project()
  const saved = await save(directory, "demo", SPEC)
  expect(saved).toEqual({ ok: true, path: join(specDirectory(directory), "demo.json") })
  expect(await list(directory)).toEqual(["demo"])
})

it("lists only json files, sorted", async () => {
  const directory = await project()
  await mkdir(specDirectory(directory), { recursive: true })
  for (const file of ["b.json", "a.json", "notes.md"]) {
    await writeFile(join(specDirectory(directory), file), "{}", "utf8")
  }
  expect(await list(directory)).toEqual(["a", "b"])
})

it("loads a saved spec", async () => {
  const directory = await project()
  await save(directory, "demo", SPEC)
  expect(await load(directory, "demo")).toEqual({ ok: true, value: SPEC })
})

it("reports a missing spec", async () => {
  const directory = await project()
  const result = await load(directory, "missing")
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain('no saved workflow named "missing"')
})

it("reports a file that is not valid JSON", async () => {
  const directory = await project()
  await mkdir(specDirectory(directory), { recursive: true })
  await writeFile(join(specDirectory(directory), "broken.json"), "{ not json", "utf8")
  const result = await load(directory, "broken")
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain("is not valid JSON")
})

it("rejects a name that could escape the workflow directory", async () => {
  const directory = await project()
  for (const name of ["../secret", "..", "a/b", "", "sub dir", 7]) {
    const result = await load(directory, name)
    expect(result.ok).toBe(false)
    const saved = await save(directory, name, SPEC)
    expect(saved.ok).toBe(false)
  }
  expect(await list(directory)).toEqual([])
})
