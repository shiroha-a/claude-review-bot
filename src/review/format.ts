import type { ReviewComment, ReviewOutput } from "./claude.js";
import { isCommentable, type ParsedPatch } from "./diff.js";
import type { SkippedFile } from "./filter.js";

export interface InlineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

export interface ReviewPayload {
  body: string;
  comments: InlineComment[];
}

const SEVERITY_ORDER: Record<ReviewComment["severity"], number> = {
  critical: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

const SKIP_REASON: Record<SkippedFile["reason"], string> = {
  excluded: "除外対象",
  "no-patch": "差分なし(バイナリ等)",
  removed: "削除されたファイル",
  "size-limit": "サイズ上限超過",
};

function label(c: ReviewComment): string {
  return `**[${c.severity}]**`;
}

/**
 * Converts the model output into a GitHub review payload.
 * Comments that point at a line outside the diff would make the whole review request fail
 * with 422, so they are moved into the review body instead of being dropped.
 */
export function buildReviewPayload(
  output: ReviewOutput,
  patches: Map<string, ParsedPatch>,
  skipped: SkippedFile[],
  model: string,
): ReviewPayload {
  const sorted = [...output.comments].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const inline: InlineComment[] = [];
  const outside: ReviewComment[] = [];

  for (const c of sorted) {
    const parsed = patches.get(c.path);
    if (parsed && isCommentable(parsed, c.line, c.side)) {
      inline.push({ path: c.path, line: c.line, side: c.side, body: `${label(c)} ${c.body}` });
    } else {
      outside.push(c);
    }
  }

  const sections: string[] = ["## Claude Review", output.summary.trim()];

  if (outside.length > 0) {
    const items = outside.map((c) => `- ${label(c)} \`${c.path}:${c.line}\` ${c.body}`);
    sections.push(`### 差分外の指摘\n\n${items.join("\n")}`);
  }
  if (skipped.length > 0) {
    const items = skipped.map((s) => `- \`${s.filename}\`(${SKIP_REASON[s.reason]})`);
    sections.push(
      `<details><summary>レビュー対象外のファイル(${skipped.length}件)</summary>\n\n${items.join("\n")}\n\n</details>`,
    );
  }
  sections.push(`<sub>model: ${model}</sub>`);

  return { body: sections.join("\n\n"), comments: inline };
}
