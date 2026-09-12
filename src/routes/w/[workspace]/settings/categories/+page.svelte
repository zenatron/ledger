<script lang="ts">
	import { submit } from '$lib/actions/submit';
	import { page } from '$app/state';
	import { ChevronLeft, Pencil, Plus, Shapes, Trash2, X } from '@lucide/svelte';

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
	<h1 class="px-1 text-[28px]">Categories</h1>

	<!-- Built-in categories -->
	<div class="card overflow-hidden">
		<div class="flex items-center justify-between px-4 pt-4 pb-2">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Shapes class="h-4 w-4" style="color: var(--ws-accent)" /> Built-in
			</h2>
			<span class="text-[13px]" style="color: var(--ink-3)"
				>{data.builtIn.length} categor{data.builtIn.length === 1 ? 'y' : 'ies'}</span
			>
		</div>
		{#each data.builtIn as c, i (c.id)}
			<div
				class="flex items-center gap-3 px-4 py-2.5"
				style={i > 0 ? 'box-shadow: inset 0 0.5px 0 var(--hairline)' : ''}
			>
				<span class="text-[20px] leading-none">{c.icon ?? '📦'}</span>
				<span class="flex-1 text-[15px]" style="color: var(--ink)">{c.name}</span>
				<span class="text-[15px]" style="color: var(--ink-3)">
					{c.purchases > 0 ? `${c.purchases} purchase${c.purchases === 1 ? '' : 's'}` : 'unused'}
				</span>
			</div>
		{/each}
	</div>

	<!-- Custom categories -->
	<div class="card overflow-hidden">
		<div class="flex items-center justify-between px-4 pt-4 pb-2">
			<h2
				class="flex items-center gap-2 font-[family-name:var(--font-sans)] text-[16px] font-semibold tracking-normal"
				style="color: var(--ink)"
			>
				<Pencil class="h-4 w-4" style="color: var(--ws-accent)" /> Custom
			</h2>
			<span class="text-[13px]" style="color: var(--ink-3)"
				>{data.custom.length} categor{data.custom.length === 1 ? 'y' : 'ies'}</span
			>
		</div>
		{#if data.custom.length === 0 && !showNew}
			<div class="px-4 pb-4">
				<p class="text-[14px]" style="color: var(--ink-3)">
					None yet. Add one below to extend the category list everywhere.
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
					<span class="text-[15px]" style="color: var(--ink-3)">
						{c.purchases > 0 ? `${c.purchases}` : 'unused'}
					</span>
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
								style="color: var(--ink-4)"
							>
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						</form>
					{/if}
				</div>
			{/if}
		{/each}
	</div>

	<!-- Add new category -->
	{#if owner}
		{#if showNew}
			<form method="POST" action="?/create" use:submit class="card space-y-3 p-4">
				<div class="flex items-center justify-between">
					<p class="flex items-center gap-2 text-[15px] font-medium" style="color: var(--ink)">
						<Plus class="h-4 w-4" style="color: var(--ws-accent)" /> New category
					</p>
					<button
						type="button"
						onclick={() => (showNew = false)}
						class="press grid h-7 w-7 place-items-center rounded-full"
						style="color: var(--ink-3)"
					>
						<X class="h-4 w-4" />
					</button>
				</div>
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
		{:else}
			<button
				onclick={() => (showNew = true)}
				class="press card flex w-full items-center gap-3 p-4 text-left"
			>
				<span
					class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
					style="background: color-mix(in oklab, var(--ws-accent) 14%, var(--surface))"
				>
					<Plus class="h-[18px] w-[18px]" style="color: var(--ws-accent)" />
				</span>
				<span class="text-[15px] font-medium" style="color: var(--ink)">Add a category</span>
			</button>
		{/if}
	{:else}
		<p class="px-1 text-[13px]" style="color: var(--ink-3)">
			Only the workspace owner can manage categories.
		</p>
	{/if}
</div>
