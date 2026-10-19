/**
 * "Add my salary, 3000 a month, on the last day" through the assistant's
 * execute endpoint.
 *
 * The parser reads "last day" as -1, and the endpoint clamped it with
 * Math.min(day, 28) — which leaves -1 alone — so the income was dated two days
 * before the month began and its rule carried an impossible start date. Days
 * 29–31 went the other way, quietly moved to the 28th.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, seedWorkspace, type TestDb } from '$lib/repo/_test/harness';
import { income, workspace, workspaceMember } from '$lib/db/schema';
import { parseRRule } from '$lib/domain/recurrence/rrule';

let h: TestDb | undefined;
vi.mock('$lib/server/db', () => ({ getDb: () => h!.db }));
// Mid-February, so the last day (28th) and the 30th both need clamping.
vi.mock('$lib/infra/time/system-clock', () => ({
	systemClock: { now: () => new Date('2026-02-10T15:00:00Z') }
}));

const { POST } = await import('../../routes/w/[workspace]/intelligence/execute/+server');

afterEach(async () => {
	await h?.close();
	h = undefined;
});

async function run(dayOfMonth: number) {
	h = await makeTestDb();
	const ws = await seedWorkspace(h.db, { timezone: 'UTC' });
	const [wsRow] = await h.db.select().from(workspace).where(eq(workspace.id, ws.workspaceId));
	const [member] = await h.db
		.select()
		.from(workspaceMember)
		.where(eq(workspaceMember.id, ws.ownerMemberId));
	const res = await POST({
		request: new Request('http://x/', {
			method: 'POST',
			body: JSON.stringify({
				proposal: {
					intent: 'create_income',
					source: 'Salary',
					amount: 3000,
					monthly: true,
					dayOfMonth,
					currency: 'USD'
				}
			})
		}),
		locals: { workspace: wsRow, member }
	} as never);
	const body = await res.json();
	const [row] = await h.db.select().from(income).where(eq(income.workspaceId, ws.workspaceId));
	return { body, row };
}

describe('assistant income on a late day of the month', () => {
	it('dates "the last day" inside the month and keeps it as the last day', async () => {
		const { body, row } = await run(-1);
		expect(row.receivedAt.toISOString().slice(0, 10)).toBe('2026-02-28');
		expect(parseRRule(row.rrule!).byMonthDay).toBe(-1);
		expect(body.answer).toContain('monthly on the last day');
	});

	it('keeps the 30th as the 30th, clamped only where the month is short', async () => {
		const { body, row } = await run(30);
		expect(row.receivedAt.toISOString().slice(0, 10)).toBe('2026-02-28');
		expect(parseRRule(row.rrule!).byMonthDay).toBe(30);
		expect(body.answer).toContain('monthly on day 30');
	});
});
