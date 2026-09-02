import type { Plugin } from "@opencode-ai/plugin"
import { resolveConfig, type WorkflowConfig } from "../src/config.js"
import { resetEngines } from "../src/engine.js"
import { consumeEvents } from "../src/events.js"
import { Mailbox } from "../src/mailbox.js"
import plugin from "../src/index.js"
import { RunStore } from "../src/persistence.js"
import { Roster } from "../src/roster.js"
import { Runner } from "../src/runner.js"
import { Spawner } from "../src/spawner.js"
import type { CommandDefinition, CommandInvocation } from "../src/commands.js"
import type { SkillDefinition } from "../src/skill.js"
import type { WorkflowTool } from "../src/tools.js"

export interface SpawnInput {
  agent: string
  description: string
  prompt: string
  background: boolean
  /** Set when the executor is asked to prompt a child that already exists. */
  sessionID?: string
}

export interface SpawnContext {
  sessionID: string
  agent: string
  messageID: string
  id: string
  progress: () => Promise<void>
}

export interface FakeSpawn {
  input: SpawnInput
  context: SpawnContext
  /** The child session the fake announced through `session.created`. */
  childID: string
  settle: (output?: string) => void
  /** Resolves with `status: "running"`, which is what a backgrounded job returns. */
  background: () => void
  fail: (message: string) => void
}

export interface FakeSession {
  parentID?: string
  title?: string
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  /** Set once the session ended. The runner polls for it after a background result. */
  outcome?: "succeeded" | "failed" | "interrupted"
}

export interface Synthetic {
  sessionID: string
  text: string
  delivery?: string
  description?: string
  /** `false` admits the item without waking the session. */
  resume?: boolean
}

export interface Prompt {
  sessionID: string
  text: string
  delivery?: string
}

export const LEAD = "ses_lead"
export const LEAD_AGENT = "build"
export const PROJECT = "proj1"

