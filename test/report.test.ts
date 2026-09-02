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
