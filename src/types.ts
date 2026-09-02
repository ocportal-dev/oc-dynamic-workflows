/** A task after normalization: aliases resolved and defaults applied. */
export interface TaskSpec {
  id: string
  description?: string
  kind: "agent" | "shell"
  /** Required when `kind` is `"agent"`. */
  prompt?: string
  /** Required when `kind` is `"shell"`. */
  command?: string
  agent?: string
  /** `"worktree"` runs the task in its own git worktree of HEAD. */
  isolation?: "worktree"
  /** Worktree tasks only: leave the worktree in place after the task settled. */
  keep: boolean
  retries: number
  timeoutMs?: number
  /** JSON Schema. Validated after the task returns. */
  outputSchema?: Record<string, unknown>
}

export interface MailboxSpec {
  peers: false
  maxMessages: number
}

export interface PhaseSpec {
  id: string
  title?: string
  strategy: "sequential" | "parallel" | "team"
  tasks: TaskSpec[]
  synthesisPrompt?: string
  /** Only allowed when `strategy` is `"team"`. */
  mailbox?: MailboxSpec
}

export interface BudgetSpec {
  usd?: number
  tokens?: number
}

/** A workflow after normalization. This is what every other module consumes. */
export interface WorkflowSpec {
  specVersion: 1
  name: string
  goal: string
  budget?: BudgetSpec
  phases: PhaseSpec[]
}

export interface TaskRecord {
  taskId: string
  kind: "agent" | "shell"
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled" | "timeout"
  /** The child session id, learned from `session.created` or from the executor result. */
  sessionID?: string
  attempts: number
  /** Clipped: 4000 characters in-phase, 1000 across phases. */
  output?: string
  /** The task output after `outputSchema` validation. */
  data?: Record<string, unknown>
  error?: string
  /** The permission ask that is open. The status line shows what the member waits for. */
  asked?: { requestID: string; action: string; resource: string }
  /** The permission ask the user refused. A task that has one is not tried again. */
  rejected?: { requestID: string; action?: string; resource?: string; at: string }
  /** What the lead told this task on a resume. Kept, so a later resume reuses it. */
  guidance?: string
  /**
   * The git worktree of an `isolation: "worktree"` task.
   *
   * Written when the worktree is created, so a restart can still find it, and written
   * again when the attempt settles, with the patch of the member's edits and its stat.
   */
  worktree?: { path: string; kept: boolean; patch?: string; stat: string }
  /** The sum of every attempt. Derived from `attemptsUsage`, so a retry adds to it. */
  usage: { usd: number; tokens: number }
  /** What each attempt spent, keyed by its child session id. A retry is a new key. */
  attemptsUsage?: Record<string, { usd: number; tokens: number }>
  startedAt?: string
  endedAt?: string
}

export interface PhaseRecord {
  id: string
  strategy: "sequential" | "parallel" | "team"
  status: "pending" | "running" | "completed" | "partial" | "failed" | "skipped"
  /** Why the phase stopped. Set when the phase status is `"failed"`. */
  error?: string
  tasks: TaskRecord[]
  synthesis?: { status: "pending" | "running" | "completed" | "failed"; output?: string; error?: string }
}

export interface RunRecord {
  /** `wf_<ulid>`. */
  runId: string
  specVersion: 1
  /** `ctx.location.project.id`. Prefixes every storage key. */
  projectID: string
  spec: WorkflowSpec
  status: "running" | "completed" | "partial" | "failed" | "cancelled" | "orphaned"
  /** Why the run stopped early. Set when a clock or a strategy ended it. */
  error?: string
  /** Tasks of one parallel phase that run at the same time. Resolved once, at the start. */
  concurrency: number
  /** The calling session. Also the wake target. */
  leadSessionID: string
  /** The agent forged into the spawn context. */
  leadAgent: string
  /**
   * The home of this run: the directory of the session that started it.
   *
   * Shell tasks, the worktrees, the patches, and the JSON mirror go there. Absent on a
   * record written before the field existed; the runner then falls back to its own.
   */
  directory?: string
  createdAt: string
  updatedAt: string
  /** How often `workflow_resume` restarted this run. */
  resumes?: number
  budget: { maxUsd?: number; maxTokens?: number; spentUsd: number; spentTokens: number }
  phases: PhaseRecord[]
  /** The message cap of the team phase that is open, and what it has used. */
  mailbox: { maxMessages: number; used: number }
  /** What the lead spent on the wakes of this run. Counted into the budget. */
  mailUsage?: { usd: number; tokens: number }
  /** The same spend, per team phase, so a second phase cannot drop the first one's. */
  mailUsageByPhase?: Record<string, { usd: number; tokens: number }>
}

export interface MailEvent {
  id: string
  runId: string
  taskId: string
  direction: "member_to_lead" | "lead_to_member"
  type: "status" | "question" | "result" | "steer"
  /** Capped at 2000 characters. */
  body: string
  ref?: string
  /** Steer only: interrupt the member before the steer lands. */
  force?: boolean
  createdAt: string
  deliveredAt?: string
  readAt?: string
}
