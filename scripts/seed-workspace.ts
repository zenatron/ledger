/**
 * Seed a rich demo workspace with ~18 months of history for exercising every
 * feature: purchases in all states, recurring rules, budgets, savings buckets,
 * income, approval workflows, sealed items, and all product toggles on.
 *
 *    DATABASE_URL=postgres://... bun scripts/seed-workspace.ts --name "Demo 3"
 *
 *   --slug  <slug>   workspace slug (default: derived from name)
 *   --name  <name>   workspace display name (default: "Demo 3")
 *   --reset          delete the workspace first if it already exists
 *   --months <n>     how many months of history (default: 18)
 *
 * Idempotent without --reset: refuses if the slug is taken.  Only touches the
 * target workspace — existing ones are left alone.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../src/lib/db/schema';
import { parseRRule, nextOccurrence, formatRRule } from '../src/lib/domain/recurrence/rrule';
import { deleteWorkspace } from '../src/lib/application/delete-workspace';
import { EVENT_TYPES, CHANNELS } from '../src/lib/notification-events';
import type { Db } from '../src/lib/db/types';

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string): string | null {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return null;
	const v = args[i + 1];
	return v && !v.startsWith('--') ? v : 'true';
}
const reset = flag('reset') !== null;
const name = flag('name') ?? 'Demo 3';
const slug =
	flag('slug') ??
	name
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '');
const MONTHS = parseInt(flag('months') ?? '18', 10);

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('Set DATABASE_URL');
	process.exit(1);
}
const client = postgres(url, { max: 1 });
const db: Db = drizzle(client, { schema });

// ── Shared helpers ────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);
const todayCal = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
const nextOccurrenceOf = (rrule: string): Date => {
	const o = nextOccurrence(parseRRule(rrule), todayCal);
	return new Date(Date.UTC(o.y, o.m - 1, o.d, 12, 0, 0));
};
const rng = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// ── Reset if requested ────────────────────────────────────────────────────
if (reset) {
	const rows = await db
		.select({ id: schema.workspace.id })
		.from(schema.workspace)
		.where(eq(schema.workspace.slug, slug));
	if (rows.length > 0) {
		console.log(`Tearing down workspace "${slug}"…`);
		await deleteWorkspace(db, rows[0].id);
		console.log('  done.');
	}
}

// ── Idempotency guard ─────────────────────────────────────────────────────
const existing = await db
	.select({ id: schema.workspace.id })
	.from(schema.workspace)
	.where(eq(schema.workspace.slug, slug));
if (existing.length > 0) {
	console.log(`Workspace "${slug}" already exists. Use --reset to rebuild.`);
	await client.end();
	process.exit(0);
}

// ── Users ─────────────────────────────────────────────────────────────────
async function upsertUser(sub: string, email: string, displayName: string): Promise<string> {
	const rows = await db
		.insert(schema.user)
		.values({ id: uuid(), oidcSubject: sub, email, displayName, createdAt: now, lastLoginAt: null })
		.onConflictDoUpdate({ target: schema.user.oidcSubject, set: { email } })
		.returning({ id: schema.user.id });
	return rows[0].id;
}

const charlieId = await upsertUser('sub-charlie', 'charlie@example.com', 'Charlie');
const danaId = await upsertUser('sub-dana', 'dana@example.com', 'Dana');
const elliotId = await upsertUser('sub-elliot', 'elliot@example.com', 'Elliot');

// If there's a dev user already in the DB (e.g. from DEV_MODE), make them an
// owner too so they can access the workspace immediately.
const devEmail = process.env.DEV_USER_EMAIL;
let devUserId: string | null = null;
if (devEmail) {
	const rows = await db
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, devEmail));
	if (rows.length > 0) devUserId = rows[0].id;
}

// ── Workspace ─────────────────────────────────────────────────────────────
const wsId = uuid();
await db.insert(schema.workspace).values({
	id: wsId,
	slug,
	name,
	ownerUserId: charlieId,
	currency: 'USD',
	timezone: 'America/Chicago',
	maxSealDays: 30,
	reapprovalThresholdPct: 15,
	accentColor: '#FF9F0A',
	billImportEnabled: true,
	barcodeEnabled: true,
	locationEnabled: true,
	intelligenceEnabled: true,
	safeToSpendAlertsEnabled: true,
	aiMode: 'local',
	aiEndpoint: 'http://localhost:11434',
	aiModel: 'llama3.2',
	aiApiKey: null,
	budgetAlertPct: 80,
	budgetAlertCooldownHours: 24,
	recentDeleteHours: 72,
	maxNudges: 5,
	createdAt: now
});

// ── Members ───────────────────────────────────────────────────────────────
const charlieMem = uuid();
const danaMem = uuid();
const elliotMem = uuid();
await db.insert(schema.workspaceMember).values([
	{
		id: charlieMem,
		workspaceId: wsId,
		userId: charlieId,
		role: 'owner',
		approvalPolicy: { mode: 'none', routing: { mode: 'any_of', approver_ids: [] } },
		status: 'active',
		summaryCadence: 'weekly',
		// The demo exists to show the app. The column now defaults to 'masked',
		// which is right for a household and useless for a screenshot: it renders
		// the one number the ledger is built around as four dots.
		safeToSpendDisplay: 'shown',
		safeToSpendAlertLevel: 0,
		joinedAt: now
	},
	{
		id: danaMem,
		workspaceId: wsId,
		userId: danaId,
		role: 'member',
		approvalPolicy: {
			mode: 'threshold',
			threshold_minor: 10_000,
			category_overrides: [],
			routing: { mode: 'any_of', approver_ids: [charlieMem] }
		},
		status: 'active',
		summaryCadence: 'monthly',
		safeToSpendDisplay: 'shown',
		safeToSpendAlertLevel: 0,
		joinedAt: now
	},
	{
		id: elliotMem,
		workspaceId: wsId,
		userId: elliotId,
		role: 'member',
		approvalPolicy: {
			mode: 'always',
			routing: { mode: 'any_of', approver_ids: [charlieMem, danaMem] }
		},
		status: 'active',
		summaryCadence: 'off',
		safeToSpendDisplay: 'shown',
		safeToSpendAlertLevel: 0,
		joinedAt: now
	}
]);
if (devUserId) {
	await db.insert(schema.workspaceMember).values({
		id: uuid(),
		workspaceId: wsId,
		userId: devUserId,
		role: 'owner',
		approvalPolicy: { mode: 'none', routing: { mode: 'any_of', approver_ids: [] } },
		status: 'active',
		summaryCadence: 'off',
		safeToSpendDisplay: 'shown',
		safeToSpendAlertLevel: 0,
		joinedAt: now
	});
}

// ── Categories ────────────────────────────────────────────────────────────
const cats = [
	{ name: 'Groceries', icon: '\u{1F6D2}', color: '#22c55e' },
	{ name: 'Dining', icon: '\u{1F35C}', color: '#f97316' },
	{ name: 'Entertainment', icon: '\u{1F3AC}', color: '#ec4899' },
	{ name: 'Utilities', icon: '\u{1F4A1}', color: '#64748b' },
	{ name: 'Transport', icon: '\u{1F698}', color: '#3b82f6' },
	{ name: 'Shopping', icon: '\u{1F6CD}', color: '#8b5cf6' },
	{ name: 'Health', icon: '\u{1F3E5}', color: '#ef4444' },
	{ name: 'Home', icon: '\u{1F3E0}', color: '#f59e0b' },
	{ name: 'Education', icon: '\u{1F393}', color: '#0891b2' },
	{ name: 'Pets', icon: '\u{1F431}', color: '#d946ef' },
	{ name: 'Clothing', icon: '\u{1F455}', color: '#14b8a6' },
	{ name: 'Travel', icon: '\u{2708}', color: '#06b6d4' }
].map((c) => ({ id: uuid(), workspaceId: wsId, ...c, isBuiltIn: true }));
await db.insert(schema.category).values(cats);
const catIds = cats.map((c) => c.id);

// ── Places ────────────────────────────────────────────────────────────────
/*
 * Somewhere for the map to draw. Without these the spending map renders an
 * empty grid, which is a screenshot of nothing and a feature nobody can
 * evaluate.
 *
 * Coordinates are integer millidegrees, the same ~110 m resolution the app
 * stores, and they are spread across the city the workspace's timezone implies
 * so the clustering has something to cluster. Everything here is invented: the
 * names are not businesses, and the points land on ordinary streets rather
 * than on anybody's door.
 *
 * Only a subset of purchases get one. Capture is opt-in per purchase in the
 * real app and most rows will always be null, so seeding every purchase with a
 * pin would misrepresent how the feature is used.
 */
