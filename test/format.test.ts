import { describe, expect, it } from "vitest";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ReviewOutputSchema } from "../src/review/claude.js";
import { parsePatch } from "../src/review/diff.js";
import { buildReviewPayload } from "../src/review/format.js";

const patches = new Map([["src/a.ts", parsePatch("@@ -1,2 +1,2 @@\n a\n-b\n+c")]]);

describe("buildReviewPayload", () => {
  it("keeps commentable findings inline, sorted by severity", () => {
    const payload = buildReviewPayload(
      {
        summary: "総評",
        comments: [
          { path: "src/a.ts", line: 1, side: "RIGHT", severity: "nit", body: "n" },
          { path: "src/a.ts", line: 2, side: "RIGHT", severity: "critical", body: "c" },
          { path: "src/a.ts", line: 2, side: "LEFT", severity: "minor", body: "m" },
        ],
      },
      patches,
      [],
      "claude-opus-5-5",
    );
    expect(payload.comments).toEqual([
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "**[critical]** c" },
      { path: "src/a.ts", line: 2, side: "LEFT", body: "**[minor]** m" },
      { path: "src/a.ts", line: 1, side: "RIGHT", body: "**[nit]** n" },
    ]);
    expect(payload.body).not.toContain("差分外の指摘");
  });

  it("moves findings outside the diff or on unknown files into the body", () => {
    const payload = buildReviewPayload(
      {
        summary: "総評",
        comments: [
          { path: "src/a.ts", line: 99, side: "RIGHT", severity: "major", body: "outside" },
          { path: "src/other.ts", line: 1, side: "RIGHT", severity: "minor", body: "unknown" },
        ],
      },
      patches,
      [],
      "m",
    );
    expect(payload.comments).toEqual([]);
    expect(payload.body).toContain("### 差分外の指摘");
    expect(payload.body).toContain("`src/a.ts:99` outside");
    expect(payload.body).toContain("`src/other.ts:1` unknown");
  });

  it("lists skipped files with the reason", () => {
    const payload = buildReviewPayload(
      { summary: "s", comments: [] },
      patches,
      [{ filename: "big.ts", reason: "size-limit" }],
      "m",
    );
    expect(payload.body).toContain("`big.ts`(サイズ上限超過)");
    expect(payload.body).toContain("レビュー対象外のファイル(1件)");
  });
});

describe("ReviewOutputSchema", () => {
  it("converts to a JSON schema output format that parses valid output", () => {
    const format = betaZodOutputFormat(ReviewOutputSchema);
    expect(format.type).toBe("json_schema");
    const parsed = format.parse(
      '{"summary":"s","comments":[{"path":"a","line":1,"side":"RIGHT","severity":"nit","body":"b"}]}',
    );
    expect(parsed.comments[0]?.side).toBe("RIGHT");
  });

  it("rejects an unknown severity", () => {
    const format = betaZodOutputFormat(ReviewOutputSchema);
    expect(() =>
      format.parse(
        '{"summary":"s","comments":[{"path":"a","line":1,"side":"RIGHT","severity":"blocker","body":"b"}]}',
      ),
    ).toThrow();
  });
});
