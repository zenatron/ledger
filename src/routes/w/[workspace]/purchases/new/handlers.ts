import type { WorkspaceContext } from '$lib/ports/context';
import type { ActionEvent, LoadEvent } from '$lib/ports/handlers';
import { fail, redirect } from '@sveltejs/kit';
import * as v from 'valibot';
import { Money, InvalidMoneyError } from '$lib/domain/money/money';
import { ApprovalRoutingError } from '$lib/domain/approval/evaluate';
import { PurchaseStateError } from '$lib/domain/purchase/purchase';
import { SealError } from '$lib/domain/visibility/seal';
import { submitPurchase } from '$lib/application/purchases';
import { holdPurchase } from '$lib/application/hold';
import { setPurchaseImage } from '$lib/application/images';
import { addDays } from '$lib/domain/recurrence/rrule';
import { ImageValidationError } from '$lib/ports/image-processor';
import { listCategories, listMembers } from '$lib/repo/workspaces';
import { listBuckets } from '$lib/repo/buckets';
import { refuseBucketCharge } from '$lib/domain/bucket/scope';
import type { ApprovalPolicy } from '$lib/domain/approval/policy';
import { listAccounts } from '$lib/repo/accounts';
import {
	calDateInZone,
	compareCalDates,
	parseCalDate,
	zonedTimeToUtc
} from '$lib/domain/time/zoned';
import { fromE3, roundToE3 } from '$lib/domain/location/coords';
import type { PurchasePlace } from '$lib/domain/location/place';

/** A chosen duration → wake instant. "1 night" (<1 day) wakes at 9am tomorrow. */
function untilFromDays(now: Date, days: number, timezone: string): Date {
	if (days < 1) {
		return zonedTimeToUtc(addDays(calDateInZone(now, timezone), 1), 9, 0, timezone);
	}
	return new Date(now.getTime() + days * 86_400_000);
}

export async function load(ctx: WorkspaceContext, { params }: LoadEvent) {
	// Re-run this workspace-scoped load when the workspace in the URL changes;
	// a locals-only load declares no such dependency. See +layout.server.ts.
	void params.workspace;
	const db = ctx.db;
	const [categories, members, buckets, accounts] = await Promise.all([
		listCategories(db, ctx.workspace.id),
		listMembers(db, ctx.workspace.id),
		listBuckets(db, ctx.workspace.id, { viewerId: ctx.member.id, now: ctx.deps.clock.now() }),
		listAccounts(db, ctx.workspace.id)
	]);
	// Buckets this member is allowed to spend from. Cosmetic, not the gate:
	// `submitPurchase` refuses the same charges however the form arrives.
	const chargeScope = {
		memberId: ctx.member.id,
		ownBucketsOnly: (ctx.member.approvalPolicy as ApprovalPolicy).own_buckets_only === true
	};
	/*
	 * Whether to offer reading a *scanned* bill — the one thing the deterministic
	 * extractor can't do, because a scan has no text layer. Resolved on the server
	 * because it needs the model catalog, and it carries its own refusal wording
	 * so the UI never has to invent one. See domain/intelligence/capability-gate
	 * for why "we couldn't establish it" fails open rather than closed.
	 */
	const vision = ctx.workspace.billImportEnabled
		? await ctx.deps.capabilities.vision(ctx.workspace)
		: { allowed: false as const, reason: 'Bill import is off for this workspace.' };
	return {
		vision,
		categories: categories.map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
		// Members the purchase could be hidden from (everyone active but me).
		sealableMembers: members
			.filter((m) => m.member.status === 'active' && m.member.id !== ctx.member.id)
			.map((m) => ({ id: m.member.id, displayName: m.user.displayName })),
		maxSealDays: ctx.workspace.maxSealDays,
		billImportEnabled: ctx.workspace.billImportEnabled,
		barcodeEnabled: ctx.workspace.barcodeEnabled && ctx.deps.capabilities.barcode,
		barcodeConfigured: ctx.deps.capabilities.barcode,
		// The whole "Where" row is absent when places are off, rather than present
		// and inert: an off feature should not leave a field on the form.
		locationEnabled: ctx.workspace.locationEnabled,
		// Only offered when a provider is actually configured. Without one the row
		// still takes a pasted map link and the device's own location, so the
		// placeholder changes rather than the feature disappearing.
		geocoderEnabled: ctx.deps.capabilities.geocoder,
		// Whether to offer the optional category suggestion. Off = deterministic form.
		aiEnabled: ctx.workspace.aiMode !== 'off',
		/*
		 * How to read 03/04/2026 when the document doesn't say. Writing the month
		 * first is essentially a US convention, and the timezone is the only locale
		 * signal the workspace stores. It's a lean, not a fact — the parser flags
		 * any date it had to resolve this way so the UI can admit the doubt.
		 */
		dayFirst: !ctx.workspace.timezone.startsWith('America/'),
		// Balances ride along so the picker can show what each bucket holds and
		// warn before a charge overdraws one. Nothing here gates the submit — the
		// balance may have moved by the time it lands, and the charge is allowed
		// either way; it's friction, not a rule.
		buckets: buckets
			.filter(
				(b) => b.bucket.status === 'active' && refuseBucketCharge(b.bucket, chargeScope) === null
			)
			.map((b) => ({
				id: b.bucket.id,
				name: b.bucket.name,
				balanceMinor: b.balanceMinor,
				currency: b.bucket.currency
			})),
		// Whether this member is held to their own buckets. The picker already
		// reflects it; this is for the overdraft warning, which otherwise promises
		// the charge lands when for them it goes for approval instead.
		ownBucketsOnly: chargeScope.ownBucketsOnly,
		// Only offered once at least one card has been named; a household with none
		// never sees the field.
		accounts: accounts.map((a) => ({ id: a.id, name: a.name, last4: a.last4 }))
	};
}