interface PlaceSeed {
	label: string;
	latE3: number;
	lngE3: number;
	/** Which category indexes plausibly happen here. */
	cats: number[];
}
const places: PlaceSeed[] = [
	{ label: 'Wicker Park Grocery', latE3: 41909, lngE3: -87677, cats: [0] },
	{ label: 'Lakeview Market', latE3: 41940, lngE3: -87654, cats: [0] },
	{ label: 'Pilsen Provisions', latE3: 41857, lngE3: -87656, cats: [0, 7] },
	{ label: 'Fulton Street Diner', latE3: 41886, lngE3: -87648, cats: [1] },
	{ label: 'Logan Square Coffee', latE3: 41929, lngE3: -87707, cats: [1] },
	{ label: 'Hyde Park Cinema', latE3: 41794, lngE3: -87590, cats: [2] },
	{ label: 'Loop Transit Center', latE3: 41879, lngE3: -87630, cats: [4] },
	{ label: 'Michigan Ave Shops', latE3: 41898, lngE3: -87624, cats: [5, 10] },
	{ label: 'Near North Clinic', latE3: 41897, lngE3: -87637, cats: [6] },
	{ label: 'Uptown Hardware', latE3: 41966, lngE3: -87655, cats: [7] },
	{ label: 'Andersonville Vets', latE3: 41977, lngE3: -87669, cats: [9] },
	{ label: "O'Hare Departures", latE3: 41978, lngE3: -87904, cats: [11] }
];
/** The places that make sense for a category, or none. */
const placesFor = (catIdx: number) => places.filter((p) => p.cats.includes(catIdx));
const catId = (n: number) => catIds[n];

// ── Purchase helpers ──────────────────────────────────────────────────────
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
	bucketId?: string | null;
	nudgeCount?: number;
	lastNudgedAt?: Date | null;
	approvedMinor?: bigint | null;
	/** A pin, when this purchase happened somewhere worth recording. */
	place?: PlaceSeed | null;
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
		latE3: opts.place?.latE3 ?? null,
		lngE3: opts.place?.lngE3 ?? null,
		placeLabel: opts.place?.label ?? null,
		// 'geocode' rather than 'device': these read as addresses somebody typed,
		// which is the path that leaves no claim about where a person stood.
		locationSource: opts.place ? 'geocode' : null,
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
		bucketId: opts.bucketId ?? null,
		parentPurchaseId: null,
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

