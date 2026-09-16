<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import { ChevronLeft, Pencil, Shapes, Trash2 } from '@lucide/svelte';

	let { data, form } = $props();
	let slug = $derived(page.params.workspace);
	const owner = $derived(data.isOwner);

	let showNew = $state(false);
	let newName = $state('');
	let newIcon = $state('📦');

	let editingId = $state<string | null>(null);
	let editName = $state('');
	let editIcon = $state('');

	const EMOJIS = [
		'🛒',
		'🍜',
		'🚆',
		'🏠',
		'💊',
		'🎬',
		'🔁',
		'🛍️',
		'🧴',
		'🐾',
		'✈️',
		'💡',
		'🎁',
		'📦',
		'📚',
		'🎓',
		'🏋️',
		'🎮',
		'🎵',
		'📱',
		'💻',
		'☕',
		'🍕',
		'🚗',
		'🏦',
		'💰',
		'💳',
		'🏥',
		'🧹',
		'👕',
		'🎨',
		'🌿',
		'🐶',
		'🔧',
		'📷',
		'🎂',
		'👶',
		'💒',
		'⚽',
		'🎣',
		'🧘',
		'🚲',
		'🍷',
		'🎪',
		'🏖️',
		'📰',
		'🔋',
		'🚿',
		'🧺',
		'🌡️',
		'🪴',
		'🛏️',
		'📺',
		'🎧',
		'⌚',
		'💍',
		'🚕',
		'⛽',
		'🚌',
		'🅿️',
		'🛵',
		'🎫',
		'🏕️',
		'🏨',
		'🧳',
		'🗺️',
		'🍎',
		'🥩',
		'🍞',
		'🥗',
		'🧀',
		'🍺',
		'🥂',
		'🍩',
		'🥡',
		'🍳',
		'💇',
		'🧖',
		'💅',
		'🪞',
		'🧼',
		'🦷',
		'👓',
		'🩺',
		'💉',
		'🧬',
		'📊',
		'📝',
		'✉️',
		'🖨️',
		'🗄️',
		'📎',
		'🖊️',
		'🔐',
		'☂️',
		'🧯',
		'🎹',
		'🎸',
		'🎻',
		'🎤',
		'🎯',
		'♟️',
		'🎲',
		'🧩',
		'🀄',
		'🎳',
		'🏌️',
		'⛷️',
		'🏄',
		'🏊',
		'🧗',
		'🏸',
		'🥊',
		'⛸️',
		'🛹',
		'🏹',
		'🍼',
		'🧸',
		'👧',
		'🦮',
		'🐱',
		'🐠',
		'🦜',
		'🐢',
		'🐹',
		'🐰',
		'🌱',
		'🌸',
		'🌳',
		'🍄',
		'🌊',
		'🔥',
		'❄️',
		'🌈',
		'⭐',
		'🎀'
	];

	function startEdit(r: { id: string; name: string; icon: string | null }) {
		editingId = r.id;
		editName = r.name;
		editIcon = r.icon ?? '📦';
	}

	function cancelEdit() {
		editingId = null;
		editName = '';
		editIcon = '';
	}

	function pickIcon(emoji: string) {
		if (editingId) editIcon = emoji;
		else newIcon = emoji;
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
	<!--
		The add control belongs in the masthead, where every other list on every
		other page keeps it — it used to sit at the bottom of the page as a card
		pretending to be a row, below a built-in list nobody can edit.
	-->
	<div class="flex items-center justify-between px-1">
		<h1 class="text-[28px]">Categories</h1>
		{#if owner}
			<button
				onclick={() => (showNew = !showNew)}
				class="btn {showNew ? 'btn-ghost' : 'btn-tint'} px-4 py-2 text-[14px]"
			>
				{showNew ? 'Cancel' : '+ New'}
			</button>
		{/if}
	</div>

	{#if owner && showNew}
		<form method="POST" action="?/create" use:submit class="card space-y-3 p-4">
			<input
				name="name"
				bind:value={newName}
				maxlength="60"
				required
				placeholder="Category name"
				aria-label="Category name"
				class="field w-full text-[16px]"
			/>
			<input type="hidden" name="icon" value={newIcon} />
			<div class="flex flex-wrap gap-1.5">
				{#each EMOJIS as e (e)}
					<button
						type="button"
						onclick={() => pickIcon(e)}
						class="press grid h-8 w-8 place-items-center rounded-md text-[18px] leading-none transition-colors {newIcon ===
						e
							? 'ring-1'
							: ''}"
						style={newIcon === e
							? 'box-shadow: inset 0 0 0 1.5px var(--ws-accent); background: color-mix(in oklab, var(--ws-accent) 12%, transparent)'
							: ''}
					>
						{e}
					</button>
				{/each}
			</div>
			{#if form && 'error' in form && form.error}
				<p class="text-[13px]" style="color: var(--deny)">{form.error}</p>
			{/if}
			<button class="btn btn-accent px-4 py-2 text-[14px]">Create category</button>
		</form>
	{/if}

	<!--
		Custom first: it is the only list on this page anyone can change, and it was
		sitting under twelve built-in rows that never move.
	-->
	<div class="card overflow-hidden">
		<!--
			The header mirrors a row: the caption sits in the same 40px column the
			counts do, and the two spacers stand in for the rename and remove buttons
			so it lands over the figures rather than over the icons. A bare column of
			numbers doesn't say what it counts.
		-->
		<div class="flex items-center gap-3 px-4 pt-4 pb-2">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Pencil class="h-4 w-4" style="color: var(--ws-accent)" /> Custom
			</h2>
			<span class="chip num" style="color: var(--ink-3); background: var(--surface-2)"
				>{data.custom.length}</span
			>
			<!-- No caption over an empty list: a column header with no column under it
			     reads as a heading for the "None yet" line. -->
			{#if data.custom.length > 0}
				<span class="section-label ml-auto w-10 text-right">Bought</span>
				{#if owner}
					<span class="w-7" aria-hidden="true"></span>
					<span class="w-7" aria-hidden="true"></span>
				{/if}
			{/if}
		</div>
		{#if data.custom.length === 0 && !showNew}
			<div class="px-4 pb-4">
				<p class="text-[14px]" style="color: var(--ink-3)">
					{owner
						? 'None yet. Add one to extend the category list everywhere.'
						: 'None yet. Only the workspace owner can add them.'}
				</p>
			</div>
		{/if}
		{#each data.custom as c, i (c.id)}
			{#if editingId === c.id}
				<form
					method="POST"
					action="?/update"
					use:submit
					class="space-y-3 px-4 py-3"
					style={i > 0 ? 'box-shadow: inset 0 0.5px 0 var(--hairline)' : ''}
				>
					<input type="hidden" name="id" value={c.id} />
					<input
						name="name"
						bind:value={editName}
						maxlength="60"
						required
						placeholder="Category name"
						aria-label="Category name"
						class="field w-full text-[16px]"
					/>
					<input type="hidden" name="icon" value={editIcon} />
					<div class="flex flex-wrap gap-1.5">
						{#each EMOJIS as e (e)}
							<button
								type="button"
								onclick={() => pickIcon(e)}
								class="press grid h-8 w-8 place-items-center rounded-md text-[18px] leading-none transition-colors {editIcon ===
								e
									? 'ring-1'
									: ''}"
								style={editIcon === e
									? 'box-shadow: inset 0 0 0 1.5px var(--ws-accent); background: color-mix(in oklab, var(--ws-accent) 12%, transparent)'
									: ''}
							>
								{e}
							</button>
						{/each}
					</div>
					<div class="flex items-center gap-2">
						<button class="btn btn-accent px-3 py-1.5 text-[13px]">Save</button>
						<button type="button" onclick={cancelEdit} class="btn btn-ghost px-3 py-1.5 text-[13px]"
							>Cancel</button
						>
					</div>
				</form>
			{:else}
				<div
					class="flex items-center gap-3 px-4 py-2.5"
					style={i > 0 ? 'box-shadow: inset 0 0.5px 0 var(--hairline)' : ''}
				>
					<span class="text-[20px] leading-none">{c.icon ?? '📦'}</span>
					<span class="flex-1 text-[15px]" style="color: var(--ink)">{c.name}</span>
					<span class="num w-10 text-right text-[15px]" style="color: var(--ink-3)"
						>{c.purchases}</span
					>
					{#if owner}
						<button
							onclick={() => startEdit(c)}
							class="press grid h-7 w-7 place-items-center rounded-full"
							aria-label="Rename {c.name}"
							style="color: var(--ink-3)"
						>
							<Pencil class="h-3.5 w-3.5" />
						</button>
						<form method="POST" action="?/remove" use:submit={{ confirm: `Remove "${c.name}"?` }}>
							<input type="hidden" name="id" value={c.id} />
							<button
								class="press grid h-7 w-7 place-items-center rounded-full"
								aria-label="Remove {c.name}"
								style="color: var(--deny)"
							>
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						</form>
					{/if}
				</div>
			{/if}
		{/each}
	</div>

	<!-- Built-in: the fixed list, for reference. -->
	<div class="card overflow-hidden">
		<div class="flex items-center gap-3 px-4 pt-4 pb-2">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Shapes class="h-4 w-4" style="color: var(--ws-accent)" /> Built-in
			</h2>
			<span class="chip num" style="color: var(--ink-3); background: var(--surface-2)"
				>{data.builtIn.length}</span
			>
			<span class="section-label ml-auto w-10 text-right">Bought</span>
		</div>
		{#each data.builtIn as c, i (c.id)}
			<div
				class="flex items-center gap-3 px-4 py-2.5"
				style={i > 0 ? 'box-shadow: inset 0 0.5px 0 var(--hairline)' : ''}
			>
				<span class="text-[20px] leading-none">{c.icon ?? '📦'}</span>
				<span class="flex-1 text-[15px]" style="color: var(--ink)">{c.name}</span>
				<!-- Both lists count the same way: the number alone, tabular and in a
			     fixed column so it lines up under the caption. "12 purchases" here
			     and a bare "12" there was the same fact in two formats. -->
				<span class="num w-10 text-right text-[15px]" style="color: var(--ink-3)"
					>{c.purchases}</span
				>
			</div>
		{/each}
	</div>
</div>
