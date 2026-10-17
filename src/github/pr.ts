import type { Octokit } from "octokit";
import type { PullFile } from "../review/filter.js";
import type { PreviousComment } from "../review/followup.js";
import type { ReviewPayload } from "../review/format.js";

export interface PullRef {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface PullInfo {
  title: string;
  body: string;
  headSha: string;
  draft: boolean;
  state: string;
}

export interface BotReview {
  id: number;
  commitId: string;
  body: string;
}

/**
 * The subset of GitHub operations the reviewer depends on.
 * Kept as an interface so the reviewer can be tested without network access.
 */
export interface PullRequestGateway {
  getPull(ref: PullRef): Promise<PullInfo>;
  listFiles(ref: PullRef): Promise<PullFile[]>;
  /** Reviews written by the bot, oldest first. */
  listBotReviews(ref: PullRef, botLogin: string): Promise<BotReview[]>;
  /** Top-level inline comments of one review. */
  listReviewComments(ref: PullRef, reviewId: number): Promise<PreviousComment[]>;
  /** Files changed from `base` to `head`, or null when `head` is not a fast-forward of `base`. */
  compareCommits(ref: PullRef, base: string, head: string): Promise<PullFile[] | null>;
  createReview(ref: PullRef, sha: string, payload: ReviewPayload): Promise<void>;
  replyToComment(ref: PullRef, commentId: number, body: string): Promise<void>;
  /** Resolves the review threads that start with the given comments. */
  resolveThreads(ref: PullRef, commentIds: number[]): Promise<void>;
}

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          comments: { nodes: { databaseId: number | null }[] };
        }[];
      };
    } | null;
  } | null;
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

/** Creates a gateway backed by an installation-scoped Octokit client. */
export function createGateway(octokit: Octokit): PullRequestGateway {
  return {
    async getPull({ owner, repo, pullNumber }) {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
      return {
        title: data.title,
        body: data.body ?? "",
        headSha: data.head.sha,
        draft: data.draft ?? false,
        state: data.state,
      };
    },

    async listFiles({ owner, repo, pullNumber }) {
      // 1ページ最大100件、APIの上限は3000ファイル
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      return files.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch }));
    },

    async listBotReviews({ owner, repo, pullNumber }, botLogin) {
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      return reviews
        .filter((r) => r.user?.login === botLogin && r.commit_id)
        .map((r) => ({ id: r.id, commitId: r.commit_id!, body: r.body }));
    },

    async listReviewComments({ owner, repo, pullNumber }, reviewId) {
      // レビュー単位の一覧(listCommentsForReview)は行番号を返さないため、PR全体の一覧から絞り込む
      const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      return comments
        .filter((c) => c.pull_request_review_id === reviewId && c.in_reply_to_id === undefined)
        .map((c) => ({
          id: c.id,
          path: c.path,
          // 指摘箇所がpushで消えるとlineはnullになるため、レビュー時点の行で補う
          line: c.line ?? c.original_line ?? null,
          body: c.body,
          url: c.html_url,
        }));
    },

    async compareCommits({ owner, repo }, base, head) {
      try {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${base}...${head}`,
        });
        // force-push等でheadがbaseの子孫でない場合、差分は前回レビューとの比較にならない
        if (data.status !== "ahead" && data.status !== "identical") return null;
        return (data.files ?? []).map((f) => ({
          filename: f.filename,
          status: f.status,
          patch: f.patch,
        }));
      } catch (error) {
        // 前回のcommitがforce-pushで消えていると404になる
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },

    async createReview({ owner, repo, pullNumber }, sha, payload) {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: sha,
        event: "COMMENT",
        body: payload.body,
        comments: payload.comments,
      });
    },

    async replyToComment({ owner, repo, pullNumber }, commentId, body) {
      await octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        comment_id: commentId,
        body,
      });
    },

    async resolveThreads({ owner, repo, pullNumber }, commentIds) {
      if (commentIds.length === 0) return;
      const wanted = new Set(commentIds);
      const threadIds: string[] = [];
      let cursor: string | null = null;
      do {
        const page: ThreadsPage = await octokit.graphql<ThreadsPage>(THREADS_QUERY, {
          owner,
          repo,
          number: pullNumber,
          cursor,
        });
        const threads = page.repository?.pullRequest?.reviewThreads;
        if (!threads) break;
        for (const t of threads.nodes) {
          const first = t.comments.nodes[0]?.databaseId;
          if (!t.isResolved && first != null && wanted.has(first)) threadIds.push(t.id);
        }
        cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
      } while (cursor);
      for (const threadId of threadIds) {
        await octokit.graphql(RESOLVE_MUTATION, { threadId });
      }
    },
  };
}
