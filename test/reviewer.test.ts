import { describe, expect, it, vi } from "vitest";
import type { PullInfo, PullRequestGateway } from "../src/github/pr.js";
import type { ClaudeReviewOptions, ClaudeReviewResult } from "../src/review/claude.js";
import type { PullFile } from "../src/review/filter.js";
import { reviewPullRequest, type ReviewerDeps } from "../src/review/reviewer.js";

const REF = { owner: "o", repo: "r", pullNumber: 1 };
const BOT = "claude-review[bot]";

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
  const requestReview = vi.fn(
    async (_options: ClaudeReviewOptions): Promise<ClaudeReviewResult> =>
      opts.result ?? {
        kind: "ok" as const,
        model: "m",
        output: {
          summary: "s",
          comments: [
            {
              path: "a.ts",
              line: 1,
              side: "RIGHT" as const,
              severity: "major" as const,
              body: "x",
            },
          ],
        },
      },
  );
  const deps: ReviewerDeps = {
    gateway,
    requestReview,
    botLogin: BOT,
    config: {
      model: "m",
      effort: "medium",
      maxTokens: 1000,
      language: "Japanese",
      maxDiffChars: 10_000,
      excludeGlobs: [],
    },
  };
  return { deps, gateway, requestReview };
}

describe("reviewPullRequest", () => {
  it("posts an inline review for the head commit", async () => {
    const { deps, gateway, requestReview } = setup({});
    await expect(reviewPullRequest(deps, REF, { force: false })).resolves.toBe("posted");

    expect(gateway.hasReviewForCommit).toHaveBeenCalledWith(REF, "sha1", BOT);
    const prompt = requestReview.mock.calls[0]![0];
    expect(prompt.user).toContain('<file path="a.ts" status="modified">');
    expect(gateway.createReview).toHaveBeenCalledWith(
      REF,
      "sha1",
      expect.objectContaining({
        comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "**[major]** x" }],
      }),
    );
  });

  it("skips a commit the bot has already reviewed", async () => {
    const { deps, gateway, requestReview } = setup({ alreadyReviewed: true });
    await expect(reviewPullRequest(deps, REF, { force: false })).resolves.toBe(
      "skipped-already-reviewed",
    );
    expect(requestReview).not.toHaveBeenCalled();
    expect(gateway.createReview).not.toHaveBeenCalled();
  });

  it("skips drafts unless forced", async () => {
    const draft = setup({ pull: { draft: true } });
    await expect(reviewPullRequest(draft.deps, REF, { force: false })).resolves.toBe(
      "skipped-draft",
    );
    expect(draft.requestReview).not.toHaveBeenCalled();

    const forced = setup({ pull: { draft: true }, alreadyReviewed: true });
    await expect(reviewPullRequest(forced.deps, REF, { force: true })).resolves.toBe("posted");
  });

  it("does not review closed pull requests even when forced", async () => {
    const { deps, requestReview } = setup({ pull: { state: "closed" } });
    await expect(reviewPullRequest(deps, REF, { force: true })).resolves.toBe("skipped-closed");
    expect(requestReview).not.toHaveBeenCalled();
  });

  it("does not call Claude when every file is filtered out", async () => {
    const { deps, requestReview, gateway } = setup({
      files: [{ filename: "package-lock.json", status: "modified", patch: "x" }],
    });
    await expect(reviewPullRequest(deps, REF, { force: false })).resolves.toBe("skipped-no-files");
    expect(requestReview).not.toHaveBeenCalled();
    expect(gateway.createReview).not.toHaveBeenCalled();
  });

  it("posts a notice when the model refuses", async () => {
    const { deps, gateway } = setup({ result: { kind: "refused", category: "cyber" } });
    await expect(reviewPullRequest(deps, REF, { force: false })).resolves.toBe("refused");
    expect(gateway.createReview).toHaveBeenCalledWith(
      REF,
      "sha1",
      expect.objectContaining({ comments: [], body: expect.stringContaining("category: cyber") }),
    );
  });

  it("does not post anything when the Claude call fails", async () => {
    const { deps, gateway, requestReview } = setup({});
    requestReview.mockRejectedValueOnce(new Error("boom"));
    await expect(reviewPullRequest(deps, REF, { force: false })).rejects.toThrow("boom");
    expect(gateway.createReview).not.toHaveBeenCalled();
  });
});
