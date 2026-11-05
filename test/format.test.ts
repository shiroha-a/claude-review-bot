import { describe, expect, it } from "vitest";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ReviewOutputSchema, type ReviewComment, type ReviewOutput } from "../src/review/claude.js";
import { parsePatch } from "../src/review/diff.js";
import { parseMarker, type FindingStatus, type PreviousFinding } from "../src/review/followup.js";
import { buildReviewPayload, effectiveVerdict } from "../src/review/format.js";

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
    checked_clean: [],
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
            confidence: "confirmed",
            failure_scenario: [],
            pre_existing: false,
            body: "n",
          },
          {
            path: "src/a.ts",
            line: 2,
            side: "RIGHT",
            severity: "critical",
            category: "bug",
            confidence: "confirmed",
            failure_scenario: [],
            pre_existing: false,
            body: "c",
          },
          {
            path: "src/a.ts",
            line: 2,
            side: "LEFT",
            severity: "minor",
            category: "test",
            confidence: "confirmed",
            failure_scenario: [],
            pre_existing: false,
            body: "m",
          },
        ],
      }),
      patches,
      [],
      META,
    );
    expect(payload.comments).toEqual([
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "**[critical · bug · confirmed]** c" },
      { path: "src/a.ts", line: 2, side: "LEFT", body: "**[minor · test · confirmed]** m" },
      { path: "src/a.ts", line: 1, side: "RIGHT", body: "**[nit · style · confirmed]** n" },
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
            confidence: "confirmed",
            failure_scenario: [],
            pre_existing: false,
            body: "outside",
          },
          {
            path: "src/other.ts",
            line: 1,
            side: "RIGHT",
            severity: "minor",
            category: "design",
            confidence: "confirmed",
            failure_scenario: [],
            pre_existing: false,
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

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: "src/a.ts",
    line: 2,
    side: "RIGHT",
    severity: "major",
    category: "bug",
    confidence: "confirmed",
    body: "本文",
    failure_scenario: [],
    pre_existing: false,
    ...overrides,
  };
}

describe("buildReviewPayload deep review rules", () => {
  it("appends the failure scenario as a numbered list, skipping blank steps", () => {
    const payload = buildReviewPayload(
      output({ comments: [comment({ failure_scenario: ["空配列を渡す", " ", "2行目で落ちる"] })] }),
      patches,
      [],
      META,
    );
    expect(payload.comments[0]!.body).toBe(
      "**[major · bug · confirmed]** 本文\n\n**失敗シナリオ**\n1. 空配列を渡す\n2. 2行目で落ちる",
    );
  });

  it("indents the scenario of an out-of-diff finding so it stays inside the list item", () => {
    const { body } = buildReviewPayload(
      output({ comments: [comment({ line: 99, failure_scenario: ["手順"] })] }),
      patches,
      [],
      META,
    );
    expect(body).toContain(
      "- **[major · bug · confirmed]** `src/a.ts:99` 本文\n  \n  **失敗シナリオ**\n  1. 手順",
    );
  });

  it("drops unverified findings below major and notes how many were dropped", () => {
    const payload = buildReviewPayload(
      output({
        comments: [
          comment({ confidence: "possible", severity: "minor", body: "drop-minor" }),
          comment({ confidence: "possible", severity: "nit", body: "drop-nit" }),
          comment({ confidence: "possible", severity: "major", body: "keep-major" }),
          comment({ confidence: "possible", severity: "critical", body: "keep-critical" }),
          comment({ confidence: "likely", severity: "minor", body: "keep-likely" }),
        ],
      }),
      patches,
      [],
      META,
    );
    const bodies = payload.comments.map((c) => c.body).join("\n");
    expect(bodies).not.toContain("drop-");
    expect(payload.comments).toHaveLength(3);
    expect(payload.body).toContain("未検証のminor/nit 2件を除外");
  });

  it("does not mention dropped findings when nothing was dropped", () => {
    const { body } = buildReviewPayload(output({ comments: [comment()] }), patches, [], META);
    expect(body).not.toContain("除外");
  });

  it("raises a mergeable verdict when a new major or critical finding exists", () => {
    for (const severity of ["major", "critical"] as const) {
      const { body } = buildReviewPayload(
        output({
          verdict: "mergeable",
          verdict_reason: "問題なし",
          comments: [comment({ severity })],
        }),
        patches,
        [],
        META,
      );
      expect(body).toContain(
        "**判定: 要修正** — 問題なし(major以上の指摘があるため、判定を要修正にしています)",
      );
    }
  });

  it("keeps the verdict when the serious findings are pre-existing, minor, or dropped", () => {
    const cases = [
      comment({ pre_existing: true }),
      comment({ severity: "minor" }),
      comment({ severity: "minor", confidence: "possible" }),
    ];
    for (const c of cases) {
      const { body } = buildReviewPayload(
        output({ verdict: "mergeable", comments: [c] }),
        patches,
        [],
        META,
      );
      expect(body).toContain("**判定: マージ可**");
    }
  });

  it("never lowers the verdict", () => {
    expect(effectiveVerdict(output({ verdict: "needs_discussion" }), [])).toBe("needs_discussion");
    expect(effectiveVerdict(output({ verdict: "needs_changes" }), [])).toBe("needs_changes");
  });

  it("lists pre-existing findings in their own section, not inline and not in the marker", () => {
    const payload = buildReviewPayload(
      output({ comments: [comment({ pre_existing: true, body: "昔から" })] }),
      patches,
      [],
      META,
    );
    expect(payload.comments).toEqual([]);
    expect(payload.body).toContain(
      "### 既存の問題(このPRで持ち込まれたものではありません)\n\n- **[major · bug · confirmed]** `src/a.ts:2` 昔から",
    );
    expect(payload.body).not.toContain("差分外の指摘");
    expect(parseMarker(payload.body)).toEqual([]);
  });

  it("shows what was checked and found clean in a collapsed section", () => {
    const { body } = buildReviewPayload(
      output({ checked_clean: ["認可: 全ハンドラで確認", "  "] }),
      patches,
      [],
      META,
    );
    expect(body).toContain(
      "<details><summary>確認して問題なしと判断した点(1件)</summary>\n\n- 認可: 全ハンドラで確認\n\n</details>",
    );
    expect(buildReviewPayload(output(), patches, [], META).body).not.toContain("問題なしと判断");
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
            confidence: "confirmed",
            failure_scenario: [],
            pre_existing: false,
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
      {
        path: "src/a.ts",
        line: 99,
        body: "**[minor · design · confirmed]** 外",
        commentId: null,
        url: null,
      },
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
      {
        path: "a",
        line: 1,
        side: "RIGHT",
        severity: "nit",
        category: "style",
        confidence: "likely",
        body: "b",
        failure_scenario: ["step"],
        pre_existing: false,
      },
    ],
    checked_clean: ["c"],
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
        JSON.stringify({ ...valid, comments: [{ ...valid.comments[0], confidence: "maybe" }] }),
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
