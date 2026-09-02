# AGENTS.md / CLAUDE.md / GEMINI.md

Guidance for coding agents working in this repository.

## What This Is

An opencode plugin (`opencode-dynamic-workflows`) that lets an agent write a small JSON
workflow spec, fan the tasks out to child sessions, join the results, and exchange mail
with the members of a `team` phase.

It runs `sequential`, `parallel`, and `team` phases, joins a phase with a synthesis, and
shapes the request of every session that belongs to a run. A `team` phase runs like a
`parallel` one with the hub mailbox open, so a member can reach the lead while it works and
the lead can steer a member back. `workflow_resume` picks a run up again after a failure, a
budget stop, a cancel, or a restart, and keeps every task that already completed.

This package targets OpenCode v2 (`opencode2`) only. It depends on `@opencode-ai/plugin`
at an exact beta version, pinned as a runtime dependency, because opencode installs
published plugins with production dependencies only. `zod` is pinned to the same version
the plugin package uses, so a schema is accepted as a `Tool.Info` input.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc) to dist/
npm run typecheck    # Type-check sources and tests (tsc --noEmit -p tsconfig.test.json)
npm run schema       # Regenerate assets/workflow.schema.json (bun scripts/schema.ts)
bun test             # Run the test suite
```

npm is the package manager. Bun is the test runner only. There is no linter.

The user npm config sets `min-release-age=7`, which is newer than the pinned beta's
publish date. Install with `npm install --min-release-age=0`.

## Architecture

- **`src/index.ts`** — Plugin entry point. Attaches to the shared engine, building the store,
  the roster, the spawner, and the runner on the first instance. Registers the tools through
  `ctx.tool.transform`, the commands through `ctx.command.transform`, and the skill through
  `ctx.skill.transform`, captures the built-in `subagent` executor, starts the event consumer,
  recovers orphaned runs on the first attach, and returns the cleanup function.
- **`src/skill.ts`** — `workflowSkill(config)`: the `workflow` skill the plugin registers. Its
  body is built from the resolved options, and its grammar section is `DSL` from `src/spec.ts`.
- **`src/commands.ts`** — The `/workflow`, `/workflow-status`, `/workflow-resume`, and
  `/workflow-cancel` slash commands. A command cannot answer with text, so each one builds an envelope and puts it in
  the calling session with `ctx.session.prompt`. Never throws.
- **`src/budget.ts`** — Reads the caps off a run record and names the one it hit. A budget is
  never required.
- **`src/config.ts`** — Reads `ctx.options`. Clamps every number. Never throws; an invalid
  value becomes a warning and the default.
- **`src/log.ts`** — The console prefix and `swallow`, the catch handler every promise that
  nobody awaits ends in. A timer, an event handler, and a cleanup path never throw.
- **`src/types.ts`** — The normalized `WorkflowSpec` plus `RunRecord`, `PhaseRecord`,
  `TaskRecord`, and `MailEvent`.
- **`src/spec.ts`** — The Zod schema for `specVersion: 1`, the alias normalization, and the
  v1 rejections. `parseSpec` returns either the spec or a list of one-line messages.
- **`src/engine.ts`** — `attach(prefix, build)` / `detach(prefix)`: the module-level, refcounted
  map of the one engine every plugin instance of a project shares, keyed by the storage prefix.
- **`src/spec-store.ts`** — Reads and writes `<directory>/.opencode/workflows/<name>.json`.
- **`scripts/schema.ts`** — Generates `assets/workflow.schema.json` from `WorkflowObject` with
  `z.toJSONSchema` (`target: "draft-7"`, `io: "input"`). Run with `npm run schema`.
- **`assets/workflow.schema.json`** — The generated JSON Schema an editor points at. Committed,
  never hand-edited.
- **`src/persistence.ts`** — `RunStore`: run records in `ctx.storage`, keyed by project, plus
  a JSON mirror under `.opencode/workflows/runs/`. Keeps the live record in memory so the
  runner and the event consumer mutate one object.
- **`src/spawner.ts`** — Holds the captured `subagent` executor and calls it with a forged
  tool context. The only module that touches those internals.
- **`src/roster.ts`** — Maps run to lead and task to child session. Fills from
  `session.created` and falls back to `ctx.session.get`.
- **`src/events.ts`** — The `ctx.event.subscribe` loop. Routes `session.created`,
  `session.usage.updated`, `session.execution.failed`, `session.inbox.delivered`,
  `permission.asked`, and `permission.replied`. Resubscribes with a backoff.
- **`src/runner.ts`** — The detached run loop: phases in order, the sequential path, the
  parallel worker pool, the team phase with its mailbox, the synthesis of a phase, retries,
  timeouts, the run clock, the budget stop, context chaining, `outputSchema`, usage, cancel,
  resume, orphan recovery, and the final report.
- **`src/mailbox.ts`** — The hub mailbox of a `team` phase: the send-side gate, the
  `<workflow-mail>` envelope, the mail records, the debounced lead wake, the steer, and the
  inbox. Also charges the lead's wakes to the run budget.
- **`src/hooks.ts`** — The `session` `"context"` hook: takes the engine tools out of a
  member's request, gives it the mail the lead queued before it started, and gives the lead
  the progress tree. Never throws, never writes.
- **`src/output-schema.ts`** — Finds the first JSON object in a task output and checks it
  against a small JSON Schema subset. No dependency.
- **`src/shell.ts`** — `kind: "shell"` tasks through `Bun.spawn`.
- **`src/worktree.ts`** — `create`, `settle`, `remove` for an `isolation: "worktree"` task, on
  top of `git` through `Bun.spawn`. Never throws.
- **`src/report.ts`** — The spec tree, the progress tree, the final report, and
  `wrapUntrusted`, the envelope every borrowed output is put in.
- **`src/tools.ts`** — The `workflow_*` and `team_*` tool definitions, including
  `workflow_resume` and `workflow_doctor`.
  Every executor catches its own errors and returns a `Tool.Result`, and every executor
  that drives the engine refuses a member session first.
- **Root `index.ts`** — Development shim. Re-exports the default export of `src/index.ts` so
  a local directory path works as a configured plugin with no build step.
- **`test/`** — One test file per area. `test/fake.ts` holds the scripted context: a
  subagent executor whose calls stay pending until the test settles them, an event stream,
  an in-memory storage, and recorders for the session calls.

## OpenCode v2 API facts this code depends on

Verified against `node_modules/@opencode-ai/plugin@0.0.0-beta-18743` and, where noted, in a
live `opencode2` (spike S6).

- `Plugin.define({ id, setup })` returns the plugin. `setup(ctx)` may return a cleanup
  function. `dist/promise/plugin.d.ts`.
- `ctx.tool.transform(callback)` resolves to a `Registration` with `dispose()`. The draft
  has `list()`, `get(id)`, `add(tool)`, `update(id, fn)`, and `remove(id)`.
- The host replays every transform on reload, so the callback must be idempotent.
- `ctx.skill.transform(callback)` works the same way. The draft has `list()`, `add(skill)`,
  `update(id, fn)`, and `remove(id)`, and `add` is a keyed set, so a replay is idempotent.
- A skill is `{ id, name, description?, slash?, autoinvoke?, location, content }`
  (`@opencode-ai/schema/dist/skill.d.ts`). `id`, `name`, and `location` are branded strings, and
  `@opencode-ai/schema` is a transitive dependency, so `src/index.ts` casts the entry once.
- `location` is a synthetic absolute path. The host scans the sibling directory of a skill only
  when the basename is `SKILL.md`, so `/builtin/oc-dynamic-workflows/workflow.md` loads the
  inline `content` and nothing else.
- The model sees only `id`, `name`, and `description` in the skill listing, once per session, so
  the description names the trigger situations and stays under 200 characters. The `skill`
  tool fetches the body on the turn the model loads it.
- The `workflow` skill sets no `slash` flag: a command of the same name shadows a `slash` skill
  in the palette, and `/workflow` is already a command.
- A command carries `{ name, description }` only. There is no argument hint, so the description
  states the argument shape.
- A tool is `{ name, description, input, execute, output?, options? }`. The identifier field
  is `name`, not `id`. Once `output` is declared, every result must carry `output`.
- A tool executor has no abort signal, and a rejected promise becomes a fiber defect rather
  than a tool error. Every executor here catches and returns `{ content: "error: ..." }`.
- A tool call runs inside one step of the lead's turn, and the inbox is promoted only
  between steps. The lead cannot read anything until the call returns, so a run is
  detached and the lead is told through `ctx.session.synthetic`.
- `draft.get("subagent")` is the built-in subagent tool. Its `execute(input, context)` can
  be called from plugin code at any later time. This is unsupported internals: it skips the
  input decode, the `tool.execute.*` hooks, and the `Tool.Error` coercion.
  - Input: `{ agent, description, prompt, sessionID?, background? }`. `agent` must be a
    subagent-mode agent. `description` becomes the child session title. With `sessionID` set to
    an existing direct child of the caller the executor prompts that session instead of creating
    one, and blocks until its turn ends exactly as it does for a fresh child; no
    `session.created` is published for that call.
  - The forged context is `{ sessionID, agent, messageID, id, progress }`. `sessionID` must
    be the real lead session and `agent` the lead's real agent, because the executor asks
    for permission with them. `messageID` should be the lead's latest assistant message id
    (`ctx.session.context`), or a permission ask can throw in the TUI.
  - With `background: false` the promise resolves with
    `{ output: { sessionID, status, output }, content, metadata }`, where `output.output` is
    the child's last assistant text.
  - The child is created with `parentID = context.sessionID` and `model = agent.model ??
    parent.model`. The depth limit of 1 stops a child from spawning further children.
  - `ctx.session.interrupt({ sessionID: child, continue: false })` makes the promise reject
    with `Tool.Error: Subagent cancelled (sessionID: ...)`. Dropping the promise without
    interrupting leaks the child, so every path settles it.
  - `continue: true` rejects that promise the same way, although the child lives on and
    takes its steered items (verified live: the member's `shell` call ended
    `aborted: Tool execution interrupted`, then it answered the steer). A forced steer
    therefore tells the runner first, and the runner watches the member through
    `Session.Info.outcome` instead of calling the task failed.
- `session.created` carries `parentID` and `title`, which is how a spawn learns its child.
- `session.status` and `session.idle` are not published on v2. Lifecycle comes from
  `session.execution.{started,succeeded,failed,interrupted}` and `Session.Info.outcome`.
- `ctx.session.get({ sessionID })` returns `cost` (a number) and
  `tokens: { input, output, reasoning, cache }`. The token budget sums input, output, and
  reasoning.
- `ctx.session.synthetic({ sessionID, delivery: "steer", description, text })` starts a turn
  when the session is idle and lands at the next step boundary when it is busy. With
  `resume: false` the item is admitted without a wake, so it is read on the session's next
  turn.
- `ctx.session.prompt({ sessionID, text, delivery: "steer" })` admits a user item and never
  interrupts the step the session is in. It resolves with the inbox item, whose `id` is the
  `inboxID` of the later `session.inbox.delivered` event
  (`data: { inboxID, sessionID }`). `ctx.session.interrupt({ sessionID, continue: true })`
  ends the current step and then resumes the steer-delivery items.
- `ctx.session.move({ sessionID, directory, delivery? })` resolves the directory, boots the
  destination location instance, and admits an inbox control item. The move is applied at the
  session's next step boundary, so an idle session takes it with no model request and a busy one
  takes it only after the step it is in. Booting that instance starts the global MCP servers
  again and took about 2.5 seconds live, far longer than a first step, which is why a worktree
  member is warmed up with one cheap turn, moved while it is idle, and only then prompted with
  its real task. `session.moved` (`data: { sessionID, location }`) is published to both the old
  and the new location, and there is one plugin instance per location, all in one process, so
  both see it.
- `ctx.location.directory` is the project directory. `ctx.location.project.id` prefixes every
  storage key, because `ctx.storage` is one key-value store for every project. Outside a
  project that id is `"global"`, so the plugin then uses a 12-character SHA-1 of the
  directory instead (`dir_<hex>`). `workflow_doctor` reports the prefix in use.
- `ctx.command.transform(callback)` resolves to a `Registration` with `dispose()`. The draft
  has `add({ name, description?, execute })` only. `execute` receives
  `{ sessionID, prompt: { text, files?, agents?, skills? }, delivery }` and resolves to
  `void`: a command cannot answer with text, so it acts through `ctx.session.prompt`. The
  command name carries no leading slash. `prompt.text` is the argument text.
  `POST /api/session/{sessionID}/command` with `{ command, text, delivery }` runs one;
  `opencode2 run` does **not** route a slash prefix and sends the text as it is.
- `ctx.session.hook("context", callback)` fires before every model request, including a
  retry. The event has a mutable `tools: Record<string, { description, input }>`, a
  mutable `system: SystemPart[]`, and `messages`. A `SystemPart` is an object,
  `{ type: "text", text }`, not a string. Deleting a key from `event.tools` is enforced:
  core rejects a call to a tool that was not in the request (`core/src/tool.ts:252`).
- `ctx.generate.text({ prompt, model? })` resolves to `{ text }`. With no `model` it uses
  the catalog default. It can answer with an empty string, so an empty synthesis is
  recorded as a failure instead of being passed on.
- `ctx.agent.list()` resolves to `{ location, data: Agent.Info[] }`, not to a plain array.
  An `Agent.Info` carries `id`, `name`, and `mode` (`subagent`, `primary`, or `all`).
- `ctx.session.context({ sessionID })` returns the message history. A message uses `type`,
  not `role`, and an assistant message keeps its text in `content: [{ type: "text", text }]`.
- `Session.Info.outcome` is `succeeded`, `failed`, or `interrupted`, and is only set once
  the session ended. It is how a backgrounded member is watched.
- `ctx.event.subscribe({ signal })` is an async iterable over the in-process bus. The stream
  can end, so the consumer resubscribes with a backoff.
- Backpressure (spike S8): the bus publishes to `PubSub.unbounded` and the plugin adapter
  hands out a pull iterator (`Stream.toAsyncIterableWith`, `adapter.js:15-40`;
  `core/src/bus.ts:194,762`). A slow consumer therefore **buffers**: nothing is dropped,
  the stream does not end, and the publisher never blocks. The cost of a stalled consumer
  is memory, so the consumer keeps its per-event work short.
- The plugin runs inside the opencode process, so `Bun.spawn` works. It bypasses the
  permission rules, the classifier, and the shell hooks.

## Key Design Decisions

- No tool executor ever throws.
- The config never throws. A typo cannot stop the plugin from loading.
- A spec is normalized once, at the edge. Every other module reads the normalized shape.
- A run is detached. `workflow_run` returns a run id, and the lead reads the final report
  from a synthetic message.
- A retry is a new attempt, which means a new child session. A task that runs out of time
  is interrupted and never sent again inside the same attempt.
- A permission the user rejected stops its task for good: core interrupts the member, so
  the task is named `permission rejected by the user: <action> <resource>` instead of
  cancelled, and it is not tried again, because a new attempt would only ask the same
  question once more. In a `team` phase the member also mails the lead one question, which
  goes through the normal gate, cap, and wake policy, so nothing is sent outside one.
- A resume takes `guidance`, a task id to a text, which is kept on the task record and put
  at the end of that task's prompt in the `<untrusted>` envelope. It is how a rejected
  permission is answered: the report and the status name the task to guide. An id the run
  does not have is reported back rather than dropped.
- Every transition writes the run record. Memory is a cache, not the record of truth.
- A `parallel` phase is a worker pool over one shared cursor. A failed task does not stop
  the other workers; the phase is `completed`, `partial`, or `failed`.
- A `team` phase is that same pool with the mailbox open for its tasks. The phase joins
  when every task is terminal, and the mailbox closes with it, so a late send is refused.
- A `question` wakes the lead, a `status` and a `result` do not. A burst of questions is
  collected for two seconds and becomes one wake, and the join adds one wake with the
  digest of the unread mail. Every mail travels in an escaped `<workflow-mail>` envelope
  with a body of at most 2000 characters, and a digest is capped at 16 KB.
- A steer to a task that has not started yet is kept and shown to the member by the context
  hook, because the hook may not write. It is marked delivered by
  `session.inbox.delivered`, or when the steer prompt is admitted.
- A `sequential` phase passes the earlier task outputs on. A `parallel` phase does not,
  because the order of the results is not fixed. Across phases only the synthesis travels.
- Every output of a member or a shell command is wrapped in `<untrusted>` before it is put
  in another prompt, and its markup is escaped.
- The context hook never writes state and never throws, because it fires on every request.
- One clock per task (`defaultTaskTimeoutMs`) and one for the whole run (`maxRunMinutes`).
  A run that passes its limit drops the remaining work and ends as `partial`.
- A budget is never required. The cap is read before a task starts, after one settles, and
  after a mailbox wake was charged. Past it no new task starts, the members that are still
  going are interrupted, what is left is skipped, and the run ends `partial` with the cap
  named in `run.error`.
- A resume keeps the run id, the spend, and every completed task, and it re-homes the lead
  to the caller. The prompt of a task that runs again is rebuilt from the record, never
  re-read from a member session. A phase that completed with its synthesis is skipped whole;
  any other phase is run again and synthesised again.
- A resume is refused while the run is `running`, when it is `completed`, and when the
  budget is already spent and no override raises the cap. Each refusal names the next step.
- A restart leaves no run loop behind, so `recoverOrphans` marks such a run `orphaned`,
  marks its `running` tasks `cancelled`, and interrupts every member that has no outcome
  yet, because core resumes a suspended child on its own. The lead is not woken.
- `task.model` is rejected in v1 with a message that names the fix.
- D14, one engine per project. `src/engine.ts` holds it, keyed by the storage prefix and
  refcounted. A worktree is another location, so opencode boots a second plugin instance for
  it, and that instance serves the member's hooks, tool calls, and events. It has to see the
  same roster, mailbox, and run records, so every instance attaches to the engine the first
  one built and registers only its own tools, commands, skill, hook, and event consumer. The
  first attach runs `recoverOrphans`; the last detach disposes. The engine's home directory
  is the `ctx.location.directory` of the instance that built it.
- A run's home is the directory of the session that started it, kept on the record as
  `run.directory`. The shell cwd, the worktree base, the patches, and the JSON mirror all read
  it, so a run started from the main checkout never writes into a worktree, whichever instance
  happened to build the shared engine first. A resume keeps it. A record from before the field
  falls back to the directory of the instance that reads it.
- D15, a worktree task saves its edits. When an attempt settles, whatever the outcome,
  everything is staged, `git diff --cached HEAD` becomes
  `<home>/.opencode/workflows/runs/<runId>/<taskId>.patch`, and the stat goes on the task. The
  worktree is then removed unless `keep`. An agent task goes through three steps, because a
  child inherits the lead's directory and a move only lands at a step boundary: it is spawned
  with the warm-up prompt, moved while the session is idle, and then prompted with its real
  task through the same executor with `sessionID` set. Nothing is interrupted on that path; a
  warm-up or a move that does not come back fails the attempt, and a retry gets a new session
  and a fresh worktree.
- A task with an `outputSchema` has to answer with JSON. A miss is a failed attempt, so a
  retry can fix it.
- Saved workflow names are restricted to `[A-Za-z0-9._-]` and may not contain `..`, so a
  name cannot escape `.opencode/workflows/`.
- `$schema` is accepted at the edge and dropped by the normalizer, so a saved spec can point
  an editor at the schema and no spec ever carries the key onwards. The asset under `assets/`
  is generated, never hand-edited, and `test/schema.test.ts` fails when it drifts.
- `@opencode-ai/plugin` and `zod` are pinned to exact versions and declared as runtime
  dependencies.

## Smoke test in a live opencode

The plugin has to run inside `opencode2`. A private server keeps a detached run alive after
the lead's turn ends, which `--standalone` does not.

```bash
# 1. Start a private server in the project you want to test.
env -C /tmp/wfdemo PWD=/tmp/wfdemo nohup \
  opencode2 serve --port 4599 --print-logs --log-level info > /tmp/serve.log 2>&1 &

# 2. Drive it. PWD has to be set: the CLI reads it, not the working directory.
env -C /tmp/wfdemo PWD=/tmp/wfdemo opencode2 run --server http://127.0.0.1:4599 \
  --auto --format json --print-logs --log-level info --title smoke \
  'Call workflow_run_saved with name "chain". Then reply with the runId and nothing else.'

# 3. Read the run record while it goes, and the lead transcript after.
cat /tmp/wfdemo/.opencode/workflows/runs/<runId>.json
opencode2 export <leadSessionID> --server http://127.0.0.1:4599
```

Notes that cost time to learn:
- `--print-logs` to a file. Without it a run can end with no output at all.
- macOS has no `timeout`. Background the run and use a `sleep`-and-`kill` watchdog.
- Wait about 3 seconds between runs.
- Do not open the TUI for a smoke test.

## Git

Commit messages use plain Conventional Commits. Commit only when asked.
