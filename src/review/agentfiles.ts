import picomatch from "picomatch";
import type { ParsedPatch } from "./diff.js";
import { isGuidelinePath } from "./guidelines.js";

/**
 * Files that AI coding agents and reviewers read as instructions or execute as configuration.
 * Matched case-insensitively.
 */
export const AGENT_FILE_GLOBS = [
  "**/CLAUDE.md",
  "**/CLAUDE.local.md",
  "**/AGENTS.md",
  "**/GEMINI.md",
  "**/.claude/**",
  "**/.mcp.json",
  ".vscode/mcp.json",
  "**/.cursorrules",
  "**/.cursor/**",
  "**/.windsurfrules",
  "**/.windsurf/**",
  "**/.clinerules",
  "**/.clinerules/**",
  "**/.gemini/**",
  ".github/copilot-instructions.md",
  ".github/instructions/**",
  ".github/prompts/**",
  ".github/agents/**",
];

const matchAgentFile = picomatch(AGENT_FILE_GLOBS, { dot: true, nocase: true });

/** Whether a change to `path` affects how AI agents working on the repository behave. */
export function isAgentFile(path: string): boolean {
  return isGuidelinePath(path) || matchAgentFile(path);
}

export interface HiddenCharacters {
  path: string;
  line: number;
  /** Code points found on the line, in order of first appearance, as "U+XXXX". */
  codePoints: string[];
  /** ASCII text hidden with Unicode tag characters, when there is any. */
  decoded: string | null;
}

export const MAX_HIDDEN_CHARACTER_LINES = 50;

// ゼロ幅文字・方向制御文字(Trojan Source)・タグ文字と異体字セレクタ補助(ASCII smuggling)。
// 正規表現リテラルに書くとprettierが\uエスケープを実際の不可視文字へ戻すため、数値で持つ
const HIDDEN_RANGES: [number, number][] = [
  [0x200b, 0x200d],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

function isHidden(cp: number): boolean {
  return HIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Finds added lines that contain characters GitHub does not display. */
export function findHiddenCharacters(
  files: { filename: string; parsed: ParsedPatch }[],
): HiddenCharacters[] {
  const found: HiddenCharacters[] = [];
  for (const file of files) {
    for (const l of file.parsed.lines) {
      if (l.kind !== "add" || l.newLine === null) continue;
      const codePoints = new Set<string>();
      let decoded = "";
      let index = 0;
      for (const ch of l.text) {
        const cp = ch.codePointAt(0)!;
        const atStart = index === 0;
        index += ch.length;
        if (!isHidden(cp)) continue;
        // ファイル先頭のBOMは正当なので数えない
        if (cp === 0xfeff && l.newLine === 1 && atStart) continue;
        codePoints.add(hex(cp));
        if (cp >= 0xe0020 && cp <= 0xe007e) decoded += String.fromCharCode(cp - 0xe0000);
      }
      if (codePoints.size === 0) continue;
      found.push({
        path: file.filename,
        line: l.newLine,
        codePoints: [...codePoints],
        decoded: decoded || null,
      });
      if (found.length >= MAX_HIDDEN_CHARACTER_LINES) return found;
    }
  }
  return found;
}
