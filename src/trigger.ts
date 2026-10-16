import type { ReviewOptions } from "./review/reviewer.js";

export interface CommandContext {
  commentBody: string;
  commenterLogin: string;
  commenterAssociation: string;
  commenterIsBot: boolean;
  prAuthorLogin: string;
}

export type CommandDecision =
  { run: false } | { run: true; actor: "maintainer" | "author"; options: ReviewOptions };

/**
 * Decides whether a pull request comment should start a review, and how.
 * Maintainers can force a re-review of any pull request. The pull request author can
 * request one review per head commit; everyone else is ignored so that strangers
 * cannot spend the API budget.
 */
export function decideCommandTrigger(
  ctx: CommandContext,
  config: { command: string; maintainerAssociations: string[] },
): CommandDecision {
  if (ctx.commenterIsBot) return { run: false };
  if (ctx.commentBody.trim() !== config.command) return { run: false };

  if (config.maintainerAssociations.includes(ctx.commenterAssociation)) {
    return { run: true, actor: "maintainer", options: { skipDraft: false, skipIfReviewed: false } };
  }
  if (ctx.commenterLogin !== "" && ctx.commenterLogin === ctx.prAuthorLogin) {
    // 本人が明示的に依頼しているのでdraftでも実行するが、同じコミットの再レビューは不可
    return { run: true, actor: "author", options: { skipDraft: false, skipIfReviewed: true } };
  }
  return { run: false };
}
