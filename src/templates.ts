import type { RoleName, WorkflowConfig } from "./config.js"
import { roleAgentId } from "./roles.js"
import { GATE_SCHEMA } from "./spec.js"

/** The workflows the plugin ships. A saved file of the same name shadows one. */
export const TEMPLATE_NAMES = ["build-review", "secure-build", "plan-research"] as const
export type TemplateName = (typeof TEMPLATE_NAMES)[number]

export function isTemplate(name: string): name is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(name)
}

/** What a `researcher` task answers with, the shape the role's own prompt names. */
const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "source"],
        properties: { claim: { type: "string" }, source: { type: "string" }, url: { type: "string" } },
      },
    },
    open: { type: "array", items: { type: "string" } },
  },
}

const IMPLEMENT = [
  "Do what the goal above asks for, in this worktree.",
  "Make the change, then run whatever proves it works.",
  "Reply with the files you changed, the commands you ran, and what they printed.",
].join(" ")

const REVIEW = [
  "Review the edits of task impl against the goal above.",
  "Read the patch it left, then read the files that patch touches.",
  "Reply with one JSON object.",
].join(" ")

/**
 * The built-in workflows.
 *
 * A template carries no placeholder: the goal is a field of the spec, and `buildPrompt`
 * puts it at the top of every member prompt, so a task prompt can point back at it.
 */
export function template(name: TemplateName, config: WorkflowConfig, goal: string): Record<string, unknown> {
  const agent = (role: RoleName): string => roleAgentId(config, role)
  if (name === "build-review") {
    return {
      specVersion: 1,
      name,
      goal,
      phases: [
        {
          id: "build",
          strategy: "sequential",
          repeat: { gate: "review", maxRounds: 3 },
          tasks: [
            { id: "impl", prompt: IMPLEMENT, isolation: "worktree", retries: 1 },
            { id: "review", agent: agent("reviewer"), prompt: REVIEW, retries: 1, outputSchema: GATE_SCHEMA },
          ],
        },
      ],
    }
  }
  if (name === "secure-build") {
    return {
      specVersion: 1,
      name,
      goal,
      phases: [
        {
          id: "build",
          strategy: "sequential",
          repeat: { gate: "security", maxRounds: 3 },
          tasks: [
            { id: "impl", prompt: IMPLEMENT, isolation: "worktree", retries: 1 },
            { id: "review", agent: agent("reviewer"), prompt: REVIEW, retries: 1, outputSchema: GATE_SCHEMA },
            {
              id: "security",
              agent: agent("security-reviewer"),
              prompt: [
                "Review the same edits for security defects.",
                "The verdict of task review is above: a finding of it that the code still has is a finding of yours.",
                "Reply with one JSON object.",
              ].join(" "),
              retries: 1,
              outputSchema: GATE_SCHEMA,
            },
          ],
        },
      ],
    }
  }
  return {
    specVersion: 1,
    name,
    goal,
    phases: [
      {
        id: "research",
        strategy: "parallel",
        synthesisPrompt: [
          "Merge the three reports into one briefing for the goal.",
          "Keep every claim with its source, and end with what is still open.",
        ].join(" "),
        tasks: [
          {
            id: "codebase",
            agent: agent("researcher"),
            prompt: "Find what in this repository the goal touches: the files, the modules, and the tests that cover them.",
            retries: 1,
            outputSchema: FINDINGS_SCHEMA,
          },
          {
            id: "docs",
            agent: agent("researcher"),
            prompt: "Find the documentation, the specifications, and the external references the goal depends on.",
            retries: 1,
            outputSchema: FINDINGS_SCHEMA,
          },
          {
            id: "risks",
            agent: agent("researcher"),
            prompt: "Find what could make the goal fail: the constraints, the dependencies, and the parts nobody owns.",
            retries: 1,
            outputSchema: FINDINGS_SCHEMA,
          },
        ],
      },
      {
        id: "plan",
        strategy: "sequential",
        repeat: { gate: "check", maxRounds: 2 },
        tasks: [
          {
            id: "draft",
            agent: agent("researcher"),
            prompt: [
              "Using the briefing above, write the plan for the goal: the steps in order, the files each step",
              "touches, and the check that proves each step.",
              "This task is the exception to your answer shape: reply with the plan itself as Markdown, not with JSON.",
            ].join(" "),
            retries: 1,
          },
          {
            id: "check",
            agent: agent("stakeholder"),
            prompt: [
              "Check the plan of task draft against the goal above.",
              "Does it deliver what was asked, and does it add work nobody asked for?",
              "Reply with one JSON object.",
            ].join(" "),
            retries: 1,
            outputSchema: GATE_SCHEMA,
          },
        ],
      },
    ],
  }
}
