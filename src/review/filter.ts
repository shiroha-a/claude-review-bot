import picomatch from "picomatch";
import { isAgentFile } from "./agentfiles.js";

/** Subset of the GitHub "list pull request files" item that the reviewer needs. */
export interface PullFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface SkippedFile {
  filename: string;
  reason: "excluded" | "no-patch" | "removed" | "size-limit";
}

export interface FilterResult {
  included: Required<PullFile>[];
  skipped: SkippedFile[];
}

export const DEFAULT_EXCLUDE_GLOBS = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/go.sum",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.snap",
  "**/dist/**",
  "**/vendor/**",
];

/**
 * Selects the files to send to the model.
 * Files are taken in the given order until the cumulative patch size exceeds `maxChars`;
 * every file that does not make it is reported in `skipped` so the review can say so.
 * Files that AI agents read or execute are never excluded by glob and use the size budget
 * first, because a change to them can steer agents and this bot; both lists keep the input order.
 */
export function filterFiles(
  files: PullFile[],
  options: { excludeGlobs: string[]; maxChars: number },
): FilterResult {
  const isExcluded = picomatch([...DEFAULT_EXCLUDE_GLOBS, ...options.excludeGlobs], { dot: true });
  const included: [number, Required<PullFile>][] = [];
  const skipped: [number, SkippedFile][] = [];
  let total = 0;

  const indexed = files.map((file, index) => ({ file, index, agent: isAgentFile(file.filename) }));
  const ordered = [...indexed.filter((f) => f.agent), ...indexed.filter((f) => !f.agent)];
  for (const { file, index, agent } of ordered) {
    if (file.status === "removed") {
      skipped.push([index, { filename: file.filename, reason: "removed" }]);
    } else if (!agent && isExcluded(file.filename)) {
      skipped.push([index, { filename: file.filename, reason: "excluded" }]);
    } else if (!file.patch) {
      // バイナリや巨大ファイルはGitHubがpatchを返さない
      skipped.push([index, { filename: file.filename, reason: "no-patch" }]);
    } else if (total + file.patch.length > options.maxChars) {
      skipped.push([index, { filename: file.filename, reason: "size-limit" }]);
    } else {
      total += file.patch.length;
      included.push([index, { filename: file.filename, status: file.status, patch: file.patch }]);
    }
  }

  const inOrder = <T>(entries: [number, T][]) =>
    entries.sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  return { included: inOrder(included), skipped: inOrder(skipped) };
}
