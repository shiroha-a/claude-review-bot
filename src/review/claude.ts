import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const ReviewOutputSchema = z.object({
  summary: z.string(),
  comments: z.array(
    z.object({
      path: z.string(),
      line: z.number().int(),
      side: z.enum(["RIGHT", "LEFT"]),
      severity: z.enum(["critical", "major", "minor", "nit"]),
      body: z.string(),
    }),
  ),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
export type ReviewComment = ReviewOutput["comments"][number];

export type ClaudeReviewResult =
  | { kind: "ok"; output: ReviewOutput; model: string }
  | { kind: "refused"; category: string | null };

export interface ClaudeReviewOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  system: string;
  user: string;
}

/**
 * Asks Claude for a structured review.
 * Throws when the response is truncated or does not match the schema, since a partial
 * review posted to a pull request would be misleading.
 */
export async function requestReview(
  client: Anthropic,
  options: ClaudeReviewOptions,
): Promise<ClaudeReviewResult> {
  // diffが大きいと応答に時間がかかるため、HTTPタイムアウトを避けてストリーミングで受ける
  const stream = client.beta.messages.stream({
    model: options.model,
    max_tokens: options.maxTokens,
    // 安全分類器による拒否をサーバー側で別モデルへフォールバックさせる
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: options.effort,
      format: betaZodOutputFormat(ReviewOutputSchema),
    },
    system: options.system,
    messages: [{ role: "user", content: options.user }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    return { kind: "refused", category: message.stop_details?.category ?? null };
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error(
      `Claude response was truncated at max_tokens=${options.maxTokens}; raise CLAUDE_MAX_TOKENS`,
    );
  }
  if (!message.parsed_output) {
    throw new Error(
      `Claude response did not match the review schema (stop_reason=${message.stop_reason})`,
    );
  }
  return { kind: "ok", output: message.parsed_output, model: message.model };
}
