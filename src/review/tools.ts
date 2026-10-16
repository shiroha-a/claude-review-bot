import type Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import picomatch from "picomatch";
import { z } from "zod";

const run = promisify(execFile);

export const LIMITS = {
  readLines: 2000,
  readBytes: 2_000_000,
  listFiles: 500,
  grepMatches: 200,
  grepLineChars: 300,
  grepTimeoutMs: 10_000,
};

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: "read_file",
    description:
      "Read a file from the pull request's head commit. Returns lines prefixed with their line number. " +
      `At most ${LIMITS.readLines} lines are returned per call; use start_line/end_line to page through larger files.`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the repository root" },
        start_line: { type: "integer", description: "First line to return (1-based, inclusive)" },
        end_line: { type: "integer", description: "Last line to return (inclusive)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "list_files",
    description:
      "List tracked files in the repository, optionally filtered by a glob such as 'src/**/*.ts'. " +
      `Returns at most ${LIMITS.listFiles} paths.`,
    input_schema: {
      type: "object",
      properties: { glob: { type: "string", description: "Glob pattern relative to the root" } },
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "grep",
    description:
      "Search tracked text files with an extended regular expression (git grep -E). " +
      "Use it to find callers, definitions, and tests related to the change. " +
      `Returns at most ${LIMITS.grepMatches} matches as 'path:line:text'.`,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Extended regular expression" },
        glob: { type: "string", description: "Optional glob to limit the searched paths" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
];

const ReadFileInput = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
});
const ListFilesInput = z.object({ glob: z.string().min(1).optional() });
const GrepInput = z.object({ pattern: z.string().min(1), glob: z.string().min(1).optional() });

export interface ToolResult {
  content: string;
  isError: boolean;
}

const fail = (content: string): ToolResult => ({ content, isError: true });

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolves a model-supplied path inside the workspace.
 * Returns null for anything that escapes the root (`..`, absolute paths, symlinks) or
 * points into `.git`.
 */
export async function resolveInside(root: string, path: string): Promise<string | null> {
  const target = resolve(root, path);
  if (!isInside(root, target)) return null;
  const rel = relative(root, target);
  if (rel === ".git" || rel.startsWith(`.git${sep}`)) return null;
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    // 存在しないパスはこの時点では脱出していないので、呼び出し側でENOENTとして扱う
    return target;
  }
  const realRoot = await realpath(root);
  return isInside(realRoot, real) ? target : null;
}

async function readFileTool(root: string, input: z.infer<typeof ReadFileInput>) {
  const target = await resolveInside(root, input.path);
  if (!target) return fail(`path is outside the repository: ${input.path}`);
  let info;
  try {
    info = await stat(target);
  } catch {
    return fail(`file not found: ${input.path}`);
  }
  if (info.isDirectory()) return fail(`${input.path} is a directory; use list_files`);
  if (info.size > LIMITS.readBytes) return fail(`file is too large (${info.size} bytes)`);

  const buf = await readFile(target);
  if (buf.includes(0)) return fail(`${input.path} looks like a binary file`);
  const lines = buf.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const start = input.start_line ?? 1;
  const end = Math.min(input.end_line ?? lines.length, start + LIMITS.readLines - 1, lines.length);
  if (start > lines.length)
    return fail(`start_line ${start} is past the end (${lines.length} lines)`);

  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(6)}  ${l}`)
    .join("\n");
  const note = end < lines.length ? `\n[showing lines ${start}-${end} of ${lines.length}]` : "";
  return { content: body + note, isError: false };
}

async function listFilesTool(root: string, input: z.infer<typeof ListFilesInput>) {
  const { stdout } = await run("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 50_000_000 });
  let files = stdout.split("\0").filter((f) => f.length > 0);
  if (input.glob) {
    // filterに直接渡すと、indexがpicomatchの第2引数(returnObject)に入って常に真になる
    const isMatch = picomatch(input.glob, { dot: true });
    files = files.filter((f) => isMatch(f));
  }
  if (files.length === 0) return { content: "(no files)", isError: false };
  const shown = files.slice(0, LIMITS.listFiles);
  const note =
    files.length > shown.length ? `\n[${files.length - shown.length} more files not shown]` : "";
  return { content: shown.join("\n") + note, isError: false };
}

async function grepTool(root: string, input: z.infer<typeof GrepInput>) {
  const args = ["grep", "-n", "-I", "--no-color", "-E", "-e", input.pattern];
  if (input.glob) args.push("--", `:(glob)${input.glob}`);
  let stdout: string;
  try {
    ({ stdout } = await run("git", args, {
      cwd: root,
      timeout: LIMITS.grepTimeoutMs,
      maxBuffer: 20_000_000,
    }));
  } catch (error) {
    const e = error as { code?: number; killed?: boolean; stderr?: string };
    // git grepは一致なしで終了コード1を返す
    if (e.code === 1 && !e.stderr) return { content: "(no matches)", isError: false };
    if (e.killed) return fail("search timed out; narrow the pattern or glob");
    return fail(`grep failed: ${(e.stderr ?? String(error)).trim().slice(0, 500)}`);
  }
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const shown = lines
    .slice(0, LIMITS.grepMatches)
    .map((l) => (l.length > LIMITS.grepLineChars ? `${l.slice(0, LIMITS.grepLineChars)}...` : l));
  const note =
    lines.length > shown.length ? `\n[${lines.length - shown.length} more matches not shown]` : "";
  return { content: shown.join("\n") + note, isError: false };
}

/** Validates and executes one tool call against the workspace. Never throws. */
export async function executeTool(root: string, name: string, input: unknown): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file": {
        const parsed = ReadFileInput.safeParse(input);
        return parsed.success ? await readFileTool(root, parsed.data) : fail(parsed.error.message);
      }
      case "list_files": {
        const parsed = ListFilesInput.safeParse(input);
        return parsed.success ? await listFilesTool(root, parsed.data) : fail(parsed.error.message);
      }
      case "grep": {
        const parsed = GrepInput.safeParse(input);
        return parsed.success ? await grepTool(root, parsed.data) : fail(parsed.error.message);
      }
      default:
        return fail(`unknown tool: ${name}`);
    }
  } catch (error) {
    return fail(`tool failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
