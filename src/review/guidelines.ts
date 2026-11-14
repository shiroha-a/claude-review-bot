import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Repository-wide documents, matched case-insensitively against the full path. */
export const ROOT_GUIDELINES = [
  "claude.md",
  "agents.md",
  "contributing.md",
  ".claude/claude.md",
  ".github/contributing.md",
  "docs/contributing.md",
  ".github/copilot-instructions.md",
];

/** Documents that apply to the directory they are in, matched case-insensitively by name. */
export const SCOPED_GUIDELINES = ["claude.md", "agents.md"];

export interface Guideline {
  path: string;
  content: string;
  /** True when the content was cut at the size limit. */
  truncated: boolean;
}

export interface ProjectGuidelines {
  /** Commit the documents were read from (the base of the pull request). */
  commit: string;
  files: Guideline[];
  /** Selected documents left out because the size limit was reached. */
  omitted: string[];
  /** Guideline documents the pull request itself adds, changes, or removes. */
  changedInPull: string[];
}

/** Whether a path names a document the bot treats as a project guideline. */
export function isGuidelinePath(path: string): boolean {
  const lower = path.toLowerCase();
  return ROOT_GUIDELINES.includes(lower) || SCOPED_GUIDELINES.includes(posix.basename(lower));
}

/**
 * Picks the guideline documents that apply to a change: the repository-wide documents, then
 * the scoped documents in every ancestor directory of a changed file, shallowest first.
 */
export function selectGuidelinePaths(tracked: string[], changed: string[]): string[] {
  const root = tracked
    .filter((p) => ROOT_GUIDELINES.includes(p.toLowerCase()))
    .sort(
      (a, b) =>
        ROOT_GUIDELINES.indexOf(a.toLowerCase()) - ROOT_GUIDELINES.indexOf(b.toLowerCase()) ||
        a.localeCompare(b),
    );

  const dirs = new Set<string>();
  for (const path of changed) {
    // ルート直下はROOT_GUIDELINESで拾うので、サブディレクトリだけを辿る
    for (let dir = posix.dirname(path); dir !== "." && dir !== "/"; dir = posix.dirname(dir)) {
      dirs.add(dir);
    }
  }
  const scoped = tracked
    .filter((p) => {
      const dir = posix.dirname(p);
      return dirs.has(dir) && SCOPED_GUIDELINES.includes(posix.basename(p).toLowerCase());
    })
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  return [...root, ...scoped];
}

/**
 * Reads the guideline documents that apply to a change from `commit` in the checked-out
 * repository at `root`, keeping their total size under `maxChars`.
 * Only regular files are read; symlinks are skipped because their targets are untrusted.
 */
export async function loadGuidelines(
  root: string,
  commit: string,
  changed: string[],
  maxChars: number,
): Promise<ProjectGuidelines> {
  const result: ProjectGuidelines = {
    commit,
    files: [],
    omitted: [],
    changedInPull: changed.filter(isGuidelinePath),
  };
  if (maxChars <= 0) return result;

  const { stdout } = await run("git", ["ls-tree", "-r", "-z", "--full-tree", commit], {
    cwd: root,
    maxBuffer: 50_000_000,
  });
  // 形式: "<mode> <type> <object>\t<path>"。symlink(120000)とsubmodule(160000)は除外する
  const blobs = new Map<string, string>();
  for (const entry of stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    if (type === "blob" && (mode === "100644" || mode === "100755")) {
      blobs.set(entry.slice(tab + 1), object!);
    }
  }

  let remaining = maxChars;
  for (const path of selectGuidelinePaths([...blobs.keys()], changed)) {
    if (remaining <= 0) {
      result.omitted.push(path);
      continue;
    }
    const { stdout: content } = await run("git", ["cat-file", "blob", blobs.get(path)!], {
      cwd: root,
      maxBuffer: 50_000_000,
    });
    if (content.includes("\0") || content.trim() === "") continue;
    const truncated = content.length > remaining;
    const kept = truncated ? content.slice(0, remaining) : content;
    result.files.push({ path, content: kept, truncated });
    remaining -= kept.length;
  }
  return result;
}
