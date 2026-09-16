<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { takeHandoff } from '$lib/reconcile/handoff.svelte';
	import { page } from '$app/state';
	import { submit } from '$lib/actions/submit';
	import { ChevronLeft, ChevronRight, FileText, Sparkles, Upload } from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let slug = $derived(page.params.workspace);

	/** The mapper appears only when auto-detection gave up on a file. */
	const mapping = $derived(
		form && 'needsMapping' in form && form.needsMapping
			? (form as unknown as {
					filename: string;
					headers: string[];
					csv: string;
					accountId: string | null;
					modelRead?: boolean;
				})
			: null
	);

	/*
	 * The PDF path. A CSV is posted as a file and read on the server; a PDF is
	 * read here, in the browser, and only the three columns pulled out of it are
	 * posted. A bank statement carries far more than the ledger needs — card
	 * numbers, addresses, every transaction that has nothing to do with this app —
	 * so the document itself stays on the device.
	 */
	let uploadForm = $state<HTMLFormElement | null>(null);
	let derivedCsv = $state('');
	let derivedName = $state('');
	let format = $state<'csv' | 'pdf'>('csv');
	let reading = $state(false);
	let pdfError = $state('');
	let modelRead = $state(false);

	/*
	 * The scanned path.
	 *
	 * A photographed or photocopied statement has no text layer, so the parser has
	 * nothing to work with. A model can look at the page — but this is the one
	 * place in the app where a model's output describes *money that moved*, so it
	 * gets the one thing the rest of the assist layer doesn't need: a step where a
	 * person looks at what was read before any of it is imported.
	 *
	 * That step is not a heuristic dressed up as a check. Nothing here can tell a
	 * transcribed statement from an invented one — a fabricated page of
	 * transactions looks exactly like a real one at this layer. What a *person*
	 * can tell instantly is whether the bank's name, the account number and the
	 * period belong to them. So that is what gets shown, next to the rows.
	 */
	let scanned = $state<import('$lib/reconcile/read-statement-pdf').StatementPdfResult | null>(null);
	let scanFile = $state<File | null>(null);
	let scanRows = $state<{ date: string; amount: string; description: string; page: number }[]>([]);
	let scanHeader = $state<{ bank?: string; account?: string; period?: string }>({});
	let scanning = $state(false);
	let scanError = $state('');

	/** Matches MAX_PAGES on the endpoint; past this a CSV export is the honest answer. */
	const MAX_SCAN_PAGES = 10;

	async function readScannedPages() {
		if (!scanned || scanning) return;
		scanning = true;
		scanError = '';
		try {
			const pages = await scanned.renderPages(MAX_SCAN_PAGES);
			const body = new FormData();
			for (const p of pages) body.append('pages', p);
			const res = await fetch(`/w/${slug}/reconcile/read-pages`, { method: 'POST', body });
			if (!res.ok) {
				scanError = "Couldn't read those pages just now.";
				return;
			}
			const out = (await res.json()) as {
				rows: typeof scanRows;
				header: typeof scanHeader;
			};
			if (out.rows.length === 0) {
				scanError = "Couldn't make out any transactions. A CSV export from your bank will work.";
				return;
			}
			scanRows = out.rows;
			scanHeader = out.header;
		} catch {
			scanError = "Couldn't read those pages just now.";
		} finally {
			scanning = false;
		}
	}

	/** Only after a person has looked at the rows and the letterhead. */
	async function importScanned() {
		const { rowsToCsv } = await import('$lib/domain/reconcile/parse-pdf');
		derivedCsv = rowsToCsv(scanRows);
		derivedName = scanFile?.name ?? 'statement.pdf';
		format = 'pdf';
		modelRead = true;
		// Svelte batches DOM writes, and these values live in hidden inputs the form
		// is about to serialise. Submitting in the same tick posts the *previous*
		// values — which, with an empty csv field, means the server falls back to
		// the file input and tries to read a PDF's bytes as text.
		await tick();
		uploadForm?.requestSubmit();
		cancelScan();
	}

	function cancelScan() {
		scanned?.dispose();
		scanned = null;
		scanFile = null;
		scanRows = [];
		scanHeader = {};
		scanError = '';
		scanning = false;
	}

	/*
	 * Arriving from the bill reader, which recognised a statement and sent the
	 * file along rather than making it be picked twice. Taken once — a reload
	 * finds nothing and the picker below is the normal way in.
	 */
	onMount(() => {
		const handed = takeHandoff();
		if (handed) void ingest(handed, null);
	});

	async function chooseFile(e: Event & { currentTarget: HTMLInputElement }) {
		// Captured now: `currentTarget` is nulled once the event finishes
		// dispatching, and everything below this line is after an await.
		const input = e.currentTarget;
		const file = input.files?.[0];
		if (!file) return;
		await ingest(file, input);
	}

	/** The one path a statement takes, whether picked here or handed over. */
	async function ingest(file: File, input: HTMLInputElement | null) {
		pdfError = '';

		const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
		if (!isPdf) {
			// Straight through as a file, exactly as before.
			derivedCsv = '';
			derivedName = '';
			format = 'csv';
			// Handed a CSV with no input to carry it: put it in the picker so the
			// form has something to post.
			if (!input && uploadForm) {
				const dt = new DataTransfer();
				dt.items.add(file);
				const picker = uploadForm.querySelector<HTMLInputElement>('input[name=statement]');
				if (picker) picker.files = dt.files;
			}
			await tick();
			uploadForm?.requestSubmit();
			return;
		}

		reading = true;
		try {
			const { readStatementPdf } = await import('$lib/reconcile/read-statement-pdf');
			const result = await readStatementPdf(file);
			if (result.isScanned && result.rows.length === 0) {
				// A picture of a statement. Offer the model if one can look at it;
				// otherwise say plainly why this file can't work.
				if (data.vision.allowed) {
					scanned = result;
					scanFile = file;
					if (input) input.value = '';
					return;
				}
				result.dispose();
				pdfError = data.vision.reason
					? `That PDF is a scan, so there's no text to read. ${data.vision.reason}`
					: "That PDF is a scan, so there's no text to read. A CSV export will work.";
				return;
			}
			if (result.rows.length === 0) {
				result.dispose();
				pdfError = "Couldn't find any transactions in that PDF. A CSV export will work better.";
				return;
			}
			result.dispose();
			modelRead = false;
			derivedCsv = result.csv;
			derivedName = file.name;
			format = 'pdf';
			// The file input still holds the PDF; clear it so the server reads the
			// extracted rows rather than trying to parse the document as a CSV.
			if (input) input.value = '';
			await tick();
			uploadForm?.requestSubmit();
		} catch {
			pdfError = "Couldn't read that PDF. A CSV export from your bank will work better.";
		} finally {
			reading = false;
		}
	}

	function fmtDate(iso: string | Date): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
	function fmtDateLong(iso: string | Date): string {
		return new Date(iso).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	/** "Jun 1 – Jun 30", or the import date when the file carried no dates. */
	function periodLabel(from: string | Date | null, to: string | Date | null): string | null {
		if (!from || !to) return null;
		return `${fmtDate(from)} – ${fmtDate(to)}`;
	}
</script>

<svelte:head><title>Reconcile · Ledger</title></svelte:head>

<div class="mx-auto max-w-lg">
	<a
		href="/w/{slug}"
		class="press mb-4 -ml-1 inline-flex items-center gap-0.5 text-[14px] font-medium"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Settings
	</a>

	<div class="px-1">
		<p class="section-label">Statements</p>
		<h1 class="mt-1 text-[28px]">Reconcile</h1>
		<p class="mt-2 text-[15px] leading-relaxed" style="color: var(--ink-3)">
			Import a CSV or PDF from your bank and check it against what's recorded here. Nothing is
			created, edited or deleted. Importing only marks what has cleared. A PDF is read on your
			device; only the dates, amounts and descriptions are sent.
		</p>
	</div>

	{#if form?.error}
		<div
			class="card mt-4 p-4 text-[15px]"
			style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, var(--surface))"
		>
			{form.error}
		</div>
	{/if}

	{#if mapping}
		<!--
			Auto-detection failed. Rather than sending the person away to reformat a
			file, name the columns here. The CSV rides back in a hidden field so the
			file doesn't have to be chosen a second time.
		-->
		<form
			method="POST"
			action="?/uploadMapped"
			use:submit={{ reset: false }}
			class="card mt-4 space-y-4 p-5"
		>
			<div>
				<p class="text-[15px] font-semibold" style="color: var(--ink)">Which column is which?</p>
				<p class="mt-0.5 text-[13px]" style="color: var(--ink-3)">
					{mapping.filename}. Its headers didn't match anything recognizable.
				</p>
			</div>

			<input type="hidden" name="csv" value={mapping.csv} />
			<input type="hidden" name="modelRead" value={mapping.modelRead ? 'true' : 'false'} />
			<input type="hidden" name="filename" value={mapping.filename} />
			<input type="hidden" name="accountId" value={mapping.accountId ?? ''} />
			<input type="hidden" name="format" value={format} />

			{#each [{ name: 'dateCol', label: 'Date' }, { name: 'amountCol', label: 'Amount' }, { name: 'descriptionCol', label: 'Description' }] as f (f.name)}
				<label class="block">
					<span class="section-label mb-1.5 block">{f.label}</span>
					<select name={f.name} class="field text-[16px]" required>
						{#each mapping.headers as h, i (i)}
							<option value={i}>{h || `Column ${i + 1}`}</option>
						{/each}
					</select>
				</label>
			{/each}

			<label class="block">
				<span class="section-label mb-1.5 block">Date order</span>
				<select name="dateOrder" class="field text-[16px]">
					<option value="MDY">Month / Day / Year</option>
					<option value="DMY">Day / Month / Year</option>
					<option value="YMD">Year / Month / Day</option>
				</select>
			</label>

			<label class="flex items-start gap-2.5">
				<input type="checkbox" name="invertAmount" class="mt-0.5" />
				<span class="text-[14px] leading-snug" style="color: var(--ink-2)">
					Positive amounts are money going out
					<span class="mt-0.5 block text-[13px]" style="color: var(--ink-3)">
						Check this if your bank lists spending as positive numbers.
					</span>
				</span>
			</label>

			<button class="btn btn-accent w-full">Import with these columns</button>
		</form>
	{:else}
		{#if scanned}
			<!--
				The scanned path's one extra screen. Everything on it is here so a
				person can answer one question the code cannot: is this my statement?
			-->
			<div class="card mt-5 p-4">
				<p class="section-label">A scanned statement</p>
				{#if scanRows.length === 0}
					<p class="mt-2 text-[14px] leading-relaxed" style="color: var(--ink-2)">
						There's no text in this PDF, so it's a picture of a statement: {scanned.pageCount}
						{scanned.pageCount === 1 ? 'page' : 'pages'}. Harmony can read the pages and show you
						what it found. Nothing is imported until you've looked at it.
					</p>
					<div class="mt-3 flex flex-wrap items-center gap-2">
						<button
							onclick={readScannedPages}
							disabled={scanning}
							class="btn btn-accent px-3.5 py-1.5 text-[13px]"
						>
							{scanning ? 'Reading the pages…' : 'Read the pages'}
						</button>
						<button
							onclick={cancelScan}
							class="press text-[13px] underline underline-offset-2"
							style="color: var(--ink-3)">Cancel</button
						>
					</div>
				{:else}
					<!--
						The letterhead first, and deliberately above the figures. If the
						model never actually saw the page it will have invented a plausible
						statement, and the fastest way anyone can tell is that the bank
						isn't theirs. The rows below could be checked one by one; this can
						be checked at a glance.
					-->
					<p class="mt-2 text-[14px] leading-relaxed" style="color: var(--ink-2)">
						Read from the page. Check this is your statement before importing. These figures were
						transcribed from a picture.
					</p>
					<dl class="mt-3 space-y-1 text-[14px]">
						{#each [['Bank', scanHeader.bank], ['Account', scanHeader.account], ['Period', scanHeader.period]] as [label, value] (label)}
							<div class="flex gap-2">
								<dt style="color: var(--ink-3)">{label}</dt>
								<dd class="flex-1 text-right" style="color: var(--ink)">
									{value || '·'}
								</dd>
							</div>
						{/each}
					</dl>

					<div class="mt-4 flex items-center justify-between">
						<p class="section-label">
							{scanRows.length === 1 ? 'Transaction' : 'Transactions'}
						</p>
						<span class="chip num" style="color: var(--ink-3); background: var(--surface-2)"
							>{scanRows.length}</span
						>
					</div>
					<div class="mt-1 max-h-64 overflow-y-auto">
						{#each scanRows as r, i (i)}
							<div class="flex items-baseline gap-2 py-1.5 text-[13px] {i ? 'hairline' : ''}">
								<span class="num shrink-0" style="color: var(--ink-3)">{r.date}</span>
								<span class="min-w-0 flex-1 truncate" style="color: var(--ink-2)"
									>{r.description || '·'}</span
								>
								<span class="num shrink-0" style="color: var(--ink)">{r.amount}</span>
							</div>
						{/each}
					</div>

					<div class="mt-3 flex flex-wrap items-center gap-2">
						<button onclick={importScanned} class="btn btn-accent px-3.5 py-1.5 text-[13px]">
							Import these
						</button>
						<button
							onclick={cancelScan}
							class="press text-[13px] underline underline-offset-2"
							style="color: var(--ink-3)">Not my statement</button
						>
					</div>
				{/if}
				{#if scanError}
					<p class="mt-2 text-[13px]" style="color: var(--ink-3)">{scanError}</p>
				{/if}
			</div>
		{/if}

		<form
			bind:this={uploadForm}
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			use:submit={{ reset: false }}
			class="mt-5"
		>
			<!-- Filled in only on the PDF path, where the browser did the reading. -->
			<input type="hidden" name="csv" bind:value={derivedCsv} />
			<input type="hidden" name="filename" bind:value={derivedName} />
			<input type="hidden" name="format" bind:value={format} />
			<input type="hidden" name="modelRead" value={modelRead ? 'true' : 'false'} />

			{#if data.accounts.length > 0}
				<label class="mb-3 block">
					<span class="section-label mb-1.5 block">Which card is this?</span>
					<select name="accountId" class="field text-[16px]">
						<option value="">Not sure / all cards</option>
						{#each data.accounts as a (a.id)}
							<option value={a.id}>{a.last4 ? `${a.name} ·${a.last4}` : a.name}</option>
						{/each}
					</select>
					<span class="mt-1.5 block text-[13px] leading-snug" style="color: var(--ink-3)">
						Naming the card keeps one statement from matching another card's purchases.
					</span>
				</label>
			{/if}

			<!--
				The file input below is required only when the file *is* the payload.
				Both PDF paths clear it and post extracted rows instead, and
				`requestSubmit()` silently does nothing on a form that fails constraint
				validation — so leaving it unconditionally required makes the submit a
				no-op at exactly the moment there is something to submit.
			-->
			<label
				class="press flex cursor-pointer items-center gap-3.5 rounded-[14px] p-4"
				style="box-shadow: inset 0 0 0 1px var(--hairline); background: var(--surface)"
			>
				<span
					class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
					style="background: color-mix(in oklab, var(--ws-accent) 18%, transparent)"
				>
					{#if reading}
						<span
							class="h-4 w-4 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
							style="color: var(--ws-accent)"
						></span>
					{:else}
						<Upload class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
					{/if}
				</span>
				<span class="min-w-0 flex-1">
					<span class="block text-[15px] font-medium" style="color: var(--ink)">
						{reading ? 'Reading the statement…' : 'Import a statement'}
					</span>
					<span class="mt-0.5 block text-[13px]" style="color: var(--ink-3)">
						{pdfError ? pdfError : 'A CSV or PDF from your bank'}
					</span>
				</span>
				<input
					type="file"
					name="statement"
					accept=".csv,text/csv,.pdf,application/pdf"
					required={!derivedCsv}
					class="sr-only"
					onchange={chooseFile}
				/>
			</label>
			<button type="submit" class="sr-only">Import</button>
		</form>

		<!--
			Cards are named here rather than buried in settings: the moment you need
			one is the moment you are importing a second card's statement.
		-->
		<details class="mt-3 px-1">
			<summary class="cursor-pointer text-[13px]" style="color: var(--ink-3)">
				{data.accounts.length > 0 ? 'Add another card' : 'Name your cards'}
			</summary>
			<form method="POST" action="?/addAccount" use:submit class="mt-2 flex items-end gap-2">
				<label class="min-w-0 flex-1">
					<span class="section-label mb-1.5 block">Name</span>
					<input name="name" required maxlength="60" placeholder="Visa" class="field text-[16px]" />
				</label>
				<label class="w-24 shrink-0">
					<span class="section-label mb-1.5 block">Last 4</span>
					<input
						name="last4"
						inputmode="numeric"
						maxlength="4"
						placeholder="1234"
						class="field text-[16px]"
					/>
				</label>
				<button class="btn btn-ghost shrink-0 px-4 py-2.5 text-[14px]">Add</button>
			</form>
		</details>
	{/if}

	{#if data.imports.length === 0}
		<div class="mt-8 px-6 py-10 text-center">
			<div
				class="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[22px]"
				style="background: radial-gradient(120% 120% at 30% 20%, color-mix(in oklab, var(--ws-accent) 40%, var(--surface)), var(--surface))"
			>
				<FileText class="h-8 w-8" style="color: color-mix(in oklab, var(--ws-accent) 80%, white)" />
			</div>
			<p class="text-[19px] font-semibold" style="color: var(--ink)">No statements yet</p>
			<p
				class="mx-auto mt-1.5 max-w-[30ch] text-[15px] leading-relaxed"
				style="color: var(--ink-3)"
			>
				Most banks export a CSV from their transactions page, and a PDF statement works too. Import
				one and Ledger will match it against what's recorded here.
			</p>
		</div>
	{:else}
		<p class="section-label mt-8 mb-1 px-1">Imported</p>
		<div class="rule">
			{#each data.imports as imp, i (imp.id)}
				{@const period = periodLabel(imp.periodStart, imp.periodEnd)}
				{@const done = imp.confirmedCount >= imp.lineCount}
				<a
					href="/w/{slug}/reconcile/{imp.id}"
					class="press flex items-center gap-3 px-1 py-3.5 {i === data.imports.length - 1
						? ''
						: 'hairline'}"
				>
					<div class="min-w-0 flex-1">
						<p class="flex items-center gap-1.5 text-[16px] font-medium" style="color: var(--ink)">
							<span class="truncate">{period ?? imp.filename}</span>
							{#if imp.modelRead}
								<!-- Marked in the list too: you should know before you open it. -->
								<Sparkles
									class="h-3.5 w-3.5 shrink-0"
									style="color: var(--pending)"
									aria-label="Read from a picture"
								/>
							{/if}
							{#if imp.closed}
								<span
									class="chip shrink-0"
									style="color: var(--approve); background: color-mix(in oklab, var(--approve) 14%, transparent)"
									>Closed</span
								>
							{/if}
						</p>
						<p class="mt-0.5 truncate text-[13px]" style="color: var(--ink-3)">
							{imp.lineCount}
							{imp.lineCount === 1 ? 'line' : 'lines'} · {imp.importedByName} · {fmtDateLong(
								imp.createdAt
							)}
						</p>
					</div>
					<!--
						Progress as a fraction, not a bar: reconciling is counted work with a
						known end, and "12 / 40" says how much is left in a way a bar can't.
					-->
					<span
						class="num shrink-0 text-[13px]"
						style="color: {done ? 'var(--approve)' : 'var(--ink-3)'}"
					>
						{imp.confirmedCount}/{imp.lineCount}
					</span>
					<ChevronRight class="h-4 w-4 shrink-0" style="color: var(--ink-4)" />
				</a>
			{/each}
		</div>
	{/if}
</div>
