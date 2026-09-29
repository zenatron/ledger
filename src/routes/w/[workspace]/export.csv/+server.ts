import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { account, category, merchant, purchase, user, workspaceMember } from '$lib/db/schema';
import { visibleTo } from '$lib/repo/purchases';
import { Money } from '$lib/domain/money/money';
import { systemClock } from '$lib/infra/time/system-clock';
import { calDateInZone, formatCalDate } from '$lib/domain/time/zoned';
import type { RequestHandler } from './$types';

/**
 * Quote per RFC 4180, and neutralize spreadsheet formula injection: Excel and
 * Sheets execute a cell starting with = + - @ (or a leading tab/CR), so an item
 * named `=HYPERLINK(...)` would run on open. A leading apostrophe forces text.
 */
function csvField(value: string): string {
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Purchase history export. Seal-filtered like every other read surface. */
export const GET: RequestHandler = async ({ locals }) => {
	const now = systemClock.now();
	const tz = locals.workspace!.timezone;
	const rows = await getDb()
		.select({
			p: purchase,
			requester: user.displayName,
			categoryName: category.name,
			merchantName: merchant.name,
			accountName: account.name
		})
		.from(purchase)
		.innerJoin(workspaceMember, eq(purchase.memberId, workspaceMember.id))
		.innerJoin(user, eq(workspaceMember.userId, user.id))
		.leftJoin(category, eq(purchase.categoryId, category.id))
		.leftJoin(merchant, eq(purchase.merchantId, merchant.id))
		.leftJoin(account, eq(purchase.accountId, account.id))
		.where(and(eq(purchase.workspaceId, locals.workspace!.id), visibleTo(locals.member!.id, now)))
		.orderBy(asc(purchase.createdAt));

	const header =
		'date,item,from,state,requester,category,card,requested,approved,final,currency,note';
	const lines = rows.map((r) => {
		const amount = (minor: bigint | null) =>
			minor === null ? '' : Money.of(minor, r.p.currency).toDecimalString();
		return [
			// The calendar date where the household lives, as every screen shows it.
			// toISOString() gave the UTC date, so an evening purchase west of
			// Greenwich exported as the next day and landed in the wrong month.
			formatCalDate(calDateInZone(r.p.completedAt ?? r.p.requestedAt ?? r.p.createdAt, tz)),
			csvField(r.p.itemName),
			csvField(r.merchantName ?? ''),
			r.p.state,
			csvField(r.requester),
			csvField(r.categoryName ?? ''),
			csvField(r.accountName ?? ''),
			amount(r.p.requestedAmountMinor),
			amount(r.p.approvedAmountMinor),
			amount(r.p.finalAmountMinor),
			r.p.currency,
			csvField(r.p.note ?? '')
		].join(',');
	});

	return new Response([header, ...lines].join('\n') + '\n', {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${locals.workspace!.slug}-purchases.csv"`
		}
	});
};
