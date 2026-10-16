import type { PullRequestGateway, PullRef } from "../github/pr.js";
import type { ClaudeReviewOptions, ClaudeReviewResult } from "./claude.js";
import { parsePatch, type ParsedPatch } from "./diff.js";
import { filterFiles } from "./filter.js";
import { buildReviewPayload } from "./format.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";

export interface ReviewerDeps {
  gateway: PullRequestGateway;
  requestReview: (options: ClaudeReviewOptions) => Promise<ClaudeReviewResult>;
  botLogin: string;
  config: {
    model: string;
    effort: ClaudeReviewOptions["effort"];
    maxTokens: number;
    language: string;
    maxDiffChars: number;
    excludeGlobs: string[];
  };
}

export type ReviewOutcome =
  | "posted"
  | "skipped-closed"
  | "skipped-draft"
  | "skipped-already-reviewed"
  | "skipped-no-files"
  | "refused";

export interface ReviewOptions {
  /** Skip draft pull requests. */
  skipDraft: boolean;
  /** Skip when the bot has already reviewed the current head commit. */
  skipIfReviewed: boolean;
}

/** Reviews one pull request end to end and posts the result as a COMMENT review. */
export async function reviewPullRequest(
  deps: ReviewerDeps,
  ref: PullRef,
  options: ReviewOptions,
): Promise<ReviewOutcome> {
  const { gateway, config } = deps;
  const pull = await gateway.getPull(ref);

  if (pull.state !== "open") return "skipped-closed";
  if (options.skipDraft && pull.draft) return "skipped-draft";
  if (
    options.skipIfReviewed &&
    (await gateway.hasReviewForCommit(ref, pull.headSha, deps.botLogin))
  ) {
    return "skipped-already-reviewed";
  }

  const files = await gateway.listFiles(ref);
  const { included, skipped } = filterFiles(files, {
    excludeGlobs: config.excludeGlobs,
    maxChars: config.maxDiffChars,
  });
  if (included.length === 0) return "skipped-no-files";

  const patches = new Map<string, ParsedPatch>(
    included.map((f) => [f.filename, parsePatch(f.patch)]),
  );
  const result = await deps.requestReview({
    model: config.model,
    effort: config.effort,
    maxTokens: config.maxTokens,
    system: buildSystemPrompt(config.language),
    user: buildUserPrompt({
      repo: `${ref.owner}/${ref.repo}`,
      title: pull.title,
      body: pull.body,
      files: included.map((f) => ({
        filename: f.filename,
        status: f.status,
        parsed: patches.get(f.filename)!,
      })),
    }),
  });

  if (result.kind === "refused") {
    await gateway.createReview(ref, pull.headSha, {
      body: `## Claude Review\n\nこのPRはモデルの安全判定によりレビューできませんでした(category: ${result.category ?? "unknown"})。`,
      comments: [],
    });
    return "refused";
  }

  const payload = buildReviewPayload(result.output, patches, skipped, result.model);
  await gateway.createReview(ref, pull.headSha, payload);
  return "posted";
}
