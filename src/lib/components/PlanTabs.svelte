<script lang="ts">
	import Segmented from '$lib/components/Segmented.svelte';
	import { page } from '$app/state';
	import { CalendarDays } from '@lucide/svelte';

	/**
	 * Sub-navigation for the Plan tab. Recurring charges and buckets are both
	 * money already claimed before anything discretionary — a subscription and a
	 * standing transfer to the travel fund are the same shape from a budgeting
	 * view — so they share a tab.
	 *
	 * Real links rather than a client-side toggle: each keeps its own route, load
	 * and actions, and stays independently bookmarkable.
	 */
	let slug = $derived(page.params.workspace);
	let current = $derived(page.url.pathname.includes('/buckets') ? 'buckets' : 'recurring');

	const items = [
		{ key: 'recurring', label: 'Recurring', hint: 'Bills & subscriptions' },
		{ key: 'buckets', label: 'Buckets', hint: 'Set aside each month' }
	];
</script>

<!--
	The pill stays centred; the calendar sits beside it rather than in it. A third
	tab would have said the calendar is a sibling of Recurring and Buckets, and it
	isn't — it's a view *across* both, which is why it reads as an action.
-->
<div class="relative mb-4 flex justify-center">
	<Segmented
		options={items.map((i) => ({
			value: i.key,
			label: i.label,
			href: `/w/${slug}/${i.key}`,
			title: i.hint
		}))}
		value={current}
		fill={false}
		ariaLabel="Plan section"
	/>
	<a
		href="/w/{slug}/calendar"
		class="press icon-btn absolute top-1/2 right-0 -translate-y-1/2"
		aria-label="Month calendar"
		title="Scheduled, by day"
	>
		<CalendarDays class="h-4 w-4" style="color: var(--ink-3)" />
	</a>
</div>
