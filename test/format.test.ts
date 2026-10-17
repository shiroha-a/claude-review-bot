import { describe, expect, it } from "vitest";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ReviewOutputSchema, type ReviewOutput } from "../src/review/claude.js";
import { parsePatch } from "../src/review/diff.js";
import { parseMarker, type FindingStatus, type PreviousFinding } from "../src/review/followup.js";
import { buildReviewPayload } from "../src/review/format.js";

const patches = new Map([["src/a.ts", parsePatch("@@ -1,2 +1,2 @@\n a\n-b\n+c")]]);
const META = { model: "claude-opus-5-5", stats: { turns: 3, toolCalls: 7 } };

function output(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    overview: "概要",
    verdict: "needs_changes",
    verdict_reason: "バグがあるため",
    summary: "主な指摘",
    testing: "",
    design: "",
    comments: [],
    previous_findings: [],
    ...overrides,
  };
}

describe("buildReviewPayload", () => {
  it("keeps commentable findings inline, sorted by severity, labeled with category", () => {
    const payload = buildReviewPayload(
      output({
        comments: [
          {
            path: "src/a.ts",
            line: 1,
            side: "RIGHT",
            severity: "nit",
            category: "style",
            body: "n",
          },
          {
            path: "src/a.ts",
            line: 2,
            side: "RIGHT",
            severity: "critical",
            category: "bug",
            body: "c",
          },
          {
            path: "src/a.ts",
            line: 2,
            side: "LEFT",
            severity: "minor",
            category: "test",
            body: "m",
          },
        ],
      }),
      patches,
      [],
      META,
    );
    expect(payload.comments).toEqual([
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "**[critical · bug]** c" },
      { path: "src/a.ts", line: 2, side: "LEFT", body: "**[minor · test]** m" },
      { path: "src/a.ts", line: 1, side: "RIGHT", body: "**[nit · style]** n" },
    ]);
    expect(payload.body).not.toContain("差分外の指摘");
  });

  it("renders the verdict, overview, and summary in order", () => {
    const { body } = buildReviewPayload(output(), patches, [], META);
    const order = [
      "## Claude Review",
      "**判定: 要修正** — バグがあるため",
      "### 変更の概要",
      "### 主な指摘",
    ];
    const positions = order.map((s) => body.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it.each([
    ["mergeable", "マージ可"],
    ["needs_discussion", "要議論"],
  ] as const)("labels verdict %s", (verdict, label) => {
    expect(buildReviewPayload(output({ verdict }), patches, [], META).body).toContain(
      `**判定: ${label}**`,
    );
  });

  it("omits testing and design sections when empty, and shows them when present", () => {
    const empty = buildReviewPayload(output({ testing: "  ", design: "" }), patches, [], META);
    expect(empty.body).not.toContain("### テスト");
    expect(empty.body).not.toContain("### 設計・保守性");

    const full = buildReviewPayload(output({ testing: "T", design: "D" }), patches, [], META);
    expect(full.body).toContain("### テスト\n\nT");
    expect(full.body).toContain("### 設計・保守性\n\nD");
  });

  it("moves findings outside the diff or on unknown files into the body", () => {
    const payload = buildReviewPayload(
      output({
        comments: [
          {
            path: "src/a.ts",
            line: 99,
            side: "RIGHT",
            severity: "major",
            category: "bug",
            body: "outside",
          },
          {
            path: "src/other.ts",
            line: 1,
            side: "RIGHT",
            severity: "minor",
            category: "design",
            body: "unknown",
          },
        ],
      }),
      patches,
      [],
      META,
    );
    expect(payload.comments).toEqual([]);
    expect(payload.body).toContain("### 差分外の指摘");
    expect(payload.body).toContain("`src/a.ts:99` outside");
    expect(payload.body).toContain("`src/other.ts:1` unknown");
  });

  it("lists skipped files and the tool usage", () => {
    const payload = buildReviewPayload(
      output(),
      patches,
      [{ filename: "big.ts", reason: "size-limit" }],
      META,
    );
    expect(payload.body).toContain("`big.ts`(サイズ上限超過)");
    expect(payload.body).toContain("ツール呼び出し7回 / 3ターン");
  });
});

function finding(overrides: Partial<PreviousFinding> = {}): PreviousFinding {
  return {
    id: "F1",
    path: "src/a.ts",
    line: 2,
    body: "**[major · bug]** 境界値で落ちる\n詳細",
    commentId: 11,
    url: "https://example.test/c/11",
    ...overrides,
  };
}

describe("buildReviewPayload follow-up", () => {
  const statuses: FindingStatus[] = [
    { finding: finding(), status: "resolved", note: "条件を修正済み" },
    {
      finding: finding({ id: "F2", commentId: null, url: null, line: null, body: "古い指摘" }),
      status: "unresolved",
      note: "まだ残っている",
    },
    { finding: finding({ id: "F3", commentId: 13, body: "未回答" }), status: "unknown", note: "" },
  ];

  it("reports the status of each previous finding right after the verdict", () => {
    const payload = buildReviewPayload(output(), patches, [], META, {
      commit: "abcdef1234567",
      statuses,
    });
    const body = payload.body;
    expect(body).toContain("### 前回の指摘の対応状況(`abcdef1`からの変更)");
    expect(body).toContain(
      "- **修正済み** [`src/a.ts:2`](https://example.test/c/11) 境界値で落ちる — 条件を修正済み",
    );
    expect(body).toContain("- **未修正** `src/a.ts` 古い指摘 — まだ残っている");
    expect(body).toContain("- **未確認** [`src/a.ts:2`](https://example.test/c/11) 未回答\n");
    expect(body.indexOf("前回の指摘")).toBeLessThan(body.indexOf("### 変更の概要"));
  });

  it("keeps unresolved previous findings and new out-of-diff findings in the marker", () => {
    const payload = buildReviewPayload(
      output({
        comments: [
          {
            path: "src/a.ts",
            line: 99,
            side: "RIGHT",
            severity: "minor",
            category: "design",
            body: "外",
          },
        ],
      }),
      patches,
      [],
      META,
      { commit: "abcdef1", statuses },
    );
    expect(parseMarker(payload.body)).toEqual([
      { path: "src/a.ts", line: null, body: "古い指摘", commentId: null, url: null },
      {
        path: "src/a.ts",
        line: 2,
        body: "未回答",
        commentId: 13,
        url: "https://example.test/c/11",
      },
      { path: "src/a.ts", line: 99, body: "**[minor · design]** 外", commentId: null, url: null },
    ]);
  });

  it("omits the section and the marker when nothing is open", () => {
    const payload = buildReviewPayload(output(), patches, [], META, {
      commit: "abcdef1",
      statuses: [],
    });
    expect(payload.body).not.toContain("前回の指摘");
    expect(payload.body).not.toContain("claude-review:open-findings");
  });
});

describe("ReviewOutputSchema", () => {
  const valid = {
    overview: "o",
    verdict: "mergeable",
    verdict_reason: "r",
    summary: "s",
    testing: "",
    design: "",
    comments: [
      { path: "a", line: 1, side: "RIGHT", severity: "nit", category: "style", body: "b" },
    ],
    previous_findings: [{ id: "F1", status: "resolved", note: "n" }],
  };

  it("converts to a JSON schema output format that parses valid output", () => {
    const format = betaZodOutputFormat(ReviewOutputSchema);
    expect(format.type).toBe("json_schema");
    expect(format.parse(JSON.stringify(valid)).comments[0]?.category).toBe("style");
  });

  it("rejects an unknown verdict or category", () => {
    const format = betaZodOutputFormat(ReviewOutputSchema);
    expect(() => format.parse(JSON.stringify({ ...valid, verdict: "lgtm" }))).toThrow();
    expect(() =>
      format.parse(
        JSON.stringify({ ...valid, comments: [{ ...valid.comments[0], category: "other" }] }),
      ),
    ).toThrow();
    expect(() =>
      format.parse(
        JSON.stringify({
          ...valid,
          previous_findings: [{ id: "F1", status: "fixed", note: "n" }],
        }),
      ),
    ).toThrow();
  });
});
