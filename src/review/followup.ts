import { z } from "zod";
import type { ReviewOutput } from "./claude.js";

/** A top-level inline comment from a previous bot review. */
export interface PreviousComment {
  id: number;
  path: string;
  /** Null when GitHub no longer maps the comment onto the current diff. */
  line: number | null;
  body: string;
  url: string;
}

const OpenFindingSchema = z.object({
  path: z.string(),
  line: z.number().int().nullable(),
  body: z.string(),
  commentId: z.number().int().nullable(),
  url: z.string().nullable(),
});

/** A finding that is still open and has to be checked again by the next review. */
export type OpenFinding = z.infer<typeof OpenFindingSchema>;

/** An open finding with the identifier shown to the model. */
export interface PreviousFinding extends OpenFinding {
  id: string;
}

export type FindingStatusValue = ReviewOutput["previous_findings"][number]["status"];

export interface FindingStatus {
  finding: PreviousFinding;
  /** `unknown` when the model did not return a status for the finding. */
  status: FindingStatusValue | "unknown";
  note: string;
}

const MARKER_PREFIX = "<!-- claude-review:open-findings ";
const MARKER_SUFFIX = " -->";
// レビュー本文の上限(65536文字)を超えないよう、1件あたりの本文を切り詰める
const MAX_STORED_BODY = 1000;

/** Encodes the open findings into a hidden marker for the review body, or null when none. */
export function encodeMarker(findings: OpenFinding[]): string | null {
  if (findings.length === 0) return null;
  const stored = findings.map((f) => ({ ...f, body: f.body.slice(0, MAX_STORED_BODY) }));
  // 本文に`-->`が含まれてもHTMLコメントが壊れないようbase64にする
  const encoded = Buffer.from(JSON.stringify(stored), "utf8").toString("base64");
  return `${MARKER_PREFIX}${encoded}${MARKER_SUFFIX}`;
}

/** Reads the open findings stored by {@link encodeMarker}; returns [] when absent or invalid. */
export function parseMarker(body: string): OpenFinding[] {
  const start = body.lastIndexOf(MARKER_PREFIX);
  if (start === -1) return [];
  const end = body.indexOf(MARKER_SUFFIX, start + MARKER_PREFIX.length);
  try {
    const json = Buffer.from(body.slice(start + MARKER_PREFIX.length, end), "base64").toString(
      "utf8",
    );
    const parsed = z.array(OpenFindingSchema).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Merges the inline comments and the stored open findings of the previous review,
 * and gives each one an identifier (`F1`, `F2`, ...).
 */
export function collectPreviousFindings(
  comments: PreviousComment[],
  stored: OpenFinding[],
): PreviousFinding[] {
  const fromComments: OpenFinding[] = comments.map((c) => ({
    path: c.path,
    line: c.line,
    body: c.body,
    commentId: c.id,
    url: c.url,
  }));
  const seen = new Set(fromComments.map((f) => f.commentId));
  // 同じスレッドが行コメントとマーカーの両方に現れた場合は行コメント側を使う
  const carried = stored.filter((f) => f.commentId === null || !seen.has(f.commentId));
  return [...fromComments, ...carried].map((f, i) => ({ ...f, id: `F${i + 1}` }));
}

/** Pairs every previous finding with the status the model returned for it. */
export function matchStatuses(
  findings: PreviousFinding[],
  output: ReviewOutput["previous_findings"],
): FindingStatus[] {
  return findings.map((finding) => {
    const answer = output.find((o) => o.id === finding.id);
    return answer
      ? { finding, status: answer.status, note: answer.note.trim() }
      : { finding, status: "unknown", note: "" };
  });
}

/** Returns the previous findings that stay open after this review. */
export function stillOpen(statuses: FindingStatus[]): OpenFinding[] {
  return statuses
    .filter((s) => s.status !== "resolved")
    .map(({ finding: { id: _id, ...rest } }) => rest);
}
