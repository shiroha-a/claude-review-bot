import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeTool, LIMITS } from "../src/review/tools.js";
import { openWorkspace, type Workspace } from "../src/review/workspace.js";

let source: string;
let sha: string;
let ws: Workspace;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeAll(async () => {
  source = mkdtempSync(join(tmpdir(), "review-src-"));
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.email", "t@example.com");
  git(source, "config", "user.name", "t");
  // SHA指定のfetchをローカルリポジトリで許可する(GitHubは既定で許可している)
  git(source, "config", "uploadpack.allowAnySHA1InWant", "true");
  mkdirSync(join(source, "src"));
  writeFileSync(
    join(source, "src/a.ts"),
    "export const a = 1;\nexport function callA() {\n  return a;\n}\n",
  );
  writeFileSync(join(source, "src/b.ts"), "import { a } from './a';\nconsole.log(a);\n");
  writeFileSync(
    join(source, "big.txt"),
    Array.from({ length: LIMITS.readLines + 5 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  writeFileSync(join(source, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
  symlinkSync("/etc/passwd", join(source, "escape-abs"));
  symlinkSync("../../..", join(source, "escape-rel"));
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "init");
  sha = git(source, "rev-parse", "HEAD");
  ws = await openWorkspace({ remoteUrl: source, sha });
});

afterAll(async () => {
  await ws?.dispose();
  rmSync(source, { recursive: true, force: true });
});

describe("openWorkspace", () => {
  it("checks out the requested commit", () => {
    expect(git(ws.root, "rev-parse", "HEAD")).toBe(sha);
    expect(existsSync(join(ws.root, "src/a.ts"))).toBe(true);
  });

  it("removes the checkout on dispose, and dispose is idempotent", async () => {
    const tmp = await openWorkspace({ remoteUrl: source, sha });
    await tmp.dispose();
    await tmp.dispose();
    expect(existsSync(tmp.root)).toBe(false);
  });

  it("cleans up and rejects when the commit does not exist", async () => {
    const checkouts = () =>
      new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("claude-review-")));
    const before = checkouts();
    await expect(openWorkspace({ remoteUrl: source, sha: "0".repeat(40) })).rejects.toThrow();
    const leaked = [...checkouts()].filter((n) => !before.has(n));
    expect(leaked).toEqual([]);
  });

  it("checks out symlinks as plain files", () => {
    // realpathでの検査に加えた多層防御。リンクとして展開されないこと自体を確認する
    expect(lstatSync(join(ws.root, "escape-abs")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(ws.root, "escape-abs"), "utf8")).toBe("/etc/passwd");
  });
});

describe("read_file", () => {
  it("returns numbered lines", async () => {
    const r = await executeTool(ws.root, "read_file", { path: "src/a.ts" });
    expect(r.isError).toBe(false);
    expect(r.content.split("\n")[1]).toBe("     2  export function callA() {");
  });

  it("supports line ranges", async () => {
    const r = await executeTool(ws.root, "read_file", {
      path: "src/a.ts",
      start_line: 3,
      end_line: 3,
    });
    expect(r.content).toBe("     3    return a;\n[showing lines 3-3 of 4]");
  });

  it("caps the number of lines and says so", async () => {
    const r = await executeTool(ws.root, "read_file", { path: "big.txt" });
    expect(r.content).toContain(`[showing lines 1-${LIMITS.readLines} of ${LIMITS.readLines + 5}]`);
    expect(r.content).not.toContain(`line ${LIMITS.readLines + 1}\n`);
  });

  it.each([["../../etc/passwd"], ["/etc/passwd"], [".git/config"], ["src/../../outside"]])(
    "rejects paths outside the repository: %s",
    async (path) => {
      const r = await executeTool(ws.root, "read_file", { path });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("outside the repository");
    },
  );

  it("does not follow symlinks out of the repository", async () => {
    for (const path of ["escape-abs", "escape-rel"]) {
      const r = await executeTool(ws.root, "read_file", { path });
      // core.symlinks=falseでリンク先パスを中身とする通常ファイルになる
      expect(r.content).not.toContain("root:");
      expect(r.content).not.toMatch(/^\s+1\s+[a-z_-]+:x:/m);
    }
  });

  it("refuses binary files and missing files", async () => {
    expect((await executeTool(ws.root, "read_file", { path: "bin.dat" })).content).toContain(
      "binary",
    );
    expect((await executeTool(ws.root, "read_file", { path: "nope.ts" })).content).toContain(
      "not found",
    );
  });

  it("rejects invalid input without throwing", async () => {
    const r = await executeTool(ws.root, "read_file", { path: 42 });
    expect(r.isError).toBe(true);
  });
});

describe("list_files", () => {
  it("lists tracked files filtered by glob", async () => {
    const r = await executeTool(ws.root, "list_files", { glob: "src/**" });
    expect(r.content.split("\n")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("lists everything without a glob", async () => {
    const r = await executeTool(ws.root, "list_files", {});
    expect(r.content).toContain("big.txt");
    expect(r.content).not.toContain(".git/");
  });
});

describe("grep", () => {
  it("finds matches with path and line number", async () => {
    const r = await executeTool(ws.root, "grep", { pattern: "callA|from './a'" });
    expect(r.content.split("\n").sort()).toEqual([
      "src/a.ts:2:export function callA() {",
      "src/b.ts:1:import { a } from './a';",
    ]);
  });

  it("limits the search to a glob", async () => {
    const r = await executeTool(ws.root, "grep", { pattern: "a", glob: "src/b.ts" });
    expect(r.content.split("\n").every((l) => l.startsWith("src/b.ts:"))).toBe(true);
  });

  it("reports no matches as a normal result", async () => {
    const r = await executeTool(ws.root, "grep", { pattern: "definitely-not-here" });
    expect(r).toEqual({ content: "(no matches)", isError: false });
  });

  it("reports an invalid pattern as an error", async () => {
    const r = await executeTool(ws.root, "grep", { pattern: "(" });
    expect(r.isError).toBe(true);
  });

  it("caps the number of matches", async () => {
    const r = await executeTool(ws.root, "grep", { pattern: "^line", glob: "big.txt" });
    expect(r.content.split("\n")).toHaveLength(LIMITS.grepMatches + 1);
    expect(r.content).toContain("more matches not shown");
  });
});

describe("executeTool", () => {
  it("rejects unknown tools", async () => {
    expect(await executeTool(ws.root, "write_file", {})).toEqual({
      content: "unknown tool: write_file",
      isError: true,
    });
  });
});
