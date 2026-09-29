/**
 * Tell the service worker who the cached pages belong to — the signed-in user,
 * or `null` on the sign-in screen. The worker empties its page cache whenever
 * this changes, so an offline fallback never shows one person's ledger to the
 * next. See `setPageOwner` in service-worker.ts.
 */
export function announcePageOwner(userId: string | null): void {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
	void navigator.serviceWorker.ready
		.then((reg) => reg.active?.postMessage({ type: 'page-owner', id: userId }))
		.catch(() => {
			/* no worker — nothing cached to protect */
		});
}