// ── Recurring Rules ──────────────────────────────────────────────────────
interface RecDef {
	id: string;
	member: string;
	item: string;
	cat: number;
	minor: bigint;
	rrule: string;
	dayOfMonth: number;
	/**
	 * Days ago this rule was ended, for the Recurring page's Ended section.
	 * Its charges stop here, so the lifetime total covers a real run and then
	 * stops.
	 */
	endedDaysAgo?: number;
}
const recDefs: RecDef[] = [
	{
		id: uuid(),
		member: charlieMem,
		item: 'Rent',
		cat: 3,
		minor: 1_650_00n,
		rrule: 'DTSTART=2025-07-01;FREQ=MONTHLY;BYMONTHDAY=1',
		dayOfMonth: 1
	},
	{
		id: uuid(),
		member: charlieMem,
		item: 'Internet',
		cat: 3,
		minor: 79_99n,
		rrule: 'DTSTART=2025-07-05;FREQ=MONTHLY;BYMONTHDAY=5',
		dayOfMonth: 5
	},
	{
		id: uuid(),
		member: charlieMem,
		item: 'Spotify',
		cat: 2,
		minor: 10_99n,
		rrule: 'DTSTART=2025-07-08;FREQ=MONTHLY;BYMONTHDAY=8',
		dayOfMonth: 8
	},
	{
		id: uuid(),
		member: charlieMem,
		item: 'Car insurance',
		cat: 8,
		minor: 95_00n,
		rrule: 'DTSTART=2025-07-15;FREQ=MONTHLY;BYMONTHDAY=15',
		dayOfMonth: 15
	},
	{
		id: uuid(),
		member: danaMem,
		item: 'Netflix',
		cat: 2,
		minor: 15_49n,
		rrule: 'DTSTART=2025-07-03;FREQ=MONTHLY;BYMONTHDAY=3',
		dayOfMonth: 3
	},
	{
		id: uuid(),
		member: danaMem,
		item: 'Gym membership',
		cat: 6,
		minor: 54_99n,
		rrule: 'DTSTART=2025-07-10;FREQ=MONTHLY;BYMONTHDAY=10',
		dayOfMonth: 10
	},
	{
		id: uuid(),
		member: danaMem,
		item: 'Phone bill',
		cat: 3,
		minor: 70_00n,
		rrule: 'DTSTART=2025-07-20;FREQ=MONTHLY;BYMONTHDAY=20',
		dayOfMonth: 20
	},
	{
		id: uuid(),
		member: elliotMem,
		item: 'Dog food subscription',
		cat: 9,
		minor: 38_99n,
		rrule: 'DTSTART=2025-07-12;FREQ=MONTHLY;BYMONTHDAY=12',
		dayOfMonth: 12
	},
	{
		id: uuid(),
		member: elliotMem,
		item: 'iCloud',
		cat: 2,
		minor: 2_99n,
		rrule: 'DTSTART=2025-07-07;FREQ=MONTHLY;BYMONTHDAY=7',
		dayOfMonth: 7
	},
	{
		id: uuid(),
		member: elliotMem,
		item: 'Student loan',
		cat: 8,
		minor: 320_00n,
		rrule: 'DTSTART=2025-07-18;FREQ=MONTHLY;BYMONTHDAY=18',
		dayOfMonth: 18
	},
	{
		// Cancelled four months ago, so the Ended section has something in it.
		id: uuid(),
		member: danaMem,
		item: 'Meal kit delivery',
		cat: 1,
		minor: 62_50n,
		rrule: 'DTSTART=2025-07-22;FREQ=MONTHLY;BYMONTHDAY=22',
		dayOfMonth: 22,
		endedDaysAgo: 120
	}
];

await db.insert(schema.recurringRule).values(
	recDefs.map((r) => ({
		id: r.id,
		workspaceId: wsId,
		memberId: r.member,
		itemName: r.item,
		categoryId: catId(r.cat),
		amountMinor: r.minor,
		currency: 'USD',
		rrule: r.rrule,
		lastGeneratedAt: daysAgo(r.endedDaysAgo ?? rng(28, 35)),
		status: (r.endedDaysAgo === undefined ? 'active' : 'ended') as any,
		autoComplete: false,
		// An ended rule stops here and has no next date, exactly as endRule leaves it.
		endedAt: r.endedDaysAgo === undefined ? null : daysAgo(r.endedDaysAgo),
		nextOccurrenceAt: r.endedDaysAgo === undefined ? nextOccurrenceOf(r.rrule) : null
	}))
);

// ── Recurring purchases across every month ───────────────────────────────
let recCount = 0;
for (let month = 1; month <= MONTHS; month++) {
	for (const rp of recDefs) {
		const day = month * 30 - rp.dayOfMonth;
		if (day < 3) continue; // skip very recent
		// `day` counts backwards, so anything more recent than the end date never
		// happened for a rule that has been ended.
		if (rp.endedDaysAgo !== undefined && day < rp.endedDaysAgo) continue;
		// Vary the amount slightly month to month
		const variance = BigInt(rng(-500, 500));
		const minor = rp.minor + variance;
		const id = await addPurchase({
			member: rp.member,
			state: 'completed',
			item: rp.item,
			catIdx: rp.cat,
			minor,
			day,
			recurringRuleId: rp.id
		});
		await addEvent(id, rp.member, 'draft', 'completed', daysAgo(day));
		recCount++;
	}
}

