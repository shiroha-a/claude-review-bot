import { describe, expect, it, vi } from "vitest";
import type { PullInfo, PullRequestGateway } from "../src/github/pr.js";
import type { ClaudeReviewOptions, ClaudeReviewResult } from "../src/review/claude.js";
import type { PullFile } from "../src/review/filter.js";
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
  result?: ClaudeReviewResult;
}) {
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
    hasReviewForCommit: vi.fn(async () => opts.alreadyReviewed ?? false),
    createReview: vi.fn(async () => {}),
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
        },
      },
  );
  const deps: ReviewerDeps = {
    gateway,
    openWorkspace,
    runAgent: requestReview,
    botLogin: BOT,
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
  return { deps, gateway, requestReview, openWorkspace, dispose };
}

describe("reviewPullRequest", () => {
  it("posts an inline review for the head commit", async () => {
    const { deps, gateway, requestReview } = setup({});
    await expect(reviewPullRequest(deps, REF, AUTO)).resolves.toBe("posted");

    expect(gateway.hasReviewForCommit).toHaveBeenCalledWith(REF, "sha1", BOT);
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

  it("does not look up existing reviews when re-review is forced", async () => {
    const { deps, gateway } = setup({});
    await reviewPullRequest(deps, REF, FORCE);
    expect(gateway.hasReviewForCommit).not.toHaveBeenCalled();
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
});
