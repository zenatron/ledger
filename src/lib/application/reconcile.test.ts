import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { purchase, statementLine, workspaceMember } from '$lib/db/schema';
import type { Db } from '$lib/db/types';
import {
	importStatement,
	createPurchaseFromLine,
	closeImport,
	reopenImport,
	confirmMatch,
	ignoreLine,
	unignoreLine,
	ReconcileError
} from '$lib/application/reconcile';
import { getLine, getImport } from '$lib/repo/statements';
import { nullNotifier } from '$lib/ports/notifier';

let h: TestDb | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const NOW = new Date('2026-06-17T12:00:00Z');
const ids = { newId: () => crypto.randomUUID() };
const deps = { clock: { now: () => NOW }, ids, notifier: nullNotifier };

// One matchable line, one unmatched debit, one credit.
const CSV = [
	'date,description,amount',
	'2026-06-10,ACME COFFEE,-12.34',
	'2026-06-11,UNKNOWN SHOP,-48.00',
	'2026-06-12,REFUND CREDIT,15.00'
].join('\n');

type Scope = { workspaceId: string; memberId: string };

async function seedWithStatement() {
	h = await makeTestDb();
	const ws = await seedWorkspace(h.db, { timezone: 'America/New_York' });
	// The existing purchase the matcher should find for the coffee line.
	await ws.addPurchase({
		itemName: 'Coffee',
		amountMinor: 1234n,
		state: 'completed',
		completedAt: new Date('2026-06-10T15:00:00Z')
	});
	const scope: Scope = { workspaceId: ws.workspaceId, memberId: ws.ownerMemberId };
	const imp = await importStatement(h.db, deps, scope, {
		filename: 'june.csv',
		csv: CSV,
		currency: 'USD'
	});
	return { ws, scope, imp };
}

async function lineByDescription(db: Db, desc: string) {
	const rows = await db.select().from(statementLine).where(eq(statementLine.rawDescription, desc));
	if (rows.length === 0) throw new Error(`no line ${desc}`);
	return rows[0];
}

describe('createPurchaseFromLine', () => {
	it('turns an unmatched line into a completed purchase and confirms the line with it', async () => {
		const { ws, scope, imp } = await seedWithStatement();
		const line = await lineByDescription(h!.db, 'UNKNOWN SHOP');
		expect(line.matchState).toBe('unmatched');

		const r = await createPurchaseFromLine(h!.db, deps, scope, line.id);
		expect(r.state).toBe('completed');

		// The purchase: completed at the line's amount, named by the line.
		const [p] = await h!.db.select().from(purchase).where(eq(purchase.id, r.purchaseId));
		expect(p.state).toBe('completed');
		expect(p.finalAmountMinor).toBe(4800n);
		expect(p.itemName).toBe('UNKNOWN SHOP');
		// The line IS the statement evidence, so the cleared mark landed now.
		expect(p.clearedAt?.toISOString()).toBe(NOW.toISOString());

		const after = (await getLine(h!.db, ws.workspaceId, line.id, ws.ownerMemberId, NOW))!;
		expect(after.matchState).toBe('confirmed');
		expect(after.matchedPurchaseId).toBe(r.purchaseId);
		expect(after.matchReason).toBe('created from statement');

		const impAfter = (await getImport(h!.db, ws.workspaceId, imp.importId, ws.ownerMemberId))!;
		expect(impAfter.matchedCount).toBeGreaterThan(imp.matchedCount);
	});

	it('refuses an import whose rows were read from a picture', async () => {
		const { ws, scope } = await seedWithStatement();
		// Re-import the same rows, but as a model-read scan: different content
		// hash (different filename is not enough — hash is over the csv), so
		// shift a description.
		const csv = CSV.replace('UNKNOWN SHOP', 'UNKNOWN SHOP 2');
		const imp = await importStatement(h!.db, deps, scope, {
			filename: 'scan.pdf',
			csv,
			currency: 'USD',
			format: 'pdf',
			modelRead: true
		});
		const line = await lineByDescription(h!.db, 'UNKNOWN SHOP 2');

		await expect(createPurchaseFromLine(h!.db, deps, scope, line.id)).rejects.toBeInstanceOf(
			ReconcileError
		);
		// Nothing was created on the way to the refusal.
		const after = (await getLine(h!.db, ws.workspaceId, line.id, ws.ownerMemberId, NOW))!;
		expect(after.matchState).toBe('unmatched');
		expect(imp.importId).toBeTruthy();
	});

	it('refuses a line that is money in', async () => {
		const { scope } = await seedWithStatement();
		const line = await lineByDescription(h!.db, 'REFUND CREDIT');
		await expect(createPurchaseFromLine(h!.db, deps, scope, line.id)).rejects.toThrow(/money in/);
	});

	it('refuses a line that already has an answer', async () => {
		const { scope } = await seedWithStatement();
		const matched = await lineByDescription(h!.db, 'ACME COFFEE');
		expect(matched.matchState).toBe('matched'); // the matcher found the coffee

		await expect(createPurchaseFromLine(h!.db, deps, scope, matched.id)).rejects.toThrow(
			/unanswered/
		);
	});

	it('leaves the line matched, not confirmed, when the policy wants a decision first', async () => {
		const { ws, scope } = await seedWithStatement();
		// Everything this member logs needs approval — routed to themselves,
		// the only member this workspace has.
		await h!.db
			.update(workspaceMember)
			.set({
				approvalPolicy: {
					mode: 'always',
					routing: { mode: 'any_of', approver_ids: [ws.ownerMemberId] }
				}
			})
			.where(eq(workspaceMember.id, ws.ownerMemberId));

		const line = await lineByDescription(h!.db, 'UNKNOWN SHOP');
		const r = await createPurchaseFromLine(h!.db, deps, scope, line.id);
		expect(r.state).toBe('pending_approval');

		const [p] = await h!.db.select().from(purchase).where(eq(purchase.id, r.purchaseId));
		expect(p.state).toBe('pending_approval');
		// cleared_at is a person's mark on a finished purchase: it waits.
		expect(p.clearedAt).toBeNull();

		const after = (await getLine(h!.db, ws.workspaceId, line.id, ws.ownerMemberId, NOW))!;
		expect(after.matchState).toBe('matched');
		expect(after.matchedPurchaseId).toBe(r.purchaseId);
	});
});

