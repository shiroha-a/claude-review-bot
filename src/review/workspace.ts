import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Workspace {
  /** Absolute path of the checked-out tree. */
  root: string;
  /** Removes the checkout. Safe to call more than once. */
  dispose(): Promise<void>;
}

export interface OpenWorkspaceOptions {
  /** Clone URL, e.g. https://github.com/owner/repo.git */
  remoteUrl: string;
  /** Commit to check out. */
  sha: string;
  /** Installation token. Omit for public or local remotes. */
  token?: string;
  timeoutMs?: number;
}

/**
 * Shallow-fetches a single commit into a fresh temporary directory.
 * The repository content is untrusted: nothing in it is ever executed, symlinks are
 * checked out as plain files, and LFS smudging is disabled.
 */
export async function openWorkspace(options: OpenWorkspaceOptions): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "claude-review-"));
  // force: trueなので2回目以降の呼び出しも失敗しない
  const dispose = () => rm(root, { recursive: true, force: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    // ユーザーやシステムのgit設定(credential helperやhook)の影響を受けない
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  if (options.token) {
    // トークンをargvやremote URLに載せると、psや.git/configに残るため環境変数で渡す
    const basic = Buffer.from(`x-access-token:${options.token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  const git = (args: string[]) =>
    run("git", args, { cwd: root, env, timeout: options.timeoutMs ?? 120_000 });

  try {
    await git(["init", "-q"]);
    await git(["config", "core.symlinks", "false"]);
    await git(["fetch", "-q", "--depth", "1", "--no-tags", options.remoteUrl, options.sha]);
    await git(["checkout", "-q", "--detach", "FETCH_HEAD"]);
  } catch (error) {
    await dispose();
    throw error;
  }
  return { root, dispose };
}