// ── Purchase item pools ───────────────────────────────────────────────────
const groceriesItems = [
	'Weekly groceries',
	'Whole Foods run',
	"Trader Joe's",
	"Farmer's market",
	'Costco bulk',
	'Aldi run',
	'Sprouts',
	'Walmart groceries'
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
	'Italian dinner',
	'Food truck',
	'Ice cream',
	'Donuts',
	'BBQ place',
	'Pho'
];
const entertainmentItems = [
	'Movie tickets',
	'Concert tickets',
	'Streaming services',
	'Video game',
	'Board game',
	'Museum tickets',
	'Escape room',
	'Bowling',
	'Mini golf',
	'Comedy show',
	'Arcade tokens',
	'Theatre tickets'
];
const transportItems = [
	'Gas station',
	'Parking garage',
	'Uber ride',
	'Subway pass',
	'Bus fare',
	'Bike repair',
	'Toll fees',
	'Car wash',
	'Oil change',
	'EV charging'
];
const shoppingItems = [
	'Amazon order',
	'New shoes',
	'Clothes shopping',
	'Home decor',
	'Kitchen gadget',
	'Office supplies',
	'Electronics',
	'Books',
	'New tools',
	'Art supplies',
	'Plant nursery'
];
const healthItems = [
	'Pharmacy',
	'Dentist co-pay',
	'Protein powder',
	'Vitamins',
	'Doctor visit',
	'Massage',
	'Eye exam',
	'Prescription refill',
	'First aid kit'
];
const homeItems = [
	'Hardware store',
	'Light bulbs',
	'Cleaning supplies',
	'New towels',
	'Furniture delivery',
	'Paint supplies',
	'Gardening tools',
	'Grill propane'
];
const educationItems = [
	'Online course',
	'Textbooks',
	'Coding bootcamp',
	'Language app',
	'Workshop ticket',
	'Conference pass',
	'Certification exam'
];
const petItems = [
	'Vet visit',
	'Dog treats',
	'Cat litter',
	'Pet grooming',
	'New leash',
	'Pet toys',
	'Bird seed',
	'Aquarium filter'
];
const clothingItems = [
	'New jeans',
	'Winter coat',
	'Running shoes',
	'Work shirts',
	'Summer dress',
	'Socks pack',
	'Rain jacket',
	'Hat'
];
const travelItems = [
	'Weekend trip hotel',
	'Flight booking',
	'Airbnb',
	'Rental car',
	'Travel insurance',
	'Souvenirs',
	'Airport parking',
	'Luggage'
];

function memberItems(member: string): Record<number, string[]> {
	const base: Record<number, string[]> = {
		0: groceriesItems,
		1: diningItems,
		2: entertainmentItems,
		4: transportItems
	};
	if (member === charlieMem) {
		return {
			...base,
			3: ['Electric bill', 'Water bill', 'Gas bill'],
			5: shoppingItems,
			6: healthItems,
			7: homeItems,
			8: ['Certification fee', 'LinkedIn Learning', 'Pluralsight'],
			11: travelItems
		};
	}
	if (member === danaMem) {
		return {
			...base,
			3: [],
			5: clothingItems,
			6: ['Yoga class', 'Gym supplements'],
			7: homeItems,
			8: ['Coursera', 'Design book', 'Typography course']
		};
	}
	// elliot
	return { ...base, 3: [], 5: [], 6: [], 9: petItems, 10: clothingItems };
}

const memberCats = (member: string): number[] => {
	if (member === charlieMem) return [0, 1, 2, 4, 5, 6, 7, 8, 11];
	if (member === danaMem) return [0, 1, 2, 4, 5, 7, 8, 10];
	return [0, 1, 2, 4, 9, 10];
};

function monthlyPurchases(monthAgo: number, member: string): Promise<void>[] {
	const baseDay = monthAgo * 30;
	const cats = memberCats(member);
	const items = memberItems(member);

	const promises: Promise<void>[] = [];
	for (const c of cats) {
		const pool = items[c] ?? [];
		if (pool.length === 0) continue;
		const count = (() => {
			switch (c) {
				case 0:
					return rng(3, 6); // groceries 3-6/month
				case 1:
					return rng(2, 5); // dining 2-5/month
				case 2:
					return rng(0, 2); // entertainment 0-2
				case 4:
					return rng(1, 4); // transport 1-4
				case 3:
					return member === charlieMem ? 2 : 0; // utilities
				default:
					return rng(0, 2);
			}
		})();
		for (let w = 0; w < count; w++) {
			const d = baseDay - rng(0, 28) - w * 7;
			if (d < 3) continue;
			let minor: bigint;
			switch (c) {
				case 0:
					minor = BigInt(rng(2500, 22000));
					break; // groceries
				case 1:
					minor = BigInt(rng(600, 8500));
					break; // dining
				case 2:
					minor = BigInt(rng(500, 20000));
					break; // entertainment
				case 3:
					minor = BigInt(rng(7000, 22000));
					break; // utilities
				case 4:
					minor = BigInt(rng(800, 8000));
					break; // transport
				case 5:
					minor = BigInt(rng(800, 25000));
					break; // shopping
				case 6:
					minor = BigInt(rng(500, 15000));
					break; // health
				case 7:
					minor = BigInt(rng(400, 16000));
					break; // home
				case 8:
					minor = BigInt(rng(1500, 40000));
					break; // education
				case 9:
					minor = BigInt(rng(500, 6000));
					break; // pets
				case 10:
					minor = BigInt(rng(1500, 18000));
					break; // clothing
				case 11:
					minor = BigInt(rng(8000, 70000));
					break; // travel
				default:
					minor = BigInt(rng(500, 5000));
			}
			// About a third, and only where the category has somewhere to be. Pins
			// are opt-in per purchase in the real app, so a fully pinned ledger
			// would be a lie about how the feature gets used.
			const candidates = placesFor(c);
			const place = candidates.length > 0 && rng(0, 2) === 0 ? pick(candidates) : null;
			const p = addPurchase({
				member,
				state: 'completed',
				item: pick(pool),
				catIdx: c,
				minor,
				day: d,
				place
			}).then((id) => addEvent(id, member, 'draft', 'completed', daysAgo(d)));
			promises.push(p);
		}
	}
	return promises;
}

