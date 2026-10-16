import type { ReviewComment, ReviewOutput, ReviewStats } from "./claude.js";
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

const VERDICT_LABEL: Record<ReviewOutput["verdict"], string> = {
  mergeable: "マージ可",
  needs_changes: "要修正",
  needs_discussion: "要議論",
};

function label(c: ReviewComment): string {
  return `**[${c.severity} · ${c.category}]**`;
}

function section(title: string, text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? `### ${title}\n\n${trimmed}` : null;
}

export interface ReviewMeta {
  model: string;
  stats: ReviewStats;
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
  meta: ReviewMeta,
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

  const sections: (string | null)[] = [
    "## Claude Review",
    `**判定: ${VERDICT_LABEL[output.verdict]}** — ${output.verdict_reason.trim()}`,
    section("変更の概要", output.overview),
    section("主な指摘", output.summary),
    section("テスト", output.testing),
    section("設計・保守性", output.design),
  ];

  if (outside.length > 0) {
    const items = outside.map((c) => `- ${label(c)} \`${c.path}:${c.line}\` ${c.body}`);
    sections.push(`### 差分外の指摘\n\n${items.join("\n")}`);
  }
  if (skipped.length > 0) {
    const items = skipped.map((s) => `- \`${s.filename}\`(${SKIP_REASON[s.reason]})`);
    sections.push(
      `<details><summary>diffを渡していないファイル(${skipped.length}件)</summary>\n\n${items.join("\n")}\n\n</details>`,
    );
  }
  sections.push(
    `<sub>model: ${meta.model} · ツール呼び出し${meta.stats.toolCalls}回 / ${meta.stats.turns}ターン</sub>`,
  );

  return { body: sections.filter((s): s is string => s !== null).join("\n\n"), comments: inline };
}
