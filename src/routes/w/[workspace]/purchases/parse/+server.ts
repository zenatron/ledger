import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getLlmAssist } from '$lib/infra/llm';
import { suggestCategory } from '$lib/application/suggest-category';
import { parsePurchaseText } from '$lib/domain/intelligence/parse-purchase';
import { calDateInZone } from '$lib/domain/time/zoned';
import { addDays } from '$lib/domain/recurrence/rrule';
import { systemClock } from '$lib/infra/time/system-clock';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/http/origin';

/**
 * Turn a spoken/typed sentence into purchase fields for the Add form. Money and
 * date come only from the deterministic parser; the optional assist adds only a
 * category. Nothing is submitted — the client fills the form, the person confirms.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	assertSameOrigin(request);
	const ws = locals.workspace!;
	const body = await request.json().catch(() => ({}));
	const text = typeof body?.text === 'string' ? body.text.slice(0, 300) : '';
	if (!text.trim()) return json({ empty: true });

	// The person's own calendar day, so "on the 3rd" resolves against where they
	// are rather than where the server is.
	const today = calDateInZone(systemClock.now(), ws.timezone);
	const parsed = parsePurchaseText(text, today);

	// Deterministic date → a YYYY-MM-DD the form can back-date with.
	const pad = (n: number) => String(n).padStart(2, '0');
	let spentAt: string | null = null;
	if (parsed.dateOffsetDays < 0) {
		const d = addDays(today, parsed.dateOffsetDays);
		spentAt = `${d.y}-${pad(d.m)}-${pad(d.d)}`;
	}

	// A category suggestion, constrained to the workspace's own set. Runs even
	// with the assist off: the merchant memory half of it is our own data.
	const suggestion = await suggestCategory(
		getDb(),
		getLlmAssist({
			aiMode: ws.aiMode,
			aiEndpoint: ws.aiEndpoint,
			aiModel: ws.aiModel,
			aiApiKey: ws.aiApiKey
		}),
		ws.id,
		{
			itemName: parsed.itemName,
			merchantName: parsed.merchantName,
			amount: parsed.amount,
			sentence: text
		},
		{ memberId: locals.member!.id, now: new Date() }
	);

	return json({
		amount: parsed.amount,
		itemName: parsed.itemName,
		merchantName: parsed.merchantName,
		intent: parsed.intent,
		dateOffsetDays: parsed.dateOffsetDays,
		dateLabel: parsed.dateLabel,
		spentAt,
		categoryId: suggestion.categoryId,
		categoryName: suggestion.name
	});
};