/** Lets the event consumer and the detached run loop make progress. */
export async function tick(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The scripted world both harnesses share: a subagent executor whose calls stay pending
 * until the test settles them, an event stream, an in-memory storage, and recorders for
 * the session calls the runner makes.
 */
function makeWorld() {
  const spawns: FakeSpawn[] = []
  const storage = new Map<string, unknown>()
  const interrupts: string[] = []
  const synthetic: Synthetic[] = []
  const sessions = new Map<string, FakeSession>()
  const messages = new Map<string, unknown[]>()
  const generated: { prompt: string }[] = []
  const agents: { name: string; mode: string }[] = [{ name: "general", mode: "subagent" }]
  const queue: unknown[] = []
  const flight = { now: 0, max: 0 }
  let wake: (() => void) | undefined
  let generatedText = "SYNTHESIS"
  let promptFails = false
  let announceChildren = true
  let storageFails: ((key: string) => boolean) | undefined

  const emit = (event: unknown): void => {
    queue.push(event)
    wake?.()
    wake = undefined
  }

  const subagent = {
    id: "subagent",
    name: "subagent",
    description: "",
    input: {},
    execute: (input: SpawnInput, context: SpawnContext) =>
      new Promise((resolve, reject) => {
        // A call that names a session prompts that child again; it creates none.
        const childID = input.sessionID ?? `ses_child${spawns.length + 1}`
        if (!sessions.has(childID)) {
          sessions.set(childID, {
            parentID: context.sessionID,
            title: input.description,
            cost: 0.01,
            tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } },
          })
        }
        flight.now += 1
        flight.max = Math.max(flight.max, flight.now)
        const done = <T>(value: T): T => {
          flight.now -= 1
          return value
        }
        spawns.push({
          input,
          context,
          childID,
          settle: (output = "done") =>
            resolve(
              done({
                output: { sessionID: childID, status: "completed", output },
                content: output,
                metadata: { sessionID: childID, status: "completed" },
              }),
            ),
          background: () =>
            resolve(
              done({
                output: { sessionID: childID, status: "running", output: "" },
                content: "",
                metadata: { sessionID: childID, status: "running" },
              }),
            ),
          fail: (message: string) => reject(done(new Error(message))),
        })
        // A spawn whose `session.created` never arrives leaves the child unnamed, and a
        // continued child was announced by the call that created it.
        if (announceChildren && !input.sessionID) {
          emit({
            type: "session.created",
            data: { sessionID: childID, parentID: context.sessionID, title: input.description },
          })
        }
      }),
  }

  const gets: string[] = []
  const prompts: Prompt[] = []
  const moves: { sessionID: string; directory: string }[] = []
  let moveFails = false
  let moveDelayMs = 0
  const interruptCalls: { sessionID: string; continue: boolean }[] = []
  let inbox = 0
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      gets.push(sessionID)
      return sessions.get(sessionID)
    },
    context: async ({ sessionID }: { sessionID: string }) =>
      messages.get(sessionID) ?? [{ id: "msg_lead", role: "assistant" }],
    interrupt: async ({ sessionID, continue: resume }: { sessionID: string; continue?: boolean }) => {
      interrupts.push(sessionID)
      interruptCalls.push({ sessionID, continue: resume === true })
      // `continue: true` resumes the steered items, so the spawn is not cancelled. A child
      // can have been prompted more than once, and only the newest call is still pending.
      const pending = [...spawns].reverse().find((spawn) => spawn.childID === sessionID)
      if (!resume) pending?.fail(`Subagent cancelled (sessionID: ${sessionID})`)
      return {}
    },
    move: async (input: { sessionID: string; directory: string }) => {
      if (moveFails) throw new Error("the directory does not exist")
      moves.push(input)
      // The real call boots the location instance of the destination first.
      if (moveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, moveDelayMs))
      return undefined
    },
    prompt: async (input: Prompt) => {
      if (promptFails) throw new Error("the session is gone")
      prompts.push(input)
      inbox += 1
      return { id: `inbox_${inbox}`, sessionID: input.sessionID, type: "user" }
    },
    synthetic: async (input: Synthetic) => {
      synthetic.push(input)
      return {}
    },
  }

  const writes: string[] = []
  const storageDomain = {
    get: async (key: string) => storage.get(key),
    set: async (key: string, value: unknown) => {
      writes.push(key)
      if (storageFails?.(key)) throw new Error(`the storage refused ${key}`)
      // The real store keeps JSON, so a snapshot must not follow later mutations.
      storage.set(key, JSON.parse(JSON.stringify(value)))
    },
    remove: async (key: string) => {
      storage.delete(key)
    },
  }

  const subscribe = async function* (request: { signal: AbortSignal }) {
    while (!request.signal.aborted) {
      if (queue.length > 0) {
        yield queue.shift()
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        request.signal.addEventListener("abort", () => resolve(), { once: true })
      })
    }
  }

  const generate = {
    text: async (input: { prompt: string }) => {
      generated.push(input)
      return { text: generatedText }
    },
  }

  return {
    spawns,
    storage,
    storageDomain,
    /** Every key that was written, in order. */
    writes,
    interrupts,
    interruptCalls,
    prompts,
    moves,
    synthetic,
    sessions,
    gets,
    messages,
    generated,
    generate,
    agents,
    flight,
    emit,
    subagent,
    session,
    subscribe,
    /** Scripts the event that marks an inbox item as taken. */
    deliver: (inboxID: string, sessionID: string) => {
      emit({ type: "session.inbox.delivered", data: { inboxID, sessionID } })
    },
    /** Scripts the event a session publishes once it arrived in its new directory. */
    move: (sessionID: string, directory: string) => {
      emit({ type: "session.moved", data: { sessionID, location: { directory } } })
    },
    /** Makes every later `session.move` reject, as a missing directory would. */
    setMoveFails: (value: boolean) => {
      moveFails = value
    },
    /** How long `session.move` takes to come back, as booting a location instance does. */
    setMoveDelay: (ms: number) => {
      moveDelayMs = ms
    },
    /** Scripts the permission a member session asked the user for. */
    ask: (sessionID: string, requestID: string, action = "bash", resource = "rm -rf /") => {
      emit({ type: "permission.asked", data: { sessionID, id: requestID, action, resources: [resource] } })
    },
    /** Scripts the answer the user gave to that ask. */
    reply: (sessionID: string, requestID: string, reply: "once" | "always" | "reject") => {
      emit({ type: "permission.replied", data: { sessionID, requestID, reply } })
    },
    setGeneratedText: (text: string) => {
      generatedText = text
    },
    /** Makes every later `session.prompt` reject, which a command must survive. */
    setPromptFails: (value: boolean) => {
      promptFails = value
    },
    /** Makes the matching storage writes reject, which no timer may turn into a defect. */
    setStorageFails: (predicate?: (key: string) => boolean) => {
      storageFails = predicate
    },
    /** Turns `session.created` off, so a spawn leaves its child unnamed. */
    setAnnounceChildren: (value: boolean) => {
      announceChildren = value
    },
  }
}

