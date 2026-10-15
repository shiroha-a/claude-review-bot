import { describe, expect, it } from "vitest";
import { isCommentable, parsePatch, renderNumberedPatch } from "../src/review/diff.js";

const PATCH = [
  "@@ -10,4 +10,5 @@ function foo() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " return a;",
  "\\ No newline at end of file",
  "@@ -40,2 +41,2 @@",
  " x();",
  "-y();",
  "+z();",
].join("\n");

describe("parsePatch", () => {
  it("assigns old and new line numbers across multiple hunks", () => {
    const parsed = parsePatch(PATCH);
    expect(parsed.lines).toEqual([
      { kind: "context", oldLine: 10, newLine: 10, text: "const a = 1;" },
      { kind: "del", oldLine: 11, newLine: null, text: "const b = 2;" },
      { kind: "add", oldLine: null, newLine: 11, text: "const b = 3;" },
      { kind: "add", oldLine: null, newLine: 12, text: "const c = 4;" },
      { kind: "context", oldLine: 12, newLine: 13, text: "return a;" },
      { kind: "context", oldLine: 40, newLine: 41, text: "x();" },
      { kind: "del", oldLine: 41, newLine: null, text: "y();" },
      { kind: "add", oldLine: null, newLine: 42, text: "z();" },
    ]);
  });

  it("ignores a trailing empty line produced by the final newline", () => {
    const parsed = parsePatch("@@ -1,1 +1,1 @@\n-a\n+b\n");
    expect(parsed.lines).toHaveLength(2);
  });
});

describe("isCommentable", () => {
  const parsed = parsePatch(PATCH);

  it("accepts added and context lines on RIGHT", () => {
    expect(isCommentable(parsed, 12, "RIGHT")).toBe(true);
    expect(isCommentable(parsed, 13, "RIGHT")).toBe(true);
  });

  it("accepts removed lines on LEFT only", () => {
    expect(isCommentable(parsed, 41, "LEFT")).toBe(true);
    expect(isCommentable(parsed, 11, "LEFT")).toBe(true);
  });

  it("rejects lines outside every hunk", () => {
    expect(isCommentable(parsed, 20, "RIGHT")).toBe(false);
    expect(isCommentable(parsed, 9, "LEFT")).toBe(false);
  });

  it("rejects a new-file line number used on the LEFT side", () => {
    // 42は新ファイル側にしか存在しない
    expect(isCommentable(parsed, 42, "LEFT")).toBe(false);
  });
});

describe("renderNumberedPatch", () => {
  it("prefixes each line with old and new numbers", () => {
    const out = renderNumberedPatch(parsePatch("@@ -1,2 +1,2 @@\n a\n-b\n+c"));
    expect(out.split("\n")).toEqual(["    1     1   a", "    2     - - b", "    -     2 + c"]);
  });
});
