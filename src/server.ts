import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { createNodeMiddleware } from "@octokit/webhooks";
import { App } from "octokit";
import { loadConfig } from "./config.js";
import { createGateway, type PullRef } from "./github/pr.js";
import { KeyedQueue } from "./queue.js";
import { createSender, runReviewAgent } from "./review/claude.js";
import { openWorkspace } from "./review/workspace.js";
import { reviewPullRequest, type ReviewOptions } from "./review/reviewer.js";
import { decideCommandTrigger } from "./trigger.js";

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

const sender = createSender(anthropic);
const queue = new KeyedQueue();
const maintainers = new Set(config.MAINTAINER_ASSOCIATIONS);

type InstallationOctokit = Parameters<typeof createGateway>[0];

function schedule(
  octokit: InstallationOctokit,
  ref: PullRef,
  options: ReviewOptions,
  onSkippedAlreadyReviewed?: () => Promise<void>,
) {
  const key = `${ref.owner}/${ref.repo}#${ref.pullNumber}`;
  // Webhookの応答を待たせないため、レビューは投げっぱなしで実行する
  void queue
    .enqueue(key, async () => {
      const outcome = await reviewPullRequest(
        {
          gateway: createGateway(octokit),
          openWorkspace: async ({ owner, repo }, sha) => {
            const auth = (await octokit.auth({ type: "installation" })) as { token: string };
            return openWorkspace({
              remoteUrl: `https://github.com/${owner}/${repo}.git`,
              sha,
              token: auth.token,
            });
          },
          runAgent: (options, executeTool) =>
            runReviewAgent(
              {
                send: sender,
                executeTool: async (name, input) => {
                  const result = await executeTool(name, input);
                  console.log(
                    `[tool] ${key} ${name} ${JSON.stringify(input)}${result.isError ? " (error)" : ""}`,
                  );
                  return result;
                },
              },
              options,
            ),
          botLogin,
          config: {
            model: config.CLAUDE_MODEL,
            effort: config.CLAUDE_EFFORT,
            maxTokens: config.CLAUDE_MAX_TOKENS,
            maxTurns: config.MAX_AGENT_TURNS,
            language: config.REVIEW_LANGUAGE,
            maxDiffChars: config.MAX_DIFF_CHARS,
            excludeGlobs: config.EXCLUDE_GLOBS,
          },
        },
        ref,
        options,
      );
      console.log(`[review] ${key} ${outcome}`);
      if (outcome === "skipped-already-reviewed") await onSkippedAlreadyReviewed?.();
    })
    .catch((error: unknown) => {
      console.error(`[review] ${key} failed`, error);
    });
}

if (config.AUTO_REVIEW) {
  app.webhooks.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.ready_for_review",
      "pull_request.synchronize",
    ],
    ({ octokit, payload }) => {
      const pr = payload.pull_request;
      // 自動レビューはメンテナのPRに限る。外部のPRはコマンドで明示的に依頼してもらう
      if (!maintainers.has(pr.author_association)) {
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
        { skipDraft: true, skipIfReviewed: true },
      );
    },
  );
}

app.webhooks.on("issue_comment.created", ({ octokit, payload }) => {
  const { issue, comment } = payload;
  if (!issue.pull_request) return;
  const decision = decideCommandTrigger(
    {
      commentBody: comment.body,
      commenterLogin: comment.user?.login ?? "",
      commenterAssociation: comment.author_association,
      commenterIsBot: comment.user?.type === "Bot",
      prAuthorLogin: issue.user?.login ?? "",
    },
    { command: config.REVIEW_COMMAND, maintainerAssociations: [...maintainers] },
  );
  if (!decision.run) return;

  const ref = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: issue.number,
  };
  schedule(octokit, ref, decision.options, async () => {
    await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.pullNumber,
      body: `@${comment.user?.login} このコミットはレビュー済みです。変更をpushしてから、もう一度\`${config.REVIEW_COMMAND}\`を実行してください。`,
    });
  });
});

app.webhooks.onError((error) => {
  console.error("[webhook] error", error);
});

// @octokit/appのミドルウェアはOAuth設定を必須とするため、Webhook専用のものを使う
const middleware = createNodeMiddleware(app.webhooks);
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
  console.log(
    `auto review: ${config.AUTO_REVIEW ? "on" : "off"}, command: ${config.REVIEW_COMMAND}`,
  );
  console.log(`webhook endpoint: POST /api/github/webhooks`);
});
