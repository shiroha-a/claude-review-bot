import type { Octokit } from "octokit";
import type { PullFile } from "../review/filter.js";
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

/**
 * The subset of GitHub operations the reviewer depends on.
 * Kept as an interface so the reviewer can be tested without network access.
 */
export interface PullRequestGateway {
  getPull(ref: PullRef): Promise<PullInfo>;
  listFiles(ref: PullRef): Promise<PullFile[]>;
  hasReviewForCommit(ref: PullRef, sha: string, botLogin: string): Promise<boolean>;
  createReview(ref: PullRef, sha: string, payload: ReviewPayload): Promise<void>;
}

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

    async hasReviewForCommit({ owner, repo, pullNumber }, sha, botLogin) {
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      return reviews.some((r) => r.user?.login === botLogin && r.commit_id === sha);
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
  };
}
