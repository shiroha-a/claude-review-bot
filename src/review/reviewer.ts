import type { PullRequestGateway, PullRef } from "../github/pr.js";
import type { ClaudeReviewOptions, ClaudeReviewResult } from "./claude.js";
import type { ToolResult } from "./tools.js";
import type { Workspace } from "./workspace.js";
import { parsePatch, type ParsedPatch } from "./diff.js";
import { filterFiles } from "./filter.js";
import {
  collectPreviousFindings,
  encodeMarker,
  matchStatuses,
  parseMarker,
  type FindingStatus,
} from "./followup.js";
import { buildReviewPayload, REVIEW_HEADING } from "./format.js";
import { buildSystemPrompt, buildUserPrompt, type PreviousContext } from "./prompt.js";
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
  /** Reports a non-fatal failure, such as a reply that could not be posted. */
  warn: (message: string, error: unknown) => void;
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

  // 返信用に作られるレビューなどを除き、ボットが本文付きで投稿したレビューだけを見る
  const reviews = (await gateway.listBotReviews(ref, deps.botLogin)).filter((r) =>
    r.body.startsWith(REVIEW_HEADING),
  );
  if (options.skipIfReviewed && reviews.some((r) => r.commitId === pull.headSha)) {
    return "skipped-already-reviewed";
  }

  const filterOptions = { excludeGlobs: config.excludeGlobs, maxChars: config.maxDiffChars };
  const files = await gateway.listFiles(ref);
  const { included, skipped } = filterFiles(files, filterOptions);
  if (included.length === 0) return "skipped-no-files";

  let previous: PreviousContext | undefined;
  const lastReview = reviews.at(-1);
  if (lastReview) {
    const findings = collectPreviousFindings(
      await gateway.listReviewComments(ref, lastReview.id),
      parseMarker(lastReview.body),
    );
    if (findings.length > 0) {
      const changed =
        lastReview.commitId === pull.headSha
          ? []
          : await gateway.compareCommits(ref, lastReview.commitId, pull.headSha);
      const changes = changed && filterFiles(changed, filterOptions);
      previous = {
        commit: lastReview.commitId,
        findings,
        changes:
          changes?.included.map((f) => ({
            filename: f.filename,
            status: f.status,
            parsed: parsePatch(f.patch),
          })) ?? null,
        skippedChanges:
          changes?.skipped.filter((s) => s.reason !== "removed").map((s) => s.filename) ?? [],
      };
    }
  }

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
      previous,
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
    // 前回の指摘は確認できていないので、次の再レビューへそのまま持ち越す
    const marker = encodeMarker(previous?.findings.map(({ id: _id, ...rest }) => rest) ?? []);
    await gateway.createReview(ref, pull.headSha, {
      body: [
        `${REVIEW_HEADING}\n\nこのPRはモデルの安全判定によりレビューできませんでした(category: ${result.category ?? "unknown"})。`,
        marker,
      ]
        .filter((s) => s !== null)
        .join("\n\n"),
      comments: [],
    });
    return "refused";
  }

  const statuses = previous
    ? matchStatuses(previous.findings, result.output.previous_findings)
    : [];
  const payload = buildReviewPayload(
    result.output,
    patches,
    skipped,
    { model: result.model, stats: result.stats },
    previous && { commit: previous.commit, statuses },
  );
  await gateway.createReview(ref, pull.headSha, payload);
  await updateThreads(deps, ref, pull.headSha, statuses);
  return "posted";
}

const REPLY_HEADLINE: Record<Exclude<FindingStatus["status"], "unknown">, string> = {
  resolved: "修正を確認しました",
  partially_resolved: "一部のみ修正されています",
  unresolved: "まだ修正されていません",
};

/** Replies to each previous inline finding with its status and resolves the fixed ones. */
async function updateThreads(
  deps: ReviewerDeps,
  ref: PullRef,
  headSha: string,
  statuses: FindingStatus[],
): Promise<void> {
  const resolved: number[] = [];
  for (const s of statuses) {
    const commentId = s.finding.commentId;
    if (commentId === null || s.status === "unknown") continue;
    const body = `**${REPLY_HEADLINE[s.status]}**(\`${headSha.slice(0, 7)}\`)${s.note ? `\n\n${s.note}` : ""}`;
    try {
      await deps.gateway.replyToComment(ref, commentId, body);
    } catch (error) {
      // 返信やresolveの失敗でレビュー本体を失敗扱いにしない
      deps.warn(`failed to reply to comment ${commentId}`, error);
      continue;
    }
    if (s.status === "resolved") resolved.push(commentId);
  }
  try {
    await deps.gateway.resolveThreads(ref, resolved);
  } catch (error) {
    deps.warn(`failed to resolve threads ${resolved.join(",")}`, error);
  }
}
