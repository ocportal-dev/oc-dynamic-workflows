import { Plugin } from "@opencode-ai/plugin"
import { workflowCommands } from "./commands.js"
import { resolveConfig } from "./config.js"
import { consumeEvents } from "./events.js"
import { contextHook } from "./hooks.js"
import { PREFIX } from "./log.js"
import { Mailbox } from "./mailbox.js"
import { RunStore, storagePrefix } from "./persistence.js"
import { Roster } from "./roster.js"
import { Runner } from "./runner.js"
import { workflowSkill } from "./skill.js"
import { Spawner } from "./spawner.js"
import { workflowTools } from "./tools.js"

export default Plugin.define({
  id: "oc-dynamic-workflows",
  setup: async (ctx) => {
    const { config, warnings } = resolveConfig(ctx.options)
    for (const warning of warnings) console.warn(`${PREFIX} ${warning}`)

    const prefix = storagePrefix(ctx.location.project?.id, ctx.location.directory)
    const runs = new RunStore(ctx.storage, prefix, ctx.location.directory)
    const roster = new Roster(async (sessionID) => ctx.session.get({ sessionID }))
    const spawner = new Spawner({ interrupt: (sessionID) => ctx.session.interrupt({ sessionID, continue: false }) })
    const mailbox = new Mailbox({
      session: ctx.session,
      store: runs,
      roster,
      config,
      // The runner owns the spawn promise that the forced interrupt rejects.
      onForcedSteer: (runId, taskId) => runner.noteForcedSteer(runId, taskId),
      // A wake is billed to the run, so the cap is read again right after it.
      onSpend: async (runId: string): Promise<void> => {
        await runner.checkBudget(runId)
      },
    })
    const runner = new Runner({
      session: ctx.session,
      store: runs,
      roster,
      spawner,
      config,
      mailbox,
      directory: ctx.location.directory,
      generate: (input) => ctx.generate.text(input),
    })
    const tools = workflowTools({
      config,
      warnings,
      directory: ctx.location.directory,
      spawner,
      runner,
      runs,
      roster,
      mailbox,
      agents: () => ctx.agent.list(),
    })
    // The host replays the transform on every reload, so the probe result is reported once.
    let reported = false

    const registrations = await Promise.all([
      ctx.tool.transform((draft) => {
        spawner.capture(draft.get("subagent"))
        for (const tool of tools) draft.add(tool)
        if (!reported) {
          reported = true
          const found = spawner.available() ? "found" : "not found"
          console.log(`${PREFIX} subagent executor ${found}`)
        }
      }),
      ctx.command.transform((draft) => {
        for (const command of workflowCommands({ session: ctx.session })) draft.add(command)
      }),
      // The listing entry costs one line per session; the body is fetched only when it is loaded.
      ctx.skill.transform((draft) => {
        draft.add(workflowSkill(config) as never)
      }),
      // Strips the engine tools from a member's request and shows the lead its progress.
      ctx.session.hook("context", contextHook({ roster, store: runs, mailbox })),
    ])

    // The consumer names the child of every spawn, so it starts before any run can.
    const aborter = new AbortController()
    const events = consumeEvents({
      subscribe: (options) => ctx.event.subscribe(options),
      roster,
      store: runs,
      mailbox,
      signal: aborter.signal,
    })
    await runner.recoverOrphans()

    return async () => {
      aborter.abort()
      mailbox.dispose()
      // The runs of this instance have no watcher after the reload, so they are stopped.
      await runner.dispose()
      await events.catch(() => {})
      await Promise.all(registrations.map((registration) => registration.dispose()))
    }
  },
})
