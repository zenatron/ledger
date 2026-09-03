/**
 * Behavioural hints for every MCP tool.
 *
 * A client uses these to decide what it may call freely and what it must stop
 * and ask a human about. Without them every tool looks alike over the wire, and
 * `list_categories` is indistinguishable from `move_bucket_money` — which
 * pushes the whole judgement onto the model's reading of a description string.
 * That is the wrong place for it. The judgement belongs here, next to the code
 * that does the thing.
 *
 * Three rules, applied in order:
 *
 * 1. **A read tool is read-only and idempotent.** It cannot change anything, so
 *    calling it twice is calling it once.
 * 2. **Anything that writes is not read-only,** and is assumed *destructive*
 *    unless it is named below as safe. Defaulting to destructive is
 *    the safe direction: a new tool that nobody classified gets treated with
 *    caution rather than waved through, and the test in this module's spec
 *    fails until someone decides.
 * 3. **Nothing here is open-world.** Every tool acts on this workspace's own
 *    database. None reaches the internet, so a client never needs to warn that
 *    an unknown third party is involved.
 *
 * The distinction that matters most is *additive vs destructive*, not
 * read vs write. Logging a purchase writes a row, but nothing is lost if it was
 * a mistake — you cancel it, and the audit log remembers both. Moving money
 * between buckets, deleting income, or unsealing a gift changes or reveals
 * something that was already there. The second kind is what a client should
 * pause on.
 */

import type { ApiScope } from '$lib/server/repo/api-tokens';

export interface ToolAnnotations {
	/** Never modifies anything. */
	readOnlyHint: boolean;
	/** May change or remove something that already exists. */
	destructiveHint: boolean;
	/** Calling it again with the same arguments changes nothing further. */
	idempotentHint: boolean;
	/** Reaches something outside this workspace. Always false here. */
	openWorldHint: boolean;
}

/**
 * Writers a mistaken call does not cost you anything permanent — either because
 * they only *add* something, or because they flip a state that flips straight
 * back. Both kinds can be undone in one move, and the audit log keeps both
 * halves of the story, so a client should not stop and ask about them.
 *
 * Pausing a bucket belongs here for the same reason logging a purchase does:
 * getting it wrong costs a tap. Marking every state change destructive would be
 * technically defensible and practically useless — a client that prompts on
 * `resume_bucket` teaches people to click through prompts, which is how the
 * prompt on `move_bucket_money` stops being read.
 */
const SAFE_WRITES = new Set([
	// Additive: nothing existed before the call.
	'log_purchase',
	'request_purchase',
	'create_recurring',
	'create_bucket',
	'add_income',
	'sleep_on_purchase',
	// Reversible in one move, losing nothing.
	'pause_recurring',
	'resume_recurring',
	'restart_recurring',
	'pause_bucket',
	'resume_bucket',
	'wake_purchase',
	'extend_hold'
]);

/**
 * Writers whose second call is a no-op. A paused bucket that is paused again is
 * still just paused — worth saying, because it tells a client a retry after a
 * dropped connection is safe.
 */
const IDEMPOTENT_WRITES = new Set([
	'pause_recurring',
	'resume_recurring',
	'end_recurring',
	'restart_recurring',
	'pause_bucket',
	'resume_bucket',
	'archive_bucket',
	'set_budget',
	'wake_purchase',
	'let_go_purchase',
	'unseal_purchase',
	'cancel_purchase',
	'approve_purchase',
	'deny_purchase'
]);

export function annotationsFor(tool: { name: string; scope: ApiScope }): ToolAnnotations {
	if (tool.scope === 'read') {
		return {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		};
	}
	return {
		readOnlyHint: false,
		destructiveHint: !SAFE_WRITES.has(tool.name),
		idempotentHint: IDEMPOTENT_WRITES.has(tool.name),
		openWorldHint: false
	};
}

/** Every name this module classifies, for the test that keeps it honest. */
export const CLASSIFIED = { SAFE_WRITES, IDEMPOTENT_WRITES };
