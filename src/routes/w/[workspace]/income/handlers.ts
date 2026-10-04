import type { WorkspaceContext } from '$lib/ports/context';
import type { ActionEvent, LoadEvent } from '$lib/ports/handlers';
import { fail } from '@sveltejs/kit';
import * as v from 'valibot';
import { Money, InvalidMoneyError } from '$lib/domain/money/money';
import {
	RecurrenceError,
	describeRecurrence,
	formatRRule,
	parseRRule
} from '$lib/domain/recurrence/rrule';
import { calDateInZone, zonedTimeToUtc } from '$lib/domain/time/zoned';
import { addIncome, deleteIncome, listIncome, updateIncome } from '$lib/repo/income';

export async function load(ctx: WorkspaceContext, { params }: LoadEvent) {
	// Re-run this workspace-scoped load when the workspace in the URL changes;
	// a locals-only load declares no such dependency. See +layout.server.ts.
	void params.workspace;
	const rows = await listIncome(ctx.db, ctx.workspace.id);
	// Midnight today in the workspace's own timezone, so "past" means the day it
	// means to the household rather than to UTC.
	const ws = ctx.workspace;
	const t = calDateInZone(ctx.deps.clock.now(), ws.timezone);
	const startOfToday = zonedTimeToUtc(t, 0, 0, ws.timezone);
	// One-offs received in the last twelve months: the bonus, the tax refund,
	// the side job. The headline's monthly figure is templates only, so these
	// are said beside it rather than lost.
	const yearAgo = new Date(startOfToday.getTime() - 365 * 86_400_000);
	const oneOffYearMinor = rows
		.filter(
			(r) =>
				r.entry.rrule === null && r.entry.receivedAt >= yearAgo && r.entry.receivedAt < startOfToday
		)
		.reduce((sum, r) => sum + r.entry.amountMinor, 0n);
	return {
		currency: ws.currency,
		oneOffYearMinor,
		entries: rows.map((r) => {
			let freq: string | null = null;
			let monthDay: number | null = null;
			if (r.entry.rrule) {
				try {
					const parsed = parseRRule(r.entry.rrule);
					freq = parsed.freq;
					monthDay = parsed.byMonthDay ?? null;
				} catch {
					/* malformed */
				}
			}
			return {
				id: r.entry.id,
				source: r.entry.source,
				amountMinor: r.entry.amountMinor,
				currency: r.entry.currency,
				receivedAt: r.entry.receivedAt.toISOString(),
				receivedDate: r.entry.receivedAt.toISOString().slice(0, 10),
				cadence: r.entry.rrule ? describe(r.entry.rrule) : null,
				note: r.entry.note,
				memberId: r.entry.memberId,
				memberName: r.memberName,
				mine: r.entry.memberId === ctx.member.id,
				/* A monthly entry is a template, so it is never "past": it keeps
				   producing occurrences. Only a dated one-off can fall behind. */
				recurring: r.entry.rrule !== null,
				past: r.entry.rrule === null && r.entry.receivedAt < startOfToday,
				freq,
				monthDay
			};
		})
	};
}

function describe(rrule: string): string {
	try {
		return describeRecurrence(parseRRule(rrule));
	} catch {
		return rrule;
	}
}

const AddSchema = v.object({
	source: v.pipe(v.string(), v.trim(), v.minLength(1, 'Where from?'), v.maxLength(120)),
	amount: v.pipe(v.string(), v.trim(), v.minLength(1, 'How much?')),
	date: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date')),
	repeat: v.picklist(['once', 'monthly']),
	monthDay: v.optional(v.string()),
	note: v.optional(v.pipe(v.string(), v.maxLength(500)))
});

export const actions = {
	add: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const parsed = v.safeParse(AddSchema, Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const f = parsed.output;
		const [y, m, d] = f.date.split('-').map(Number);

		let amount: Money;
		let rrule: string | null = null;
		try {
			amount = Money.fromDecimal(f.amount, ctx.workspace.currency);
			if (!amount.isPositive) return fail(400, { error: 'Amount must be positive' });
			if (f.repeat === 'monthly') {
				const day = f.monthDay ? Number(f.monthDay) : Math.min(d, 28);
				rrule = formatRRule({
					start: { y, m, d },
					freq: 'monthly',
					interval: 1,
					byMonthDay: day
				});
			}
		} catch (e) {
			if (e instanceof InvalidMoneyError || e instanceof RecurrenceError) {
				return fail(400, { error: e.message });
			}
			throw e;
		}

		await addIncome(ctx.db, ctx.deps, {
			workspaceId: ctx.workspace.id,
			memberId: ctx.member.id,
			source: f.source,
			amountMinor: amount.minor,
			currency: amount.currency,
			receivedAt: zonedTimeToUtc({ y, m, d }, 9, 0, ctx.workspace.timezone),
			rrule,
			note: f.note?.trim() || null
		});
		return { ok: true };
	},

	remove: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const id = String((await request.formData()).get('incomeId') ?? '');
		const removed = await deleteIncome(
			ctx.db,
			{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
			id
		);
		if (!removed) return fail(400, { error: 'Only your own entries can be removed' });
		return { ok: true };
	},

	edit: async (ctx: WorkspaceContext, { request }: ActionEvent) => {
		const form = await request.formData();
		const incomeId = String(form.get('incomeId') ?? '');
		const source = String(form.get('source') ?? '').trim();
		const amountRaw = String(form.get('amount') ?? '').trim();
		const dateRaw = String(form.get('date') ?? '').trim();
		const repeat = String(form.get('repeat') ?? 'once');

		if (!source) return fail(400, { error: 'Where from?' });
		if (!amountRaw) return fail(400, { error: 'How much?' });
		if (!dateRaw) return fail(400, { error: 'Pick a date' });

		try {
			const amount = Money.fromDecimal(amountRaw, ctx.workspace.currency);
			if (!amount.isPositive) return fail(400, { error: 'Amount must be positive' });

			const [y, m, d] = dateRaw.split('-').map(Number);
			let rrule: string | null = null;
			if (repeat === 'monthly') {
				const monthDay = form.get('monthDay');
				const day = monthDay ? Number(monthDay) : Math.min(d, 28);
				rrule = formatRRule({
					start: { y, m, d },
					freq: 'monthly',
					interval: 1,
					byMonthDay: day
				});
			}

			const ok = await updateIncome(
				ctx.db,
				{ workspaceId: ctx.workspace.id, memberId: ctx.member.id },
				incomeId,
				{
					source,
					amountMinor: amount.minor,
					receivedAt: zonedTimeToUtc({ y, m, d }, 9, 0, ctx.workspace.timezone),
					rrule
				}
			);
			if (!ok) return fail(400, { error: 'Only your own entries can be edited' });
		} catch (e) {
			if (e instanceof InvalidMoneyError || e instanceof RecurrenceError) {
				return fail(400, { error: e.message });
			}
			throw e;
		}
		return { ok: true };
	}
};
