import { error, fail } from '@sveltejs/kit';
import { audit } from '$lib/server/audit';
import { eq } from 'drizzle-orm';
import * as v from 'valibot';
import { getDb } from '$lib/server/db';
import { workspace } from '$lib/db/schema';
import type { Actions, PageServerLoad } from './$types';

const SaveSchema = v.object({
	staleAfterHours: v.pipe(v.unknown(), v.transform(Number), v.minValue(1), v.maxValue(720)),
	reapprovalThresholdPct: v.pipe(v.unknown(), v.transform(Number), v.minValue(0), v.maxValue(100)),
	maxSealDays: v.pipe(v.unknown(), v.transform(Number), v.minValue(1), v.maxValue(365)),
	budgetAlertPct: v.pipe(v.unknown(), v.transform(Number), v.minValue(1), v.maxValue(100)),
	budgetAlertCooldownHours: v.pipe(
		v.unknown(),
		v.transform(Number),
		v.minValue(1),
		v.maxValue(720)
	),
	recentDeleteHours: v.pipe(v.unknown(), v.transform(Number), v.minValue(0), v.maxValue(720)),
	maxNudges: v.pipe(v.unknown(), v.transform(Number), v.minValue(0), v.maxValue(20)),
	inviteTtlDays: v.pipe(v.unknown(), v.transform(Number), v.minValue(1), v.maxValue(90)),
	recurringCatchupMax: v.pipe(v.unknown(), v.transform(Number), v.minValue(1), v.maxValue(500))
});

export const load: PageServerLoad = async ({ locals, params }) => {
	void params.workspace;
	const ws = locals.workspace!;

	const weekDays = [
		{ value: 0, label: 'Sunday' },
		{ value: 1, label: 'Monday' },
		{ value: 2, label: 'Tuesday' },
		{ value: 3, label: 'Wednesday' },
		{ value: 4, label: 'Thursday' },
		{ value: 5, label: 'Friday' },
		{ value: 6, label: 'Saturday' }
	];

	return {
		isOwner: locals.member!.role === 'owner',
		staleAfterHours: ws.staleAfterHours,
		reapprovalThresholdPct: ws.reapprovalThresholdPct,
		maxSealDays: ws.maxSealDays,
		budgetAlertPct: ws.budgetAlertPct,
		budgetAlertCooldownHours: ws.budgetAlertCooldownHours,
		recentDeleteHours: ws.recentDeleteHours,
		maxNudges: ws.maxNudges,
		inviteTtlDays: ws.inviteTtlDays,
		recurringCatchupMax: ws.recurringCatchupMax,
		bucketChargesSkipApproval: ws.bucketChargesSkipApproval,
		settleUpEnabled: ws.settleUpEnabled,
		uniqueCategories: ws.uniqueCategories,
		weekStartDay: ws.weekStartDay,
		weekDays
	};
};

export const actions: Actions = {
	save: async (event) => {
		const { locals, request } = event;
		if (locals.member!.role !== 'owner') error(403);
		const fd = await request.formData();
		const weekDay = Number(fd.get('weekStartDay'));
		const parsed = v.safeParse(SaveSchema, Object.fromEntries(fd));
		if (!parsed.success) return fail(400, { error: 'One or more values are out of range.' });

		const out = parsed.output;
		await getDb()
			.update(workspace)
			.set({
				staleAfterHours: out.staleAfterHours,
				reapprovalThresholdPct: out.reapprovalThresholdPct,
				maxSealDays: out.maxSealDays,
				budgetAlertPct: out.budgetAlertPct,
				budgetAlertCooldownHours: out.budgetAlertCooldownHours,
				recentDeleteHours: out.recentDeleteHours,
				maxNudges: out.maxNudges,
				inviteTtlDays: out.inviteTtlDays,
				recurringCatchupMax: out.recurringCatchupMax,
				weekStartDay: Number.isFinite(weekDay) && weekDay >= 0 && weekDay <= 6 ? weekDay : undefined
			})
			.where(eq(workspace.id, locals.workspace!.id));
		const before = locals.workspace!;
		const changed = Object.fromEntries(
			(Object.keys(out) as (keyof typeof out)[])
				.filter((k) => before[k] !== out[k])
				.map((k) => [k, { from: before[k], to: out[k] }])
		);
		if (Object.keys(changed).length > 0) {
			await audit(event, { action: 'workspace.settings_changed', detail: changed });
		}
		return { ok: true };
	}
};
