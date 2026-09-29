import { and, eq } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { account, category } from '$lib/db/schema';
import { PurchaseStateError } from '$lib/domain/purchase/purchase';
import { isUuid } from '$lib/uuid';

/**
 * The references a purchase or rule may carry, checked against the workspace.
 *
 * A category or card id is only a column value to the database, so a foreign
 * key accepts one from *any* workspace. The pickers only ever offer this
 * workspace's, but a form post, an MCP call and a recurring rule all arrive at
 * the use case directly — and a stranger's category id, once stored, is joined
 * for its name on every ledger row. So the use cases check it themselves, and
 * shape-check it first so a mangled id is a plain refusal rather than a failed
 * cast.
 *
 * An archived category is refused for new writes: it is hidden from every
 * picker, and quietly filing into it would put spending where nobody looks.
 */
export async function assertCategoryInWorkspace(
	db: Db,
	workspaceId: string,
	categoryId: string | null | undefined
): Promise<void> {
	if (!categoryId) return;
	if (!isUuid(categoryId)) throw new PurchaseStateError('That category does not exist');
	const [row] = await db
		.select({ archived: category.isArchived })
		.from(category)
		.where(and(eq(category.id, categoryId), eq(category.workspaceId, workspaceId)))
		.limit(1);
	if (!row) throw new PurchaseStateError('That category does not exist');
	if (row.archived) throw new PurchaseStateError('That category has been archived');
}

export async function assertAccountInWorkspace(
	db: Db,
	workspaceId: string,
	accountId: string | null | undefined
): Promise<void> {
	if (!accountId) return;
	if (!isUuid(accountId)) throw new PurchaseStateError('That card does not exist');
	const [row] = await db
		.select({ id: account.id })
		.from(account)
		.where(and(eq(account.id, accountId), eq(account.workspaceId, workspaceId)))
		.limit(1);
	if (!row) throw new PurchaseStateError('That card does not exist');
}

/** Merchant names are free text, but not unbounded: the form caps them at this. */
export const MERCHANT_NAME_MAX = 120;
