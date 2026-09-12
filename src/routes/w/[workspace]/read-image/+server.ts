import { error, json } from '@sveltejs/kit';
import { getLlmAssist } from '$lib/infra/llm';
import { readDocumentImage, type DocumentKind } from '$lib/application/read-document-image';
import { toModelImage } from '$lib/infra/images/process';
import type { ImageInput } from '$lib/ports/llm-assist';
import type { RequestHandler } from './$types';
import { assertSameOrigin } from '$lib/http/origin';

/**
 * Read a bill page or a receipt photo with the optional model.
 *
 * The image is posted rather than fetched: `read-pdf` runs in the browser (a
 * canvas is needed to rasterise a page, and the browser has one), so the only
 * copy of a scanned page lives on the client. It comes here, is read, and is not
 * stored — the page the user actually attaches goes through the existing image
 * pipeline on submit, as it always has.
 *
 * Writes nothing. Everything it returns lands in a form for a person to confirm.
 */

/** Matches what `read-pdf` renders and what `processUpload` accepts. */
const ALLOWED = new Set(['image/webp', 'image/jpeg', 'image/png']);

/**
 * A 2000px page render is a few hundred KB. Ten megabytes is far past anything
 * legitimate and well short of anything that would strain the box, which is the
 * right place for a bound whose only job is to refuse the absurd.
 */
const MAX_BYTES = 10 * 1024 * 1024;

export const POST: RequestHandler = async ({ locals, request }) => {
	assertSameOrigin(request);

	const ws = locals.workspace!;
	if (!ws.billImportEnabled) error(403, 'Bill import is off for this workspace.');

	const assist = getLlmAssist({
		aiMode: ws.aiMode,
		aiEndpoint: ws.aiEndpoint,
		aiModel: ws.aiModel,
		aiApiKey: ws.aiApiKey
	});
	// Not an error: the client only offers this when the assist is on, but the
	// workspace can be switched off between the page load and the tap.
	if (!assist.available) return json({ read: null });

	const form = await request.formData().catch(() => null);
	// A closed set, so the instruction the model gets is always one we wrote.
	const kindField = form?.get('kind');
	const kind: DocumentKind = kindField === 'receipt' ? 'receipt' : 'bill';
	const file = form?.get('image');
	if (!(file instanceof File)) error(400, 'An image is required');
	if (!ALLOWED.has(file.type)) error(415, 'That image type is not supported');
	if (file.size === 0 || file.size > MAX_BYTES) error(413, 'That image is too large');

	/*
	 * Re-encoded, never forwarded as posted. `toModelImage` exists because Ollama
	 * silently drops a WebP and the model then invents a bill — see the note
	 * there. It also means the declared type is ours rather than the client's,
	 * and the bytes have been through a decoder before they reach a model.
	 */
	let image: ImageInput;
	try {
		image = await toModelImage(new Uint8Array(await file.arrayBuffer()));
	} catch {
		error(415, 'Could not read that image');
	}

	const read = await readDocumentImage(assist, image, {
		kind,
		currency: ws.currency,
		// Same lean as the text path: the timezone is the only locale signal the
		// workspace stores. See the note in purchases/new/+page.server.ts.
		dayFirst: !ws.timezone.startsWith('America/')
	});

	return json({
		read: {
			// Minor units are a bigint; the form wants a decimal string anyway.
			totalMinor: read.totalMinor?.toString() ?? null,
			vendor: read.vendor ?? null,
			dueDate: read.dueDate ?? null
		}
	});
};
