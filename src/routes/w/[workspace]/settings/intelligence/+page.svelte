<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import Toggle from '$lib/components/Toggle.svelte';
	import SettingGroup from '$lib/components/SettingGroup.svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import type { DiscretionMode } from '$lib/domain/visibility/discretion';
	import {
		ChevronLeft,
		Check,
		CircleAlert,
		MapPin,
		RefreshCw,
		ScanEye,
		ScanLine,
		ShieldCheck,
		Sparkles,
		Wallet
	} from '@lucide/svelte';

	let { data, form } = $props();
	let slug = $derived(page.params.workspace);
	const owner = $derived(data.isOwner);

	let mode = $state<'off' | 'local' | 'external'>(data.config.mode);
	let endpoint = $state(data.config.endpoint);
	let model = $state(data.config.model);
	let apiKey = $state('');

	// Re-sync form state from the server after a successful save — never after a
	// test request (which doesn't write), and never during ordinary interaction
	// (where the server value is stale relative to what the user is typing).
	$effect(() => {
		if (!form?.ok) return;
		mode = data.config.mode;
		endpoint = data.config.endpoint;
		model = data.config.model;
		apiKey = '';
	});

	/*
	 * The two personal Safe to Spend preferences. Both are per-member, so neither
	 * goes through /settings/flag (which is workspace-wide and owner-only) — they
	 * use the member endpoints, which every member may write for themselves.
	 *
	 * Optimistic like every other switch: `display` moves first and the fetch
	 * follows. A failure throws, which is what makes Toggle revert and warn.
	 */
	let display = $derived(data.safeToSpendDisplay as DiscretionMode);

	async function setDisplay(next: DiscretionMode) {
		const prev = display;
		if (next === prev) return;
		display = next;
		try {
			await postPref('member-pref', { pref: 'safeToSpendDisplay', value: next });
		} catch (e) {
			display = prev;
			throw e;
		}
	}

	const setMemberFlag = (flag: string, value: boolean) => postPref('member-flag', { flag, value });

	async function postPref(endpoint: string, body: Record<string, unknown>) {
		const res = await fetch(`/w/${slug}/settings/${endpoint}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error(String(res.status));
	}

	const testResult = $derived(form && 'test' in form ? form.test : null);
	const geoHealth = $derived(form && 'geocoder' in form ? form.geocoder : null);

	/**
	 * Green only when the check actually proved something. A provider that is up
	 * but found nothing for the address you gave it is the case this whole panel
	 * exists for — the extract doesn't cover you — so it must not read as a pass.
	 */
	const geoPassed = $derived(
		geoHealth?.state === 'ready' && (geoHealth.probe === null || geoHealth.probe.found > 0)
	);
	function geoTone(state: string): string {
		if (geoPassed) return 'var(--approve)';
		if (state === 'ready' || state === 'starting') return 'var(--pending)';
		return 'var(--deny)';
	}

	const availableModels = $derived(testResult?.models ?? []);

	/*
	 * Chip colours carry meaning rather than decorating: vision is the one people
	 * are hunting for when they scan this list, so it gets the accent, and the
	 * rest sit back in the neutral ink. Anything Ollama reports that we don't
	 * recognise still renders — it just renders quietly.
	 */
	function capTone(cap: string): string {
		if (cap === 'vision') return 'var(--ws-accent)';
		if (cap === 'tools') return 'var(--info)';
		if (cap === 'thinking') return 'var(--seal)';
		return 'var(--ink-3)';
	}
</script>

<div class="mx-auto max-w-lg space-y-4">
	<a
		href="/w/{slug}"
		class="press -ml-1 inline-flex items-center gap-0.5 text-[15px]"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Settings
	</a>
	<h1 class="px-1 text-[28px]">Harmony</h1>

	<!-- The deterministic suite: always on. -->
	<div class="card p-4">
		<p class="flex items-center gap-1.5 text-[15px] font-medium" style="color: var(--ink)">
			<Sparkles class="h-4 w-4 shrink-0" style="color: var(--ws-accent)" />
			Harmony Intelligence
			<span
				class="rounded-[var(--r-full)] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.06em] uppercase"
				style="background: color-mix(in oklab, var(--pending) 16%, var(--surface)); color: var(--pending)"
				>Alpha</span
			>
		</p>
		<p class="mt-0.5 text-[13px] leading-relaxed" style="color: var(--ink-3)">
			Works out what's safe to spend this month and answers questions about your money in plain
			language.
		</p>
		<a
			href="/w/{slug}/settings/help?s=safe-to-spend"
			class="press mt-1 inline-block text-[13px] font-medium"
			style="color: var(--accent-ink)">How it works</a
		>
	</div>

	<!--
		How you read the headline, moved here from the ledger's filter sheet.
		Everything else in that sheet resets when you leave the page; this does
		not, so it was the one durable preference sitting among transient ones.

		The switch is "show it at all". Off is the whole feature gone from the
		ledger, which is why the two ways of showing it only appear once it's on.
	-->
	<SettingGroup
		title="Safe to Spend"
		description="The headline on your ledger: how much is free to spend this month. This is your own view, so it counts only what you can see."
		icon={Wallet}
		on={display !== 'off'}
		onToggle={(next) => setDisplay(next ? 'masked' : 'off')}
	>
		<div class="space-y-4">
			<Segmented
				options={[
					{ value: 'masked', label: 'Hidden until tapped' },
					{ value: 'shown', label: 'Always shown' }
				]}
				value={display}
				onselect={(v) => setDisplay(v as DiscretionMode)}
				label="On the ledger"
				size="sm"
			/>
			<p class="text-[12px] leading-relaxed" style="color: var(--ink-3)">
				{#if display === 'masked'}
					The digits read as dots until you tap the eye. They hide again next time you open the app.
				{:else}
					The figure is on screen whenever the ledger is.
				{/if}
			</p>

			<div
				class="flex items-start justify-between gap-4 border-t pt-4"
				style="border-color: var(--hairline)"
			>
				<div>
					<p class="text-[15px] font-medium" style="color: var(--ink)">The months after</p>
					<p class="mt-0.5 text-[13px] leading-relaxed" style="color: var(--ink-3)">
						Project the next few months from your recurring income, bills, and bucket accruals.
						Shown inside the breakdown when you open it.
					</p>
				</div>
				<Toggle
					on={data.showRunwayMonths}
					onToggle={(next) => setMemberFlag('showRunwayMonths', next)}
					label="Toggle the months after"
				/>
			</div>
		</div>
	</SettingGroup>

	<div class="card flex items-center justify-between gap-4 p-4">
		<div>
			<p class="flex items-center gap-1.5 text-[15px] font-medium" style="color: var(--ink)">
				<ScanEye class="h-4 w-4 shrink-0" style="color: var(--ws-accent)" />
				Read a bill or receipt
			</p>
			<p class="mt-0.5 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				Extracts text from a PDF or image. AI can help interpret unclear amounts, and nothing lands
				in the ledger until you confirm it.
			</p>
		</div>
		{#if owner}
			<Toggle
				on={data.billImportEnabled}
				flag="billImportEnabled"
				label="Toggle reading a bill or receipt"
			/>
		{/if}
	</div>

	<div class="card flex items-start justify-between gap-4 p-4">
		<div>
			<p class="flex items-center gap-1.5 text-[15px] font-medium" style="color: var(--ink)">
				<ScanLine class="h-4 w-4 shrink-0" style="color: var(--ws-accent)" />
				Scan a barcode
			</p>
			<p class="mt-0.5 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				Point your camera at a barcode to capture the product code. To look up a product name and
				category, set up a product-lookup API like <a
					href="https://world.openfoodfacts.org/data"
					target="_blank"
					rel="noopener noreferrer"
					class="underline decoration-dotted"
					style="color: var(--accent-ink)">Open Food Facts</a
				> and set the URL in your deployment's environment.
			</p>
			{#if !data.barcodeConfigured}
				<p
					class="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed"
					style="color: var(--pending)"
				>
					<CircleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<span>
						Barcode lookup isn't configured. Set <code class="font-mono text-[11px]"
							>BARCODE_LOOKUP_URL</code
						>
						in your deployment environment to enable this.
					</span>
				</p>
			{/if}
		</div>
		{#if owner}
			<Toggle
				on={data.barcodeEnabled}
				flag="barcodeEnabled"
				label="Toggle scanning a barcode"
				disabled={!data.barcodeConfigured}
			/>
		{/if}
	</div>

	<!--
		Places. The copy carries the honest version of what 110 m means on purpose:
		"rounded" invites people to read "anonymized", and it isn't. Understating it
		here would be the one place in the app where the interface is less truthful
		than the thing it describes.
	-->
	<div class="card flex items-start justify-between gap-4 p-4">
		<div>
			<p class="flex items-center gap-1.5 text-[15px] font-medium" style="color: var(--ink)">
				<MapPin class="h-4 w-4 shrink-0" style="color: var(--ws-accent)" />
				Places
			</p>
			<p class="mt-0.5 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				Attach a place to a purchase and see where the money goes on a map. Location is never
				captured automatically: you tap <strong style="color: var(--ink-2)">Use my location</strong
				>, type an address, or paste a map link.
			</p>
			<p class="mt-2 text-[13px] leading-relaxed" style="color: var(--ink-3)">
				Pins are rounded to about 110&nbsp;m before they're stored. That is too coarse to pinpoint
				an address, yet close enough to recognize a home. Places follow the same seal rules as
				everything else: a purchase you can't see has no pin you can see.
			</p>
			{#if !data.tileConfigured}
				<p
					class="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed"
					style="color: var(--pending)"
				>
					<CircleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<span>
						No basemap configured. The map still works and draws your spending on a plotted grid
						instead of streets. Set <code class="font-mono text-[11px]">MAP_TILE_URL</code> to a raster
						tile template to add streets. Tiles are fetched by the server and re-served from this origin,
						so your browser never talks to the tile provider.
					</span>
				</p>
			{:else}
				<p class="mt-2 text-[12px] leading-relaxed" style="color: var(--ink-3)">
					Basemap: {data.tileAttribution}
				</p>
			{/if}
			{#if !data.geocoderConfigured}
				<p
					class="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed"
					style="color: var(--pending)"
				>
					<CircleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<span>
						No address search configured. You can still use your device's location and paste map
						links; those are read offline and never leave this machine. Set <code
							class="font-mono text-[11px]">GEOCODER_URL</code
						>
						to <span class="font-mono text-[11px]">https://nominatim.openstreetmap.org</span> (with
						<code class="font-mono text-[11px]">GEOCODER_EMAIL</code>) or your own Nominatim to
						search addresses.
					</span>
				</p>
			{:else if owner}
				<!--
					Address search is the one optional layer whose failures are all
					invisible by design — off, unreachable, mid-import and "not in the
					imported extract" reach the form as the same empty list, because a
					person recording a purchase can do nothing with the difference. An
					operator can, and this is where they're told apart. It sits behind a
					button rather than probing on load: this is the only thing on the page
					that reaches out to another service just for being looked at.
				-->
				<div class="mt-2.5 border-t pt-2.5" style="border-color: var(--hairline)">
					<p class="text-[12px] leading-relaxed" style="color: var(--ink-3)">
						Address search: <span class="font-mono">{data.geocoderEndpoint}</span>
					</p>
					<!--
						`.field` unmodified, at its own 17px. Anything under 16px in a text
						input makes iOS Safari zoom the viewport on focus and leave it
						there — the page is an installed PWA, so that lands as the layout
						visibly lurching under someone's thumb.
					-->
					<form
						method="POST"
						action="?/checkGeocoder"
						use:submit={{ reset: false }}
						class="mt-2 space-y-2"
					>
						<input
							name="probe"
							class="field"
							placeholder="Test an address near you"
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
							enterkeyhint="search"
						/>
						<button class="btn btn-ghost px-4 py-2 text-[14px]">Check</button>
					</form>
					{#if geoHealth}
						<p
							class="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed"
							style="color: {geoTone(geoHealth.state)}"
						>
							{#if geoPassed}
								<Check class="mt-0.5 h-3.5 w-3.5 shrink-0" />
							{:else}
								<CircleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
							{/if}
							<span>
								{geoHealth.detail}
								{#if geoHealth.probe}
									{#if geoHealth.probe.first}
										<br />Best match:
										<span style="color: var(--ink-2)">{geoHealth.probe.first}</span>
									{/if}
								{/if}
								{#if geoHealth.dataUpdated}
									<br /><span style="color: var(--ink-4)"
										>{data.geocoderHosted ? 'Map data as of' : 'Data imported up to'}
										{geoHealth.dataUpdated}.</span
									>
								{/if}
							</span>
						</p>
					{/if}
				</div>
			{/if}
		</div>
		{#if owner}
			<Toggle on={data.locationEnabled} flag="locationEnabled" label="Toggle places" />
		{/if}
	</div>

	<p class="section-label px-1 pt-2">AI assistance</p>

	<!-- What this is, and the line it never crosses. -->
	<section class="card p-5">
		<h2
			class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
			style="color: var(--ink)"
		>
			<Sparkles class="h-4 w-4" style="color: var(--ws-accent)" /> How AI assistance works
		</h2>
		<p class="mt-2 text-[13px] leading-relaxed" style="color: var(--ink-2)">
			Harmony works entirely on plain arithmetic and pattern matching. You can optionally let a
			language model help with the fuzzy parts, like reading a cryptic bank line into a merchant
			name or suggesting a category. It can only
			<strong style="color: var(--ink)">suggest</strong>: it cannot approve a purchase, move money,
			or decide your Safe to Spend. Every suggestion is checked against the app's own options before
			you see it.
		</p>
		<p class="mt-2 text-[13px] leading-relaxed" style="color: var(--ink-3)">
			Leave it <strong style="color: var(--ink-2)">Off</strong> and nothing changes: Harmony keeps using
			the deterministic parsing it already ships with.
		</p>
	</section>

	<form
		method="POST"
		action="?/save"
		use:submit={{ success: 'Intelligence settings saved', reset: false }}
	>
		<section class="card space-y-4 p-5">
			<!--
				The switch is the gate, and the source picker only exists once it is
				open. Off was one of three equal-looking options, which put the two
				you cannot use next to the one you can, and left the endpoint, model
				and key fields on screen for a workspace that had said no to all of
				it. Off is now the absence of the panel.

				Still one unsaved form: nothing here writes until Save, which is why
				Save stays on screen even with the panel closed. Turning it off and
				saving is how you turn it off.
			-->
			<div class="flex items-start justify-between gap-4">
				<div>
					<p class="text-[15px] font-medium" style="color: var(--ink)">Let a model help</p>
					<p class="mt-0.5 text-[13px] leading-relaxed" style="color: var(--ink-3)">
						{#if mode === 'off'}
							Off. Harmony uses the deterministic parsing it already ships with, and no model is
							contacted.
						{:else}
							On for the fuzzy parts only. Every suggestion is checked against the app's own options
							before you see it.
						{/if}
					</p>
				</div>
				{#if owner}
					<Toggle
						on={mode !== 'off'}
						onToggle={(next) => {
							mode = next ? 'local' : 'off';
						}}
						label="Toggle AI assistance"
					/>
				{/if}
			</div>
			<input type="hidden" name="mode" value={mode} />

			{#if mode !== 'off'}
				<div>
					<Segmented
						options={[
							{ value: 'local', label: 'Local' },
							{ value: 'external', label: 'External' }
						]}
						bind:value={mode}
						label="Assist source"
						size="sm"
					/>
					<p class="mt-2 text-[12px] leading-relaxed" style="color: var(--ink-3)">
						{#if mode === 'local'}
							A model on your own machine over the Ollama API. Nothing leaves your server.
						{:else}
							Any OpenAI-compatible API. Text you send is processed by a third party, so use this
							only if you're comfortable with that trade.
						{/if}
					</p>
				</div>
			{/if}

			{#if mode !== 'off'}
				<div>
					<label class="section-label" for="endpoint">Endpoint</label>
					<input
						id="endpoint"
						name="endpoint"
						bind:value={endpoint}
						disabled={!owner}
						placeholder={mode === 'local' ? 'http://localhost:11434' : 'https://api.openai.com'}
						class="field mt-1 font-mono text-[16px]"
					/>
				</div>
				<div>
					<label class="section-label" for="model">Model</label>
					{#if mode === 'local' && availableModels.length > 0}
						<!--
							A list rather than a <select>: an <option> can only hold text, and
							what a model can do is the thing you're choosing on. The chips are
							shown only where Ollama positively said so — an older server
							reports nothing, and nothing is what we draw, because an empty
							row would read as "this model can't", which is a different and
							wrong claim.
						-->
						<div
							class="card mt-1 max-h-[19rem] overflow-y-auto"
							role="radiogroup"
							aria-label="Model"
						>
							{#each availableModels as m, i (m.name)}
								<label
									class="press flex cursor-pointer items-start gap-2.5 p-3 {i > 0 ? 'rule' : ''}"
									style="background: {model === m.name
										? 'color-mix(in oklab, var(--ws-accent) 8%, transparent)'
										: 'transparent'}"
								>
									<input
										type="radio"
										name="model"
										value={m.name}
										checked={model === m.name}
										onchange={() => (model = m.name)}
										disabled={!owner}
										class="mt-0.5 shrink-0"
									/>
									<span class="min-w-0 flex-1">
										<span class="block font-mono text-[14px] break-all" style="color: var(--ink)">
											{m.name}
										</span>
										{#if m.parameterSize || m.quantization}
											<span class="mt-0.5 block text-[11px]" style="color: var(--ink-3)">
												{[m.parameterSize, m.quantization].filter(Boolean).join(' · ')}
											</span>
										{/if}
										{#if m.capabilities && m.capabilities.length > 0}
											<span class="mt-1.5 flex flex-wrap gap-1">
												{#each m.capabilities as cap (cap)}
													<span
														class="rounded-[var(--r-full)] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em]"
														style="background: color-mix(in oklab, {capTone(
															cap
														)} 14%, var(--surface)); color: {capTone(cap)}"
													>
														{cap}
													</span>
												{/each}
											</span>
										{/if}
									</span>
								</label>
							{/each}
						</div>
					{:else}
						<input
							id="model"
							name="model"
							bind:value={model}
							disabled={!owner}
							placeholder={mode === 'local' ? 'Connect to list models' : 'gpt-4o-mini'}
							class="field mt-1 font-mono text-[16px]"
						/>
					{/if}
				</div>
				{#if mode === 'external'}
					<div>
						<label class="section-label" for="apiKey">API key</label>
						<input
							id="apiKey"
							name="apiKey"
							type="password"
							bind:value={apiKey}
							disabled={!owner}
							placeholder={data.config.apiKeySet ? 'Stored. Leave blank to keep it.' : 'sk-...'}
							class="field mt-1 font-mono text-[16px]"
						/>
					</div>
					<p class="text-[12.5px] leading-relaxed" style="color: var(--ink-3)">
						No capability chips here: an OpenAI-compatible endpoint lists model names and nothing
						more, so we never learn what yours can do. Features that need a specific capability are
						offered anyway, and if the model can't do it you'll see your provider's own error.
					</p>
				{/if}
			{/if}

			{#if form && 'error' in form && form.error}
				<p class="flex items-center gap-1.5 text-[13px]" style="color: var(--deny)">
					<CircleAlert class="h-4 w-4" />
					{form.error}
				</p>
			{/if}

			{#if testResult}
				<p
					class="flex items-center gap-1.5 text-[13px]"
					style="color: {testResult.ok ? 'var(--approve)' : 'var(--deny)'}"
				>
					{#if testResult.ok}<Check class="h-4 w-4" />{:else}<CircleAlert class="h-4 w-4" />{/if}
					{testResult.detail}
				</p>
			{/if}

			{#if owner}
				<!--
					Connect reuses whatever it already knows about each model, keyed on
					the model's own timestamp, so a repeat connect is one request.
					Refresh is for the case that can't be detected from here — you just
					pulled or replaced a model — and drops what's cached for this
					endpoint. Hence two buttons rather than one that always refetches.
				-->
				<div class="flex flex-wrap items-center gap-2 pt-1">
					<button class="btn btn-accent px-4 py-2 text-[14px]">Save</button>
					{#if mode !== 'off'}
						<button formaction="?/test" class="btn btn-ghost px-4 py-2 text-[14px]">
							{mode === 'local' ? 'Connect' : 'Test connection'}
						</button>
					{/if}
					{#if mode === 'local' && availableModels.length > 0}
						<button
							formaction="?/test"
							name="refresh"
							value="true"
							class="btn btn-ghost inline-flex items-center gap-1.5 px-4 py-2 text-[14px]"
						>
							<RefreshCw class="h-3.5 w-3.5" /> Refresh models
						</button>
					{/if}
				</div>
			{:else}
				<p class="text-[13px]" style="color: var(--ink-3)">
					Only the workspace owner can change these settings.
				</p>
			{/if}
		</section>
	</form>

	<section class="card flex items-start gap-2.5 p-4" style="color: var(--ink-3)">
		<ShieldCheck class="mt-0.5 h-4 w-4 shrink-0" style="color: var(--approve)" />
		<p class="text-[12px] leading-relaxed">
			Whatever you choose, the model can only make suggestions. It cannot approve, spend, or change
			a number on its own, and the app runs exactly the same with it turned off.
		</p>
	</section>
</div>
