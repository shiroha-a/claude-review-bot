import { describe, expect, it, vi } from "vitest";
import type { BotReview, PullInfo, PullRequestGateway } from "../src/github/pr.js";
import type {
  ClaudeReviewOptions,
  ClaudeReviewResult,
  ReviewOutput,
} from "../src/review/claude.js";
import type { PullFile } from "../src/review/filter.js";
import { encodeMarker, parseMarker, type PreviousComment } from "../src/review/followup.js";
import { reviewPullRequest, type ReviewerDeps } from "../src/review/reviewer.js";
import type { ToolResult } from "../src/review/tools.js";

const REF = { owner: "o", repo: "r", pullNumber: 1 };
const BOT = "claude-review[bot]";
const AUTO = { skipDraft: true, skipIfReviewed: true };
const AUTHOR = { skipDraft: false, skipIfReviewed: true };
const FORCE = { skipDraft: false, skipIfReviewed: false };
const WORKSPACE_ROOT = "/tmp/does-not-exist-review-ws";

type ExecuteTool = (name: string, input: unknown) => Promise<ToolResult>;

function setup(opts: {
  pull?: Partial<PullInfo>;
  files?: PullFile[];
  alreadyReviewed?: boolean;
  reviews?: BotReview[];
  reviewComments?: PreviousComment[];
  changed?: PullFile[] | null;
  result?: ClaudeReviewResult;
}) {
  const reviews =
    opts.reviews ??
    (opts.alreadyReviewed ? [{ id: 9, commitId: "sha1", body: "## Claude Review\n\nx" }] : []);
  const gateway: PullRequestGateway = {
    getPull: vi.fn(async () => ({
      title: "t",
      body: "b",
      headSha: "sha1",
      draft: false,
      state: "open",
      ...opts.pull,
    })),
    listFiles: vi.fn(
      async () =>
        opts.files ?? [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }],
    ),
    listBotReviews: vi.fn(async () => reviews),
    listReviewComments: vi.fn(async () => opts.reviewComments ?? []),
    compareCommits: vi.fn(async () => (opts.changed === undefined ? [] : opts.changed)),
    createReview: vi.fn(async () => {}),
    replyToComment: vi.fn(async () => {}),
    resolveThreads: vi.fn(async () => {}),
  };
  const dispose = vi.fn(async () => {});
  const openWorkspace = vi.fn(async () => ({ root: WORKSPACE_ROOT, dispose }));
  // 既存テストとの互換のため、エージェント実行のモックをrequestReviewと呼ぶ
  const requestReview = vi.fn(
    async (_options: ClaudeReviewOptions, _execute: ExecuteTool): Promise<ClaudeReviewResult> =>
      opts.result ?? {
        kind: "ok" as const,
        model: "m",
        stats: { turns: 1, toolCalls: 2 },
        output: {
          overview: "o",
          verdict: "needs_changes",
          verdict_reason: "r",
          summary: "s",
          testing: "",
          design: "",
          comments: [
            {
              path: "a.ts",
              line: 1,
              side: "RIGHT" as const,
              severity: "major" as const,
              category: "bug" as const,
              body: "x",
            },
          ],
          previous_findings: [],
        },
      },
  );
  const warn = vi.fn();
  const deps: ReviewerDeps = {
    gateway,
    openWorkspace,
    runAgent: requestReview,
    botLogin: BOT,
    warn,
    config: {
      model: "m",
      effort: "medium",
      maxTokens: 1000,
      maxTurns: 5,
      language: "Japanese",
      maxDiffChars: 10_000,
      excludeGlobs: [],
    },
  };
  return { deps, gateway, requestReview, openWorkspace, dispose, warn };
}

