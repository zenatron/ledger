import { error, json } from '@sveltejs/kit';
import * as v from 'valibot';
import { getDb } from '$lib/server/db';
import { createBucket } from '$lib/repo/buckets';
import { addIncome } from '$lib/repo/income';
import { setBudget, schedulableBudgetWeeks } from '$lib/repo/budgets';
import { listCategories } from '$lib/repo/workspaces';
import { Money, InvalidMoneyError } from '$lib/domain/money/money';
import { firstAccrualAt, monthlyAccrualRule } from '$lib/application/buckets';
import { formatRRule } from '$lib/domain/recurrence/rrule';
import { calDateInZone, zonedTimeToUtc } from '$lib/domain/time/zoned';
import { systemClock } from '$lib/infra/time/system-clock';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/http/origin';

const deps = { clock: systemClock, ids: uuidv7 };

function stripControlChars(s: string): string {
	return s
		.split('')
		.filter((c) => {
			const code = c.charCodeAt(0);
			return code > 0x1f && code !== 0x7f;
		})
		.join('');
}

function safeName(raw: string, maxLen = 120): string | null {
	const cleaned = stripControlChars(raw).replace(/\s+/g, ' ').trim();
	if (!cleaned) return null;
	return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

function normalizeDay(d: number): number {
	if (d === -1) return -1;
	return Math.min(Math.max(d, 1), 31);
}

const ProposalSchema = v.variant('intent', [
	v.object({
		intent: v.literal('create_bucket'),
		name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
		amount: v.number(),
		amountMinor: v.optional(v.string()),
		dayOfMonth: v.number(),
		currency: v.string()
	}),
	v.object({
		intent: v.literal('create_income'),
		source: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
		amount: v.number(),
		amountMinor: v.optional(v.string()),
		monthly: v.boolean(),
		dayOfMonth: v.number(),
		currency: v.string()
	}),
	v.object({
		intent: v.literal('set_budget'),
		category: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
		amount: v.number(),
		amountMinor: v.optional(v.string()),
		period: v.picklist(['month', 'week']),
		currency: v.string()
	}),
	v.object({
		intent: v.literal('navigate'),
		target: v.picklist(['analytics', 'buckets', 'recurring', 'income', 'purchases', 'settings']),
		label: v.optional(v.string())
	})
]);

const BodySchema = v.object({
	proposal: ProposalSchema
});

export const POST: RequestHandler = async ({ locals, request }) => {
	assertSameOrigin(request);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Malformed request body');
	}

	const parsed = v.safeParse(BodySchema, body);
	if (!parsed.success) {
		return json({ intent: 'error', answer: 'That proposal is not valid.' });
	}

	const proposal = parsed.output.proposal;
	const ws = locals.workspace!;
	const currency = ws.currency;
	const timezone = ws.timezone;
	const now = systemClock.now();
	const today = calDateInZone(now, timezone);

	if (proposal.intent === 'navigate') {
		return json({
			intent: 'navigate',
			target: proposal.target,
			answer: `Opening ${proposal.target}…`
		});
	}

	try {
		const amount = Money.fromDecimal(String(proposal.amount), currency);
		if (!amount.isPositive) {
			return json({ intent: proposal.intent, answer: 'Amount must be positive.' });
		}

		if (proposal.intent === 'create_bucket') {
			const name = safeName(proposal.name);
			if (!name) {
				return json({ intent: 'create_bucket', answer: 'Bucket needs a name.' });
			}
			const day = normalizeDay(proposal.dayOfMonth);
			const rrule = monthlyAccrualRule(day, today);
			await createBucket(getDb(), deps, {
				workspaceId: ws.id,
				memberId: locals.member!.id,
				name,
				amountMinor: amount.minor,
				currency,
				rrule,
				nextAccrualAt: firstAccrualAt(rrule, today, timezone)
			});
			return json({
				intent: 'create_bucket',
				answer: `Bucket “${name}” created: ${amount.format()}/mo on ${day === -1 ? 'the last day' : `day ${day}`}.`,
				target: 'buckets'
			});
		}

		if (proposal.intent === 'set_budget') {
			// Same rule as the settings screen and the MCP tool: budgets are the
			// owner's to set.
			if (locals.member!.role !== 'owner') {
				return json({
					intent: 'set_budget',
					answer: 'Only the workspace owner can set budgets.'
				});
			}
			// "everything"/"overall" is the all-category cap; anything else must
			// name a real category — resolved here, so typing "groceries" finds
			// "Groceries" without the person spelling it the way the list does.
			const isOverall = /^(everything|overall)$/i.test(proposal.category);
			let categoryId: string | null = null;
			let categoryName = 'Everything';
			if (!isOverall) {
				const cats = await listCategories(getDb(), ws.id);
				const needle = proposal.category.toLowerCase();
				const hit =
					cats.find((c) => c.name.toLowerCase() === needle) ??
					cats.find((c) => c.name.toLowerCase().includes(needle));
				if (!hit) {
					return json({
						intent: 'set_budget',
						answer: `I can't find a category called “${proposal.category}”. The Analytics tab lists them all.`
					});
				}
				categoryId = hit.id;
				categoryName = hit.name;
			}
			// Takes effect now: this month, or this week, on the workspace's own
			// week-start convention.
			const from =
				proposal.period === 'week'
					? schedulableBudgetWeeks(today, ws.weekStartDay)[0]
					: `${today.y}-${String(today.m).padStart(2, '0')}-01`;
			await setBudget(getDb(), deps.ids, {
				workspaceId: ws.id,
				categoryId,
				amountMinor: amount.minor,
				effectiveFrom: from,
				period: proposal.period
			});
			return json({
				intent: 'set_budget',
				answer: `${proposal.period === 'week' ? 'Weekly' : 'Monthly'} budget for ${categoryName} set to ${amount.format()}, from ${from}.`,
				target: 'analytics'
			});
		}

		if (proposal.intent === 'create_income') {
			const source = safeName(proposal.source);
			if (!source) {
				return json({ intent: 'create_income', answer: 'Income needs a source.' });
			}
			const day = normalizeDay(proposal.dayOfMonth);
			const start = proposal.monthly
				? { y: today.y, m: today.m, d: Math.min(day, 28) }
				: { y: today.y, m: today.m, d: today.d };
			const rrule = proposal.monthly
				? formatRRule({ start, freq: 'monthly', interval: 1, byMonthDay: start.d })
				: null;
			await addIncome(getDb(), deps, {
				workspaceId: ws.id,
				memberId: locals.member!.id,
				source,
				amountMinor: amount.minor,
				currency,
				receivedAt: zonedTimeToUtc(start, 9, 0, timezone),
				rrule,
				note: null
			});
			return json({
				intent: 'create_income',
				answer: proposal.monthly
					? `Income “${source}” added: ${amount.format()} monthly on day ${start.d}.`
					: `Income “${source}” added: ${amount.format()}.`,
				target: 'income'
			});
		}
	} catch (e) {
		if (e instanceof InvalidMoneyError) {
			return json({ intent: proposal.intent, answer: e.message });
		}
		throw e;
	}

	return json({ intent: 'error', answer: 'That action could not be completed.' });
};
