import { isUuid } from '$lib/uuid';
import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listImports } from '$lib/repo/statements';
import {
	MAX_CSV_BYTES,
	ReconcileError,
	deleteImport,
	importStatement
} from '$lib/application/reconcile';
import { detectColumns } from '$lib/domain/reconcile/parse-csv';
import { createAccount, listAccounts } from '$lib/repo/accounts';
import { rateLimitOk } from '$lib/server/rate-limit';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { systemClock } from '$lib/infra/time/system-clock';
import { visionGate } from '$lib/server/vision-gate';
import type { Actions, PageServerLoad } from './$types';

const deps = { clock: systemClock, ids: uuidv7 };

export const load: PageServerLoad = async ({ locals, params }) => {
	// See +layout.server.ts: a locals-only load declares no dependency on the
	// workspace in the URL, so switching workspaces wouldn't re-run it.
	void params.workspace;
	const db = getDb();
	const ws = locals.workspace!;
	const [imports, accounts, vision] = await Promise.all([
		listImports(db, ws.id),
		listAccounts(db, ws.id),
		// Only consulted for a PDF with no text layer. Carries its own refusal
		// wording, so the UI never invents one — see domain/intelligence/capability-gate
		// for why "we couldn't establish it" fails open rather than closed.
		visionGate(ws)
	]);
	return { currency: ws.currency, imports, accounts, vision };
};

/**
 * The card a statement is for, validated against this workspace. An id from
 * anywhere else, or a blank picker, becomes null — which is the old behaviour of
 * matching against every purchase in the window.
 */
async function accountFrom(form: FormData, workspaceId: string): Promise<string | null> {
	const raw = form.get('accountId');
	if (typeof raw !== 'string' || !raw) return null;
	const accounts = await listAccounts(getDb(), workspaceId);
	return accounts.some((a) => a.id === raw) ? raw : null;
}

/** First row of a CSV, for the manual column mapper. */
function headerOf(csv: string): string[] {
	const firstLine = csv.replaceAll('\r\n', '\n').split('\n')[0] ?? '';
	// Good enough to *label* the mapper's dropdowns; the real RFC 4180 tokeniser
	// in parse-csv does the actual reading.
	return firstLine.split(',').map((h) => h.replace(/^"|"$/g, '').trim());
}

