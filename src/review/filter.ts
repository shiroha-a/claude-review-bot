import picomatch from "picomatch";

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
 */
export function filterFiles(
  files: PullFile[],
  options: { excludeGlobs: string[]; maxChars: number },
): FilterResult {
  const isExcluded = picomatch([...DEFAULT_EXCLUDE_GLOBS, ...options.excludeGlobs], { dot: true });
  const included: Required<PullFile>[] = [];
  const skipped: SkippedFile[] = [];
  let total = 0;

  for (const file of files) {
    if (file.status === "removed") {
      skipped.push({ filename: file.filename, reason: "removed" });
    } else if (isExcluded(file.filename)) {
      skipped.push({ filename: file.filename, reason: "excluded" });
    } else if (!file.patch) {
      // バイナリや巨大ファイルはGitHubがpatchを返さない
      skipped.push({ filename: file.filename, reason: "no-patch" });
    } else if (total + file.patch.length > options.maxChars) {
      skipped.push({ filename: file.filename, reason: "size-limit" });
    } else {
      total += file.patch.length;
      included.push({ filename: file.filename, status: file.status, patch: file.patch });
    }
  }

  return { included, skipped };
}
