import { eq, inArray } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import {
	account,
	approvalEvent,
	bankConnection,
	bankFeedAccount,
	budget,
	budgetAlertLog,
	bucket,
	bucketTransaction,
	category,
	income,
	invite,
	merchant,
	notificationPref,
	purchase,
	purchaseApprover,
	purchaseImage,
	recurringRule,
	session,
	statementImport,
	statementLine,
	workspace,
	workspaceMember
} from '$lib/db/schema';

/**
 * Erase a workspace and everything under it, in one transaction.
 *
 * The schema declares no ON DELETE CASCADE, so rows have to go children-first or
 * a foreign key blocks the delete halfway. The order below is that dependency
 * graph read leaves-up; getting it wrong fails loudly rather than corrupting, so
 * it is safe to maintain, but it must stay complete — a new table that points at
 * the workspace and isn't listed here will wedge every future deletion.
 *
 * Blobs are intentionally left in place. They are content-addressed and
 * append-only (see BlobStore) — the app never deletes them even when a single
 * image is removed, both because identical bytes may be shared with another
 * workspace and because the store is meant to be backed up independently of the
 * DB. Orphaned blobs are harmless; a blob deleted out from under another
 * workspace's purchase is not.
 */
export async function deleteWorkspace(db: Db, workspaceId: string): Promise<void> {
	await db.transaction(async (tx) => {
		const purchaseIds = tx
			.select({ id: purchase.id })
			.from(purchase)
			.where(eq(purchase.workspaceId, workspaceId));
		const memberIds = tx
			.select({ id: workspaceMember.id })
			.from(workspaceMember)
			.where(eq(workspaceMember.workspaceId, workspaceId));
		const bucketIds = tx
			.select({ id: bucket.id })
			.from(bucket)
			.where(eq(bucket.workspaceId, workspaceId));

		// Grandchildren of purchase / bucket / member.
		await tx.delete(bucketTransaction).where(inArray(bucketTransaction.bucketId, bucketIds));
		await tx.delete(purchaseApprover).where(inArray(purchaseApprover.purchaseId, purchaseIds));
		await tx.delete(purchaseImage).where(inArray(purchaseImage.purchaseId, purchaseIds));
		await tx.delete(approvalEvent).where(inArray(approvalEvent.purchaseId, purchaseIds));
		await tx.delete(notificationPref).where(inArray(notificationPref.workspaceMemberId, memberIds));

		// Reconciliation and bank sync. Lines point at purchases, imports and bank
		// connections at members, and imports and feed accounts at cards, so all of
		// it goes before those.
		await tx.delete(statementLine).where(eq(statementLine.workspaceId, workspaceId));
		await tx.delete(statementImport).where(eq(statementImport.workspaceId, workspaceId));
		await tx.delete(bankFeedAccount).where(eq(bankFeedAccount.workspaceId, workspaceId));
		await tx.delete(bankConnection).where(eq(bankConnection.workspaceId, workspaceId));

		// Direct children of the workspace. purchase, recurringRule, income and
		// bucket all reference members and categories, so they precede those.
		await tx.delete(purchase).where(eq(purchase.workspaceId, workspaceId));
		await tx.delete(account).where(eq(account.workspaceId, workspaceId));
		await tx.delete(recurringRule).where(eq(recurringRule.workspaceId, workspaceId));
		await tx.delete(income).where(eq(income.workspaceId, workspaceId));
		await tx.delete(budget).where(eq(budget.workspaceId, workspaceId));
		await tx.delete(budgetAlertLog).where(eq(budgetAlertLog.workspaceId, workspaceId));
		await tx.delete(bucket).where(eq(bucket.workspaceId, workspaceId));
		await tx.delete(category).where(eq(category.workspaceId, workspaceId));
		await tx.delete(merchant).where(eq(merchant.workspaceId, workspaceId));
		await tx.delete(invite).where(eq(invite.workspaceId, workspaceId));
		await tx.delete(workspaceMember).where(eq(workspaceMember.workspaceId, workspaceId));

		// Sessions point at this workspace as their active one; null it so the FK
		// on workspace doesn't block, and so the next request re-picks a workspace.
		await tx
			.update(session)
			.set({ activeWorkspaceId: null })
			.where(eq(session.activeWorkspaceId, workspaceId));

		await tx.delete(workspace).where(eq(workspace.id, workspaceId));
	});
}
