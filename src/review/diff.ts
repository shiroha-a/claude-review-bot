export type Side = "LEFT" | "RIGHT";

export interface DiffLine {
  kind: "add" | "del" | "context";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface ParsedPatch {
  /** Lines that appear in the patch, with resolved old/new line numbers. */
  lines: DiffLine[];
  /** Line numbers on the new file that GitHub accepts for side=RIGHT comments. */
  rightLines: Set<number>;
  /** Line numbers on the old file that GitHub accepts for side=LEFT comments. */
  leftLines: Set<number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a unified diff patch as returned by the GitHub "list pull request files" API.
 * The patch has no file headers, only hunks.
 */
export function parsePatch(patch: string): ParsedPatch {
  const lines: DiffLine[] = [];
  const rightLines = new Set<number>();
  const leftLines = new Set<number>();
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      inHunk = true;
      continue;
    }
    // "\ No newline at end of file" は下のどの分岐にも当たらず、行番号を進めない
    if (!inHunk) continue;

    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") {
      lines.push({ kind: "add", oldLine: null, newLine: newNo, text });
      rightLines.add(newNo);
      newNo++;
    } else if (marker === "-") {
      lines.push({ kind: "del", oldLine: oldNo, newLine: null, text });
      leftLines.add(oldNo);
      oldNo++;
    } else if (marker === " ") {
      // 末尾の空文字列(splitの副産物)は文脈行として数えない
      lines.push({ kind: "context", oldLine: oldNo, newLine: newNo, text });
      rightLines.add(newNo);
      leftLines.add(oldNo);
      oldNo++;
      newNo++;
    }
  }

  return { lines, rightLines, leftLines };
}

/**
 * Renders a parsed patch with explicit line numbers so the model does not have to count lines.
 * Format: `<old> <new> <marker> <text>`, with `-` for a missing number.
 */
export function renderNumberedPatch(parsed: ParsedPatch): string {
  return parsed.lines
    .map((l) => {
      const oldCol = l.oldLine === null ? "-" : String(l.oldLine);
      const newCol = l.newLine === null ? "-" : String(l.newLine);
      const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      return `${oldCol.padStart(5)} ${newCol.padStart(5)} ${marker} ${l.text}`;
    })
    .join("\n");
}

/** Returns true when GitHub will accept a review comment at this position. */
export function isCommentable(parsed: ParsedPatch, line: number, side: Side): boolean {
  return side === "RIGHT" ? parsed.rightLines.has(line) : parsed.leftLines.has(line);
}