export type World = ReturnType<typeof makeWorld>

export interface ContextEvent {
  sessionID: string
  tools: Record<string, unknown>
  system: { type: "text"; text: string }[]
}

export interface Fake extends World {
  tools: WorkflowTool[]
  skills: SkillDefinition[]
  tool: (name: string) => WorkflowTool
  commands: CommandDefinition[]
  command: (name: string) => CommandDefinition
  /** Calls one registered command the way the host would. */
  slash: (name: string, text: string, sessionID?: string) => Promise<void>
  run: (name: string, input: unknown, context?: Partial<SpawnContext>) => Promise<{ content: unknown; output: unknown }>
  /** Calls the registered `context` hook with a request the host would have built. */
  context: (sessionID: string) => Promise<ContextEvent>
  asked: string[]
  disposed: string[]
  cleanup: Plugin.Cleanup | void
}

/**
 * Boots the plugin against a hand-rolled context.
 *
 * The engine map is module state, so every boot starts from an empty one. A test that
 * needs a second instance of the same project passes `share: true`, which is what a
 * worktree directory does in a live process.
 */
export async function startPlugin(
  options: {
    options?: unknown
    directory?: string
    subagent?: boolean
    projectID?: string
    /** Attaches to the engine an earlier boot built instead of starting from nothing. */
    share?: boolean
  } = {},
): Promise<Fake> {
  if (!options.share) resetEngines()
  const world = makeWorld()
  const added: WorkflowTool[] = []
  const commands: CommandDefinition[] = []
  const skills: SkillDefinition[] = []
  const asked: string[] = []
  const disposed: string[] = []
  const hooks = new Map<string, (event: unknown) => Promise<void>>()

  const ctx = {
    options: options.options ?? {},
    location: { directory: options.directory ?? "/project", project: { id: options.projectID ?? PROJECT } },
    storage: world.storageDomain,
    session: {
      ...world.session,
      hook: async (name: string, callback: (event: unknown) => Promise<void>) => {
        hooks.set(name, callback)
        return {
          dispose: async () => {
            disposed.push("session.hook")
          },
        }
      },
    },
    generate: world.generate,
    // The host answers `{ location, data }`, not a plain array.
    agent: { list: async () => ({ location: {}, data: world.agents }) },
    event: { subscribe: world.subscribe },
    command: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({ add: (command: CommandDefinition) => commands.push(command) })
        return {
          dispose: async () => {
            disposed.push("command.transform")
          },
        }
      },
    },
    skill: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({ add: (skill: SkillDefinition) => skills.push(skill) })
        return {
          dispose: async () => {
            disposed.push("skill.transform")
          },
        }
      },
    },
    tool: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({
          add: (tool: WorkflowTool) => added.push(tool),
          get: (id: string) => {
            asked.push(id)
            return id === "subagent" && options.subagent !== false ? world.subagent : undefined
          },
          list: () => added,
          remove: () => {},
          update: () => {},
        })
        return {
          dispose: async () => {
            disposed.push("tool.transform")
          },
        }
      },
    },
  } as unknown as Plugin.Context

  const cleanup = await plugin.setup(ctx)
  const tool = (name: string): WorkflowTool => {
    const found = added.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`tool ${name} was not registered`)
    return found
  }

  const command = (name: string): CommandDefinition => {
    const found = commands.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`command ${name} was not registered`)
    return found
  }

  return {
    ...world,
    tools: added,
    tool,
    skills,
    commands,
    command,
    slash: (name: string, text: string, sessionID: string = LEAD) =>
      command(name).execute({ sessionID, prompt: { text }, delivery: "steer" } as CommandInvocation),
    run: (name, input, context) =>
      tool(name).execute(input as never, {
        sessionID: LEAD,
        agent: LEAD_AGENT,
        messageID: "msg_lead",
        id: "call_1",
        progress: async () => {},
        ...context,
      } as never) as Promise<{ content: unknown; output: unknown }>,
    context: async (sessionID: string) => {
      const event: ContextEvent = {
        sessionID,
        tools: { workflow_run: {}, workflow_status: {}, subagent: {}, read: {}, bash: {} },
        system: [],
      }
      await hooks.get("context")?.(event)
      return event
    },
    asked,
    disposed,
    cleanup,
  }
}

