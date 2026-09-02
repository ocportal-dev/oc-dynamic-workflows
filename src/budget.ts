import type { RunRecord } from "./types.js"

export interface BudgetStop {
  cap: "usd" | "tokens"
  /** The sentence that goes into `run.error` and into the final report. */
  message: string
}

/**
 * Whether a run has spent what it was given.
 *
 * A budget is never required: a run with no cap can never stop this way. The caps
 * live on the record, so an override raises them for the resumed run as well.
 */
export function budgetExceeded(run: RunRecord): BudgetStop | undefined {
  const { maxUsd, maxTokens, spentUsd, spentTokens } = run.budget
  if (maxUsd !== undefined && spentUsd >= maxUsd) {
    return { cap: "usd", message: `budget exceeded: $${spentUsd.toFixed(4)} of $${maxUsd}` }
  }
  if (maxTokens !== undefined && spentTokens >= maxTokens) {
    return { cap: "tokens", message: `budget exceeded: ${spentTokens} of ${maxTokens} tokens` }
  }
  return undefined
}

/** The name of the override that raises the cap a run hit. */
export function overrideFor(stop: BudgetStop): string {
  return stop.cap === "usd" ? "overrides.maxCostUsd" : "overrides.maxTokens"
}
