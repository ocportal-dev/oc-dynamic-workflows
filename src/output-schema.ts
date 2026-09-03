/**
 * A small JSON Schema subset, used to check what a task replied with.
 *
 * A member's output is plain text, so a schema cannot be enforced by the host. The task output
 * is searched for a JSON object instead, and that object
 * is checked here. Only these keywords are read: `type`, `properties`, `required`,
 * `items`, `enum`, and `additionalProperties`. Anything else in the schema is ignored.
 */
export type ExtractResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

/** Finds the first JSON object in the text, fenced or bare. */
export function extractJson(text: string): ExtractResult {
  for (const candidate of candidates(text)) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> }
      }
    } catch {
      // Not the object; keep looking.
    }
  }
  return { ok: false, error: "the output holds no JSON object" }
}

/** Every brace-balanced slice that starts at a `{`, longest first at each start. */
function* candidates(text: string): Generator<string> {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue
    const slice = balanced(text, index)
    if (slice) yield slice
  }
}

function balanced(text: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** Returns one message per problem. An empty list means the value matches. */
export function validateJson(schema: unknown, value: unknown, path = "$"): string[] {
  if (!isRecord(schema)) return []
  const errors: string[] = []

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum
    if (!allowed.some((option) => same(option, value))) {
      errors.push(`${path}: must be one of ${allowed.map((option) => JSON.stringify(option)).join(", ")}`)
      return errors
    }
  }

  const types = typeNames(schema.type)
  if (types.length > 0 && !types.some((name) => matchesType(name, value))) {
    errors.push(`${path}: must be ${types.join(" or ")}, not ${typeOf(value)}`)
    return errors
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === "string" && !(name in value)) errors.push(`${path}.${name}: required`)
      }
    }
    for (const [name, child] of Object.entries(value)) {
      if (name in properties) errors.push(...validateJson(properties[name], child, `${path}.${name}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${name}: not allowed`)
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      errors.push(...validateJson(schema.items, item, `${path}[${index}]`))
    }
  }

  return errors
}

function typeNames(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.filter((name): name is string => typeof name === "string")
  return []
}

function matchesType(name: string, value: unknown): boolean {
  switch (name) {
    case "object":
      return isRecord(value)
    case "array":
      return Array.isArray(value)
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    default:
      return true
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