export interface RunnerFake extends World {
  runner: Runner
  store: RunStore
  roster: Roster
  mailbox: Mailbox
  stop: () => Promise<void>
}

/** Builds the runner directly, so a test can use a spec the tool schema would clamp. */
export function startRunner(
  options: {
    options?: unknown
    directory?: string
    now?: () => number
    pollIntervalMs?: number
    generate?: boolean
    /** How long a burst of questions is collected. Short, so a test does not wait. */
    debounceMs?: number
    /** Written over the resolved config, so a test can use a value the clamp forbids. */
    config?: Partial<WorkflowConfig>
    /** How often a timed-out task asks for its child. Short, so a test does not wait. */
    childPollMs?: number
    /** How long the move of an idle member gets. Short, so a test does not wait. */
    moveTimeoutMs?: number
  } = {},
): RunnerFake {
  const world = makeWorld()
  const config = { ...resolveConfig(options.options ?? {}).config, ...options.config }
  const store = new RunStore(world.storageDomain, PROJECT)
  // The same lookup the plugin builds, so a test can count it through `gets`.
  const roster = new Roster(async (sessionID) => world.session.get({ sessionID }), { now: options.now })
  const spawner = new Spawner({ interrupt: (sessionID) => world.session.interrupt({ sessionID }) })
  spawner.capture(world.subagent)
  const mailbox = new Mailbox({
    session: world.session,
    store,
    roster,
    config,
    debounceMs: options.debounceMs ?? 5,
    onForcedSteer: (runId, taskId) => runner.noteForcedSteer(runId, taskId),
    onSpend: async (runId: string): Promise<void> => {
      await runner.checkBudget(runId)
    },
  })
  const runner = new Runner({
    session: world.session,
    store,
    roster,
    spawner,
    config,
    mailbox,
    directory: options.directory ?? "/project",
    generate: options.generate === false ? undefined : world.generate.text,
    now: options.now,
    pollIntervalMs: options.pollIntervalMs ?? 5,
    childPollMs: options.childPollMs ?? 1,
    moveTimeoutMs: options.moveTimeoutMs ?? 2000,
  })
  const aborter = new AbortController()
  const events = consumeEvents({
    subscribe: world.subscribe,
    roster,
    store,
    mailbox,
    runner,
    signal: aborter.signal,
  })

  return {
    ...world,
    runner,
    store,
    roster,
    mailbox,
    stop: async () => {
      aborter.abort()
      mailbox.dispose()
      await events.catch(() => {})
    },
  }
}

/** Waits until a condition holds, or fails the test with what it waited for. */
export async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (await check()) return
    await tick(1)
  }
  throw new Error(`waited too long for ${label}`)
}

/** Waits until the fake has recorded `count` spawns. */
export async function waitForSpawn(world: World, count: number): Promise<FakeSpawn> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (world.spawns.length >= count) {
      await tick(2)
      return world.spawns[count - 1]!
    }
    await tick(1)
  }
  throw new Error(`spawn ${count} never happened (${world.spawns.length} so far)`)
}
