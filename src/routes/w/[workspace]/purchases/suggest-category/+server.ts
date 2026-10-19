import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getLlmAssist } from '$lib/infra/llm';
import { suggestCategory } from '$lib/application/suggest-category';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/http/origin';

/**
 * Suggest a category for a purchase from its item name and merchant, as the Add
 * form's fields lose focus. A suggestion is never applied here; the client shows
 * it as a chip the person taps to accept.
 *
 * The thinking lives in `suggestCategory`, shared with the describe box. Note
 * what this no longer does: it used to bail out immediately when the assist was
 * off, because a model was the only thing it knew how to ask. The merchant
 * memory needs no model, so the question is worth asking either way — and with
 * AI off this is now the only category help in the app rather than none.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	assertSameOrigin(request);
	const ws = locals.workspace!;
	const body = await request.json().catch(() => ({}));
	const itemName = typeof body?.itemName === 'string' ? body.itemName.trim().slice(0, 120) : '';
	const merchantName =
		typeof body?.merchantName === 'string' ? body.merchantName.trim().slice(0, 200) : '';
	if (!itemName && !merchantName) return json({ categoryId: null });

	const suggestion = await suggestCategory(
		getDb(),
		getLlmAssist({
			aiMode: ws.aiMode,
			aiEndpoint: ws.aiEndpoint,
			aiModel: ws.aiModel,
			aiApiKey: ws.aiApiKey
		}),
		ws.id,
		{ itemName, merchantName },
		{ memberId: locals.member!.id, now: new Date() }
	);

	return json({
		categoryId: suggestion.categoryId,
		name: suggestion.name,
		icon: suggestion.icon
	});
};
