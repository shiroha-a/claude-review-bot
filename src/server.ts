import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { App, createNodeMiddleware } from "octokit";
import { loadConfig } from "./config.js";
import { createGateway, type PullRef } from "./github/pr.js";
import { KeyedQueue } from "./queue.js";
import { requestReview } from "./review/claude.js";
import { reviewPullRequest } from "./review/reviewer.js";

const config = loadConfig();

const app = new App({
  appId: config.GITHUB_APP_ID,
  privateKey: config.GITHUB_PRIVATE_KEY,
  webhooks: { secret: config.GITHUB_WEBHOOK_SECRET },
});
const anthropic = new Anthropic(
  config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : {},
);

const { data: appInfo } = await app.octokit.rest.apps.getAuthenticated();
if (!appInfo) throw new Error("Failed to resolve GitHub App identity");
// 二重レビュー判定でbot自身のレビューを識別するためのログイン名
const botLogin = `${appInfo.slug}[bot]`;

const queue = new KeyedQueue();
const allowed = new Set(config.ALLOWED_AUTHOR_ASSOCIATIONS);

function schedule(octokit: Parameters<typeof createGateway>[0], ref: PullRef, force: boolean) {
  const key = `${ref.owner}/${ref.repo}#${ref.pullNumber}`;
  // Webhookの応答を待たせないため、レビューは投げっぱなしで実行する
  void queue
    .enqueue(key, async () => {
      const outcome = await reviewPullRequest(
        {
          gateway: createGateway(octokit),
          requestReview: (options) => requestReview(anthropic, options),
          botLogin,
          config: {
            model: config.CLAUDE_MODEL,
            effort: config.CLAUDE_EFFORT,
            maxTokens: config.CLAUDE_MAX_TOKENS,
            language: config.REVIEW_LANGUAGE,
            maxDiffChars: config.MAX_DIFF_CHARS,
            excludeGlobs: config.EXCLUDE_GLOBS,
          },
        },
        ref,
        { force },
      );
      console.log(`[review] ${key} ${outcome}`);
    })
    .catch((error: unknown) => {
      console.error(`[review] ${key} failed`, error);
    });
}

app.webhooks.on(
  [
    "pull_request.opened",
    "pull_request.reopened",
    "pull_request.ready_for_review",
    "pull_request.synchronize",
  ],
  ({ octokit, payload }) => {
    const pr = payload.pull_request;
    if (!allowed.has(pr.author_association)) {
      console.log(`[review] skip #${pr.number}: author_association=${pr.author_association}`);
      return;
    }
    schedule(
      octokit,
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pullNumber: pr.number,
      },
      false,
    );
  },
);

app.webhooks.on("issue_comment.created", ({ octokit, payload }) => {
  const { issue, comment } = payload;
  if (!issue.pull_request) return;
  if (comment.user?.type === "Bot") return;
  if (comment.body.trim() !== config.REVIEW_COMMAND) return;
  if (!allowed.has(comment.author_association)) return;
  schedule(
    octokit,
    {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pullNumber: issue.number,
    },
    true,
  );
});

app.webhooks.onError((error) => {
  console.error("[webhook] error", error);
});

const middleware = createNodeMiddleware(app);
const server = createServer(async (req, res) => {
  if (await middleware(req, res)) return;
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  res.writeHead(404).end();
});

server.listen(config.PORT, () => {
  console.log(`claude-review-bot (${botLogin}) listening on :${config.PORT}`);
  console.log(`webhook endpoint: POST /api/github/webhooks`);
});
