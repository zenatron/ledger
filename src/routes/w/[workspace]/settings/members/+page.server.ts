import { error, fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import * as v from 'valibot';
import { getDb } from '$lib/server/db';
import { workspaceMember } from '$lib/db/schema';
import { createInvite, listOpenInvites } from '$lib/server/repo/invites';
import { listMembers } from '$lib/repo/workspaces';
import {
	BUCKET_CHARGE_RULES,
	InvalidPolicyError,
	strandedByRemoving,
	validatePolicy,
	type ApprovalPolicy
} from '$lib/domain/approval/policy';
import { Money, InvalidMoneyError } from '$lib/domain/money/money';
import { describeRecurrence, parseRRule } from '$lib/domain/recurrence/rrule';
import { listBuckets } from '$lib/repo/buckets';
import { uuidv7 } from '$lib/infra/id/uuidv7';
import { systemClock } from '$lib/infra/time/system-clock';
import { audit } from '$lib/server/audit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	// Re-run this workspace-scoped load when the workspace in the URL changes;
	// a locals-only load declares no such dependency. See +layout.server.ts.
	void params.workspace;
	const db = getDb();
	const now = systemClock.now();
	const members = await listMembers(db, locals.workspace!.id);
	const isOwner = locals.member!.role === 'owner';
	// Invites live here rather than on the settings root: creating a code is
	// how a member gets added, so it belongs with the people it adds.
	const invites = isOwner ? await listOpenInvites(db, locals.workspace!.id, now) : [];
	// Each member's allowance, if an owner set one up. Read off the bucket's own
	// flag: inferring it from "only I can charge this" also caught personal
	// savings buckets, which are that too. Shown here for reference only; it is
	// managed on the Buckets page.
	const buckets = await listBuckets(db, locals.workspace!.id);
	const allowanceOf = new Map(
		buckets
			.filter((b) => b.bucket.isAllowance && b.bucket.status === 'active')
			.map((b) => [
				b.bucket.memberId,
				{
					name: b.bucket.name,
					amountMinor: b.bucket.amountMinor,
					balanceMinor: b.balanceMinor,
					cadence: describeSchedule(b.bucket.rrule)
				}
			])
	);

	return {
		isOwner,
		viewerMemberId: locals.member!.id,
		// So "inherit" can name what it defers to instead of being a dead end.
		workspaceSkipsBucketCharges: locals.workspace!.bucketChargesSkipApproval,
		members: members.map((m) => ({
			id: m.member.id,
			displayName: m.user.displayName,
			role: m.member.role,
			status: m.member.status,
			policy: m.member.approvalPolicy as ApprovalPolicy,
			allowance: allowanceOf.get(m.member.id) ?? null
		})),
		invites: invites.map((i) => ({ code: i.code, expiresAt: i.expiresAt.toISOString() }))
	};
};

const PolicySchema = v.object({
	memberId: v.pipe(v.string(), v.nonEmpty()),
	mode: v.picklist(['none', 'threshold', 'always']),
	threshold: v.optional(v.string()),
	bucketCharges: v.optional(v.picklist(BUCKET_CHARGE_RULES), 'inherit'),
	bucketScope: v.optional(v.picklist(['any', 'own']), 'any'),
	routingMode: v.optional(v.picklist(['any_of', 'specific']), 'any_of')
});

/** The rule in words, for the one-line summary beside a member's name. */
function describeSchedule(rrule: string): string {
	try {
		return describeRecurrence(parseRRule(rrule));
	} catch {
		return 'on a schedule';
	}
}

