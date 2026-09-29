import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getImport, listLines, matchCandidates } from '$lib/repo/statements';
import {
	ReconcileError,
	closeImport,
	confirmMatch,
	createPurchaseFromLine,
	ignoreLine,
	linkManually,
	reopenImport,
	unignoreLine,
	unlinkMatch
} from '$lib/application/reconcile';
import { getNotifier } from '$lib/server/notify';
import { isMalformedInputError } from '$lib/server/db/errors';
import { PurchaseStateError } from '$lib/domain/purchase/purchase';
import { ApprovalRoutingError } from '$lib/domain/approval/evaluate';
import { getLlmAssist } from '$lib/infra/llm';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { systemClock } from '$lib/infra/time/system-clock';
import type { Actions, PageServerLoad } from './$types';

const deps = { clock: systemClock, ids: uuidv7 };

const DAY_MS = 86_400_000;

export const load: PageServerLoad = async ({ locals, params }) => {
	void params.workspace;
	const db = getDb();
	const ws = locals.workspace!;
	const now = systemClock.now();
	const scope = { workspaceId: ws.id, viewerId: locals.member!.id };

	const imp = await getImport(db, ws.id, params.importId);
	if (!imp) error(404, 'That import no longer exists.');

	const lines = await listLines(db, scope, imp.id, now);

	/*
	 * Purchases still available to link by hand. Offered over the statement's
	 * whole period plus a week either side — wider than the auto-matcher's
	 * three-day tolerance, because a person linking by hand knows something the
	 * matcher doesn't and shouldn't be boxed in by its caution.
	 *
	 * Seal-filtered by `matchCandidates`, so this list can never become a way to
	 * discover a concealed purchase.
	 */
	const from = new Date((imp.periodStart ?? now).getTime() - 7 * DAY_MS);
	const to = new Date((imp.periodEnd ?? now).getTime() + 7 * DAY_MS);
	const candidates = await matchCandidates(db, scope, from, to, now);

	return {
		currency: ws.currency,
		/*
		 * Whether to offer "Help me find this" at all. `assist.available` is the
		 * real gate everywhere in this app — not a workspace flag — and it is false
		 * whenever the layer is off or misconfigured, which is the default. With it
		 * false the review screen is exactly what it was: a shortlist, a search, and
		 * a person.
		 */
		assistAvailable: getLlmAssist({
			aiMode: ws.aiMode,
			aiEndpoint: ws.aiEndpoint,
			aiModel: ws.aiModel,
			aiApiKey: ws.aiApiKey
		}).available,
		import: {
			id: imp.id,
			filename: imp.filename,
			createdAt: imp.createdAt.toISOString(),
			lineCount: imp.lineCount,
			periodStart: imp.periodStart?.toISOString() ?? null,
			periodEnd: imp.periodEnd?.toISOString() ?? null,
			modelRead: imp.modelRead,
			closed: imp.status === 'reconciled',
			accountId: imp.accountId
		},
		lines: lines.map((l) => ({
			id: l.id,
			postedAt: l.postedAt.toISOString(),
			amountMinor: l.amountMinor,
			currency: l.currency,
			rawDescription: l.rawDescription,
			matchState: l.matchState,
			matchReason: l.matchReason,
			suggestions: l.suggestions.map((p) => ({
				id: p.id,
				itemName: p.itemName,
				merchantName: p.merchantName,
				categoryIcon: p.categoryIcon,
				completedAt: p.completedAt?.toISOString() ?? null,
				amountMinor: p.amountMinor
			})),
			purchase: l.purchase
				? {
						id: l.purchase.id,
						itemName: l.purchase.itemName,
						merchantName: l.purchase.merchantName,
						categoryIcon: l.purchase.categoryIcon,
						completedAt: l.purchase.completedAt?.toISOString() ?? null,
						amountMinor: l.purchase.amountMinor
					}
				: null
		})),
		candidates: candidates.map((c) => ({
			id: c.id,
			amountMinor: c.amountMinor,
			completedAt: c.completedAt.toISOString(),
			itemName: c.itemName,
			merchantName: c.merchantName
		}))
	};
};

/** Every action takes a lineId and reports ReconcileError as a form failure. */
function scopeOf(locals: App.Locals) {
	return { workspaceId: locals.workspace!.id, memberId: locals.member!.id };
}

/**
 * The errors an action here can answer with a message rather than a 500:
 * reconciliation's own refusals, and — since "create" goes through
 * `submitPurchase` — the purchase rules it can trip (no approver to route to, a
 * category that isn't this workspace's). A line or purchase id that isn't an id
 * at all is a line that doesn't exist.
 */
function refusal(e: unknown) {
	if (
		e instanceof ReconcileError ||
		e instanceof PurchaseStateError ||
		e instanceof ApprovalRoutingError
	) {
		return fail(400, { error: e.message });
	}
	if (isMalformedInputError(e)) return fail(400, { error: "That line doesn't exist any more." });
	throw e;
}

async function run(fn: () => Promise<void>) {
	try {
		await fn();
		return { ok: true };
	} catch (e) {
		return refusal(e);
	}
}

export const actions: Actions = {
	confirm: async ({ request, locals }) => {
		const id = String((await request.formData()).get('lineId') ?? '');
		return run(() => confirmMatch(getDb(), deps, scopeOf(locals), id));
	},
	unlink: async ({ request, locals }) => {
		const id = String((await request.formData()).get('lineId') ?? '');
		return run(() => unlinkMatch(getDb(), deps, scopeOf(locals), id));
	},
	link: async ({ request, locals }) => {
		const form = await request.formData();
		const id = String(form.get('lineId') ?? '');
		const purchaseId = String(form.get('purchaseId') ?? '');
		if (!purchaseId) return fail(400, { error: 'Pick a purchase to link.' });
		return run(() => linkManually(getDb(), deps, scopeOf(locals), id, purchaseId));
	},
	ignore: async ({ request, locals }) => {
		const id = String((await request.formData()).get('lineId') ?? '');
		return run(() => ignoreLine(getDb(), deps, scopeOf(locals), id));
	},
	unignore: async ({ request, locals }) => {
		const id = String((await request.formData()).get('lineId') ?? '');
		return run(() => unignoreLine(getDb(), deps, scopeOf(locals), id));
	},
	// The new door, and the one the modelRead column has been waiting for. The
	// application layer carries the guard; the route only passes the person's
	// optional edits through.
	create: async ({ request, locals }) => {
		const form = await request.formData();
		const id = String(form.get('lineId') ?? '');
		const itemName = String(form.get('itemName') ?? '').trim() || null;
		const categoryId = String(form.get('categoryId') ?? '').trim() || null;
		try {
			const r = await createPurchaseFromLine(
				getDb(),
				{ ...deps, notifier: getNotifier() },
				scopeOf(locals),
				id,
				{ itemName, categoryId }
			);
			return {
				ok: true,
				created: true,
				pending: r.state === 'pending_approval'
			};
		} catch (e) {
			return refusal(e);
		}
	},
	close: async ({ locals, params }) =>
		run(() => closeImport(getDb(), deps, scopeOf(locals), params.importId)),
	reopen: async ({ locals, params }) =>
		run(() => reopenImport(getDb(), deps, scopeOf(locals), params.importId))
};
