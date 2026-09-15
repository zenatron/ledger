<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import { ChevronLeft, Circle, Contrast, Monitor, Moon, Palette, Sun } from '@lucide/svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import AccentPicker from '$lib/components/AccentPicker.svelte';
	import {
		contrast,
		setContrast,
		setTheme,
		theme,
		type ContrastPref,
		type ThemePref
	} from '$lib/theme.svelte';
	import { accentFor } from '$lib/accent';

	/**
	 * Everything about how the app looks, in one place.
	 *
	 * These two had been sitting apart on the settings root: the theme in one
	 * card, the accent in another two screens down, with the workspace's feature
	 * settings in between. They are one subject and they now read as one, which
	 * also gets the settings root back to a list of destinations.
	 *
	 * The theme is per-device (localStorage, no round trip) and the accent is
	 * per-workspace (a column, owner-only). The page says which is which rather
	 * than letting the reader guess from where a control happens to sit.
	 */
	let { data, form } = $props();
	let slug = $derived(page.params.workspace);

	// Seeded from the server and re-derived when the load data changes; Save
	// appears only once the picked value and the stored one diverge.
	const currentAccent = $derived(accentFor({ slug: slug ?? '', accentColor: data.accentColor }));
	let accent = $derived(currentAccent);

	const themeOptions: { id: ThemePref; label: string; icon: typeof Sun }[] = [
		{ id: 'system', label: 'System', icon: Monitor },
		{ id: 'light', label: 'Light', icon: Sun },
		{ id: 'dark', label: 'Dark', icon: Moon }
	];
</script>

<div class="mx-auto max-w-lg space-y-4">
	<a
		href="/w/{slug}"
		class="press -ml-1 inline-flex items-center gap-0.5 text-[15px]"
		style="color: var(--ink-3)"
	>
		<ChevronLeft class="h-4 w-4" /> Settings
	</a>
	<h1 class="px-1 text-[28px]">Appearance</h1>

	{#if form?.error}
		<p class="card p-3 text-[14px]" style="color: var(--deny)">{form.error}</p>
	{/if}

	<section class="card p-5">
		<h2
			class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
			style="color: var(--ink)"
		>
			<Sun class="h-4 w-4" style="color: var(--ws-accent)" /> Theme
		</h2>
		<p class="mt-1 mb-3.5 text-[13px]" style="color: var(--ink-3)">
			Follows your device by default. Saved on this device.
		</p>
		<Segmented
			options={themeOptions.map((o) => ({ value: o.id, label: o.label, icon: o.icon }))}
			value={theme.pref}
			onselect={(v) => setTheme(v as ThemePref)}
			ariaLabel="Theme"
		/>
	</section>

	{#if data.isOwner}
		<section class="card p-5">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Palette class="h-4 w-4" style="color: var(--ws-accent)" /> Accent
			</h2>
			<p class="mt-1 mb-3.5 text-[13px]" style="color: var(--ink-3)">
				Colors this workspace for everyone in it. Each workspace keeps its own.
			</p>
			<form method="POST" action="?/accent" use:submit={{ success: 'Accent updated' }}>
				<AccentPicker bind:value={accent} label="" />
				<input type="hidden" name="accentColor" value={accent} />
				{#if accent !== currentAccent}
					<button class="btn btn-tint mt-3.5 px-4 py-2 text-[14px]">Save accent</button>
				{/if}
			</form>
		</section>
	{/if}

	<!--
		Contrast is the same kind of choice as the theme — how this device reads
		the page, stored on it, following the OS until told otherwise — and sits
		after the accent, the colour it most visibly changes. More keeps the paper
		and the layout. It darkens the ink, strengthens the rules and deepens the
		status colours, like the same statement printed with a fresher ribbon.
	-->
	<section class="card p-5">
		<h2
			class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
			style="color: var(--ink)"
		>
			<Contrast class="h-4 w-4" style="color: var(--ws-accent)" /> Contrast
		</h2>
		<p class="mt-1 mb-3.5 text-[13px]" style="color: var(--ink-3)">
			More makes text darker, dividers firmer and status colors deeper. Follows your device's
			Increase Contrast setting by default. Saved on this device.
		</p>
		<Segmented
			options={[
				{ value: 'system', label: 'System', icon: Monitor },
				{ value: 'standard', label: 'Standard', icon: Circle },
				{ value: 'more', label: 'More', icon: Contrast }
			]}
			value={contrast.pref}
			onselect={(v) => setContrast(v as ContrastPref)}
			ariaLabel="Contrast"
		/>
	</section>
</div>
