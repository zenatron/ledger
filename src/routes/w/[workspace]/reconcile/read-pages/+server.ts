import { error, json } from '@sveltejs/kit';
import { getLlmAssist } from '$lib/infra/llm';
import { readStatementPage } from '$lib/application/read-statement-image';
import { toModelImage } from '$lib/infra/images/process';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/http/origin';

/**
 * Transcribe the pages of a scanned statement.
 *
 * The pages are posted rather than the PDF: `read-statement-pdf` rasterises in
 * the browser, and the statement itself still never leaves the device — the same
 * property the text path already has, and the reason that path exists. Nothing
 * is stored here and nothing is written; the rows come back for a person to look
 * at before any import happens.
 *
 * Pages are read one at a time rather than in parallel. A local box serving a
 * vision model is usually the bottleneck for the whole machine, and firing eight
 * page-sized requests at it at once is how you turn a slow feature into a hung
 * one.
 */

/**
 * A statement is usually one to four pages; ten is generous. The bound is not
 * about cost so much as honesty — past this the feature is pretending to do
 * something it will do badly, and a CSV export from the bank is right there.
 */
const MAX_PAGES = 10;
const MAX_BYTES_PER_PAGE = 10 * 1024 * 1024;

export const POST: RequestHandler = async ({ locals, request }) => {
	assertSameOrigin(request);

	const ws = locals.workspace!;
	const assist = getLlmAssist({
		aiMode: ws.aiMode,
		aiEndpoint: ws.aiEndpoint,
		aiModel: ws.aiModel,
		aiApiKey: ws.aiApiKey
	});
	if (!assist.available) return json({ rows: [], header: {}, pagesRead: 0 });

	const form = await request.formData().catch(() => null);
	const files = (form?.getAll('pages') ?? []).filter((f): f is File => f instanceof File);
	if (files.length === 0) error(400, 'At least one page image is required');
	if (files.length > MAX_PAGES) error(413, `That statement has more than ${MAX_PAGES} pages`);
	if (files.some((f) => f.size === 0 || f.size > MAX_BYTES_PER_PAGE)) {
		error(413, 'One of those pages is too large');
	}

	const dayFirst = !ws.timezone.startsWith('America/');
	const rows = [];
	let header = {};
	let pagesRead = 0;

	for (const [i, file] of files.entries()) {
		let image;
		try {
			// Re-encoded, never forwarded as posted — see `toModelImage`. A silently
			// undecodable image is the one failure that would produce a *fabricated*
			// statement rather than an empty one.
			image = await toModelImage(new Uint8Array(await file.arrayBuffer()));
		} catch {
			continue;
		}
		const read = await readStatementPage(assist, image, {
			page: i + 1,
			currency: ws.currency,
			dayFirst,
			// Only the first page carries the letterhead, and it is the page a
			// person will recognise. One extra call for the whole statement.
			withHeader: i === 0
		});
		if (i === 0) header = read.header;
		rows.push(...read.rows);
		pagesRead++;
	}

	return json({ rows, header, pagesRead });
};
