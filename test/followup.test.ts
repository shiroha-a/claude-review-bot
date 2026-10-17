import { describe, expect, it } from "vitest";
import {
  collectPreviousFindings,
  encodeMarker,
  matchStatuses,
  parseMarker,
  stillOpen,
  type OpenFinding,
} from "../src/review/followup.js";

const OPEN: OpenFinding = {
  path: "a.ts",
  line: 3,
  body: "contains --> and 日本語",
  commentId: null,
  url: null,
};

describe("marker", () => {
  it("round-trips open findings even when a body would close an HTML comment", () => {
    const marker = encodeMarker([OPEN])!;
    expect(marker).toMatch(/^<!-- claude-review:open-findings [A-Za-z0-9+/=]+ -->$/);
    expect(parseMarker(`## Claude Review\n\ntext\n\n${marker}\n\n<sub>x</sub>`)).toEqual([OPEN]);
  });

  it("returns null when there is nothing to store", () => {
    expect(encodeMarker([])).toBeNull();
  });

  it("truncates long bodies so the review stays under the size limit", () => {
    const [stored] = parseMarker(encodeMarker([{ ...OPEN, body: "x".repeat(5000) }])!);
    expect(stored!.body).toHaveLength(1000);
  });

  it("ignores a missing, unterminated, or malformed marker", () => {
    expect(parseMarker("## Claude Review")).toEqual([]);
    expect(parseMarker("<!-- claude-review:open-findings abc")).toEqual([]);
    expect(parseMarker("<!-- claude-review:open-findings !!! -->")).toEqual([]);
    const wrongShape = Buffer.from(JSON.stringify([{ path: 1 }])).toString("base64");
    expect(parseMarker(`<!-- claude-review:open-findings ${wrongShape} -->`)).toEqual([]);
  });
});

describe("collectPreviousFindings", () => {
  it("numbers inline comments first, then carried findings, skipping duplicated threads", () => {
    const findings = collectPreviousFindings(
      [{ id: 7, path: "b.ts", line: null, body: "inline", url: "u7" }],
      [OPEN, { ...OPEN, body: "dup", commentId: 7, url: "u7" }, { ...OPEN, commentId: 8 }],
    );
    expect(findings).toEqual([
      { id: "F1", path: "b.ts", line: null, body: "inline", commentId: 7, url: "u7" },
      { id: "F2", ...OPEN },
      { id: "F3", ...OPEN, commentId: 8 },
    ]);
  });
});

describe("matchStatuses and stillOpen", () => {
  const findings = collectPreviousFindings([], [OPEN, { ...OPEN, line: 4 }, { ...OPEN, line: 5 }]);

  it("pairs findings by id and marks missing answers as unknown", () => {
    const statuses = matchStatuses(findings, [
      { id: "F2", status: "unresolved", note: " still there " },
      { id: "F1", status: "resolved", note: "fixed" },
      { id: "F9", status: "resolved", note: "not a finding" },
    ]);
    expect(statuses.map((s) => [s.finding.id, s.status, s.note])).toEqual([
      ["F1", "resolved", "fixed"],
      ["F2", "unresolved", "still there"],
      ["F3", "unknown", ""],
    ]);
    expect(stillOpen(statuses)).toEqual([
      { ...OPEN, line: 4 },
      { ...OPEN, line: 5 },
    ]);
  });
});
