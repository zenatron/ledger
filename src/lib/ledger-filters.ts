/**
 * The ledger's filter vocabulary, shared by the page that reads it and the
 * analytics page that writes it into drill-through links. Both sides import
 * these so a rename can't silently break the hand-off.
 */

/**
 * `category=none` means "has no category" — the rows analytics shows as
 * "Other". A plain id can't express absence, and an empty param already means
 * "no category filter at all".
 */
export const NO_CATEGORY = 'none';

export interface LedgerLinkParams {
	/** Inclusive calendar dates, YYYY-MM-DD. */
	from?: string;
	to?: string;
	/** A category id, or NO_CATEGORY. */
	category?: string | null;
	member?: string;
	/** Only charges a recurring rule made. */
	recurring?: boolean;
	/**
	 * A geographic window, as `minLat,minLng,maxLat,maxLng` in millidegrees —
	 * the same integers the columns hold, so the link carries no precision the
	 * data doesn't have. Written by the map and the "By place" rows.
	 */
	bbox?: { minLatE3: number; minLngE3: number; maxLatE3: number; maxLngE3: number };
}

/** Serialize a bbox for the URL. Integers only, comma-separated, in this order. */
export function bboxParam(b: NonNullable<LedgerLinkParams['bbox']>): string {
	return `${b.minLatE3},${b.minLngE3},${b.maxLatE3},${b.maxLngE3}`;
}

/** Parse one back, or null for anything malformed. */
export function parseBboxParam(s: string | null): LedgerLinkParams['bbox'] | null {
	if (!s) return null;
	const parts = s.split(',');
	if (parts.length !== 4) return null;
	const n = parts.map(Number);
	if (!n.every((x) => Number.isInteger(x))) return null;
	const [minLatE3, minLngE3, maxLatE3, maxLngE3] = n;
	if (minLatE3 > maxLatE3 || minLngE3 > maxLngE3) return null;
	if (Math.abs(minLatE3) > 90_000 || Math.abs(maxLatE3) > 90_000) return null;
	if (Math.abs(minLngE3) > 180_000 || Math.abs(maxLngE3) > 180_000) return null;
	return { minLatE3, minLngE3, maxLatE3, maxLngE3 };
}

/**
 * Build a link into the ledger showing the rows behind an analytics figure.
 *
 * Always pins basis=spend: analytics figures are sums of completed spending, so
 * the ledger has to read the window the same way or the rows won't add up to
 * the number that was tapped.
 */
export function ledgerLink(slug: string, params: LedgerLinkParams): string {
	const q = new URLSearchParams();
	if (params.from) q.set('from', params.from);
	if (params.to) q.set('to', params.to);
	if (params.category !== undefined) q.set('category', params.category ?? NO_CATEGORY);
	if (params.member) q.set('member', params.member);
	if (params.recurring) q.set('recurring', '1');
	if (params.bbox) q.set('bbox', bboxParam(params.bbox));
	q.set('basis', 'spend');
	return `/w/${slug}/purchases?${q}`;
}
