export function formatPct(pct: number): string {
	if (pct >= 1_000_000) {
		return (pct / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M%';
	}
	if (pct >= 1000) {
		return (pct / 1000).toFixed(1).replace(/\.0$/, '') + 'k%';
	}
	return pct.toFixed(0) + '%';
}

/**
 * Bytes at photo scale: whole KB under a megabyte, one decimal of MB above,
 * plain bytes below a KB. For captions ("67 KB") — the exact count lives in
 * the database and nobody reads a 50960-byte photo described that way.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	if (bytes < 1_000_000) {
		return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0).replace(/\.0$/, '')} KB`;
	}
	return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`;
}
