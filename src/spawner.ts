/**
 * Holds the built-in `subagent` tool executor. A member session has to be a real child
 * of the calling session, and that executor is the only way a plugin can create one.
 *
 * The executor is captured from the tool draft, which the host replays on every reload,
 * so `capture` has to be idempotent.
 *
 * Calling the executor from plugin code is unsupported internals: it skips the input
 * decode, the `tool.execute.*` hooks, and the `Tool.Error` coercion.
 */
export interface SpawnRequest {
  /** The calling session. Becomes the child's `parentID`. */
  lead: string
  /** The agent forged into the spawn context. */
  leadAgent: string
  /** The lead's latest assistant message id, used by the permission ask renderer. */
  messageID?: string
  /** A subagent-mode agent. The executor rejects a primary agent. */
  agent: string
  /** Unique per attempt. Becomes the child session title. */
  description: string
  prompt: string
}

export interface SpawnOutput {
  sessionID: string
  status: "completed" | "running"
  output: string
}

export interface SpawnHandle {
  /** Rejects when the child fails or is interrupted. Always await it, or the child leaks. */
  promise: Promise<SpawnOutput>
  /** Interrupts the child. The promise then rejects. */
  cancel: (childSessionID: string) => Promise<void>
}

export interface SpawnerDeps {
  /** `ctx.session.interrupt({ sessionID, continue: false })`. */
  interrupt: (sessionID: string) => Promise<unknown>
}

type Executor = (input: unknown, context: unknown) => Promise<unknown>

const MISSING = "the built-in subagent tool is not available, so no member session can be started"

export class Spawner {
  #execute: Executor | undefined
  #deps: SpawnerDeps

  constructor(deps: SpawnerDeps) {
    this.#deps = deps
  }

  /** Accepts the value of `draft.get("subagent")`. Anything else is ignored. */
  capture(tool: unknown): void {
    if (!tool || typeof tool !== "object") return
    const candidate = tool as { name?: unknown; execute?: unknown }
    if (candidate.name !== "subagent") return
    if (typeof candidate.execute !== "function") return
    this.#execute = candidate.execute as Executor
  }

  available(): boolean {
    return this.#execute !== undefined
  }

  /** Starts a child session. The caller owns the promise and has to settle it. */
  spawn(request: SpawnRequest): SpawnHandle {
    const cancel = async (childSessionID: string): Promise<void> => {
      await this.#deps.interrupt(childSessionID)
    }
    const execute = this.#execute
    if (!execute) return { promise: Promise.reject(new Error(MISSING)), cancel }

    const context = {
      sessionID: request.lead,
      agent: request.leadAgent,
      messageID: request.messageID ?? "msg_wf",
      id: `wf_${request.description}`,
      progress: async () => {},
    }
    const input = {
      agent: request.agent,
      description: request.description,
      prompt: request.prompt,
      background: false,
    }
    const promise = execute(input, context).then(readOutput)
    return { promise, cancel }
  }
}

/** The executor resolves with `{ output, content, metadata }`. Only `output` is used. */
function readOutput(result: unknown): SpawnOutput {
  const output = (result as { output?: unknown } | undefined)?.output
  if (!output || typeof output !== "object") throw new Error("the subagent tool returned no output")
  const value = output as { sessionID?: unknown; status?: unknown; output?: unknown }
  if (typeof value.sessionID !== "string") throw new Error("the subagent tool returned no session id")
  return {
    sessionID: value.sessionID,
    status: value.status === "running" ? "running" : "completed",
    output: typeof value.output === "string" ? value.output : "",
  }
}