export const actions: Actions = {
	invite: async (event) => {
		const { locals } = event;
		if (locals.member!.role !== 'owner') error(403, 'Only the owner can create invites');
		const created = await createInvite(
			getDb(),
			{ clock: systemClock, ids: uuidv7 },
			{
				workspaceId: locals.workspace!.id,
				createdByMemberId: locals.member!.id,
				ttlDays: locals.workspace!.inviteTtlDays
			}
		);
		// The code itself is a credential until used; the log names it by id.
		await audit(event, {
			action: 'invite.created',
			detail: { inviteId: created.id, expiresAt: created.expiresAt.toISOString() }
		});
		return { ok: true };
	},

	/**
	 * Promote a member to owner, or step an owner back down.
	 *
	 * Ownership used to be fixed at creation — the person who made the workspace
	 * was the only one who could ever change a setting, a budget or a policy, and
	 * there was no way to hand that over. Losing that account left the workspace
	 * permanently unadministrable.
	 *
	 * There is no separate "transfer" action because it would be this one twice:
	 * promote whoever is taking over, then they step you down. Allowing several
	 * owners at once is what makes the handover safe — at no point is there
	 * nobody in charge — and making the demotion theirs, not yours, keeps a
	 * workspace from changing hands in one sitting.
	 */
	setMemberRole: async (event) => {
		const { locals, request } = event;
		if (locals.member!.role !== 'owner') error(403, 'Only an owner can change roles');
		const form = await request.formData();
		const memberId = String(form.get('memberId') ?? '');
		const makeOwner = form.get('owner') === 'true';

		const db = getDb();
		const members = await listMembers(db, locals.workspace!.id);
		const target = members.find((m) => m.member.id === memberId);
		if (!target) return fail(400, { error: 'Unknown member' });

		// A disabled member has no access, so making them an owner would grant
		// authority to someone who cannot use it — restore them first.
		if (target.member.status !== 'active') {
			return fail(400, { error: 'Restore this member before changing their role' });
		}

		// Not even your own role: promote the person taking over and let them
		// return the favour. A demotion you perform yourself is how a workspace
		// ends up owned by whoever was promoted last.
		if (!makeOwner && memberId === locals.member!.id) {
			return fail(400, {
				error: 'You cannot step yourself down. Another owner must change your role'
			});
		}

		if (!makeOwner) {
			const otherActiveOwners = members.filter(
				(m) => m.member.id !== memberId && m.member.role === 'owner' && m.member.status === 'active'
			);
			if (otherActiveOwners.length === 0) {
				return fail(400, {
					error: 'Someone has to own this workspace. Make another member an owner first.'
				});
			}
		}

		await db
			.update(workspaceMember)
			.set({ role: makeOwner ? 'owner' : 'member' })
			.where(
				and(eq(workspaceMember.id, memberId), eq(workspaceMember.workspaceId, locals.workspace!.id))
			);
		await audit(event, {
			action: 'member.role_changed',
			targetMemberId: memberId,
			targetName: target.user.displayName,
			detail: { from: target.member.role, to: makeOwner ? 'owner' : 'member' }
		});
		return { ok: true };
	},

	/**
	 * Disable or re-enable a member.
	 *
	 * Disabling revokes access outright — findWorkspaceForUser and the workspace
	 * switcher both already join on status='active', so the status *is* the gate.
	 * Their history stays: past purchases are a record of what happened, not
	 * configuration, and deleting them would silently rewrite everyone's totals.
	 */
	setMemberStatus: async (event) => {
		const { locals, request } = event;
		if (locals.member!.role !== 'owner') error(403, 'Only the owner can disable members');
		const form = await request.formData();
		const memberId = String(form.get('memberId') ?? '');
		const disable = form.get('disabled') === 'true';

		const db = getDb();
		const members = await listMembers(db, locals.workspace!.id);
		const target = members.find((m) => m.member.id === memberId);
		if (!target) return fail(400, { error: 'Unknown member' });

		if (disable) {
			// Locking yourself out is never what you meant, and with no ownership
			// transfer there would be no way back in.
			if (memberId === locals.member!.id) {
				return fail(400, { error: 'You cannot disable yourself' });
			}
			// The last owner holds the only keys to settings, budgets and invites.
			const otherActiveOwners = members.filter(
				(m) => m.member.id !== memberId && m.member.role === 'owner' && m.member.status === 'active'
			);
			if (target.member.role === 'owner' && otherActiveOwners.length === 0) {
				return fail(400, { error: 'That is the only owner. The workspace would be unmanageable.' });
			}

			const stranded = strandedByRemoving(
				members.map((m) => ({
					id: m.member.id,
					policy: m.member.approvalPolicy as ApprovalPolicy,
					status: m.member.status
				})),
				memberId
			);
			if (stranded.length > 0) {
				const names = stranded
					.map((id) => members.find((m) => m.member.id === id)?.user.displayName ?? 'someone')
					.join(' and ');
				return fail(400, {
					error: `${target.user.displayName} is the only approver for ${names}. Name someone else first.`
				});
			}
		}

		await db
			.update(workspaceMember)
			.set({ status: disable ? 'disabled' : 'active' })
			.where(
				and(eq(workspaceMember.id, memberId), eq(workspaceMember.workspaceId, locals.workspace!.id))
			);
		await audit(event, {
			action: 'member.status_changed',
			targetMemberId: memberId,
			targetName: target.user.displayName,
			detail: { from: target.member.status, to: disable ? 'disabled' : 'active' }
		});
		return { ok: true };
	},

	policy: async (event) => {
		const { locals, request } = event;
		if (locals.member!.role !== 'owner') error(403, 'Only the owner can change policies');
		const form = await request.formData();
		const approverIds = form.getAll('approverIds').map(String);
		const parsed = v.safeParse(PolicySchema, {
			memberId: form.get('memberId'),
			mode: form.get('mode'),
			threshold: form.get('threshold') ?? undefined,
			bucketCharges: form.get('bucketCharges') ?? undefined,
			routingMode: form.get('routingMode') ?? undefined
		});
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const f = parsed.output;

		const db = getDb();
		const members = await listMembers(db, locals.workspace!.id);
		const target = members.find((m) => m.member.id === f.memberId);
		if (!target) return fail(400, { error: 'Unknown member' });

		let thresholdMinor: number | undefined;
		if (f.mode === 'threshold') {
			try {
				const money = Money.fromDecimal(f.threshold ?? '', locals.workspace!.currency);
				thresholdMinor = Number(money.minor);
			} catch (e) {
				if (e instanceof InvalidMoneyError) return fail(400, { error: e.message });
				throw e;
			}
		}

		const existing = target.member.approvalPolicy as ApprovalPolicy;
		const policy: ApprovalPolicy = {
			mode: f.mode,
			...(thresholdMinor !== undefined ? { threshold_minor: thresholdMinor } : {}),
			category_overrides: existing.category_overrides,
			// 'inherit' is the absent state, so it is stored as absent rather than
			// as a literal — one representation for one meaning.
			...(f.bucketCharges !== 'inherit' ? { bucket_charges: f.bucketCharges } : {}),
			// Same reasoning: 'any' is the default, so it is stored as absent.
			...(f.bucketScope === 'own' ? { own_buckets_only: true } : {}),
			routing: { mode: f.routingMode, approver_ids: approverIds }
		};
		const activeIds = members.filter((m) => m.member.status === 'active').map((m) => m.member.id);
		try {
			validatePolicy(policy, activeIds);
		} catch (e) {
			if (e instanceof InvalidPolicyError) return fail(400, { error: e.message });
			throw e;
		}
		await db
			.update(workspaceMember)
			.set({ approvalPolicy: policy })
			.where(
				and(
					eq(workspaceMember.id, f.memberId),
					eq(workspaceMember.workspaceId, locals.workspace!.id)
				)
			);
		await audit(event, {
			action: 'member.policy_changed',
			targetMemberId: f.memberId,
			targetName: target.user.displayName,
			detail: { from: existing, to: policy }
		});
		return { ok: true };
	}
};
