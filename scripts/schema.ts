/**
 * Generates `assets/workflow.schema.json` from the Zod schema, so an editor can validate a
 * saved spec under `.opencode/workflows/`.
 *
 *     bun scripts/schema.ts
 *
 * The asset is committed and `test/schema.test.ts` fails when it drifts from this output.
 * Never hand-edit it.
 */
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { DSL, WorkflowObject } from "../src/spec.js"

export const SCHEMA_PATH = fileURLToPath(new URL("../assets/workflow.schema.json", import.meta.url))

/**
 * `io: "input"` is what a person writes: a field with a default stays optional. The
 * cross-field rules live in `superRefine`, so JSON Schema cannot carry them.
 */
export function buildSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(WorkflowObject, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>
  return {
    $schema,
    $id: "https://github.com/velazcod/oc-dynamic-workflows/assets/workflow.schema.json",
    title: "opencode dynamic workflow spec",
    description: DSL,
    ...rest,
  }
}

export function render(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`
}

if (import.meta.main) {
  await writeFile(SCHEMA_PATH, render(buildSchema()), "utf8")
  console.log(`wrote ${SCHEMA_PATH}`)
}