describe("reviewPullRequest", () => {
  it("posts an inline review for the head commit", async () => {
    const { deps, gateway, requestReview } = setup({});
    await expect(reviewPullRequest(deps, REF, AUTO)).resolves.toBe("posted");

    expect(gateway.listBotReviews).toHaveBeenCalledWith(REF, BOT);
    const prompt = requestReview.mock.calls[0]![0];
    expect(prompt.user).toContain('<file path="a.ts" status="modified">');
    expect(gateway.createReview).toHaveBeenCalledWith(
      REF,
      "sha1",
      expect.objectContaining({
        comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "**[major · bug]** x" }],
      }),
    );
  });

  it("skips a commit the bot has already reviewed", async () => {
    const { deps, gateway, requestReview } = setup({ alreadyReviewed: true });
    await expect(reviewPullRequest(deps, REF, AUTO)).resolves.toBe("skipped-already-reviewed");
    expect(requestReview).not.toHaveBeenCalled();
    expect(gateway.createReview).not.toHaveBeenCalled();
  });

  it("skips drafts unless forced", async () => {
    const draft = setup({ pull: { draft: true } });
    await expect(reviewPullRequest(draft.deps, REF, AUTO)).resolves.toBe("skipped-draft");
    expect(draft.requestReview).not.toHaveBeenCalled();

    const forced = setup({ pull: { draft: true }, alreadyReviewed: true });
    await expect(reviewPullRequest(forced.deps, REF, FORCE)).resolves.toBe("posted");
  });

  it("lets the author review a draft once per commit", async () => {
    const fresh = setup({ pull: { draft: true } });
    await expect(reviewPullRequest(fresh.deps, REF, AUTHOR)).resolves.toBe("posted");

    const reviewed = setup({ pull: { draft: true }, alreadyReviewed: true });
    await expect(reviewPullRequest(reviewed.deps, REF, AUTHOR)).resolves.toBe(
      "skipped-already-reviewed",
    );
    expect(reviewed.requestReview).not.toHaveBeenCalled();
  });

  it("re-reviews a commit the bot has already reviewed when forced", async () => {
    const { deps, requestReview } = setup({ alreadyReviewed: true });
    await expect(reviewPullRequest(deps, REF, FORCE)).resolves.toBe("posted");
    expect(requestReview).toHaveBeenCalledTimes(1);
  });

  it("ignores bot reviews without the review heading when checking for a prior review", async () => {
    // スレッドへの返信は本文の空のレビューとして記録される
    const { deps, requestReview } = setup({
      reviews: [{ id: 9, commitId: "sha1", body: "" }],
    });
    await expect(reviewPullRequest(deps, REF, AUTHOR)).resolves.toBe("posted");
    expect(requestReview).toHaveBeenCalledTimes(1);
  });

  it("does not review closed pull requests even when forced", async () => {
    const { deps, requestReview } = setup({ pull: { state: "closed" } });
    await expect(reviewPullRequest(deps, REF, FORCE)).resolves.toBe("skipped-closed");
    expect(requestReview).not.toHaveBeenCalled();
  });

  it("does not call Claude when every file is filtered out", async () => {
    const { deps, requestReview, gateway } = setup({
      files: [{ filename: "package-lock.json", status: "modified", patch: "x" }],
    });
    await expect(reviewPullRequest(deps, REF, AUTO)).resolves.toBe("skipped-no-files");
    expect(requestReview).not.toHaveBeenCalled();
    expect(gateway.createReview).not.toHaveBeenCalled();
  });

  it("posts a notice when the model refuses", async () => {
    const { deps, gateway } = setup({ result: { kind: "refused", category: "cyber" } });
    await expect(reviewPullRequest(deps, REF, AUTO)).resolves.toBe("refused");
    expect(gateway.createReview).toHaveBeenCalledWith(
      REF,
      "sha1",
      expect.objectContaining({ comments: [], body: expect.stringContaining("category: cyber") }),
    );
  });

  it("does not post anything when the Claude call fails", async () => {
    const { deps, gateway, requestReview } = setup({});
    requestReview.mockRejectedValueOnce(new Error("boom"));
    await expect(reviewPullRequest(deps, REF, AUTO)).rejects.toThrow("boom");
    expect(gateway.createReview).not.toHaveBeenCalled();
  });

  it("opens the workspace at the head commit and disposes it after the review", async () => {
    const { deps, openWorkspace, dispose } = setup({});
    await reviewPullRequest(deps, REF, AUTO);
    expect(openWorkspace).toHaveBeenCalledWith(REF, "sha1");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the workspace even when the agent fails", async () => {
    const { deps, requestReview, dispose } = setup({});
    requestReview.mockRejectedValueOnce(new Error("boom"));
    await expect(reviewPullRequest(deps, REF, AUTO)).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not open a workspace when the review is skipped", async () => {
    const { deps, openWorkspace } = setup({ alreadyReviewed: true });
    await reviewPullRequest(deps, REF, AUTO);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("binds the tool executor to the workspace root", async () => {
    const { deps, requestReview } = setup({});
    await reviewPullRequest(deps, REF, AUTO);
    const execute = requestReview.mock.calls[0]![1];
    // 存在しないルートで実行するとnot foundになる。ルートが渡っていることの確認
    const r = await execute("read_file", { path: "a.ts" });
    expect(r).toEqual({ content: "file not found: a.ts", isError: true });
  });

  it("tells the model about changed files that are not in the diff, except removed ones", async () => {
    const { deps, requestReview } = setup({
      files: [
        { filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
        { filename: "package-lock.json", status: "modified", patch: "x" },
        { filename: "gone.ts", status: "removed", patch: "-x" },
      ],
    });
    await reviewPullRequest(deps, REF, AUTO);
    const { user, maxTurns } = requestReview.mock.calls[0]![0];
    expect(user).toContain("<not_in_diff>");
    expect(user).toContain("package-lock.json");
    expect(user).not.toContain("gone.ts");
    expect(maxTurns).toBe(5);
  });

  describe("follow-up review", () => {
    const PREV_BODY = `## Claude Review\n\n${encodeMarker([
      { path: "b.ts", line: null, body: "carried", commentId: null, url: null },
    ])}`;
    const COMMENTS: PreviousComment[] = [
      { id: 101, path: "a.ts", line: 1, body: "**[major · bug]** fixed?", url: "u101" },
      { id: 102, path: "a.ts", line: 1, body: "still broken", url: "u102" },
    ];
    const ok = (previous_findings: ReviewOutput["previous_findings"]): ClaudeReviewResult => ({
      kind: "ok",
      model: "m",
      stats: { turns: 1, toolCalls: 1 },
      output: {
        overview: "o",
        verdict: "needs_changes",
        verdict_reason: "r",
        summary: "s",
        testing: "",
        design: "",
        comments: [],
        previous_findings,
      },
    });
    const followUp = (extra: Parameters<typeof setup>[0] = {}) =>
      setup({
        reviews: [
          { id: 1, commitId: "old0", body: "## Claude Review\n\nfirst" },
          { id: 2, commitId: "prev123", body: PREV_BODY },
        ],
        reviewComments: COMMENTS,
        changed: [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" }],
        result: ok([
          { id: "F1", status: "resolved", note: "now checks bounds" },
          { id: "F2", status: "unresolved", note: "same code" },
          { id: "F3", status: "partially_resolved", note: "half" },
        ]),
        ...extra,
      });

    it("gives the model the latest review's findings and the changes since then", async () => {
      const { deps, gateway, requestReview } = followUp();
      await reviewPullRequest(deps, REF, AUTHOR);

      expect(gateway.listReviewComments).toHaveBeenCalledWith(REF, 2);
      expect(gateway.compareCommits).toHaveBeenCalledWith(REF, "prev123", "sha1");
      const { user } = requestReview.mock.calls[0]![0];
      expect(user).toContain('<previous_review commit="prev123">');
      expect(user).toContain('<finding id="F1" location="a.ts:1">\n**[major · bug]** fixed?');
      expect(user).toContain('<finding id="F3" location="b.ts">\ncarried');
      expect(user).toContain('<changes_since_previous_review>\n<file path="a.ts"');
    });

    it("tells the model when the previous commit cannot be compared", async () => {
      const { deps, requestReview } = followUp({ changed: null });
      await reviewPullRequest(deps, REF, AUTHOR);
      const { user } = requestReview.mock.calls[0]![0];
      expect(user).toContain('<changes_since_previous_review unavailable="true">');
    });

    it("does not compare commits when re-reviewing the same commit", async () => {
      const { deps, gateway, requestReview } = followUp({
        reviews: [{ id: 2, commitId: "sha1", body: PREV_BODY }],
      });
      await reviewPullRequest(deps, REF, FORCE);
      expect(gateway.compareCommits).not.toHaveBeenCalled();
      expect(requestReview.mock.calls[0]![0].user).toContain(
        "<changes_since_previous_review>\n(no changes)",
      );
    });

    it("skips the follow-up when the previous review left no findings", async () => {
      const { deps, gateway, requestReview } = followUp({
        reviews: [{ id: 2, commitId: "prev123", body: "## Claude Review\n\nclean" }],
        reviewComments: [],
      });
      await reviewPullRequest(deps, REF, AUTHOR);
      expect(gateway.compareCommits).not.toHaveBeenCalled();
      expect(requestReview.mock.calls[0]![0].user).not.toContain("<previous_review");
    });

    it("reports statuses, replies to inline threads, and resolves only fixed ones", async () => {
      const { deps, gateway } = followUp({ pull: { headSha: "abcdef0123456" } });
      await expect(reviewPullRequest(deps, REF, AUTHOR)).resolves.toBe("posted");

      const body = vi.mocked(gateway.createReview).mock.calls[0]![2].body;
      expect(body).toContain("### 前回の指摘の対応状況(`prev123`からの変更)");
      // 解決済み以外は次回へ持ち越す
      expect(parseMarker(body).map((f) => f.body)).toEqual(["still broken", "carried"]);

      expect(vi.mocked(gateway.replyToComment).mock.calls).toEqual([
        [REF, 101, "**修正を確認しました**(`abcdef0`)\n\nnow checks bounds"],
        [REF, 102, "**まだ修正されていません**(`abcdef0`)\n\nsame code"],
      ]);
      expect(gateway.resolveThreads).toHaveBeenCalledWith(REF, [101]);
      // 返信はレビュー投稿のあと
      expect(vi.mocked(gateway.createReview).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(gateway.replyToComment).mock.invocationCallOrder[0]!,
      );
    });

    it("does not reply to findings the model did not answer", async () => {
      const { deps, gateway } = followUp({ result: ok([]) });
      await reviewPullRequest(deps, REF, AUTHOR);
      expect(gateway.replyToComment).not.toHaveBeenCalled();
      expect(gateway.resolveThreads).toHaveBeenCalledWith(REF, []);
    });

    it("keeps going when a reply or the resolve fails", async () => {
      const { deps, gateway, warn } = followUp();
      vi.mocked(gateway.replyToComment).mockRejectedValueOnce(new Error("403"));
      vi.mocked(gateway.resolveThreads).mockRejectedValueOnce(new Error("graphql"));
      await expect(reviewPullRequest(deps, REF, AUTHOR)).resolves.toBe("posted");

      expect(gateway.replyToComment).toHaveBeenCalledTimes(2);
      // 返信に失敗したスレッドはresolveしない
      expect(gateway.resolveThreads).toHaveBeenCalledWith(REF, []);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("carries every previous finding forward when the model refuses", async () => {
      const { deps, gateway } = followUp({ result: { kind: "refused", category: "cyber" } });
      await reviewPullRequest(deps, REF, AUTHOR);
      const body = vi.mocked(gateway.createReview).mock.calls[0]![2].body;
      expect(body.startsWith("## Claude Review")).toBe(true);
      expect(parseMarker(body).map((f) => f.commentId)).toEqual([101, 102, null]);
      expect(gateway.replyToComment).not.toHaveBeenCalled();
    });
  });
});
