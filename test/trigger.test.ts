import { describe, expect, it } from "vitest";
import { decideCommandTrigger, type CommandContext } from "../src/trigger.js";

const CONFIG = { command: "/review", maintainerAssociations: ["OWNER", "MEMBER", "COLLABORATOR"] };

function ctx(overrides: Partial<CommandContext>): CommandContext {
  return {
    commentBody: "/review",
    commenterLogin: "alice",
    commenterAssociation: "CONTRIBUTOR",
    commenterIsBot: false,
    prAuthorLogin: "alice",
    ...overrides,
  };
}

describe("decideCommandTrigger", () => {
  it("lets a maintainer force a review on any pull request", () => {
    const decision = decideCommandTrigger(
      ctx({ commenterLogin: "maint", commenterAssociation: "MEMBER", prAuthorLogin: "alice" }),
      CONFIG,
    );
    expect(decision).toEqual({
      run: true,
      actor: "maintainer",
      options: { skipDraft: false, skipIfReviewed: false },
    });
  });

  it("lets the pull request author request one review per commit", () => {
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
      const decision = decideCommandTrigger(ctx({ commenterAssociation: association }), CONFIG);
      expect(decision).toEqual({
        run: true,
        actor: "author",
        options: { skipDraft: false, skipIfReviewed: true },
      });
    }
  });

  it("ignores non-maintainers commenting on someone else's pull request", () => {
    const decision = decideCommandTrigger(
      ctx({ commenterLogin: "mallory", prAuthorLogin: "alice" }),
      CONFIG,
    );
    expect(decision).toEqual({ run: false });
  });

  it("ignores bots even when they are maintainers or the author", () => {
    const decision = decideCommandTrigger(
      ctx({ commenterIsBot: true, commenterAssociation: "MEMBER" }),
      CONFIG,
    );
    expect(decision).toEqual({ run: false });
  });

  it("requires the comment to be exactly the command", () => {
    expect(decideCommandTrigger(ctx({ commentBody: "  /review\n" }), CONFIG).run).toBe(true);
    expect(decideCommandTrigger(ctx({ commentBody: "please /review" }), CONFIG).run).toBe(false);
    expect(decideCommandTrigger(ctx({ commentBody: "/reviewed" }), CONFIG).run).toBe(false);
  });

  it("does not match an empty author login against an empty commenter login", () => {
    // ユーザーが削除済み(ghost)で双方のloginが取れないケースを本人扱いしない
    const decision = decideCommandTrigger(ctx({ commenterLogin: "", prAuthorLogin: "" }), CONFIG);
    expect(decision).toEqual({ run: false });
  });
});
