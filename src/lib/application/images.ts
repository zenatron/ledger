import { and, asc, eq, or } from 'drizzle-orm';
import type { Db } from '$lib/db/types';
import { purchase, purchaseImage } from '$lib/db/schema';
import { loadPurchase, visibleTo } from '$lib/repo/purchases';
import { PurchaseNotFoundError } from '$lib/application/purchases';
import { PurchaseStateError } from '$lib/domain/purchase/purchase';
import type { ImageProcessor } from '$lib/ports/image-processor';
import type { BlobStore } from '$lib/ports/blob-store';
import type { Clock } from '$lib/ports/clock';
import type { IdGenerator } from '$lib/ports/id-generator';

interface Deps {
	clock: Clock;
	ids: IdGenerator;
	blobs: BlobStore;
	images: ImageProcessor;
}

interface Scope {
	workspaceId: string;
	memberId: string;
}

async function assertOwnPurchase(db: Db, deps: Deps, scope: Scope, purchaseId: string) {
	const p = await loadPurchase(
		db,
		{ workspaceId: scope.workspaceId, viewerId: scope.memberId },
		purchaseId,
		{ now: deps.clock.now() }
	);
	if (!p) throw new PurchaseNotFoundError();
	if (p.memberId !== scope.memberId) {
		throw new PurchaseStateError('Only the requester can change photos');
	}
	return p;
}

/**
 * Validate → derive → store (content-addressed) → record. Original discarded.
 *
 * A purchase carries one photo. This replaces whatever was there: the detail
 * page only ever rendered `images[0]`, so appending produced rows that consumed
 * storage and were never visible anywhere.
 *
 * The blob itself is left in place — the store is content-addressed and
 * append-only, and the same bytes may back another purchase's photo.
 */
export async function setPurchaseImage(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string,
	upload: Uint8Array
): Promise<void> {
	await assertOwnPurchase(db, deps, scope, purchaseId);

	// Process before touching the DB: an invalid upload must not clear the
	// existing photo.
	const processed = await deps.images.processUpload(upload);
	const [display, thumb] = await Promise.all([
		deps.blobs.put(processed.display.data, 'webp'),
		deps.blobs.put(processed.thumb.data, 'webp')
	]);

	await db.transaction(async (tx) => {
		await tx.delete(purchaseImage).where(eq(purchaseImage.purchaseId, purchaseId));
		await tx.insert(purchaseImage).values({
			id: deps.ids.newId(),
			purchaseId,
			blobId: display.id,
			thumbBlobId: thumb.id,
			width: processed.display.width,
			height: processed.display.height,
			byteSize: display.byteSize,
			position: 0,
			createdAt: deps.clock.now()
		});
	});
}

export async function removePurchaseImage(
	db: Db,
	deps: Deps,
	scope: Scope,
	purchaseId: string
): Promise<void> {
	await assertOwnPurchase(db, deps, scope, purchaseId);
	await db.delete(purchaseImage).where(eq(purchaseImage.purchaseId, purchaseId));
}

/**
 * Scoped like every other read: a purchase id alone is not authorization, so
 * the workspace + seal predicate is applied here rather than trusted upstream.
 */
export async function listImages(
	db: Db,
	scope: { workspaceId: string; viewerId: string },
	purchaseId: string,
	now: Date
) {
	const rows = await db
		.select({ image: purchaseImage })
		.from(purchaseImage)
		.innerJoin(purchase, eq(purchaseImage.purchaseId, purchase.id))
		.where(
			and(
				eq(purchaseImage.purchaseId, purchaseId),
				eq(purchase.workspaceId, scope.workspaceId),
				visibleTo(scope.viewerId, now)
			)
		)
		.orderBy(asc(purchaseImage.position));
	return rows.map((r) => r.image);
}

/**
 * Blob authorization for the serving route: the blob must belong to a purchase
 * in this workspace that the viewer may see. Content-addressed paths being
 * unguessable is not authorization — this is.
 */
export async function isBlobVisible(
	db: Db,
	scope: { workspaceId: string; viewerId: string },
	blobId: string,
	now: Date
): Promise<boolean> {
	const rows = await db
		.select({ id: purchaseImage.id })
		.from(purchaseImage)
		.innerJoin(purchase, eq(purchaseImage.purchaseId, purchase.id))
		.where(
			and(
				or(eq(purchaseImage.blobId, blobId), eq(purchaseImage.thumbBlobId, blobId)),
				eq(purchase.workspaceId, scope.workspaceId),
				visibleTo(scope.viewerId, now)
			)
		)
		.limit(1);
	return rows.length > 0;
}
