import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt } from "../src/review/prompt.js";
import { REVIEW_GUIDES, TOOL_DEFINITIONS } from "../src/review/tools.js";

describe("buildSystemPrompt", () => {
  it("is byte-stable for a language so the prompt cache prefix is shared", () => {
    expect(buildSystemPrompt("Japanese")).toBe(buildSystemPrompt("Japanese"));
    expect(buildSystemPrompt("Japanese")).not.toBe(buildSystemPrompt("English"));
  });

  it("names every tool and every review guide the model can use", () => {
    const prompt = buildSystemPrompt("Japanese");
    for (const tool of TOOL_DEFINITIONS) expect(prompt).toContain(tool.name);
    for (const guide of REVIEW_GUIDES) expect(prompt).toContain(`"${guide}"`);
  });
});

describe("buildUserPrompt guidelines", () => {
  const base = { repo: "o/r", title: "t", body: "b", files: [], skippedFiles: [] };
  const guidelines = {
    commit: "base1",
    files: [
      { path: "CLAUDE.md", content: "Rule A.\n\n", truncated: false },
      { path: "src/AGENTS.md", content: "Rule B", truncated: true },
    ],
    omitted: ["docs/CONTRIBUTING.md"],
    changedInPull: ["CLAUDE.md"],
  };

  it("renders each document with its path, truncation, omissions, and changes in the PR", () => {
    const user = buildUserPrompt({ ...base, guidelines });
    expect(user).toContain('<project_guidelines commit="base1">');
    expect(user).toContain('<guideline path="CLAUDE.md">\nRule A.\n</guideline>');
    expect(user).toContain(
      '<guideline path="src/AGENTS.md" truncated="true">\nRule B\n</guideline>',
    );
    expect(user).toContain("Not shown (size limit reached):\ndocs/CONTRIBUTING.md");
    expect(user).toMatch(/changes these guideline documents[^\n]*\nCLAUDE\.md/);
    expect(user.indexOf("<project_guidelines")).toBeLessThan(user.indexOf("<diff>"));
  });

  it("omits the block when there is nothing to say", () => {
    const empty = { commit: "base1", files: [], omitted: [], changedInPull: [] };
    expect(buildUserPrompt({ ...base, guidelines: empty })).not.toContain("project_guidelines");
    expect(buildUserPrompt(base)).not.toContain("project_guidelines");
  });

  it("notes when the base has no documents but the PR adds one", () => {
    const added = { commit: "base1", files: [], omitted: [], changedInPull: ["AGENTS.md"] };
    const user = buildUserPrompt({ ...base, guidelines: added });
    expect(user).toContain("The base branch has no guideline documents.");
    expect(user).toContain("AGENTS.md");
  });
});

describe("buildSystemPrompt guidelines", () => {
  it("explains how to use project guidelines and keeps them out of the trust exception otherwise", () => {
    const prompt = buildSystemPrompt("Japanese");
    expect(prompt).toContain("## Project guidelines");
    expect(prompt).toContain("The only\nexception is <project_guidelines>");
  });
});