const FormSchema = v.object({
	itemName: v.pipe(v.string(), v.trim(), v.minLength(1, 'What is it?'), v.maxLength(120)),
	amount: v.pipe(v.string(), v.trim(), v.minLength(1, 'How much?')),
	categoryId: v.optional(v.string()),
	note: v.optional(v.pipe(v.string(), v.maxLength(2000))),
	intent: v.picklist(['request', 'log']),
	sealUntil: v.optional(v.string()),
	spentAt: v.optional(v.string()),
	// Unlike merchantName, the place goes through the schema. A coordinate is a
	// claim about where somebody physically was, so it gets checked on the way in
	// rather than trusted because a form said so.
	latE3: v.optional(v.pipe(v.string(), v.regex(/^-?\d{1,6}$/, 'Bad location'))),
	lngE3: v.optional(v.pipe(v.string(), v.regex(/^-?\d{1,6}$/, 'Bad location'))),
	placeLabel: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(160))),
	locationSource: v.optional(v.picklist(['device', 'geocode', 'link']))
});

/**
 * The place, re-derived server-side.
 *
 * The precision guarantee is carried by the *wire format*, not by trusting the
 * client: the form sends integer millidegrees, so there is no way to express a
 * doorstep in it, and a hand-posted request is bound by the same encoding as
 * the browser. That is the load-bearing part, and it is why these fields are
 * `latE3`/`lngE3` rather than a decimal pair.
 *
 * `roundToE3` still runs here to do the rest of the job — reject anything that
 * isn't a point on Earth, and normalise — so nothing reaches the column that
 * the check constraints would have to catch.
 *
 * `'merchant'` is deliberately not an accepted source: an inherited pin is
 * something the server works out, never something a client may assert.
 */
function placeFromForm(
	f: v.InferOutput<typeof FormSchema>,
	locationEnabled: boolean
): PurchasePlace | null {
	if (!locationEnabled || !f.latE3 || !f.lngE3) return null;
	const rounded = roundToE3(fromE3({ latE3: Number(f.latE3), lngE3: Number(f.lngE3) }));
	return {
		...rounded,
		label: f.placeLabel || null,
		source: f.locationSource ?? 'device'
	};
}