console.log(`Generating ${MONTHS} months of purchases…`);
const purchasePromises: Promise<void>[] = [];
const members = [charlieMem, danaMem, elliotMem];
for (let m = 1; m <= MONTHS; m++) {
	for (const member of members) {
		purchasePromises.push(...monthlyPurchases(m, member));
	}
}
await Promise.all(purchasePromises);

// ── Special-state purchases (recent) ──────────────────────────────────────
await Promise.all([
	// Pending approval — Elliot's purchases needing Charlie's sign-off
	(async () => {
		const items = [
			{
				member: elliotMem,
				item: '4K monitor',
				cat: 5,
				minor: 479_99n,
				day: 2,
				note: 'WFH upgrade'
			},
			{
				member: elliotMem,
				item: 'Standing desk',
				cat: 5,
				minor: 599_00n,
				day: 4,
				nudge: 2,
				nudged: hoursAgo(4),
				note: 'Ergonomics setup'
			},
			{
				member: elliotMem,
				item: 'Mechanical keyboard',
				cat: 5,
				minor: 189_99n,
				day: 7,
				nudge: 1,
				nudged: hoursAgo(20)
			},
			{
				member: danaMem,
				item: 'Design tablet',
				cat: 5,
				minor: 350_00n,
				day: 5,
				nudge: 3,
				nudged: hoursAgo(1),
				note: 'Freelance tool'
			},
			{
				member: danaMem,
				item: 'Conference ticket',
				cat: 8,
				minor: 299_00n,
				day: 11,
				note: 'UX conference'
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
			await addApprover(id, p.member === elliotMem ? charlieMem : charlieMem, true);
		}
	})(),
	// Approved but not completed
	(async () => {
		for (const p of [
			{
				member: elliotMem,
				item: 'Noise-canceling headphones',
				cat: 5,
				minor: 279_99n,
				day: 8,
				approved: 280_00n
			},
			{
				member: danaMem,
				item: 'Ergonomic chair',
				cat: 7,
				minor: 420_00n,
				day: 10,
				approved: 420_00n
			}
		]) {
			const id = await addPurchase({
				...p,
				state: 'approved',
				finalMinor: null,
				approvedMinor: p.approved
			});
			await addEvent(id, p.member, 'draft', 'pending_approval', daysAgo(p.day + 0.1));
			await addApprover(id, charlieMem, true);
			await addEvent(
				id,
				charlieMem,
				'pending_approval',
				'approved',
				daysAgo(p.day + 0.3),
				'Looks good',
				p.approved
			);
		}
	})(),
	// Denied
	(async () => {
		for (const p of [
			{
				member: elliotMem,
				item: 'Gaming chair',
				cat: 5,
				minor: 899_00n,
				day: 14,
				reason: 'Too expensive right now'
			},
			{
				member: elliotMem,
				item: 'Drone',
				cat: 5,
				minor: 749_00n,
				day: 20,
				reason: 'Not essential'
			},
			{
				member: danaMem,
				item: 'Leather bag',
				cat: 10,
				minor: 295_00n,
				day: 25,
				reason: 'Over clothing budget'
			}
		]) {
			const id = await addPurchase({ ...p, state: 'denied', finalMinor: null });
			await addEvent(id, p.member, 'draft', 'pending_approval', daysAgo(p.day + 0.1));
			await addApprover(id, charlieMem, true);
			await addEvent(
				id,
				charlieMem,
				'pending_approval',
				'denied',
				daysAgo(p.day + 0.3),
				p.reason,
				p.minor
			);
		}
	})(),
	// Cancelled by requester
	(async () => {
		const id = await addPurchase({
			member: elliotMem,
			item: 'VR headset',
			cat: 2,
			minor: 399_99n,
			day: 18,
			state: 'cancelled',
			finalMinor: null
		});
		await addEvent(id, elliotMem, 'draft', 'pending_approval', daysAgo(18.1));
		await addApprover(id, charlieMem, true);
		await addEvent(id, elliotMem, 'pending_approval', 'cancelled', daysAgo(18.5));
	})(),
	// Sealed gifts
	(async () => {
		for (const p of [
			{
				member: danaMem,
				item: 'Birthday gift for Charlie',
				cat: 5,
				minor: 85_00n,
				day: 16,
				from: [charlieMem],
				note: 'Surprise! 🎁'
			},
			{
				member: charlieMem,
				item: 'Anniversary dinner',
				cat: 1,
				minor: 195_00n,
				day: 22,
				from: [elliotMem, danaMem],
				note: 'Sealed from everyone'
			},
			{
				member: elliotMem,
				item: 'Secret Santa gift',
				cat: 5,
				minor: 32_50n,
				day: 28,
				from: [danaMem],
				note: 'For Dana'
			}
		]) {
			const id = await addPurchase({
				...p,
				state: 'completed',
				sealedFrom: p.from,
				sealUntilDay: -3
			});
			await addEvent(id, p.member, 'draft', 'completed', daysAgo(p.day));
		}
	})(),
	// Over-budget re-approval scenario
	(async () => {
		const id = await addPurchase({
			member: danaMem,
			item: 'Premium office chair',
			cat: 7,
			minor: 600_00n,
			day: 35,
			state: 'completed',
			finalMinor: 895_00n,
			approvedMinor: 600_00n,
			note: 'Went over budget on the final model'
		});
		await addEvent(id, danaMem, 'draft', 'pending_approval', daysAgo(35.1));
		await addApprover(id, charlieMem, true);
		await addEvent(
			id,
			charlieMem,
			'pending_approval',
			'approved',
			daysAgo(35.3),
			'OK within reason',
			600_00n
		);
		await addEvent(
			id,
			danaMem,
			'approved',
			'completed',
			daysAgo(35),
			'Final model cost more, worth it',
			895_00n
		);
	})()
]);

// ── Income ────────────────────────────────────────────────────────────────
// Recurring salaries
await db.insert(schema.income).values([
	{
		id: uuid(),
		workspaceId: wsId,
		memberId: charlieMem,
		source: 'Salary',
		amountMinor: 6_200_00n,
		currency: 'USD',
		rrule: 'DTSTART=2025-07-01;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1',
		receivedAt: daysAgo(29),
		note: null
	},
	{
		id: uuid(),
		workspaceId: wsId,
		memberId: danaMem,
		source: 'Salary',
		amountMinor: 4_800_00n,
		currency: 'USD',
		rrule: 'DTSTART=2025-07-15;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15',
		receivedAt: daysAgo(15),
		note: null
	},
	{
		id: uuid(),
		workspaceId: wsId,
		memberId: elliotMem,
		source: 'Part-time job',
		amountMinor: 2_400_00n,
		currency: 'USD',
		rrule: 'DTSTART=2025-07-05;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=5',
		receivedAt: daysAgo(5),
		note: null
	},
	{
		id: uuid(),
		workspaceId: wsId,
		memberId: charlieMem,
		source: 'Rental income',
		amountMinor: 1_100_00n,
		currency: 'USD',
		rrule: 'DTSTART=2025-07-10;FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=10',
		receivedAt: daysAgo(10),
		note: 'Garage apartment'
	}
]);

// One-off income spread across time
const oneOffIncome = [
	{ member: charlieMem, source: 'Bonus', amount: 5_000_00n, day: 50, note: 'Q4 performance bonus' },
	{ member: charlieMem, source: 'Tax refund', amount: 2_300_00n, day: 120, note: '2024 return' },
	{ member: charlieMem, source: 'Sold old laptop', amount: 650_00n, day: 200, note: 'eBay sale' },
	{
		member: danaMem,
		source: 'Freelance project',
		amount: 3_500_00n,
		day: 80,
		note: 'Brand identity package'
	},
	{
		member: danaMem,
		source: 'Freelance project',
		amount: 1_800_00n,
		day: 180,
		note: 'Landing page design'
	},
	{
		member: danaMem,
		source: 'Freelance project',
		amount: 4_200_00n,
		day: 260,
		note: 'App UI redesign'
	},
	{ member: elliotMem, source: 'Tutoring', amount: 600_00n, day: 40, note: 'Calculus tutoring' },
	{ member: elliotMem, source: 'Tutoring', amount: 750_00n, day: 90, note: 'Physics tutoring' },
	{ member: elliotMem, source: 'Tutoring', amount: 500_00n, day: 150, note: 'Statistics tutoring' },
	{
		member: elliotMem,
		source: 'Scholarship',
		amount: 1_500_00n,
		day: 300,
		note: 'Academic merit award'
	},
	{ member: charlieMem, source: 'Dividend payment', amount: 280_00n, day: 380, note: 'Index fund' },
	{
		member: danaMem,
		source: 'Art commission',
		amount: 900_00n,
		day: 420,
		note: 'Personal portrait'
	},
	{
		member: elliotMem,
		source: 'Summer internship',
		amount: 3_200_00n,
		day: 500,
		note: 'Tech internship stipend'
	}
];
for (const io of oneOffIncome) {
	await db.insert(schema.income).values({
		id: uuid(),
		workspaceId: wsId,
		memberId: io.member,
		source: io.source,
		amountMinor: io.amount,
		currency: 'USD',
		rrule: null,
		receivedAt: daysAgo(io.day),
		note: io.note
	});
}

// ── Savings Buckets ───────────────────────────────────────────────────────
interface BucketSeed {
	id: string;
	name: string;
	member: string;
	monthly: bigint;
	day: number;
	goal?: bigint;
	color?: string;
	status?: string;
}
const bucketSeeds: BucketSeed[] = [
	{
		id: uuid(),
		name: 'Emergency fund',
		member: charlieMem,
		monthly: 500_00n,
		day: 1,
		goal: 10_000_00n,
		color: '#ef4444'
	},
	{
		id: uuid(),
		name: 'Vacation',
		member: charlieMem,
		monthly: 300_00n,
		day: 5,
		goal: 5_000_00n,
		color: '#06b6d4'
	},
	{
		id: uuid(),
		name: 'New car',
		member: charlieMem,
		monthly: 200_00n,
		day: 15,
		goal: 8_000_00n,
		color: '#3b82f6'
	},
	{
		id: uuid(),
		name: 'Home renovation',
		member: charlieMem,
		monthly: 400_00n,
		day: 10,
		goal: 15_000_00n,
		color: '#f59e0b'
	},
	{
		id: uuid(),
		name: 'Design conference',
		member: danaMem,
		monthly: 150_00n,
		day: 3,
		goal: 2_500_00n,
		color: '#ec4899'
	},
	{
		id: uuid(),
		name: 'New MacBook',
		member: danaMem,
		monthly: 200_00n,
		day: 7,
		goal: 3_000_00n,
		color: '#8b5cf6'
	},
	{
		id: uuid(),
		name: 'Tuition fund',
		member: elliotMem,
		monthly: 350_00n,
		day: 12,
		goal: 12_000_00n,
		color: '#0891b2'
	},
	{
		id: uuid(),
		name: 'Gaming PC',
		member: elliotMem,
		monthly: 100_00n,
		day: 20,
		goal: 2_000_00n,
		color: '#22c55e'
	},
	{
		id: uuid(),
		name: 'House down payment',
		member: charlieMem,
		monthly: 600_00n,
		day: 25,
		goal: 40_000_00n,
		color: '#a855f7'
	},
	{
		id: uuid(),
		name: 'Wedding fund',
		member: danaMem,
		monthly: 250_00n,
		day: 1,
		goal: 20_000_00n,
		color: '#f97316'
	},
	// paused bucket
	{
		id: uuid(),
		name: 'Mountain bike',
		member: elliotMem,
		monthly: 75_00n,
		day: 15,
		goal: 1_500_00n,
		color: '#14b8a6',
		status: 'paused'
	},
	// archived bucket
	{
		id: uuid(),
		name: 'Phone upgrade',
		member: danaMem,
		monthly: 100_00n,
		day: 28,
		goal: 1_200_00n,
		color: '#64748b',
		status: 'archived'
	}
];
for (const b of bucketSeeds) {
	const status = b.status ?? 'active';
	const rrule = formatRRule({
		start: todayCal,
		freq: 'monthly',
		interval: 1,
		byMonthDay: b.day
	});
	await db.insert(schema.bucket).values({
		id: b.id,
		workspaceId: wsId,
		memberId: b.member,
		name: b.name,
		amountMinor: b.monthly,
		currency: 'USD',
		goalCapMinor: b.goal ?? null,
		color: b.color ?? null,
		icon: null,
		status: status as any,
		rrule,
		nextAccrualAt: status === 'active' ? nextOccurrenceOf(rrule) : null,
		createdAt: now
	});
}

// Generate bucket transactions (simulate months of accruals)
for (const b of bucketSeeds) {
	if (b.status === 'archived') continue;
	let balance = 0n;
	for (let m = b.status === 'paused' ? 0 : 1; m <= MONTHS; m++) {
		const accrualDay = MONTHS * 30 - m * 30 + b.day;
		if (accrualDay < 1) continue;
		// Skip months past for paused (only add one recent)
		if (b.status === 'paused' && m > 2) continue;
		await db.insert(schema.bucketTransaction).values({
			id: uuid(),
			bucketId: b.id,
			amountMinor: b.monthly,
			currency: 'USD',
			type: 'accrual',
			createdAt: daysAgo(accrualDay)
		});
		balance += b.monthly;
		// Occasional withdrawals from active buckets
		if (b.status === 'active' && b.goal && balance >= b.goal / 4n && rng(0, 3) === 0) {
			const wdMinor = BigInt(rng(Number(b.goal / 10n), Number(b.goal / 3n)));
			await db.insert(schema.bucketTransaction).values({
				id: uuid(),
				bucketId: b.id,
				amountMinor: -wdMinor,
				currency: 'USD',
				type: 'withdrawal',
				note: `${b.name} withdrawal`,
				createdAt: daysAgo(accrualDay + 2)
			});
			balance -= wdMinor;
		}
	}
}

// ── Bucket-charged purchases ───────────────────────────────────────────
// Purchases paid for from savings buckets (bucketId set + matching withdrawal).
const bucketCharges: {
	member: string;
	item: string;
	catIdx: number;
	minor: bigint;
	day: number;
	bucketName: string;
	note?: string;
}[] = [
	{
		member: charlieMem,
		item: 'Weekend flight to Miami',
		catIdx: 11,
		minor: 320_00n,
		day: 90,
		bucketName: 'Vacation',
		note: 'Booked from Vacation fund'
	},
	{
		member: charlieMem,
		item: 'Hotel — beachfront',
		catIdx: 11,
		minor: 450_00n,
		day: 85,
		bucketName: 'Vacation',
		note: 'From Vacation bucket'
	},
	{
		member: charlieMem,
		item: 'Car down payment',
		catIdx: 4,
		minor: 2_000_00n,
		day: 180,
		bucketName: 'New car',
		note: 'Down payment from New car fund'
	},
	{
		member: charlieMem,
		item: 'Kitchen backsplash tile',
		catIdx: 7,
		minor: 620_00n,
		day: 210,
		bucketName: 'Home renovation',
		note: 'From Home renovation bucket'
	},
	{
		member: charlieMem,
		item: 'Bathroom vanity',
		catIdx: 7,
		minor: 480_00n,
		day: 160,
		bucketName: 'Home renovation',
		note: 'From Home renovation bucket'
	},
	{
		member: danaMem,
		item: 'UX Conference pass',
		catIdx: 8,
		minor: 450_00n,
		day: 120,
		bucketName: 'Design conference',
		note: 'From Design conference bucket'
	},
	{
		member: danaMem,
		item: 'MacBook Pro',
		catIdx: 5,
		minor: 1_799_99n,
		day: 60,
		bucketName: 'New MacBook',
		note: 'From New MacBook bucket'
	},
	{
		member: elliotMem,
		item: 'Tuition payment — spring semester',
		catIdx: 8,
		minor: 2_800_00n,
		day: 300,
		bucketName: 'Tuition fund',
		note: 'From Tuition fund'
	},
	{
		member: elliotMem,
		item: 'RTX 4070 GPU',
		catIdx: 5,
		minor: 549_99n,
		day: 45,
		bucketName: 'Gaming PC',
		note: 'From Gaming PC bucket'
	},
	{
		member: elliotMem,
		item: 'PC case + cooling',
		catIdx: 5,
		minor: 230_00n,
		day: 40,
		bucketName: 'Gaming PC',
		note: 'From Gaming PC bucket'
	},
	{
		member: charlieMem,
		item: 'Emergency vet visit',
		catIdx: 9,
		minor: 850_00n,
		day: 130,
		bucketName: 'Emergency fund',
		note: 'From Emergency fund — unexpected vet bill'
	},
	{
		member: charlieMem,
		item: 'Emergency car repair',
		catIdx: 4,
		minor: 1_200_00n,
		day: 75,
		bucketName: 'Emergency fund',
		note: 'Alternator replacement from Emergency fund'
	}
];

// Resolve bucket names to ids from bucketSeeds
const bucketNameToId = new Map(bucketSeeds.map((b) => [b.name, b.id]));
for (const bc of bucketCharges) {
	const bid = bucketNameToId.get(bc.bucketName);
	if (!bid) continue;
	const pId = await addPurchase({
		member: bc.member,
		state: 'completed',
		item: bc.item,
		catIdx: bc.catIdx,
		minor: bc.minor,
		day: bc.day,
		note: bc.note,
		bucketId: bid
	});
	await addEvent(pId, bc.member, 'draft', 'completed', daysAgo(bc.day));
	// Corresponding withdrawal from the bucket
	await db.insert(schema.bucketTransaction).values({
		id: uuid(),
		bucketId: bid,
		amountMinor: -bc.minor,
		currency: 'USD',
		type: 'withdrawal',
		note: bc.item,
		createdAt: daysAgo(bc.day)
	});
}

// ── Budgets (monthly for overall + every category, across time) ───────────
const budgetTargets: (number | null)[] = [null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const budgetAmounts: Record<number | string, bigint> = {
	null: 8_000_00n, // overall
	0: 800_00n, // Groceries
	1: 500_00n, // Dining
	2: 300_00n, // Entertainment
	3: 450_00n, // Utilities
	4: 300_00n, // Transport
	5: 600_00n, // Shopping
	6: 250_00n, // Health
	7: 400_00n, // Home
	8: 350_00n, // Education
	9: 150_00n, // Pets
	10: 250_00n, // Clothing
	11: 500_00n // Travel
};
for (let m = 0; m < 24; m++) {
	const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
	const nextD = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
	for (const c of budgetTargets) {
		const base = c === null ? budgetAmounts.null! : budgetAmounts[c]!;
		const variance = BigInt(rng(-100, 100));
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

// ── Notification prefs (all enabled for each member) ──────────────────────
// The app treats "no pref row" as enabled, so these rows are inert — but they
// mirror the real catalogue from src/lib/notification-events.ts.
for (const memberId of [charlieMem, danaMem, elliotMem]) {
	for (const event of EVENT_TYPES) {
		for (const channel of CHANNELS) {
			await db.insert(schema.notificationPref).values({
				workspaceMemberId: memberId,
				eventType: event.id,
				channel: channel.id,
				enabled: true
			});
		}
	}
}

// ── ntfy targets for each user ────────────────────────────────────────────
const usersWithNtfy = [
	{ userId: charlieId, topic: 'charlie-ledger', serverUrl: 'https://ntfy.example.com' },
	{ userId: danaId, topic: 'dana-ledger', serverUrl: 'https://ntfy.example.com' },
	{ userId: elliotId, topic: 'elliot-ledger', serverUrl: 'https://ntfy.example.com' }
];
for (const n of usersWithNtfy) {
	await db.insert(schema.ntfyTarget).values({
		id: uuid(),
		userId: n.userId,
		topic: n.topic,
		serverUrl: n.serverUrl,
		createdAt: now
	});
}

// ── Count and report ──────────────────────────────────────────────────────
const [purchaseCount] = await db
	.select({ count: sql`count(*)::int` })
	.from(schema.purchase)
	.where(eq(schema.purchase.workspaceId, wsId));
const [incomeCount] = await db
	.select({ count: sql`count(*)::int` })
	.from(schema.income)
	.where(eq(schema.income.workspaceId, wsId));
const [bucketCount] = await db
	.select({ count: sql`count(*)::int` })
	.from(schema.bucket)
	.where(eq(schema.bucket.workspaceId, wsId));
const [budgetCount] = await db
	.select({ count: sql`count(*)::int` })
	.from(schema.budget)
	.where(eq(schema.budget.workspaceId, wsId));
const [placed] = await db
	.select({ count: sql`count(*)::int` })
	.from(schema.purchase)
	.where(and(eq(schema.purchase.workspaceId, wsId), isNotNull(schema.purchase.latE3)));

console.log(
	[
		'',
		`Seeded workspace "${name}" (slug: "${slug}"):`,
		'  Owner: Charlie + Members: Dana, Elliot',
		`  ${purchaseCount?.count ?? '?'} purchases across ~${MONTHS} months`,
		`    ${recCount} recurring-generated`,
		'    4 pending approval, 2 approved, 3 denied, 1 cancelled, 3 sealed',
		'    1 over-budget re-approval',
		`  10 recurring rules`,
		`  ${incomeCount?.count ?? '?'} income entries (4 recurring + ${oneOffIncome.length} one-off)`,
		`  ${bucketCount?.count ?? '?'} savings buckets (10 active, 1 paused, 1 archived)`,
		`  ${budgetCount?.count ?? '?'} budget periods (overall + 12 categories)`,
		`  ${placed?.count ?? '?'} purchases with a place, across ${places.length} locations`,
		'  All notification prefs enabled',
		'  All product features enabled (AI local, barcode, bill import, places, Safe-to-Spend)',
		'',
		'  To rebuild:  bun scripts/seed-workspace.ts --reset',
		'  For a new one: bun scripts/seed-workspace.ts --name "Demo 4"',
		''
	].join('\n')
);

await client.end();
