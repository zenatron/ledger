<script lang="ts">
	import { enhance } from '$app/forms';
	import { submit } from '$lib/actions/submit';
	import { decide } from '$lib/actions/decide';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { formatMinor, tryParseMinor } from '$lib/money-format';
	import { overdraftBy } from '$lib/domain/bucket/flows';
	import {
		Bell,
		Camera,
		Check,
		ChevronLeft,
		CircleAlert,
		LocateFixed,
		Lock,
		MapPin,
		Moon,
		Pencil,
		RotateCcw,
		Search,
		Trash2,
		X
	} from '@lucide/svelte';
	import { formatCoords } from '$lib/domain/location/coords';
	import { createPlaceField } from '$lib/domain/location/place-field.svelte';
	import Money from '$lib/components/Money.svelte';
	import { money } from '$lib/actions/money';
	import { fade, fly } from 'svelte/transition';
	import { dismiss } from '$lib/actions/dismiss';
	import { modal } from '$lib/actions/modal';
	import HoldPicker from '$lib/components/HoldPicker.svelte';
	import ImageViewer from '$lib/components/ImageViewer.svelte';

	let { data, form } = $props();
	let viewing = $state(false);
	let slug = $derived(page.params.workspace);
	let editingMasthead = $state(false);
	// One Details row editable at a time — same single-slot pattern the recurring
	// and bucket pages use for their inline edit forms.
	let editingField = $state<'merchant' | 'place' | 'category' | 'note' | null>(null);
	let deciding = $state<'approve' | 'deny' | null>(null);
	let showDeny = $state(false);
	// Which of the two answers to a denial is open, and the note it carries.
	// Both require the note, which is what makes either one a new statement
	// rather than a silent re-decision.
	let denialAction: 'appeal' | 'override' | null = $state(null);
	let denialNote = $state('');

	/*
	 * The notification nudge, in the one moment it earns its place: this page
	 * is waiting on a person, and this viewer would hear the answer instead of
	 * checking back. Shown to the requester ("the moment they decide") and to
	 * a decider ("when someone needs a decision") — once per device; a nudge
	 * that reappears after being sent away is a banner wearing a card's clothes.
	 */
	let notifyNudge = $state(false);
	onMount(() => {
		try {
			notifyNudge = localStorage.getItem('notify-nudge') !== 'dismissed';
		} catch {
			notifyNudge = true; // storage unavailable — still offer it this visit
		}
	});
	function dismissNotifyNudge() {
		notifyNudge = false;
		try {
			localStorage.setItem('notify-nudge', 'dismissed');
		} catch {
			/* this visit only */
		}
	}
	// Sleep-on-it picker sheet: 'hold' for a fresh pause, 'extend' for more days.
	let holdSheet = $state<'hold' | 'extend' | null>(null);
	let holdDays = $state(3);
	const p = $derived(data.purchase);

	/** Submit the enclosing form — used by Enter on a borderless input or a select change. */
	function save(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
		el.form?.requestSubmit();
	}
	/** Escape closes the edit without saving. */
	function cancelEdit(e: KeyboardEvent) {
		if (e.key === 'Escape') editingField = null;
	}

	/*
	 * Editing the place. Same field as the new-purchase form — the device, on
	 * an explicit tap; a map link read offline; a name or address the geocoder
	 * resolves, when one is configured. There is no free-text value here: a
	 * place you can only describe is not a place this row can pin.
	 */
	const placeField = createPlaceField({
		slug: () => page.params.workspace ?? '',
		geocoderEnabled: () => data.geocoderEnabled
	});

	function openPlaceEdit() {
		// Reopen with the saved pin, so canceling the editor is not a way to
		// silently drop it.
		placeField.seed(p.place ? { ...p.place } : null);
		editingField = 'place';
	}

	/**
	 * The pin's form must not post while the link field still holds unresolved
	 * text — that submit would save no place (or worse, clear one) and close
	 * the editor over the reason. Blur has already had its say by now; if the
	 * text is still unresolved, hold the form and show why.
	 */
	function guardPlaceSubmit(e: Event) {
		if (placeField.unresolved()) {
			e.preventDefault();
			placeField.commit();
		}
	}

	/** "3 days left" · "tomorrow" · "ready" — coarse, never a ticking clock. */
	function heldLeft(iso: string): string {
		const ms = new Date(iso).getTime() - Date.now();
		if (ms <= 0) return 'ready';
		const days = Math.ceil(ms / 86_400_000);
		return days <= 1 ? 'tomorrow' : `${days} days left`;
	}
	function heldUntilLong(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric'
		});
	}

	function fmtDate(iso: string) {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
	// ISO instant -> the local calendar day, as a <input type="date"> value. Used to
	// seed "Mark as bought" with the purchase's original date so completing it keeps
	// that date instead of silently stamping today when the field is left untouched.
	function toDateValue(iso: string) {
		const d = new Date(iso);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
	function fmtDateLong(iso: string) {
		return new Date(iso).toLocaleDateString(undefined, {
			weekday: 'long',
			month: 'long',
			day: 'numeric'
		});
	}

	/*
	 * Completing is where a bucket-charged purchase actually withdraws, and the
	 * amount entered here is the one that lands — not the one approved. So the
	 * overdraft check lives on this field, seeded with the approved amount and
	 * reacting as it's edited. Nothing blocks: a bucket is an earmark, and no
	 * real money moves either way. See domain/bucket/flows.
	 */
	// Derived, not a snapshot: this route is reused when you navigate from one
	// purchase to the next, so a plain `$state` seed would carry the previous
	// purchase's amount across. What was typed is tagged with the purchase it was
	// typed into, which lets it expire on navigation without an effect.
	let typedFinal = $state<{ id: string; value: string } | null>(null);
	const finalAmount = $derived(
		typedFinal?.id === p.id
			? typedFinal.value
			: formatMinor(p.approvedAmountMinor ?? p.requestedAmountMinor, p.currency).replace(
					/[^0-9.]/g,
					''
				)
	);
	const overdraft = $derived.by(() => {
		if (!p.bucket) return null;
		const minor = tryParseMinor(finalAmount, p.bucket.currency);
		if (minor === null) return null;
		const shortMinor = overdraftBy(p.bucket.balanceMinor, minor);
		if (shortMinor === 0n) return null;
		return { shortMinor, amountMinor: minor, currency: p.bucket.currency };
	});
	const overdraftConfirm = $derived(
		overdraft && p.bucket
			? {
					title: `${p.bucket.name} doesn't have that`,
					body: `It holds ${formatMinor(p.bucket.balanceMinor, overdraft.currency)}, and you spent ${formatMinor(overdraft.amountMinor, overdraft.currency)}. Recording it leaves the bucket ${formatMinor(overdraft.shortMinor, overdraft.currency)} overdrawn, and that part counts as ordinary spending.`,
					confirmLabel: 'Record it anyway',
					tone: 'danger' as const
				}
			: undefined
	);

	const displayAmount = $derived(p.finalAmountMinor ?? p.requestedAmountMinor);
	const isPending = $derived(p.state === 'pending_approval');
	const img = $derived(data.images[0]);

	const stateLabel: Record<string, string> = {
		draft: 'Draft',
		pending_approval: 'Waiting',
		approved: 'Approved',
		denied: 'Denied',
		cancelled: 'Cancelled',
		completed: 'Completed',
		refunded: 'Refunded',
		held: 'Sleeping'
	};
	const stateVar: Record<string, string> = {
		pending_approval: '--pending',
		approved: '--approve',
		denied: '--deny',
		refunded: '--info',
		completed: '--approve',
		held: '--seal',
		draft: '--ink-3',
		cancelled: '--ink-3'
	};
</script>

<div class="mx-auto max-w-lg">
	<datalist id="merchant-names">
		{#each data.merchants as m (m)}<option value={m}></option>{/each}
	</datalist>
	<a
		href="/w/{slug}/purchases"
		class="press mb-4 -ml-1 inline-flex items-center gap-0.5 text-[14px] font-medium"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Ledger
	</a>

	<!-- Editorial masthead: the amount as a magazine headline -->
	<div style="view-transition-name: vt-card-{p.id}">
		<span
			class="chip"
			style="color: var({stateVar[p.state] ??
				'--ink-4'}); background: color-mix(in oklab, var({stateVar[p.state] ??
				'--ink-4'}) 14%, transparent)"
		>
			{stateLabel[p.state]}{p.stale ? ' · stale' : ''}{isPending && p.waitingDays > 0
				? ` · ${p.waitingDays}d`
				: ''}
		</span>
		{#if editingMasthead}
			<form
				method="POST"
				action="?/edit"
				use:submit={{ success: 'Changes saved', onSuccess: () => (editingMasthead = false) }}
				class="mt-3 space-y-2"
			>
				{#if p.state === 'approved' && p.approverNames.length > 0}
					<p class="text-[13px]" style="color: var(--pending)">
						Changing the item or amount sends this back to {p.approverNames.join(' or ')}
						for approval.
					</p>
				{:else if p.state === 'approved'}
					<p class="text-[13px]" style="color: var(--ink-3)">
						This didn't need approval, so changes apply right away.
					</p>
				{/if}
				<input
					name="amount"
					aria-label="Amount"
					use:money
					required
					inputmode="decimal"
					value={formatMinor(p.requestedAmountMinor, p.currency).replace(/[^0-9.]/g, '')}
					class="ledger-input num w-full font-[family-name:var(--font-display)] text-[length:var(--fs-mega)] leading-[0.92] font-bold"
					style="color: var(--ink)"
				/>
				<input
					name="itemName"
					aria-label="Item"
					required
					value={p.itemName}
					class="ledger-input w-full text-[18px] font-medium"
					style="color: var(--ink-2)"
				/>
				<div class="mt-2.5 flex items-center justify-end gap-2">
					<button
						type="button"
						onclick={() => (editingMasthead = false)}
						class="btn btn-ghost text-[13px]"
					>
						Cancel
					</button>
					<button class="btn btn-accent text-[13px]">Save</button>
				</div>
			</form>
		{:else}
			<Money
				minor={displayAmount}
				currency={p.currency}
				block
				class="mt-3 font-[family-name:var(--font-display)] text-[length:var(--fs-mega)] leading-[0.92] font-bold"
			/>
			<button
				type="button"
				onclick={() => data.can.edit && (editingMasthead = true)}
				class="edit-row press mt-4 flex w-full items-center gap-2 text-left text-[18px] leading-tight font-medium"
				style="color: var(--ink-2)"
				disabled={!data.can.edit}
			>
				{p.itemName}
				{#if data.can.edit}
					<Pencil class="edit-pencil h-4 w-4 shrink-0" style="color: var(--ink-4)" />
				{/if}
			</button>
		{/if}
		<p class="mt-2 text-[14px]" style="color: var(--ink-3)">
			Requested by {p.requesterName}{p.completedAt ? ` · ${fmtDateLong(p.completedAt)}` : ''}
		</p>
	</div>

	{#if p.state === 'held'}
		<!-- Sleeping. Seal-purple, the temporal-lock tone. -->
		<div
			class="mt-5 rounded-[16px] p-4"
			style="background: color-mix(in oklab, var(--seal) 9%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--seal) 24%, transparent)"
		>
			<div class="flex items-center gap-2.5">
				<Moon class="h-5 w-5 shrink-0" style="color: var(--seal)" />
				<div class="min-w-0">
					{#if p.heldReady}
						<p
							class="text-[15px] font-semibold"
							style="color: color-mix(in oklab, var(--seal) 82%, var(--ink))"
						>
							Ready to decide
						</p>
						<p class="text-[13px]" style="color: var(--ink-3)">You slept on it. Still want it?</p>
					{:else if p.heldUntil}
						<p
							class="text-[15px] font-semibold"
							style="color: color-mix(in oklab, var(--seal) 82%, var(--ink))"
						>
							Sleeping until {heldUntilLong(p.heldUntil)}
						</p>
						<p class="num text-[13px]" style="color: var(--ink-3)">{heldLeft(p.heldUntil)}</p>
					{/if}
				</div>
			</div>
			{#if data.can.manageHold}
				<div class="mt-3.5 flex gap-2">
					{#if p.heldReady}
						<form
							method="POST"
							action="?/wake"
							use:submit={{ success: 'Back in the queue' }}
							class="flex-1"
						>
							<button class="btn btn-accent w-full py-2.5 text-[14px]">Buy it</button>
						</form>
						<button
							onclick={() => {
								holdDays = 3;
								holdSheet = 'extend';
							}}
							class="btn btn-ghost flex-1 py-2.5 text-[14px]">Wait more</button
						>
					{:else}
						<form
							method="POST"
							action="?/wake"
							use:submit={{ success: 'Back in the queue' }}
							class="flex-1"
						>
							<button class="btn btn-ghost w-full py-2.5 text-[14px]">Wake it now</button>
						</form>
					{/if}
					<form
						method="POST"
						action="?/letGo"
						use:submit={{
							confirm: {
								title: 'Let it go?',
								body: 'This cancels the request.',
								confirmLabel: 'Let it go',
								tone: 'danger'
							},
							success: 'Cancelled'
						}}
						class="flex-1"
					>
						<button class="btn btn-plain w-full py-2.5 text-[14px]" style="color: var(--deny)"
							>Let it go</button
						>
					</form>
				</div>
			{/if}
		</div>
	{/if}

	{#if data.isRefund && !img}
		<!--
			A refund reverses a purchase, so it shows that purchase: the original's
			photo, dimmed under a reversal arrow. Tapping goes to the original. No
			photo controls — the image belongs to the parent, and is edited there.
		-->
		<a
			href="/w/{slug}/purchases/{data.parentId}"
			class="press relative mt-5 block overflow-hidden rounded-[14px]"
			style="box-shadow: var(--shadow-card), inset 0 0 0 1px var(--hairline)"
		>
			{#if data.inheritedImage}
				<!--
					Desaturated enough to read as past tense, light enough to still
					recognize the item — dimming it into a slab would defeat the point
					of showing the photo at all. Contrast for the label comes from a
					scrim behind it, not from crushing the image.
				-->
				<img
					src="/w/{slug}/blobs/{data.inheritedImage}"
					alt=""
					class="aspect-[4/3] w-full object-cover"
					style="filter: grayscale(0.45) brightness(0.92)"
					loading="eager"
				/>
				<span
					class="absolute inset-0"
					style="background: radial-gradient(60% 50% at 50% 50%, oklch(0 0 0 / 0.5), oklch(0 0 0 / 0.12))"
				></span>
			{:else}
				<div class="aspect-[4/3] w-full" style="background: var(--surface-2)"></div>
			{/if}
			<span class="absolute inset-0 flex flex-col items-center justify-center gap-2">
				<span
					class="flex h-14 w-14 items-center justify-center rounded-full backdrop-blur"
					style="background: {data.inheritedImage
						? 'oklch(0 0 0 / 0.45)'
						: 'var(--surface)'}; color: {data.inheritedImage ? 'white' : 'var(--ink-3)'}"
				>
					<RotateCcw class="h-6 w-6" />
				</span>
				<!--
					Says what tapping does. "Reverses this purchase" read as though the
					thing on screen were being reversed — the arrow already carries the
					"this is a refund" meaning, so the label is free to be the action.
				-->
				<span
					class="text-[13px] font-semibold"
					style="color: {data.inheritedImage ? 'white' : 'var(--ink-3)'}"
				>
					See original purchase
				</span>
			</span>
		</a>
	{:else if img}
		<div class="relative mt-5">
			<!--
				The image sets its own shape. A fixed aspect box with object-cover threw
				away more than half of any portrait photo — which is most phone photos.
				Its real job was holding space so the page doesn't jump while the image
				loads, and the stored width/height do that exactly, without a crop.
				Capped so a tall receipt doesn't push everything else off screen; the
				viewer is where it gets the whole screen.
			-->
			<button
				onclick={() => (viewing = true)}
				class="press block w-full overflow-hidden rounded-[14px]"
				style="box-shadow: var(--shadow-card), inset 0 0 0 1px var(--hairline); background: var(--surface-2)"
				aria-label="View photo full screen"
			>
				<img
					src="/w/{slug}/blobs/{img.blobId}"
					alt={p.itemName}
					width={img.width}
					height={img.height}
					class="max-h-[70vh] w-full object-contain"
					style="aspect-ratio: {img.width} / {img.height}"
					loading="eager"
				/>
			</button>
			<ImageViewer src="/w/{slug}/blobs/{img.blobId}" alt={p.itemName} bind:open={viewing} />
			<!--
				Photo controls sit on the photo, because they act on it. A purchase
				carries exactly one, so this replaces rather than appends — the old
				"Add another photo" stored images that nothing ever displayed.
			-->
			{#if data.can.addPhoto}
				<div class="absolute right-2.5 bottom-2.5 flex gap-2">
					<form method="POST" action="?/addImage" enctype="multipart/form-data">
						<label
							class="press flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold backdrop-blur"
							style="background: oklch(0 0 0 / 0.55); color: white"
						>
							<Camera class="h-3.5 w-3.5" /> Replace
							<input
								type="file"
								name="photo"
								accept="image/jpeg,image/png,image/webp"
								required
								class="sr-only"
								onchange={(e) => (e.currentTarget.form as HTMLFormElement).requestSubmit()}
							/>
						</label>
					</form>
					<form
						method="POST"
						action="?/removeImage"
						use:submit={{ confirm: 'Remove this photo?', success: 'Photo removed' }}
					>
						<button
							class="press flex items-center justify-center rounded-full px-2.5 py-1.5 backdrop-blur"
							style="background: oklch(0 0 0 / 0.55); color: white"
							aria-label="Remove photo"
						>
							<Trash2 class="h-3.5 w-3.5" />
						</button>
					</form>
				</div>
			{/if}
		</div>
	{/if}

	{#if data.can.addPhoto && data.images.length === 0}
		<form method="POST" action="?/addImage" enctype="multipart/form-data" class="mt-5">
			<label
				class="press flex cursor-pointer items-center gap-3 rounded-[14px] px-4 py-4"
				style="box-shadow: inset 0 0 0 1px var(--hairline); background: var(--surface)"
			>
				<Camera class="h-5 w-5" style="color: var(--ink-3)" />
				<span class="text-[15px]" style="color: var(--ink-3)"
					>{data.isRefund
						? 'Add a photo of the return receipt'
						: 'Add a photo of what you bought'}</span
				>
				<input
					type="file"
					name="photo"
					accept="image/jpeg,image/png,image/webp"
					required
					class="sr-only"
					onchange={(e) => (e.currentTarget.form as HTMLFormElement).requestSubmit()}
				/>
			</label>
		</form>
	{/if}

	<div class="mt-6 space-y-4">
		{#if p.isOverageReapproval && p.approvedAmountMinor !== null}
			<div
				class="rounded-[12px] p-4"
				style="background: color-mix(in oklab, var(--pending) 14%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--pending) 26%, transparent)"
			>
				<p
					class="flex items-center gap-1.5 text-[14px] font-semibold"
					style="color: var(--pending)"
				>
					<CircleAlert class="h-4 w-4" /> Over budget. Needs re-approval
				</p>
				<p class="num mt-1 text-[13px]" style="color: var(--ink-2)">
					Approved {formatMinor(p.approvedAmountMinor, p.currency)}, spent {formatMinor(
						p.finalAmountMinor!,
						p.currency
					)}
				</p>
			</div>
		{/if}

		{#if form?.error}
			<div
				class="rounded-[12px] p-4 text-[15px]"
				style="color: var(--deny); background: color-mix(in oklab, var(--deny) 12%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--deny) 26%, transparent)"
			>
				{form.error}
			</div>
		{/if}

		<!-- The centerpiece: decide. Three actions on one row — Approve dominant,
		     Deny and Sleep as secondary — so the whole decision fits a glance. -->
		{#if data.can.decide || data.can.hold}
			{#if data.can.decide}
				<div class="flex items-stretch gap-2">
					<form
						method="POST"
						action="?/approve"
						use:enhance={decide(
							() => (deciding = 'approve'),
							() => (deciding = null)
						)}
						class="flex-1"
					>
						<button class="btn btn-accent w-full py-3.5 text-[17px]" disabled={deciding !== null}>
							{#if deciding === 'approve'}
								<span class="spin h-5 w-5"></span>
							{:else}
								<Check class="h-5 w-5" /> Approve
							{/if}
						</button>
					</form>
					{#if !showDeny}
						<button
							onclick={() => (showDeny = true)}
							class="btn btn-ghost shrink-0 px-4 py-3.5 text-[15px]"
							style="color: var(--deny)">Deny</button
						>
					{:else}
						<form
							id="deny-form"
							method="POST"
							action="?/deny"
							use:enhance={decide(
								() => (deciding = 'deny'),
								() => (deciding = null)
							)}
							class="shrink-0"
						>
							<button
								class="btn btn-ghost px-4 py-3.5 text-[15px]"
								style="color: var(--deny); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--deny) 30%, transparent)"
								disabled={deciding !== null}
							>
								{#if deciding === 'deny'}<span class="spin h-4 w-4"></span>{:else}Deny{/if}
							</button>
						</form>
					{/if}
					{#if data.can.hold}
						<button
							onclick={() => {
								holdDays = 3;
								holdSheet = 'hold';
							}}
							class="btn btn-ghost shrink-0 text-[15px]"
							style="color: var(--seal); width: 52px; height: 52px; padding: 0"
						>
							<Moon class="h-5 w-5" />
						</button>
					{/if}
				</div>
			{:else}
				<button
					onclick={() => {
						holdDays = 3;
						holdSheet = 'hold';
					}}
					class="btn w-full py-3 text-[15px]"
					style="color: color-mix(in oklab, var(--seal) 84%, var(--ink)); background: color-mix(in oklab, var(--seal) 10%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--seal) 26%, transparent)"
				>
					<Moon class="h-4 w-4" /> Sleep on it
				</button>
			{/if}

			{#if showDeny}
				<!--
					`form="deny-form"` rather than a form of its own. This input used to sit
					in a SECOND <form action="?/deny"> below the button, which meant the
					reason you typed was submitted by nothing: the visible Deny button
					belongs to the form above and posted without it, so the reason was
					silently dropped on the one action where the requester most wants to
					know why (the server has always read it). The `form` attribute
					associates the input across the DOM, so the reason travels with the
					button and the three-action row above keeps its layout.
				-->
				<input
					form="deny-form"
					name="reason"
					placeholder="Reason (optional)"
					aria-label="Reason for denying"
					class="field mt-2.5 text-[16px]"
				/>
			{/if}
		{/if}

		<!--
			After a denial, both sides get a way forward. The requester can ask again
			with something new to say; whoever was asked can change their mind. Both
			carry a note, both land in the history beside the denial, and neither is
			a second purchase — the record is one thing that was refused and then
			answered again.

			Deliberately quieter than the decide row above: this is the uncommon
			path, and it should not compete with the ordinary one on any screen
			where both could appear.
		-->
		{#if data.can.appeal || data.can.overrideDenial}
			<div class="rounded-[14px] p-4" style="background: var(--surface-2)">
				{#if !denialAction}
					<p class="text-[14px] leading-relaxed" style="color: var(--ink-3)">
						{data.can.appeal
							? 'Something changed since this was denied? You can ask again.'
							: 'You denied this. You can still allow it.'}
					</p>
					<div class="mt-2.5 flex flex-wrap gap-2">
						{#if data.can.appeal}
							<button
								onclick={() => (denialAction = 'appeal')}
								class="btn btn-ghost px-4 py-2 text-[14px]"
								style="color: var(--accent-ink)">Ask again</button
							>
						{/if}
						{#if data.can.overrideDenial}
							<button
								onclick={() => (denialAction = 'override')}
								class="btn btn-ghost px-4 py-2 text-[14px]"
								style="color: var(--approve)">Allow it after all</button
							>
						{/if}
					</div>
				{:else}
					{@const isAppeal = denialAction === 'appeal'}
					<form
						method="POST"
						action={isAppeal ? '?/appeal' : '?/overrideDenial'}
						use:submit={{
							success: isAppeal ? 'Sent back for a decision' : 'Approved',
							onSuccess: () => (denialAction = null)
						}}
					>
						<label class="block">
							<span class="section-label mb-1.5 block">
								{isAppeal ? 'What has changed' : 'Why you are allowing it'}
							</span>
							<input
								name="note"
								required
								bind:value={denialNote}
								placeholder={isAppeal ? "It's on sale now" : 'Talked it over'}
								class="field text-[16px]"
							/>
						</label>
						<p class="mt-1.5 text-[12px]" style="color: var(--ink-3)">
							This goes in the history, next to the denial.
						</p>
						<div class="mt-3 flex gap-2">
							<button
								class="btn btn-accent px-4 py-2.5 text-[14px] disabled:opacity-50"
								disabled={denialNote.trim().length === 0}
							>
								{isAppeal ? 'Ask again' : 'Allow it'}
							</button>
							<button
								type="button"
								onclick={() => {
									denialAction = null;
									denialNote = '';
								}}
								class="btn btn-ghost px-4 py-2.5 text-[14px]">Cancel</button
							>
						</div>
					</form>
				{/if}
			</div>
		{/if}

		<!-- Details as a printed ledger. Editable rows show a pencil on hover
		     (desktop) or faintly at rest (touch); tapping swaps the value for a
		     borderless input on the same line — writing on the ledger, not a form. -->
		<div>
			<p class="section-label mb-1">Details</p>
			<div class="rule">
				<div class="hairline flex items-center justify-between py-3.5">
					<span class="text-[15px]" style="color: var(--ink-3)">Requested by</span>
					<span class="text-[15px] font-medium" style="color: var(--ink)">{p.requesterName}</span>
				</div>

				{#if editingField === 'merchant'}
					<form
						method="POST"
						action="?/merchant"
						use:submit={{ success: 'Saved', onSuccess: () => (editingField = null) }}
						class="hairline py-3.5"
					>
						<div class="flex items-center justify-between gap-3">
							<span class="shrink-0 text-[16px]" style="color: var(--ink-3)">From</span>
							<input
								name="merchantName"
								list="merchant-names"
								maxlength="200"
								placeholder="Merchant"
								value={p.merchantName ?? ''}
								class="ledger-input min-w-0 flex-1 text-right text-[16px] font-medium"
								style="color: var(--ink)"
								onkeydown={(e) => {
									if (e.key === 'Enter') save(e.currentTarget);
									cancelEdit(e);
								}}
							/>
						</div>
						<div class="mt-2.5 flex items-center justify-end gap-2">
							<button
								type="button"
								onclick={() => (editingField = null)}
								class="btn btn-ghost text-[13px]"
							>
								Cancel
							</button>
							<button class="btn btn-accent text-[13px]">Save</button>
						</div>
					</form>
				{:else}
					<button
						type="button"
						onclick={() => data.can.annotate && (editingField = 'merchant')}
						class="edit-row hairline flex w-full items-center justify-between py-3.5"
						disabled={!data.can.annotate}
					>
						<span class="text-[16px]" style="color: var(--ink-3)">From</span>
						<span class="flex items-center gap-2">
							<span class="text-[16px] font-medium" style="color: var(--ink)"
								>{p.merchantName ?? 'Add'}</span
							>
							{#if data.can.annotate}
								<span class="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
									<Pencil class="edit-pencil h-3.5 w-3.5" style="color: var(--ink-4)" />
								</span>
							{/if}
						</span>
					</button>
				{/if}

				<!--
					"Where" — the place, which used to be what the row above was called.
					Editable only by the requester: the person who was there is the only
					one in a position to say where that was.

					Rendered when places are on, and also whenever this purchase already
					has a pin even though they are off. Turning the feature off must not
					strand a recorded location somewhere nobody can see or remove it —
					so in that state the row still shows, and the editor offers exactly
					one action: clear it.
				-->
				{#if data.locationEnabled || p.place}
					{#if editingField === 'place'}
						<form
							method="POST"
							action="?/place"
							use:submit={{ success: 'Saved', onSuccess: () => (editingField = null) }}
							onsubmit={guardPlaceSubmit}
							class="hairline py-3.5"
						>
							<!--
								A resolved pin is a ledger value and sits on the label's line,
								right-aligned like every other one. Unresolved text is not a
								value yet — it's a field being typed into, and an address is
								far too long to share a line with its label. Sharing one is
								what clipped the placeholder mid-word and made a typed address
								scroll away from the caret, so while it is still a field it
								gets the full width on its own line, left-aligned to read the
								way an address is written.
							-->
							{#if placeField.place || !data.locationEnabled}
								<div class="flex items-center justify-between gap-3">
									<span class="shrink-0 text-[16px]" style="color: var(--ink-3)">Where</span>
									<span class="flex min-w-0 items-center gap-2">
										{#if placeField.place}
											<span
												class="truncate text-[15px] {placeField.place.label ? '' : 'num'}"
												style="color: var(--ink)"
											>
												{placeField.place.label ?? formatCoords(placeField.place)}
											</span>
											<button
												type="button"
												onclick={() => placeField.clear()}
												aria-label="Remove the place"
												class="press flex h-[18px] w-[18px] shrink-0 items-center justify-center"
												style="color: var(--ink-3)"
											>
												<X class="h-4 w-4" />
											</button>
										{/if}
									</span>
								</div>
							{:else}
								<label class="block">
									<span class="text-[16px]" style="color: var(--ink-3)">Where</span>
									<input
										bind:value={placeField.query}
										onpaste={(e) => placeField.onPaste(e)}
										onblur={() => placeField.commit()}
										onkeydown={(e) => {
											if (e.key === 'Enter') {
												// Resolve the link; the Save button posts the form.
												e.preventDefault();
												placeField.commit();
												return;
											}
											cancelEdit(e);
										}}
										maxlength="200"
										autocomplete="off"
										autocapitalize="words"
										spellcheck="false"
										enterkeyhint="search"
										placeholder={data.geocoderEnabled
											? 'Address, map link, or coordinates'
											: 'Map link or coordinates'}
										class="ledger-input mt-1.5 w-full"
										style="color: var(--ink)"
									/>
								</label>
							{/if}
							<!-- The geocoder's answer, when a link or address had to be
						     looked up: pick one, and it becomes the pin. -->
							{#each placeField.candidates as c, i (i)}
								<button
									type="button"
									onpointerdown={(e) => {
										/*
										 * A tap blurs the place input at pointerdown, and that
										 * blur re-searches — emptying `candidates` before the
										 * click lands. Keep the focus where it is; the click,
										 * now always finding its button still mounted, does
										 * the selecting.
										 */
										e.preventDefault();
									}}
									onclick={() => placeField.pickCandidate(c)}
									class="mt-2 flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left"
									style="background: color-mix(in oklab, var(--surface-2) 70%, var(--surface))"
								>
									<Search class="h-4 w-4 shrink-0" style="color: var(--ink-4)" />
									<span class="min-w-0 flex-1 truncate text-[14px]" style="color: var(--ink-2)">
										{c.label}
									</span>
								</button>
							{/each}
							<div class="mt-2.5 flex items-center justify-end gap-2">
								{#if data.locationEnabled}
									<button
										type="button"
										onclick={() => placeField.locate()}
										disabled={placeField.locating}
										class="btn btn-ghost text-[13px]"
									>
										<LocateFixed class="h-3.5 w-3.5" />
										{placeField.locating ? 'Locating…' : 'Use my location'}
									</button>
								{:else}
									<!-- Places are off; the only thing left to do with a pin
								     that predates that is remove it. -->
									<span class="mr-auto text-[12px]" style="color: var(--ink-4)">
										Places are turned off. You can remove this one.
									</span>
								{/if}
								<button
									type="button"
									onclick={() => (editingField = null)}
									class="btn btn-ghost text-[13px]"
								>
									Cancel
								</button>
								<button class="btn btn-accent text-[13px]" onclick={guardPlaceSubmit}>Save</button>
							</div>
							{#if placeField.searching}
								<p class="mt-2 text-[13px] leading-relaxed" style="color: var(--ink-3)">Looking…</p>
							{:else if placeField.error}
								<p class="mt-2 text-[13px] leading-relaxed" style="color: var(--ink-3)">
									{placeField.error}
								</p>
							{/if}
							<input type="hidden" name="latE3" value={placeField.place?.latE3 ?? ''} />
							<input type="hidden" name="lngE3" value={placeField.place?.lngE3 ?? ''} />
							<input type="hidden" name="placeLabel" value={placeField.place?.label ?? ''} />
							<input type="hidden" name="locationSource" value={placeField.place?.source ?? ''} />
						</form>
					{:else}
						<button
							type="button"
							onclick={() => data.can.annotate && openPlaceEdit()}
							class="edit-row hairline flex w-full items-center justify-between gap-3 py-3.5"
							disabled={!data.can.annotate}
						>
							<!--
								`shrink-0` on the label and `min-w-0` the whole way down the right
								side: without both, a long geocoded name ("…, San Francisco,
								California, 94111, United States") refuses to shrink, `truncate`
								never engages, and the text runs out through both edges of the
								card and straight over the word "Where".
							-->
							<span class="shrink-0 text-[16px]" style="color: var(--ink-3)">Where</span>
							<span class="flex min-w-0 flex-1 items-center justify-end gap-2">
								{#if p.place}
									<span class="flex min-w-0 flex-col items-end">
										<span
											class="w-full truncate text-right text-[16px] font-medium"
											style="color: var(--ink)"
										>
											{p.place.label ?? formatCoords(p.place)}
										</span>
										<span class="num text-[12px] whitespace-nowrap" style="color: var(--ink-4)">
											{p.place.source === 'merchant'
												? 'from the vendor’s usual place'
												: `${formatCoords(p.place)} · ±110 m`}
										</span>
									</span>
								{:else}
									<span class="text-[16px] font-medium" style="color: var(--ink)">Add</span>
								{/if}
								{#if data.can.annotate}
									<span class="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
										<MapPin class="edit-pencil h-3.5 w-3.5" style="color: var(--ink-4)" />
									</span>
								{/if}
							</span>
						</button>
					{/if}
				{/if}

				{#if editingField === 'category'}
					<form
						method="POST"
						action="?/category"
						use:submit={{ success: 'Saved', onSuccess: () => (editingField = null) }}
						class="hairline py-3.5"
					>
						<div class="flex items-center justify-between gap-3">
							<span class="shrink-0 text-[16px]" style="color: var(--ink-3)">Category</span>
							<!-- No auto-submit on change: choosing is not saving. The row
							     stays open until Save says so, same as every other editor. -->
							<select
								name="categoryId"
								aria-label="Category"
								class="ledger-input min-w-0 flex-1 text-right text-[16px] font-medium"
								style="color: var(--ink)"
							>
								<option value="">Other (no category)</option>
								{#each data.categories as c (c.id)}
									<option value={c.id} selected={c.id === p.categoryId}>{c.icon} {c.name}</option>
								{/each}
							</select>
						</div>
						<div class="mt-2.5 flex items-center justify-end gap-2">
							<button
								type="button"
								onclick={() => (editingField = null)}
								class="btn btn-ghost text-[13px]"
							>
								Cancel
							</button>
							<button class="btn btn-accent text-[13px]">Save</button>
						</div>
					</form>
				{:else}
					<button
						type="button"
						onclick={() => data.can.annotate && (editingField = 'category')}
						class="edit-row hairline flex w-full items-center justify-between py-3.5"
						disabled={!data.can.annotate}
					>
						<span class="text-[16px]" style="color: var(--ink-3)">Category</span>
						<span class="flex items-center gap-2">
							<span class="text-[16px] font-medium" style="color: var(--ink)"
								>{p.categoryName ?? 'Uncategorized'}</span
							>
							{#if data.can.annotate}
								<span class="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
									<Pencil class="edit-pencil h-3.5 w-3.5" style="color: var(--ink-4)" />
								</span>
							{/if}
						</span>
					</button>
				{/if}

				{#if isPending}
					<div class="hairline flex items-center justify-between py-3.5">
						<span class="text-[15px]" style="color: var(--ink-3)">Waiting on</span>
						<span class="text-[15px] font-medium" style="color: var(--ink)"
							>{p.approverNames.join(' or ')}</span
						>
					</div>

					{#if !__DEMO__ && notifyNudge && !data.notifyConfigured && (data.can.decide || data.can.cancel)}
						{@const askingForDecision = data.can.decide && !data.can.cancel}
						<div
							class="card -mx-1 mt-3 p-4"
							style="background: color-mix(in oklab, var(--pending) 12%, var(--surface))"
						>
							<div class="flex items-start gap-2.5">
								<Bell class="mt-0.5 h-4 w-4 shrink-0" style="color: var(--pending)" />
								<div class="flex-1">
									<p class="text-[14px] font-medium" style="color: var(--ink)">
										{#if askingForDecision}
											Get notified when someone needs a decision
										{:else}
											Know the moment they decide
										{/if}
									</p>
									<p class="mt-0.5 text-[13px]" style="color: var(--ink-3)">
										One setup, then every answer arrives on its own.
									</p>
								</div>
								<button
									type="button"
									onclick={dismissNotifyNudge}
									class="press -m-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
									aria-label="Dismiss"
									style="color: var(--ink-3)"
								>
									<X class="h-4 w-4" />
								</button>
							</div>
							<a
								href="/w/{slug}/settings/notifications"
								class="btn btn-accent mt-2.5 px-4 py-2 text-[14px]"
								onclick={dismissNotifyNudge}
							>
								Set up notifications
							</a>
						</div>
					{/if}
				{/if}
				{#if p.approvedAmountMinor !== null && !p.isOverageReapproval}
					<div class="hairline flex items-center justify-between py-3.5">
						<span class="text-[15px]" style="color: var(--ink-3)">Approved</span>
						<span class="num text-[15px] font-semibold" style="color: var(--approve)"
							>{formatMinor(p.approvedAmountMinor, p.currency)}</span
						>
					</div>
				{/if}
				{#if p.completedAt}
					<div class="hairline flex items-center justify-between py-3.5">
						<span class="text-[15px]" style="color: var(--ink-3)">Date</span>
						<span class="text-[15px] font-medium" style="color: var(--ink)"
							>{fmtDateLong(p.completedAt)}</span
						>
					</div>
				{/if}

				<!-- Note — the bottom line of the details -->
				{#if editingField === 'note'}
					<form
						method="POST"
						action="?/editNote"
						use:submit={{ success: 'Note saved', onSuccess: () => (editingField = null) }}
						class="hairline space-y-3 py-3.5"
					>
						<textarea
							name="note"
							aria-label="Note"
							rows="3"
							placeholder="Add a note…"
							class="ledger-input w-full text-[16px] leading-relaxed"
							style="color: var(--ink-2)"
							onkeydown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey) save(e.currentTarget);
								cancelEdit(e);
							}}>{p.note ?? ''}</textarea
						>
						<div class="flex items-center justify-end gap-2">
							<button
								type="button"
								onclick={() => (editingField = null)}
								class="btn btn-ghost text-[13px]"
							>
								Cancel
							</button>
							<button class="btn btn-accent text-[13px]">Save</button>
						</div>
					</form>
				{:else if p.note}
					<button
						type="button"
						onclick={() => data.can.annotate && (editingField = 'note')}
						class="edit-row hairline flex w-full items-start justify-between gap-2 py-3.5 text-left"
						disabled={!data.can.annotate}
					>
						<p class="text-[16px] leading-relaxed" style="color: var(--ink-2)">{p.note}</p>
						{#if data.can.annotate}
							<Pencil class="edit-pencil mt-0.5 h-3.5 w-3.5 shrink-0" style="color: var(--ink-4)" />
						{/if}
					</button>
				{:else if data.can.annotate}
					<button
						type="button"
						onclick={() => (editingField = 'note')}
						class="edit-row press hairline flex w-full items-center gap-2 py-3.5 text-[16px]"
						style="color: var(--ink-4)"
					>
						<Pencil class="edit-pencil h-3.5 w-3.5" /> Add a note
					</button>
				{/if}
			</div>
		</div>

		{#if p.sealed}
			<div
				class="rounded-[14px] p-4"
				style="background: color-mix(in oklab, var(--seal) 10%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--seal) 30%, transparent)"
			>
				<div class="flex items-start gap-3">
					<span
						class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
						style="background: color-mix(in oklab, var(--seal) 18%, transparent)"
					>
						<Lock class="h-4 w-4" style="color: var(--seal)" />
					</span>
					<div class="min-w-0 flex-1">
						<p class="text-[15px] font-semibold" style="color: var(--seal)">
							Hidden from {p.sealedFromNames.join(' and ')}
						</p>
						<p class="mt-0.5 text-[13px]" style="color: var(--ink-3)">
							Until {fmtDate(p.sealedUntil!)}. Invisible everywhere, including totals.
						</p>
						{#if data.can.unseal}
							<form
								method="POST"
								action="?/unseal"
								use:submit={{
									confirm: 'Reveal this purchase now? It becomes visible to everyone immediately.',
									success: 'Purchase revealed'
								}}
								class="mt-2.5"
							>
								<button
									class="btn py-2 text-[13px]"
									style="color: var(--seal); background: color-mix(in oklab, var(--seal) 14%, transparent)"
									>Reveal now</button
								>
							</form>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		{#if data.can.complete}
			<div class="card p-5">
				<p class="text-[15px] font-semibold" style="color: var(--ink)">Mark as bought</p>
				<p class="mt-0.5 text-[13px]" style="color: var(--ink-3)">
					Enter what you actually spent. A large overage triggers re-approval.
					{#if p.bucket}
						It comes out of {p.bucket.name}, which holds {formatMinor(
							p.bucket.balanceMinor,
							p.bucket.currency
						)}.
					{/if}
				</p>
				<form
					method="POST"
					action="?/complete"
					use:submit={{ confirm: overdraftConfirm, success: 'Marked as bought' }}
					class="mt-3.5 space-y-3"
				>
					<div class="grid grid-cols-2 gap-3">
						<label class="block">
							<span class="section-label mb-1.5 block">Actually spent</span>
							<input
								name="finalAmount"
								aria-label="Final amount"
								use:money
								bind:value={() => finalAmount, (v) => (typedFinal = { id: p.id, value: v })}
								required
								inputmode="decimal"
								placeholder="Final amount"
								class="field num text-[17px]"
							/>
						</label>
						<label class="block">
							<span class="section-label mb-1.5 block">On</span>
							<input
								name="finalDate"
								type="date"
								aria-label="Date"
								value={p.requestedAt ? toDateValue(p.requestedAt) : ''}
								class="field text-[16px]"
							/>
						</label>
					</div>
					{#if overdraft}
						<p class="text-[13px] leading-snug" style="color: var(--pending)">
							That's {formatMinor(overdraft.shortMinor, overdraft.currency)} more than {p.bucket
								?.name} holds. The bucket goes overdrawn and the shortfall counts as ordinary spending.
						</p>
					{/if}
					<button class="btn btn-accent w-full">Complete purchase</button>
				</form>
			</div>
		{/if}

		{#if data.can.refund}
			<div class="card p-5">
				<p class="text-[15px] font-semibold" style="color: var(--ink)">Record a refund</p>
				<form
					method="POST"
					action="?/refund"
					use:submit={{ success: 'Refund recorded' }}
					class="mt-3 flex gap-2.5"
				>
					<input
						name="refundAmount"
						use:money
						required
						inputmode="decimal"
						placeholder="Amount"
						class="field num flex-1 text-[16px]"
					/>
					<button class="btn btn-ghost shrink-0">Record</button>
				</form>
			</div>
		{/if}

		{#if data.can.cancel}
			<form
				method="POST"
				action="?/cancel"
				use:submit={{
					confirm: {
						title: 'Cancel this purchase?',
						body: "It won't be requested or recorded.",
						confirmLabel: 'Yes, cancel',
						cancelLabel: "Don't cancel",
						tone: 'danger'
					},
					success: 'Purchase cancelled'
				}}
				class="pt-1 text-center"
			>
				<button class="btn btn-plain" style="color: var(--ink-3)">Cancel this purchase</button>
			</form>
		{/if}

		{#if data.can.delete}
			<form
				method="POST"
				action="?/delete"
				use:submit={{
					confirm: {
						title: 'Remove this entry?',
						body: data.isRefund
							? "The refund is deleted for everyone and the original goes back to paid. This can't be undone."
							: "It's deleted for everyone, and any refunds against it go too. This can't be undone.",
						confirmLabel: 'Remove',
						tone: 'danger'
					}
				}}
				class="text-center"
			>
				<button class="btn btn-plain" style="color: var(--deny)">Remove this entry</button>
			</form>
		{/if}

		{#if data.events.length > 0}
			<div>
				<p class="section-label mb-3">History</p>
				<div class="space-y-4">
					{#each data.events as e, i (e.at + i)}
						<div class="flex items-baseline gap-3">
							<span
								class="mt-1 h-2 w-2 shrink-0 rounded-full"
								style="background: var({stateVar[e.toState] ?? '--ink-4'})"
							></span>
							<div class="flex min-w-0 flex-1 items-baseline justify-between gap-3">
								<span class="text-[13px]" style="color: var(--ink-2)">
									{stateLabel[e.toState] ?? e.toState}{e.actorName
										? ` · ${e.actorName}`
										: ''}{e.reason ? ` · ${e.reason}` : ''}
								</span>
								<span class="num shrink-0 text-[12px]" style="color: var(--ink-3)">
									{fmtDate(e.at)}{e.amountMinor !== null
										? ` · ${formatMinor(e.amountMinor, p.currency)}`
										: ''}
								</span>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>

{#if holdSheet}
	<div
		class="fixed inset-0 z-50"
		style="background: var(--scrim)"
		use:dismiss={() => (holdSheet = null)}
		transition:fade={{ duration: 140 }}
	></div>
	<div
		class="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
		role="dialog"
		aria-modal="true"
		aria-label="Sleep on it"
		use:modal
		transition:fly={{ y: 24, duration: 200 }}
	>
		<div
			class="card-lg overflow-hidden p-5"
			style="box-shadow: var(--shadow-float); background: var(--surface)"
		>
			<div class="flex items-center justify-between">
				<h2 class="font-[family-name:var(--font-display)] text-[22px]" style="color: var(--ink)">
					{holdSheet === 'extend' ? 'Wait more' : 'Sleep on it'}
				</h2>
				<button
					onclick={() => (holdSheet = null)}
					class="press -mr-1 flex h-8 w-8 items-center justify-center rounded-full"
					style="color: var(--ink-3)"
					aria-label="Close"
				>
					<X class="h-4 w-4" />
				</button>
			</div>
			<p class="mt-1 text-[13px]" style="color: var(--ink-3)">
				Take some time before deciding. We've suggested how long based on the amount. Spin to change
				it.
			</p>
			<div class="mt-3">
				<HoldPicker amountMinor={p.requestedAmountMinor} bind:days={holdDays} />
			</div>
			<form
				method="POST"
				action={holdSheet === 'extend' ? '?/extendHold' : '?/hold'}
				use:submit={{
					success: holdSheet === 'extend' ? 'Given more time' : 'Sleeping on it',
					onSuccess: () => (holdSheet = null)
				}}
				class="mt-3"
			>
				<input type="hidden" name="days" value={holdDays} />
				<button class="btn btn-accent w-full py-3 text-[15px]">
					{holdSheet === 'extend' ? 'Give it more time' : 'Sleep on it'}
				</button>
			</form>
		</div>
	</div>
{/if}

<style>
	.ledger-input {
		border: none;
		background: transparent;
		outline: none;
		padding: 0;
		font-size: 16px;
	}
	.ledger-input::placeholder {
		color: var(--ink-4);
	}
	/* The value itself is the affordance — the pencil only hints. On desktop
	   it appears on hover; on touch it's always visible (there's no hover to
	   discover it). The row that owns it gets .edit-row. */
	@media (hover: hover) {
		.edit-pencil {
			opacity: 0;
			transition: opacity var(--dur-fast) var(--ease-out);
		}
		.edit-row:hover .edit-pencil,
		.edit-row:focus-within .edit-pencil {
			opacity: 1;
		}
	}
	.edit-row:disabled {
		cursor: default;
	}
	.spin {
		border-radius: 999px;
		border: 2.5px solid color-mix(in oklab, var(--paper) 40%, transparent);
		border-top-color: var(--paper);
		animation: spin 0.6s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
