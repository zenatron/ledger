import { env as rawEnv } from '$env/dynamic/private';
import * as v from 'valibot';
import { isPublicNominatim } from '$lib/infra/geocode/public';

/**
 * Boot-time env validation. Parse, don't validate: everything downstream
 * imports the parsed object, never process.env. Fails loudly with every
 * problem listed, not just the first.
 *
 * Vars for later phases (OIDC, VAPID, ntfy) are optional here and become
 * required in the phase that ships the feature.
 */
const EnvSchema = v.pipe(
	v.object({
		DATABASE_URL: v.pipe(v.string(), v.regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')),
		BLOB_DIR: v.optional(v.pipe(v.string(), v.nonEmpty()), './data/blobs'),
		PUBLIC_ORIGIN: v.optional(v.pipe(v.string(), v.url()), 'http://localhost:5173'),
		MIGRATIONS_DIR: v.optional(v.pipe(v.string(), v.nonEmpty()), './drizzle'),

		// Dev mode — skips OIDC, auto-creates test user
		DEV_MODE: v.optional(v.pipe(v.string(), v.transform(JSON.parse), v.boolean()), 'false'),
		DEV_USER_NAME: v.optional(v.string(), 'Dev User'),
		DEV_USER_EMAIL: v.optional(v.string(), 'dev@test.local'),

		// Phase 1 — Pocket ID OIDC
		POCKET_ID_ISSUER: v.optional(v.pipe(v.string(), v.url())),
		POCKET_ID_CLIENT_ID: v.optional(v.string()),
		POCKET_ID_CLIENT_SECRET: v.optional(v.string()),
		OIDC_REDIRECT_URI: v.optional(v.pipe(v.string(), v.url())),
		OIDC_SCOPES: v.optional(v.string(), 'openid profile email'),

		// Phase 5 — push
		VAPID_PUBLIC_KEY: v.optional(v.string()),
		VAPID_PRIVATE_KEY: v.optional(v.string()),
		VAPID_SUBJECT: v.optional(v.string()),
		NTFY_SERVER_URL: v.optional(v.pipe(v.string(), v.url())),
		NTFY_DEFAULT_TOKEN: v.optional(v.string()),

		// Phase 6 — barcode product lookup
		BARCODE_LOOKUP_URL: v.optional(v.pipe(v.string(), v.url())),

		/*
		 * Phase 7 — places.
		 *
		 * Every one of these is optional, and the feature is fully usable with none
		 * of them set: device capture, offline map-link parsing, the "By place"
		 * breakdown and the map itself all work unconfigured. These only add streets
		 * and address search.
		 */
		/** Nominatim-compatible geocoder base URL — the public instance at
		 *  https://nominatim.openstreetmap.org or one you host. Called by the server,
		 *  never the browser, so `connect-src 'self'` is untouched. */
		GEOCODER_URL: v.optional(v.pipe(v.string(), v.url())),
		/** Contact address for the geocoder's User-Agent. The public Nominatim
		 *  instance requires one and blocks anonymous clients. */
		GEOCODER_EMAIL: v.optional(v.string()),
		/**
		 * Raster tile template, e.g. https://tile.openstreetmap.org/{z}/{x}/{y}.png.
		 * Fetched server-side and re-served from our own origin, which is what keeps
		 * both `img-src` and `connect-src` at 'self'.
		 */
		MAP_TILE_URL: v.optional(
			v.pipe(
				v.string(),
				v.url(),
				// Not cosmetic. The tile route interpolates z/x/y into this string; a
				// template with no placeholders would turn it into a proxy pointed at
				// one fixed third-party URL, which is not what anyone set this to do.
				v.check(
					(u) => u.includes('{z}') && u.includes('{x}') && u.includes('{y}'),
					'must contain {z}, {x} and {y}'
				)
			)
		),
		/** Printed under the map. OSM's licence requires visible credit, so this is
		 *  rendered as a permanent caption rather than hidden behind a tap. */
		MAP_TILE_ATTRIBUTION: v.optional(v.string(), '© OpenStreetMap contributors'),
		/** Disposable third-party bytes. Deliberately outside BLOB_DIR so backups
		 *  don't carry hundreds of megabytes of somebody else's map; safe to delete. */
		TILE_CACHE_DIR: v.optional(v.pipe(v.string(), v.nonEmpty()), './data/tiles')
	}),
	/*
	 * The public instance blocks clients it can't identify, and the adapter would
	 * otherwise send "no contact configured" and find out one search at a time —
	 * every one of them "Nothing found". Refusing to boot names the fix instead.
	 */
	v.forward(
		v.partialCheck(
			[['GEOCODER_URL'], ['GEOCODER_EMAIL']],
			(e) => !isPublicNominatim(e.GEOCODER_URL) || !!e.GEOCODER_EMAIL?.trim(),
			'is required when GEOCODER_URL is the public Nominatim instance, whose usage policy blocks anonymous clients'
		),
		['GEOCODER_EMAIL']
	)
);

export type Env = v.InferOutput<typeof EnvSchema>;

let cached: Env | undefined;

/** Lazy so importing this module during `vite build` doesn't require a full env. */
export function getEnv(): Env {
	if (cached) return cached;
	// Empty string means unset (compose interpolation defaults produce "").
	const present = Object.fromEntries(Object.entries(rawEnv).filter(([, val]) => val !== ''));
	const result = v.safeParse(EnvSchema, present);
	if (!result.success) {
		const problems = result.issues
			.map((issue) => `  ${issue.path?.map((p) => p.key).join('.') ?? '(root)'}: ${issue.message}`)
			.join('\n');
		throw new Error(`Invalid environment:\n${problems}`);
	}
	cached = result.output;
	return cached;
}