export const actions: Actions = {
	upload: async ({ request, locals, params, getClientAddress }) => {
		// Parsing a statement is markedly more work than an ordinary form post,
		// and it's an authenticated upload — the same reason /push and image
		// uploads are limited.
		if (!rateLimitOk(`statement-import:${locals.member!.id}`, 10, 60_000)) {
			return fail(429, { error: 'Too many imports. Wait a minute and try again.' });
		}
		void getClientAddress;

		const form = await request.formData();

		/*
		 * Two ways in. A CSV is posted as a file and read here. A PDF was already
		 * reduced to these same three columns in the browser — see
		 * $lib/reconcile/read-statement-pdf, which keeps the document on the device
		 * — and arrives as text with a name and a format alongside it.
		 */
		const posted = form.get('csv');
		const isDerived = typeof posted === 'string' && posted.length > 0;
		const format = form.get('format') === 'pdf' ? ('pdf' as const) : ('csv' as const);

		let csv: string;
		let filename: string;
		if (isDerived) {
			csv = posted;
			filename = String(form.get('filename') ?? 'statement.pdf');
		} else {
			const file = form.get('statement');
			if (!(file instanceof File) || file.size === 0) {
				return fail(400, { error: 'Choose a CSV or PDF statement to import.' });
			}
			if (file.size > MAX_CSV_BYTES) {
				return fail(400, { error: 'That file is too large to import.' });
			}
			csv = await file.text();
			filename = file.name;
		}
		if (csv.length > MAX_CSV_BYTES) {
			return fail(400, { error: 'That file is too large to import.' });
		}
		const accountId = await accountFrom(form, locals.workspace!.id);
		/*
		 * Only ever true on the scanned path, which renders pages in the browser,
		 * has them transcribed, shows a person the result, and posts the rows they
		 * accepted. Anded with `format === 'pdf'` so a hand-rolled POST can't mark a
		 * plain CSV as model-read — the marking is a warning, and a warning that can
		 * be set on a file that didn't earn it is noise.
		 */
		const modelRead = form.get('modelRead') === 'true' && format === 'pdf';

		/*
		 * Column mapping. Auto-detection handles the common exports; when it
		 * can't, the page shows a mapper and posts back with explicit columns
		 * rather than failing. The raw CSV rides along in a hidden field so the
		 * person doesn't have to pick the file a second time — it has already
		 * been read into memory and is capped above.
		 */
		const dateCol = form.get('dateCol');
		const amountCol = form.get('amountCol');
		const descriptionCol = form.get('descriptionCol');
		const explicit =
			dateCol !== null && amountCol !== null && descriptionCol !== null
				? {
						dateCol: Number(dateCol),
						amountCol: Number(amountCol),
						descriptionCol: Number(descriptionCol),
						invertAmount: form.get('invertAmount') === 'on',
						dateOrder: (form.get('dateOrder') as 'MDY' | 'DMY' | 'YMD') || 'MDY'
					}
				: undefined;

		if (!explicit && !detectColumns(headerOf(csv))) {
			// Hand the file back with its headers so the mapper can be shown.
			return fail(400, {
				needsMapping: true,
				filename,
				accountId,
				modelRead,
				headers: headerOf(csv),
				csv,
				error: "Couldn't work out which columns are which. Point them out below."
			});
		}

		let importId: string;
		try {
			const result = await importStatement(
				getDb(),
				deps,
				{ workspaceId: locals.workspace!.id, memberId: locals.member!.id },
				{
					filename,
					csv,
					currency: locals.workspace!.currency,
					map: explicit,
					accountId,
					format,
					modelRead
				}
			);
			importId = result.importId;
		} catch (e) {
			if (e instanceof ReconcileError) return fail(400, { error: e.message });
			throw e;
		}
		redirect(303, `/w/${params.workspace}/reconcile/${importId}`);
	},

	/** Re-post of the mapper: same path, with the CSV carried in the form. */
	uploadMapped: async ({ request, locals, params }) => {
		const form = await request.formData();
		const csv = String(form.get('csv') ?? '');
		const filename = String(form.get('filename') ?? 'statement.csv');
		if (!csv) return fail(400, { error: 'That file is no longer available. Choose it again.' });
		const accountId = await accountFrom(form, locals.workspace!.id);
		const format = form.get('format') === 'pdf' ? ('pdf' as const) : ('csv' as const);
		// Only ever true for the scanned path, which posts its rows from the client
		// after a person has looked at them.
		const modelRead = form.get('modelRead') === 'true' && format === 'pdf';

		let importId: string;
		try {
			const result = await importStatement(
				getDb(),
				deps,
				{ workspaceId: locals.workspace!.id, memberId: locals.member!.id },
				{
					filename,
					csv,
					currency: locals.workspace!.currency,
					map: {
						dateCol: Number(form.get('dateCol')),
						amountCol: Number(form.get('amountCol')),
						descriptionCol: Number(form.get('descriptionCol')),
						invertAmount: form.get('invertAmount') === 'on',
						dateOrder: (form.get('dateOrder') as 'MDY' | 'DMY' | 'YMD') || 'MDY'
					},
					accountId,
					format,
					modelRead
				}
			);
			importId = result.importId;
		} catch (e) {
			if (e instanceof ReconcileError) return fail(400, { error: e.message });
			throw e;
		}
		redirect(303, `/w/${params.workspace}/reconcile/${importId}`);
	},

	/** Name a card without leaving the import screen. */
	addAccount: async ({ request, locals }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Give the card a name.' });
		await createAccount(getDb(), deps, locals.workspace!.id, {
			name: name.slice(0, 60),
			last4: String(form.get('last4') ?? '')
		});
		return { ok: true };
	},

	delete: async ({ request, locals }) => {
		const form = await request.formData();
		const importId = String(form.get('importId') ?? '');
		if (!isUuid(importId)) return fail(400, { error: 'Nothing to remove.' });
		await deleteImport(
			getDb(),
			deps,
			{ workspaceId: locals.workspace!.id, memberId: locals.member!.id },
			importId
		);
		return { ok: true };
	}
};