export const actions = {
	default: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const form = await request.formData();
		const sealMemberIds = form.getAll('sealMemberIds').map(String);
		const parsed = v.safeParse(FormSchema, {
			...Object.fromEntries(form),
			sealMemberIds: undefined
		});
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const f = parsed.output;

		let seal;
		if (sealMemberIds.length > 0) {
			if (!f.sealUntil) return fail(400, { error: 'Pick when the seal opens' });
			const day = parseCalDate(f.sealUntil);
			if (!day) return fail(400, { error: 'Invalid seal date' });
			/*
			 * The end of that day where the household lives. This read
			 * `new Date('…T23:59:59')` — the *server's* wall clock, which in a
			 * container is UTC — so a gift sealed until someone's birthday opened
			 * at 4pm the day before in California and the next morning in Tokyo.
			 * 23:59 matches what the MCP tool has always used.
			 */
			const until = zonedTimeToUtc(day, 23, 59, ctx.workspace.timezone);
			seal = { sealedUntil: until, sealedFromMemberIds: sealMemberIds };
		} else if (f.sealUntil) {
			return fail(400, { error: 'Pick who the purchase is hidden from' });
		}

		/*
		 * Back-date a logged purchase. Only for the log path — a request hasn't
		 * happened, so a date on it is meaningless and ignored. "Today" is left as
		 * undefined so the app stamps the precise `now`; only a genuinely earlier
		 * date sets completedAt, which is what analytics buckets on. Noon in the
		 * workspace's zone keeps the instant on the intended calendar day either
		 * side of a DST change.
		 */
		let spentAt: Date | undefined;
		if (f.intent === 'log' && f.spentAt) {
			const picked = parseCalDate(f.spentAt);
			if (!picked) return fail(400, { error: 'Invalid purchase date' });
			const today = calDateInZone(ctx.deps.clock.now(), ctx.workspace.timezone);
			const cmp = compareCalDates(picked, today);
			if (cmp > 0) {
				return fail(400, { error: "You can't log a purchase in the future" });
			}
			if (cmp < 0) {
				spentAt = zonedTimeToUtc(picked, 12, 0, ctx.workspace.timezone);
			}
		}

		let place;
		try {
			place = placeFromForm(f, ctx.workspace.locationEnabled);
		} catch {
			// roundToE3 throws on anything that isn't a coordinate. The regex above
			// already caught the shape, so reaching here means a value in range for
			// six digits but not for the world — refuse it rather than clamp.
			return fail(400, { error: "That location isn't a place on Earth" });
		}

		let purchaseId: string;
		try {
			const amount = Money.fromDecimal(f.amount, ctx.workspace.currency);
			({ purchaseId } = await submitPurchase(
				ctx.db,
				ctx.deps,
				{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
				{
					itemName: f.itemName,
					amount,
					categoryId: f.categoryId || null,
					note: f.note?.trim() || null,
					intent: f.intent,
					spentAt,
					seal,
					merchantName: form.get('merchantName')?.toString()?.trim() || null,
					bucketId: form.get('bucketId')?.toString()?.trim() || null,
					accountId: form.get('accountId')?.toString()?.trim() || null,
					place
				}
			));
		} catch (e) {
			if (
				e instanceof InvalidMoneyError ||
				e instanceof PurchaseStateError ||
				e instanceof ApprovalRoutingError ||
				e instanceof SealError
			) {
				return fail(400, { error: e.message });
			}
			throw e;
		}

		// "Sleep on it" at creation: submit as a normal request above, then put it
		// straight to sleep. Waking restores it to whatever it resolved to (pending
		// for approval, or approved if it was exempt) — see wake() in the domain.
		const sleepDays = Number(form.get('sleepDays'));
		if (Number.isFinite(sleepDays) && sleepDays > 0) {
			try {
				await holdPurchase(
					ctx.db,
					ctx.deps,
					{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
					purchaseId,
					untilFromDays(ctx.deps.clock.now(), sleepDays, ctx.workspace.timezone)
				);
			} catch (e) {
				if (!(e instanceof PurchaseStateError)) throw e;
			}
		}

		// Optional photo attached at creation. The purchase already exists, so a
		// bad image is not fatal — skip it (the detail page can add one later).
		const photo = form.get('photo');
		if (photo instanceof File && photo.size > 0) {
			try {
				await setPurchaseImage(
					ctx.db,
					ctx.deps,
					{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
					purchaseId,
					new Uint8Array(await photo.arrayBuffer())
				);
			} catch (e) {
				if (!(e instanceof ImageValidationError) && !(e instanceof PurchaseStateError)) throw e;
			}
		}

		redirect(303, `/w/${ctx.workspace.slug}/purchases/${purchaseId}`);
	}
};
