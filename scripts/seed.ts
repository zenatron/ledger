/**
 * Dev seed: demo workspace with two members and ~12 months of historical
 * data — purchases, income, recurring rules, budgets — so every feature
 * (especially analytics) has rich data.
 *
 *   DATABASE_URL=postgres://... bun scripts/seed.ts
 *
 * Idempotent: refuses if the demo workspace already exists.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../src/lib/db/schema';
import { parseRRule, nextOccurrence } from '../src/lib/domain/recurrence/rrule';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

const uuid = () => crypto.randomUUID();
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);

// A rule's real next occurrence from today, so demo "next" dates land on the
// rule's own day-of-month rather than an arbitrary offset (which read as a bug:
// "every month on the 10th · next Jul 23"). Noon UTC keeps it clear of any
// timezone's midnight boundary. Mirrors how the app derives nextOccurrenceAt.
const todayCal = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
const nextOccurrenceOf = (rrule: string): Date => {
	const o = nextOccurrence(parseRRule(rrule), todayCal);
	return new Date(Date.UTC(o.y, o.m - 1, o.d, 12, 0, 0));
};

const existing = await db
	.select({ id: schema.workspace.id })
	.from(schema.workspace)
	.where(eq(schema.workspace.slug, 'demo'));
if (existing.length > 0) {
	console.log('demo workspace already exists — nothing to do');
	await client.end();
	process.exit(0);
}

async function upsertUser(sub: string, email: string, name: string): Promise<string> {
	const rows = await db
		.insert(schema.user)
		.values({
			id: uuid(),
			oidcSubject: sub,
			email,
			displayName: name,
			createdAt: now,
			lastLoginAt: null
		})
		.onConflictDoUpdate({ target: schema.user.oidcSubject, set: { email } })
		.returning({ id: schema.user.id });
	return rows[0].id;
}

const aliceId = await upsertUser('sub-alice-001', 'alice@example.com', 'Alice Test');
const bobId = await upsertUser('sub-bob-002', 'bob@example.com', 'Bob Test');
// The DEV_MODE auto-login user (hooks.server.ts, oidcSubject 'dev-user'): a
// dev server run and the screenshot capture both arrive as this person, so
// they must be a member or every /w/demo page 404s. Owner, because half the
// captured screens (members, API, notifications, AI assist) are owner-only.
const devUserId = await upsertUser('dev-user', 'dev@test.local', 'Dev User');

const wsId = uuid();
await db.insert(schema.workspace).values({
	id: wsId,
	slug: 'demo',
	name: 'Demo Household',
	ownerUserId: aliceId,
	currency: 'USD',
	timezone: 'America/New_York',
	maxSealDays: 30,
	reapprovalThresholdPct: 20,
	accentColor: '#FF9F0A',
	// The map 403s with places off, and the screenshot pass captures it.
	locationEnabled: true,
	createdAt: now
});

const aliceMember = uuid();
const bobMember = uuid();
const devMember = uuid();
await db.insert(schema.workspaceMember).values([
	{
		id: aliceMember,
		workspaceId: wsId,
		userId: aliceId,
		role: 'owner',
		approvalPolicy: { mode: 'none', routing: { mode: 'any_of', approver_ids: [] } },
		status: 'active',
		joinedAt: now
	},
	{
		id: bobMember,
		workspaceId: wsId,
		userId: bobId,
		role: 'member',
		approvalPolicy: {
			mode: 'threshold',
			threshold_minor: 5000,
			category_overrides: [],
			routing: { mode: 'any_of', approver_ids: [aliceMember] }
		},
		status: 'active',
		joinedAt: now
	},
	{
		id: devMember,
		workspaceId: wsId,
		userId: devUserId,
		role: 'owner',
		approvalPolicy: { mode: 'none', routing: { mode: 'any_of', approver_ids: [] } },
		status: 'active',
		joinedAt: now
	}
]);

const cats = [
	{ name: 'Groceries', icon: '\u{1F6D2}', color: '#22c55e' },
	{ name: 'Dining', icon: '\u{1F35C}', color: '#f97316' },
	{ name: 'Entertainment', icon: '\u{1F3AC}', color: '#ec4899' },
	{ name: 'Utilities', icon: '\u{1F4A1}', color: '#64748b' },
	{ name: 'Transport', icon: '\u{1F698}', color: '#3b82f6' },
	{ name: 'Shopping', icon: '\u{1F6CD}', color: '#8b5cf6' },
	{ name: 'Health', icon: '\u{1F3E5}', color: '#ef4444' },
	{ name: 'Travel', icon: '\u{2708}', color: '#06b6d4' }
].map((c) => ({ id: uuid(), workspaceId: wsId, ...c, isBuiltIn: true }));
await db.insert(schema.category).values(cats);
const catIds = cats.map((c) => c.id);

const catId = (n: number) => catIds[n];

const rng = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// ── Helpers ──────────────────────────────────────────────────────────
async function addPurchase(opts: {
	member: string;
	state: string;
	item: string;
	catIdx: number;
	minor: bigint;
	day: number;
	note?: string | null;
	finalMinor?: bigint | null;
	sealedFrom?: string[] | null;
	sealUntilDay?: number | null;
	recurringRuleId?: string | null;
	nudgeCount?: number;
	lastNudgedAt?: Date | null;
	approvedMinor?: bigint | null;
	place?: { label: string; latE3: number; lngE3: number } | null;
}) {
	const id = uuid();
	await db.insert(schema.purchase).values({
		id,
		workspaceId: wsId,
		memberId: opts.member,
		state: opts.state as any,
		itemName: opts.item,
		note: opts.note ?? null,
		categoryId: catId(opts.catIdx),
		merchantId: null,
		requestedAmountMinor: opts.minor,
		approvedAmountMinor: opts.approvedMinor ?? null,
		finalAmountMinor:
			opts.finalMinor ??
			(opts.state === 'completed' || opts.state === 'refunded' ? opts.minor : null),
		currency: 'USD',
		sealedUntil: opts.sealUntilDay ? daysAgo(opts.sealUntilDay) : null,
		sealedFromMemberIds: opts.sealedFrom ?? [],
		requestedAt: opts.state !== 'draft' ? daysAgo(opts.day + 0.5) : null,
		decidedAt: ['approved', 'denied', 'completed', 'refunded'].includes(opts.state)
			? daysAgo(opts.day + 0.25)
			: null,
		completedAt: ['completed', 'refunded'].includes(opts.state) ? daysAgo(opts.day) : null,
		lastNudgedAt: opts.lastNudgedAt ?? null,
		nudgeCount: opts.nudgeCount ?? 0,
		recurringRuleId: opts.recurringRuleId ?? null,
		parentPurchaseId: null,
		placeLabel: opts.place?.label ?? null,
		latE3: opts.place?.latE3 ?? null,
		lngE3: opts.place?.lngE3 ?? null,
		locationSource: opts.place ? 'geocode' : null,
		createdAt: daysAgo(opts.day),
		updatedAt: daysAgo(opts.day)
	});
	return id;
}

async function addEvent(
	pId: string,
	member: string,
	from: string | null,
	to: string,
	at: Date,
	reason?: string,
	amount?: bigint
) {
	await db.insert(schema.approvalEvent).values({
		id: uuid(),
		purchaseId: pId,
		actorMemberId: member,
		fromState: from as any,
		toState: to as any,
		reason: reason ?? null,
		amountSnapshotMinor: amount ?? null,
		createdAt: at
	});
}

async function addApprover(pId: string, memberId: string, required: boolean) {
	await db
		.insert(schema.purchaseApprover)
		.values({ purchaseId: pId, memberId, isRequired: required });
}

// ── Recurring Rules ──────────────────────────────────────────────────
const recRent = uuid();
const recNetflix = uuid();
const recGym = uuid();
const recInternet = uuid();
const recPhone = uuid();

await db.insert(schema.recurringRule).values(
	[
		{
			id: recRent,
			workspaceId: wsId,
			memberId: aliceMember,
			itemName: 'Rent',
			categoryId: catId(3),
			merchantId: null,
			amountMinor: 1_800_00n,
			currency: 'USD',
			rrule: 'DTSTART=2025-07-01;FREQ=MONTHLY;BYMONTHDAY=1',
			lastGeneratedAt: daysAgo(32),
			status: 'active' as any,
			autoComplete: false,
			endedAt: null
		},
		{
			id: recNetflix,
			workspaceId: wsId,
			memberId: aliceMember,
			itemName: 'Netflix',
			categoryId: catId(2),
			merchantId: null,
			amountMinor: 15_49n,
			currency: 'USD',
			rrule: 'DTSTART=2025-07-03;FREQ=MONTHLY;BYMONTHDAY=3',
			lastGeneratedAt: daysAgo(33),
			status: 'active' as any,
			autoComplete: false,
			endedAt: null
		},
		{
			id: recGym,
			workspaceId: wsId,
			memberId: bobMember,
			itemName: 'Gym membership',
			categoryId: catId(6),
			merchantId: null,
			amountMinor: 49_99n,
			currency: 'USD',
			rrule: 'DTSTART=2025-07-05;FREQ=MONTHLY;BYMONTHDAY=5',
			lastGeneratedAt: daysAgo(36),
			status: 'active' as any,
			autoComplete: false,
			endedAt: null
		},
		{
			id: recInternet,
			workspaceId: wsId,
			memberId: aliceMember,
			itemName: 'Internet',
			categoryId: catId(3),
			merchantId: null,
			amountMinor: 79_99n,
			currency: 'USD',
			rrule: 'DTSTART=2025-07-10;FREQ=MONTHLY;BYMONTHDAY=10',
			lastGeneratedAt: daysAgo(40),
			status: 'active' as any,
			autoComplete: false,
			endedAt: null
		},
		{
			id: recPhone,
			workspaceId: wsId,
			memberId: bobMember,
			itemName: 'Phone bill',
			categoryId: catId(3),
			merchantId: null,
			amountMinor: 85_00n,
			currency: 'USD',
			rrule: 'DTSTART=2025-07-12;FREQ=MONTHLY;BYMONTHDAY=12',
			lastGeneratedAt: daysAgo(42),
			status: 'active' as any,
			autoComplete: false,
			endedAt: null
		}
	].map((r) => ({ ...r, nextOccurrenceAt: nextOccurrenceOf(r.rrule) }))
);

// ── Generate monthly recurring purchases ─────────────────────────────
const recurringPatterns: {
	member: string;
	item: string;
	cat: number;
	minor: bigint;
	ruleId: string;
	dayOffset: number;
}[] = [
	{ member: aliceMember, item: 'Rent', cat: 3, minor: 1_800_00n, ruleId: recRent, dayOffset: 1 },
	{ member: aliceMember, item: 'Netflix', cat: 2, minor: 15_49n, ruleId: recNetflix, dayOffset: 3 },
	{
		member: bobMember,
		item: 'Gym membership',
		cat: 6,
		minor: 49_99n,
		ruleId: recGym,
		dayOffset: 5
	},
	{
		member: aliceMember,
		item: 'Internet',
		cat: 3,
		minor: 79_99n,
		ruleId: recInternet,
		dayOffset: 10
	},
	{ member: bobMember, item: 'Phone bill', cat: 3, minor: 85_00n, ruleId: recPhone, dayOffset: 12 }
];

let recCount = 0;
for (let month = 1; month <= 12; month++) {
	for (const rp of recurringPatterns) {
		const day = month * 30 - rp.dayOffset;
		if (day < 5) continue; // skip very recent ones
		const id = await addPurchase({
			member: rp.member,
			state: 'completed',
			item: rp.item,
			catIdx: rp.cat,
			minor: rp.minor,
			day,
			recurringRuleId: rp.ruleId
		});
		await addEvent(id, rp.member, 'draft', 'completed', daysAgo(day));
		recCount++;
	}
}

// ── Manual completed purchases across ~360 days ──────────────────────
const groceriesItems = [
	'Weekly groceries',
	'Whole Foods run',
	"Trader Joe's",
	"Farmer's market",
	'Costco bulk',
	'Aldi run'
];
const diningItems = [
	'Takeout ramen',
	'Sushi night',
	'Pizza delivery',
	'Brunch with friends',
	'Coffee shop',
	'Burger joint',
	'Tacos',
	'Thai takeout',
	'Italian dinner'
];
const entertainmentItems = [
	'Movie tickets',
	'Concert tickets',
	'Streaming services',
	'Video game',
	'Spotify',
	'Book store',
	'Board game',
	'Museum tickets'
];
const transportItems = [
	'Gas station',
	'Parking garage',
	'Uber ride',
	'Subway pass',
	'Bus fare',
	'Bike repair'
];
const shoppingItems = [
	'Amazon order',
	'New shoes',
	'Clothes shopping',
	'Home decor',
	'Kitchen gadget',
	'Office supplies'
];
const healthItems = ['Pharmacy', 'Dentist co-pay', 'Protein powder', 'Vitamins', 'Doctor visit'];
const travelItems = [
	'Weekend trip hotel',
	'Flight booking',
	'Airbnb',
	'Rental car',
	'Travel insurance'
];

function monthlyPurchases(monthAgo: number, memberId: string) {
	const baseDay = monthAgo * 30;
	// Groceries: 4-5 trips per month
	for (let w = 0; w < rng(3, 5); w++) {
		const d = baseDay - rng(0, 6) - w * 7;
		if (d < 5) continue;
		const minor = BigInt(rng(4000, 18000));
		addPurchase({
			member: memberId,
			state: 'completed',
			item: pick(groceriesItems),
			catIdx: 0,
			minor,
			day: d
		}).then((id) => addEvent(id, memberId, 'draft', 'completed', daysAgo(d)));
	}
	// Dining: 3-5 times per month
	for (let w = 0; w < rng(2, 4); w++) {
		const d = baseDay - rng(0, 8) - w * 7;
		if (d < 5) continue;
		const minor = BigInt(rng(800, 9000));
		addPurchase({
			member: memberId,
			state: 'completed',
			item: pick(diningItems),
			catIdx: 1,
			minor,
			day: d
		}).then((id) => addEvent(id, memberId, 'draft', 'completed', daysAgo(d)));
	}
	// Entertainment: 1-2 per month
	for (let w = 0; w < rng(1, 2); w++) {
		const d = baseDay - rng(0, 10) - w * 14;
		if (d < 5) continue;
		const minor = BigInt(rng(500, 15000));
		addPurchase({
			member: memberId,
			state: 'completed',
			item: pick(entertainmentItems),
			catIdx: 2,
			minor,
			day: d
		}).then((id) => addEvent(id, memberId, 'draft', 'completed', daysAgo(d)));
	}
	// Transport: 2-4 per month
	for (let w = 0; w < rng(1, 3); w++) {
		const d = baseDay - rng(0, 5) - w * 10;
		if (d < 5) continue;
		const minor = BigInt(rng(1000, 7000));
		addPurchase({
			member: memberId,
			state: 'completed',
			item: pick(transportItems),
			catIdx: 4,
			minor,
			day: d
		}).then((id) => addEvent(id, memberId, 'draft', 'completed', daysAgo(d)));
	}
	// Shopping: 0-2 per month
	for (let w = 0; w < rng(0, 2); w++) {
		const d = baseDay - rng(0, 10);
		if (d < 5) continue;
		const minor = BigInt(rng(1000, 20000));
		addPurchase({
			member: memberId,
			state: 'completed',
			item: pick(shoppingItems),
			catIdx: 5,
			minor,
			day: d
		}).then((id) => addEvent(id, memberId, 'draft', 'completed', daysAgo(d)));
	}
	// Health: 0-1 per month
	if (rng(0, 1)) {
		const d = baseDay - rng(0, 12);
		if (d >= 5) {
			const minor = BigInt(rng(1000, 8000));
			addPurchase({
				member: memberId,
				state: 'completed',
				item: pick(healthItems),
				catIdx: 6,
				minor,
				day: d
			}).then((id) => addEvent(id, memberId, 'draft', 'completed', daysAgo(d)));
		}
	}
	// Utilities: monthly
	if (memberId === aliceMember) {
		const d = baseDay - rng(1, 5);
		if (d >= 5) {
			const elec = BigInt(rng(12000, 18000));
			addPurchase({
				member: memberId,
				state: 'completed',
				item: 'Electric bill',
				catIdx: 3,
				minor: elec,
				day: d
			}).then((id) => addEvent(id, memberId, 'draft', 'completed', daysAgo(d)));
		}
	}
}

console.log('Generating historical purchases across 12 months...');
// Generate for both members, both get their own sets of purchases
for (let m = 1; m <= 12; m++) {
	monthlyPurchases(m, aliceMember);
	monthlyPurchases(m, bobMember);
}
// Occasional travel (every 3-4 months)
for (let m = 3; m <= 12; m += rng(3, 4)) {
	const d = m * 30 - rng(0, 10);
	if (d >= 5) {
		const minor = BigInt(rng(15000, 50000));
		addPurchase({
			member: pick([aliceMember, bobMember]),
			state: 'completed',
			item: pick(travelItems),
			catIdx: 7,
			minor,
			day: d
		}).then((id) => addEvent(id, pick([aliceMember, bobMember]), 'draft', 'completed', daysAgo(d)));
	}
}

await new Promise((r) => setTimeout(r, 1000)); // let async inserts finish

// ── Special-state purchases (recent days) ───────────────────────────
await Promise.all([
	// Pending approval
	(async () => {
		const items = [
			{ member: bobMember, item: 'New monitor', cat: 5, minor: 349_99n, day: 3 },
			{
				member: bobMember,
				item: 'Office chair',
				cat: 5,
				minor: 210_00n,
				day: 6,
				nudge: 1,
				nudged: hoursAgo(12)
			},
			{
				member: bobMember,
				item: 'Standing desk',
				cat: 5,
				minor: 499_00n,
				day: 8,
				nudge: 3,
				nudged: hoursAgo(6),
				note: 'WFH setup upgrade'
			}
		];
		for (const p of items) {
			const id = await addPurchase({
				...p,
				state: 'pending_approval',
				finalMinor: null,
				nudgeCount: p.nudge ?? 0,
				lastNudgedAt: p.nudged ?? null
			});
			await addEvent(id, p.member, 'draft', 'pending_approval', daysAgo(p.day));
			await addApprover(id, aliceMember, true);
		}
	})(),
	// Approved not completed
	(async () => {
		const id = await addPurchase({
			member: bobMember,
			item: 'New headphones',
			cat: 5,
			minor: 179_99n,
			day: 9,
			state: 'approved',
			finalMinor: null,
			approvedMinor: 180_00n
		});
		await addEvent(id, bobMember, 'draft', 'pending_approval', daysAgo(9.1));
		await addApprover(id, aliceMember, true);
		await addEvent(
			id,
			aliceMember,
			'pending_approval',
			'approved',
			daysAgo(9.2),
			'Looks good',
			179_99n
		);
	})(),
	// Denied
	(async () => {
		for (const p of [
			{
				member: bobMember,
				item: 'Gaming PC',
				cat: 2,
				minor: 2_499_99n,
				day: 15,
				reason: 'Overkill for work needs'
			},
			{
				member: bobMember,
				item: 'Drone',
				cat: 5,
				minor: 799_00n,
				day: 22,
				reason: 'Not in budget right now'
			}
		]) {
			const id = await addPurchase({ ...p, state: 'denied', finalMinor: null });
			await addEvent(id, p.member, 'draft', 'pending_approval', daysAgo(p.day + 0.1));
			await addApprover(id, aliceMember, true);
			await addEvent(
				id,
				aliceMember,
				'pending_approval',
				'denied',
				daysAgo(p.day + 0.3),
				p.reason,
				p.minor
			);
		}
	})(),
	// Cancelled
	(async () => {
		const id = await addPurchase({
			member: bobMember,
			item: 'VR headset',
			cat: 2,
			minor: 399_99n,
			day: 25,
			state: 'cancelled',
			finalMinor: null
		});
		await addEvent(id, bobMember, 'draft', 'pending_approval', daysAgo(25.1));
		await addApprover(id, aliceMember, true);
		await addEvent(id, bobMember, 'pending_approval', 'cancelled', daysAgo(25.5));
	})(),
	// Sealed gift
	(async () => {
		const id = await addPurchase({
			member: bobMember,
			item: 'Birthday gift for Alice',
			cat: 5,
			minor: 150_00n,
			day: 12,
			state: 'completed',
			sealedFrom: [aliceMember],
			sealUntilDay: -3,
			note: 'Surprise! 🎁'
		});
		await addEvent(id, bobMember, 'draft', 'completed', daysAgo(12));
	})(),
	// Over-budget re-approval
	(async () => {
		const id = await addPurchase({
			member: bobMember,
			item: 'Mechanical keyboard',
			cat: 5,
			minor: 150_00n,
			day: 40,
			state: 'approved',
			finalMinor: null,
			approvedMinor: 150_00n
		});
		await addEvent(id, bobMember, 'draft', 'pending_approval', daysAgo(40.1));
		await addApprover(id, aliceMember, true);
		await addEvent(id, aliceMember, 'pending_approval', 'approved', daysAgo(40.3), 'OK', 150_00n);
		const id2 = await addPurchase({
			member: bobMember,
			item: 'Mechanical keyboard',
			cat: 5,
			minor: 210_00n,
			day: 35,
			state: 'completed',
			finalMinor: 210_00n,
			approvedMinor: 150_00n
		});
		await addEvent(
			id2,
			bobMember,
			'approved',
			'completed',
			daysAgo(35),
			'Paid more than planned',
			210_00n
		);
		// NB: overage is derived (pending + a final amount), not stored.
		// parent_purchase_id means "refund child" — see the schema comment — and
		// setting it here made this row look like a refund and blocked can.refund.
	})()
]);

// ── Income (recurring + one-offs) ───────────────────────────────────
// One recurring entry per member — the rrule expansion generates the
// monthly occurrences on the fly; no need for 12 separate entries.
await db.insert(schema.income).values([
	{
		id: uuid(),
		workspaceId: wsId,
		memberId: aliceMember,
		source: 'Salary',
		amountMinor: 5_000_00n,
		currency: 'USD',
		rrule: 'DTSTART=2025-07-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1',
		receivedAt: daysAgo(29),
		note: null
	},
	{
		id: uuid(),
		workspaceId: wsId,
		memberId: bobMember,
		source: 'Salary',
		amountMinor: 3_800_00n,
		currency: 'USD',
		rrule: 'DTSTART=2025-07-15;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15',
		receivedAt: daysAgo(15),
		note: null
	}
]);
// Extra one-off income entries
await db.insert(schema.income).values([
	{
		id: uuid(),
		workspaceId: wsId,
		memberId: bobMember,
		source: 'Freelance project',
		amountMinor: 2_200_00n,
		currency: 'USD',
		rrule: null,
		receivedAt: daysAgo(45),
		note: 'Logo design'
	},
	{
		id: uuid(),
		workspaceId: wsId,
		memberId: aliceMember,
		source: 'Tax refund',
		amountMinor: 1_500_00n,
		currency: 'USD',
		rrule: null,
		receivedAt: daysAgo(100),
		note: '2024 return'
	},
	{
		id: uuid(),
		workspaceId: wsId,
		memberId: bobMember,
		source: 'Side gig',
		amountMinor: 850_00n,
		currency: 'USD',
		rrule: null,
		receivedAt: daysAgo(160),
		note: 'Consulting'
	}
]);

// ── Budgets (monthly, overall + categories) ──────────────────────────
const budgetCats: (number | null)[] = [null, 0, 1, 2, 3, 4, 5, 6, 7];
const monthlyBudgetAmounts: Record<number, bigint> = {
	null: 4_000_00n // overall
};
const catBudgets: [number, bigint][] = [
	[0, 650_00n],
	[1, 400_00n],
	[2, 200_00n],
	[3, 350_00n],
	[4, 200_00n],
	[5, 500_00n],
	[6, 150_00n],
	[7, 300_00n]
];

for (let m = 0; m < 19; m++) {
	const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
	const nextD = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
	const variance = BigInt(rng(-200, 200));
	for (const c of budgetCats) {
		const base = c === null ? 4_000_00n : BigInt(catBudgets.find(([ci]) => ci === c)![1]);
		await db.insert(schema.budget).values({
			id: uuid(),
			workspaceId: wsId,
			categoryId: c !== null ? catId(c) : null,
			amountMinor: base + variance,
			period: 'month' as any,
			effectiveFrom: d.toISOString().slice(0, 10) as any,
			effectiveTo: nextD.toISOString().slice(0, 10) as any
		});
	}
}

// ── Pinned purchases ─────────────────────────────────────────────────
// The map draws the month, and the screenshot pass captures it: without a
// handful of pins in the recent window the shot is the empty state. Chicago
// neighborhoods, sized like a real week of food and hardware.
const pins: {
	item: string;
	catIdx: number;
	minor: bigint;
	day: number;
	place: { label: string; latE3: number; lngE3: number };
}[] = [
	{
		item: 'Farmers market veg',
		catIdx: 0,
		minor: 34_12n,
		day: 2,
		place: { label: 'Andersonville Greenmarket', latE3: 41981, lngE3: -87667 }
	},
	{
		item: 'Weekly groceries',
		catIdx: 0,
		minor: 137_40n,
		day: 4,
		place: { label: 'Pilsen Provisions', latE3: 41856, lngE3: -87656 }
	},
	{
		item: 'Date night',
		catIdx: 1,
		minor: 86_20n,
		day: 5,
		place: { label: 'Wicker Park Table', latE3: 41903, lngE3: -87677 }
	},
	{
		item: 'Shelf brackets',
		catIdx: 7,
		minor: 41_99n,
		day: 6,
		place: { label: 'Uptown Hardware', latE3: 41972, lngE3: -87659 }
	},
	{
		item: 'Movie night',
		catIdx: 2,
		minor: 50_37n,
		day: 8,
		place: { label: 'Hyde Park Cinema', latE3: 41795, lngE3: -87593 }
	},
	{
		item: 'Michigan Ave run',
		catIdx: 5,
		minor: 173_82n,
		day: 9,
		place: { label: 'Michigan Ave Shops', latE3: 41895, lngE3: -87624 }
	}
];
for (const p of pins) {
	await addPurchase({
		member: aliceMember,
		state: 'completed',
		item: p.item,
		catIdx: p.catIdx,
		minor: p.minor,
		day: p.day,
		place: p.place
	});
}

const [countRow] = await db.select({ count: sql`count(*)::int` }).from(schema.purchase);

console.log(
	[
		'seeded workspace "demo" with:',
		'  alice (owner) + bob (member, needs approval >$50)',
		`  ${countRow?.count ?? '?'} total purchases across ~12 months`,
		'  3 pending approval, 1 approved, 2 denied, 1 cancelled, 1 sealed',
		'  5 recurring rules (Rent, Netflix, Gym, Internet, Phone)',
		`  ${recCount} recurring-generated purchases`,
		'  2 recurring income entries + 3 one-off income entries',
		'  12 months of budgets (overall + 8 categories)'
	].join('\n')
);
await client.end();
