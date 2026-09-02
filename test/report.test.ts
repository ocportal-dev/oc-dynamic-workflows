import { expect, it } from "bun:test"
import { renderFinalReport, renderSpecTree, renderStatus } from "../src/report.js"
import type { RunRecord, TaskRecord } from "../src/types.js"

function record(task: Partial<TaskRecord>): RunRecord {
  return {
    runId: "wf_1",
    specVersion: 1,
    projectID: "proj1",
    status: "completed",
    concurrency: 1,
    leadSessionID: "ses_lead",
    leadAgent: "build",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    budget: { spentUsd: 0, spentTokens: 0 },
    mailbox: { maxMessages: 0, used: 0 },
    spec: {
      specVersion: 1,
      name: "demo",
      goal: "edit a file",
      phases: [
        {
          id: "p",
          strategy: "parallel",
          tasks: [{ id: "a", kind: "agent", prompt: "edit", retries: 0, isolation: "worktree", keep: false }],
        },
      ],
    },
    phases: [
      {
        id: "p",
        strategy: "parallel",
        status: "completed",
        tasks: [
          {
            taskId: "a",
            kind: "agent",
            status: "completed",
            attempts: 1,
            usage: { usd: 0, tokens: 0 },
            ...task,
          },
        ],
      },
    ],
  }
}

it("names the patch of a settled worktree after the task output", () => {
  const run = record({
    output: "edited it",
    worktree: { path: "/home/.opencode/workflows/worktrees/wf_1/a", kept: false, patch: "/home/p/a.patch", stat: "1 file changed, 1 insertion(+)" },
  })
  const report = renderFinalReport(run)
  expect(report).toContain("Output of a (completed):")
  expect(report).toContain("Worktree of a: 1 file changed, 1 insertion(+); patch /home/p/a.patch")
})

it("names a kept worktree by its path", () => {
  const run = record({
    worktree: { path: "/home/wt/a", kept: true, patch: "/home/p/a.patch", stat: "2 files changed" },
  })
  const report = renderFinalReport(run)
  expect(report).toContain("Worktree of a: 2 files changed; kept at /home/wt/a")
})

it("says a worktree with an empty diff changed nothing", () => {
  const report = renderFinalReport(record({ worktree: { path: "/home/wt/a", kept: false, stat: "" } }))
  expect(report).toContain("Worktree of a: no changes")
  expect(report).not.toContain("; patch")
})

it("shows the isolation of a task in the spec tree and its worktree in the status", () => {
  const run = record({ worktree: { path: "/home/wt/a", kept: false, stat: "" } })
  run.spec.phases[0]!.tasks[0]!.keep = true
  expect(renderSpecTree(run.spec)).toContain("  - a (agent, retries=0, worktree, keep)")
  expect(renderStatus(run)).toContain("worktree /home/wt/a")
})

/** A run of a repeat phase where the gate refused both rounds. */
function gated(): RunRecord {
  const run = record({ output: "implemented" })
  run.spec.phases[0] = {
    id: "p",
    strategy: "sequential",
    repeat: { gate: "review", maxRounds: 2 },
    tasks: [
      { id: "a", kind: "agent", prompt: "build", retries: 0, keep: false },
      { id: "review", kind: "agent", prompt: "review", retries: 0, keep: false },
    ],
  }
  const phase = run.phases[0]!
  phase.strategy = "sequential"
  phase.round = 2
  phase.rounds = [
    { round: 1, approved: false, findings: ["the flag is not read anywhere"], tasks: [] },
    { round: 2, approved: false, findings: ["still not read", "and it has no test"], tasks: [] },
  ]
  return run
}

it("shows the round of a repeat phase and one line per finished round", () => {
  const status = renderStatus(gated())
  expect(status).toContain("p [completed] round 2/2")
  expect(status).toContain("  round 1: not approved (1 findings)")
  expect(status).toContain("  round 2: not approved (2 findings)")
})

it("names a round the gate approved and one the gate never judged", () => {
  const run = gated()
  run.phases[0]!.rounds = [
    { round: 1, approved: undefined, findings: [], tasks: [] },
    { round: 2, approved: true, findings: [], tasks: [] },
  ]
  const status = renderStatus(run)
  expect(status).toContain("  round 1: gate did not complete")
  expect(status).toContain("  round 2: approved")
})

it("sums the gate up in the final report and wraps the last findings", () => {
  const report = renderFinalReport(gated())
  expect(report).toContain("Gate review of phase p: not approved (2 findings) after 2 of 2 rounds.")
  expect(report).toContain('<untrusted source="gate" id="review">')
  expect(report).toContain("still not read\nand it has no test")
})

it("shows the repeat gate of a phase in the spec tree", () => {
  expect(renderSpecTree(gated().spec)).toContain("p [sequential] repeat gate=review maxRounds=2")
})
