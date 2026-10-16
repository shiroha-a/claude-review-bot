import type { PullRequestGateway, PullRef } from "../github/pr.js";
import type { ClaudeReviewOptions, ClaudeReviewResult } from "./claude.js";
import type { ToolResult } from "./tools.js";
import type { Workspace } from "./workspace.js";
import { parsePatch, type ParsedPatch } from "./diff.js";
import { filterFiles } from "./filter.js";
import { buildReviewPayload } from "./format.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { executeTool as executeToolIn } from "./tools.js";

export interface ReviewerDeps {
  gateway: PullRequestGateway;
  /** Checks out the pull request head so the model can explore it. */
  openWorkspace: (ref: PullRef, sha: string) => Promise<Workspace>;
  /** Runs the review agent; `executeTool` is bound to the opened workspace. */
  runAgent: (
    options: ClaudeReviewOptions,
    executeTool: (name: string, input: unknown) => Promise<ToolResult>,
  ) => Promise<ClaudeReviewResult>;
  botLogin: string;
  config: {
    model: string;
    effort: ClaudeReviewOptions["effort"];
    maxTokens: number;
    maxTurns: number;
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
  const agentOptions: ClaudeReviewOptions = {
    model: config.model,
    effort: config.effort,
    maxTokens: config.maxTokens,
    maxTurns: config.maxTurns,
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
      skippedFiles: skipped.filter((s) => s.reason !== "removed").map((s) => s.filename),
    }),
  };

  const workspace = await deps.openWorkspace(ref, pull.headSha);
  let result: ClaudeReviewResult;
  try {
    result = await deps.runAgent(agentOptions, (name, input) =>
      executeToolIn(workspace.root, name, input),
    );
  } finally {
    // 一時ディレクトリはレビューの成否に関わらず必ず消す
    await workspace.dispose();
  }

  if (result.kind === "refused") {
    await gateway.createReview(ref, pull.headSha, {
      body: `## Claude Review\n\nこのPRはモデルの安全判定によりレビューできませんでした(category: ${result.category ?? "unknown"})。`,
      comments: [],
    });
    return "refused";
  }

  const payload = buildReviewPayload(result.output, patches, skipped, {
    model: result.model,
    stats: result.stats,
  });
  await gateway.createReview(ref, pull.headSha, payload);
  return "posted";
}
