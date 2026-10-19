import { and, eq, lt, or } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { pendingShare, purchaseImage, statementImport, user } from '$lib/db/schema';
import type { BlobStore } from '$lib/ports/blob-store';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';

/** A shared photo is pick-up only for the member who shared it, within the hour. */
export const SHARE_TTL_MS = 60 * 60 * 1000;

export interface StoredShare {
	id: string;
	blobId: string;
	filename: string;
	contentType: string;
	byteSize: number;
}

export async function createShare(
	db: Db,
	deps: { clock: Clock; ids: IdGenerator },
	input: {
		workspaceId: string;
		memberId: string;
		blobId: string;
		filename: string;
		contentType: string;
		byteSize: number;
	}
): Promise<string> {
	const id = deps.ids.newId();
	await db.insert(pendingShare).values({ id, ...input, createdAt: deps.clock.now() });
	return id;
}

/**
 * Scoped like every other read: the id alone is not authorization. A share
 * found past its TTL is treated as absent — the sweep will collect the row,
 * and the picker's copy ("that share has expired") stays true.
 */
export async function loadShare(
	db: Db,
	scope: { workspaceId: string; memberId: string },
	shareId: string,
	now: Date
): Promise<StoredShare | null> {
	const row = await db
		.select()
		.from(pendingShare)
		.where(
			and(
				eq(pendingShare.id, shareId),
				eq(pendingShare.workspaceId, scope.workspaceId),
				eq(pendingShare.memberId, scope.memberId)
			)
		)
		.limit(1);
	if (row.length === 0) return null;
	if (now.getTime() - row[0].createdAt.getTime() > SHARE_TTL_MS) return null;
	return {
		id: row[0].id,
		blobId: row[0].blobId,
		filename: row[0].filename,
		contentType: row[0].contentType,
		byteSize: row[0].byteSize
	};
}

/**
 * Swept from the 5-minute sweep; returns the count for the log line.
 *
 * With a store, the staged originals go too. The blob store is otherwise
 * append-only on purpose (see delete-workspace), but a staged share is not a
 * record of anything: it is a full-size original, up to 10 MB, that nothing
 * durable ever points at — the form re-processes it into a purchase photo of
 * its own. Left in place, every photo shared to the app stayed on disk for
 * good. A file is removed only when no row anywhere still names it, since
 * content addressing means the same bytes could have been shared twice.
 */
export async function sweepExpiredShares(db: Db, now: Date, blobs?: BlobStore): Promise<number> {
	const rows = await db
		.delete(pendingShare)
		.where(lt(pendingShare.createdAt, new Date(now.getTime() - SHARE_TTL_MS)))
		.returning({ id: pendingShare.id, blobId: pendingShare.blobId });
	if (blobs) {
		for (const blobId of new Set(rows.map((r) => r.blobId))) {
			if (!(await blobReferenced(db, blobId))) await blobs.delete(blobId);
		}
	}
	return rows.length;
}

/** Does any row still name this blob? Every blob-id column in the schema. */
async function blobReferenced(db: Db, blobId: string): Promise<boolean> {
	const hits = await Promise.all([
		db
			.select({ id: pendingShare.id })
			.from(pendingShare)
			.where(eq(pendingShare.blobId, blobId))
			.limit(1),
		db
			.select({ id: purchaseImage.id })
			.from(purchaseImage)
			.where(or(eq(purchaseImage.blobId, blobId), eq(purchaseImage.thumbBlobId, blobId)))
			.limit(1),
		db.select({ id: user.id }).from(user).where(eq(user.avatarBlobId, blobId)).limit(1),
		db
			.select({ id: statementImport.id })
			.from(statementImport)
			.where(eq(statementImport.blobId, blobId))
			.limit(1)
	]);
	return hits.some((r) => r.length > 0);
}