describe('statement close', () => {
	async function answerEverything() {
		const seeded = await seedWithStatement();
		const coffee = await lineByDescription(h!.db, 'ACME COFFEE');
		await confirmMatch(h!.db, deps, seeded.scope, coffee.id);
		const credit = await lineByDescription(h!.db, 'REFUND CREDIT');
		await ignoreLine(h!.db, deps, seeded.scope, credit.id);
		const unknown = await lineByDescription(h!.db, 'UNKNOWN SHOP');
		await createPurchaseFromLine(h!.db, deps, seeded.scope, unknown.id);
		return seeded;
	}

	it('refuses to close while lines are unanswered, then closes and reopens', async () => {
		const { ws, scope, imp } = await seedWithStatement();
		await expect(closeImport(h!.db, deps, scope, imp.importId)).rejects.toThrow(/answer/);

		// Answer every line in place: confirm the match, ignore the credit,
		// create from the unknown debit.
		const coffee = await lineByDescription(h!.db, 'ACME COFFEE');
		await confirmMatch(h!.db, deps, scope, coffee.id);
		const credit = await lineByDescription(h!.db, 'REFUND CREDIT');
		await ignoreLine(h!.db, deps, scope, credit.id);
		const unknown = await lineByDescription(h!.db, 'UNKNOWN SHOP');
		await createPurchaseFromLine(h!.db, deps, scope, unknown.id);

		await closeImport(h!.db, deps, scope, imp.importId);
		expect((await getImport(h!.db, ws.workspaceId, imp.importId, ws.ownerMemberId))!.status).toBe(
			'reconciled'
		);

		await reopenImport(h!.db, deps, scope, imp.importId);
		expect((await getImport(h!.db, ws.workspaceId, imp.importId, ws.ownerMemberId))!.status).toBe(
			'reviewing'
		);
	});

	it('reopens on its own when a closed statement gets a line back in review', async () => {
		const done = await answerEverything();
		await closeImport(h!.db, deps, done.scope, done.imp.importId);

		// A decision undone is a question again — the statement must not sit
		// "closed" over an unanswered line.
		const credit = await lineByDescription(h!.db, 'REFUND CREDIT');
		await unignoreLine(h!.db, deps, done.scope, credit.id);
		const imp = (await getImport(
			h!.db,
			done.ws.workspaceId,
			done.imp.importId,
			done.ws.ownerMemberId
		))!;
		expect(imp.status).toBe('reviewing');
	});
});
