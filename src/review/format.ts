import type { ReviewComment, ReviewOutput, ReviewStats } from "./claude.js";
import { isCommentable, type ParsedPatch } from "./diff.js";
import type { SkippedFile } from "./filter.js";
import { encodeMarker, stillOpen, type FindingStatus, type OpenFinding } from "./followup.js";

/** The first line of every review the bot posts; used to recognize its own reviews. */
export const REVIEW_HEADING = "## Claude Review";

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

const STATUS_LABEL: Record<FindingStatus["status"], string> = {
  resolved: "修正済み",
  partially_resolved: "一部のみ修正",
  unresolved: "未修正",
  unknown: "未確認",
};

// 一覧で読みやすいよう、ラベルを除いた最初の1行だけを短く表示する
function headline(body: string): string {
  const first = body
    .replace(/^\*\*\[[^\]]*\]\*\*\s*/, "")
    .split("\n")[0]!
    .trim();
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

function statusItem(s: FindingStatus): string {
  const { finding } = s;
  const location = `\`${finding.line === null ? finding.path : `${finding.path}:${finding.line}`}\``;
  const linked = finding.url ? `[${location}](${finding.url})` : location;
  const note = s.note ? ` — ${s.note}` : "";
  return `- **${STATUS_LABEL[s.status]}** ${linked} ${headline(finding.body)}${note}`;
}

/** Previous findings to report on, and the commit they were made against. */
export interface FollowUp {
  commit: string;
  statuses: FindingStatus[];
}

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
  followUp?: FollowUp,
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
    REVIEW_HEADING,
    `**判定: ${VERDICT_LABEL[output.verdict]}** — ${output.verdict_reason.trim()}`,
  ];
  if (followUp && followUp.statuses.length > 0) {
    sections.push(
      `### 前回の指摘の対応状況(\`${followUp.commit.slice(0, 7)}\`からの変更)\n\n${followUp.statuses.map(statusItem).join("\n")}`,
    );
  }
  sections.push(
    section("変更の概要", output.overview),
    section("主な指摘", output.summary),
    section("テスト", output.testing),
    section("設計・保守性", output.design),
  );

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
  // 差分外の新しい指摘と未解決の前回の指摘を、次の再レビューのために本文へ隠して残す
  const open: OpenFinding[] = [
    ...(followUp ? stillOpen(followUp.statuses) : []),
    ...outside.map((c) => ({
      path: c.path,
      line: c.line,
      body: `${label(c)} ${c.body}`,
      commentId: null,
      url: null,
    })),
  ];
  sections.push(encodeMarker(open));
  sections.push(
    `<sub>model: ${meta.model} · ツール呼び出し${meta.stats.toolCalls}回 / ${meta.stats.turns}ターン</sub>`,
  );

  return { body: sections.filter((s): s is string => s !== null).join("\n\n"), comments: inline };
}
