import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { WorkflowSpec } from "./types.js"

export type LoadResult = { ok: true; value: unknown } | { ok: false; error: string }
export type SaveResult = { ok: true; path: string } | { ok: false; error: string }

const NAME = /^[A-Za-z0-9._-]+$/

/** Saved specs live next to the project config so a person can edit them by hand. */
export function specDirectory(directory: string): string {
  return join(directory, ".opencode", "workflows")
}

/** Rejects anything that could escape the workflow directory. */
export function checkName(name: unknown): string | undefined {
  if (typeof name !== "string" || !name) return "name: required"
  if (!NAME.test(name)) return `name: "${name}" may only contain letters, digits, ".", "_", and "-"`
  if (name.includes("..")) return `name: "${name}" may not contain ".."`
  return undefined
}

/** Returns the saved workflow names, sorted. A missing directory yields an empty list. */
export async function list(directory: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(specDirectory(directory))
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((name) => checkName(name) === undefined)
    .sort()
}

export async function load(directory: string, name: unknown): Promise<LoadResult> {
  const invalid = checkName(name)
  if (invalid) return { ok: false, error: invalid }
  const path = join(specDirectory(directory), `${name as string}.json`)
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return { ok: false, error: `no saved workflow named "${name as string}" in ${specDirectory(directory)}` }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function save(directory: string, name: unknown, spec: WorkflowSpec): Promise<SaveResult> {
  const invalid = checkName(name)
  if (invalid) return { ok: false, error: invalid }
  const path = join(specDirectory(directory), `${name as string}.json`)
  try {
    await mkdir(specDirectory(directory), { recursive: true })
    await writeFile(path, `${JSON.stringify(spec, null, 2)}\n`, "utf8")
  } catch (error) {
    return { ok: false, error: `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, path }
}
