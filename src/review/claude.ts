import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { TOOL_DEFINITIONS, type ToolResult } from "./tools.js";

export const ReviewOutputSchema = z.object({
  overview: z.string(),
  verdict: z.enum(["mergeable", "needs_changes", "needs_discussion"]),
  verdict_reason: z.string(),
  summary: z.string(),
  testing: z.string(),
  design: z.string(),
  comments: z.array(
    z.object({
      path: z.string(),
      line: z.number().int(),
      side: z.enum(["RIGHT", "LEFT"]),
      severity: z.enum(["critical", "major", "minor", "nit"]),
      category: z.enum(["bug", "security", "performance", "test", "design", "style"]),
      body: z.string(),
    }),
  ),
  previous_findings: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["resolved", "partially_resolved", "unresolved"]),
      note: z.string(),
    }),
  ),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
export type ReviewComment = ReviewOutput["comments"][number];

export interface ReviewStats {
  turns: number;
  toolCalls: number;
}

export type ClaudeReviewResult =
  | { kind: "ok"; output: ReviewOutput; model: string; stats: ReviewStats }
  | { kind: "refused"; category: string | null };

export interface ClaudeReviewOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  /** Number of tool-calling turns before the model is asked to answer without tools. */
  maxTurns: number;
  system: string;
  user: string;
}

const OUTPUT_FORMAT = betaZodOutputFormat(ReviewOutputSchema);

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type FinalMessage = Anthropic.Beta.BetaMessage & { parsed_output?: ReviewOutput | null };

export interface AgentDeps {
  /** Sends one request and resolves with the final message of the stream. */
  send: (params: StreamParams) => Promise<FinalMessage>;
  executeTool: (name: string, input: unknown) => Promise<ToolResult>;
}

/** Creates the real `send` function backed by the Anthropic client. */
export function createSender(client: Anthropic): AgentDeps["send"] {
  return (params) => client.beta.messages.stream(params).finalMessage() as Promise<FinalMessage>;
}

export const BUDGET_NOTICE =
  "The tool budget for this review is used up. Do not call any more tools. " +
  "Write the final review now from what you have already read.";

/**
 * Runs the review as a tool-using loop: Claude explores the checked-out repository with
 * read-only tools, then answers with the structured review.
 * The system prompt and tool list stay fixed and messages are only appended, so the
 * prompt cache and earlier thinking blocks stay valid across turns.
 */
export async function runReviewAgent(
  deps: AgentDeps,
  options: ClaudeReviewOptions,
): Promise<ClaudeReviewResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: options.user }];
  let turns = 0;
  let toolCalls = 0;
  let parseRetries = 0;

  while (true) {
    const budgetSpent = turns >= options.maxTurns;
    let message: FinalMessage;
    try {
      message = await deps.send({
        model: options.model,
        max_tokens: options.maxTokens,
        // 安全分類器による拒否をサーバー側で別モデルへフォールバックさせる
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: options.effort, format: OUTPUT_FORMAT },
        // 毎ターン履歴全体を送り直すので、自動キャッシュで再送分を安くする
        cache_control: { type: "ephemeral" },
        system: options.system,
        tools: TOOL_DEFINITIONS,
        tool_choice: budgetSpent ? { type: "none" } : { type: "auto" },
        messages,
      });
      parseRetries = 0;
    } catch (error) {
      // ツール入力のJSONが壊れていた場合だけ同じターンを再送する。APIエラーはそのまま投げる
      if (error instanceof Anthropic.APIError || parseRetries++ >= 2) throw error;
      continue;
    }

    if (message.stop_reason === "refusal") {
      return { kind: "refused", category: message.stop_details?.category ?? null };
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error(
        `Claude response was truncated at max_tokens=${options.maxTokens}; raise CLAUDE_MAX_TOKENS`,
      );
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) {
      if (!message.parsed_output) {
        throw new Error(
          `Claude response did not match the review schema (stop_reason=${message.stop_reason})`,
        );
      }
      return {
        kind: "ok",
        output: message.parsed_output,
        model: message.model,
        stats: { turns, toolCalls },
      };
    }

    messages.push({ role: "assistant", content: message.content });
    const results = await Promise.all(
      toolUses.map(async (t): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const r = await deps.executeTool(t.name, t.input);
        return { type: "tool_result", tool_use_id: t.id, content: r.content, is_error: r.isError };
      }),
    );
    turns++;
    toolCalls += toolUses.length;

    const content: Anthropic.Beta.BetaContentBlockParam[] = [...results];
    if (turns >= options.maxTurns) content.push({ type: "text", text: BUDGET_NOTICE });
    messages.push({ role: "user", content });
  }
}
