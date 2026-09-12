import { error, fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import * as v from 'valibot';
import { getDb } from '$lib/server/db';
import { workspace } from '$lib/db/schema';
import { getGeocoder } from '$lib/infra/geocode';
import { getLlmAssist, type AssistConfig } from '$lib/infra/llm';
import { listModels } from '$lib/infra/llm/model-catalog';
import { getEnv } from '$lib/server/env';
import type { Actions, PageServerLoad } from './$types';

const ConfigSchema = v.object({
	mode: v.picklist(['off', 'local', 'external']),
	endpoint: v.optional(v.pipe(v.string(), v.trim()), ''),
	model: v.optional(v.pipe(v.string(), v.trim()), ''),
	// Blank means "keep the existing key" so it's never echoed back to the client.
	apiKey: v.optional(v.string(), '')
});

function validateEndpoint(endpoint: string): string | null {
	let u: URL;
	try {
		u = new URL(endpoint);
	} catch {
		return 'Endpoint is not a valid URL';
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Endpoint must be http or https';
	// Credentials in the URL would sit in the database and ride along on every
	// fetch; the key field is where secrets belong.
	if (u.username || u.password) return 'Put any API key in the key field, not the URL';
	// Link-local is where cloud metadata lives — the one address that turns a
	// probed endpoint into stolen credentials on a hosted deployment. Loopback
	// and the private LAN stay allowed: pointing this at an Ollama on your own
	// machine is the feature.
	if (/^169\.254\./.test(u.hostname) || u.hostname === '0.0.0.0') {
		return 'That address is not allowed';
	}
	return null;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	void params.workspace;
	const ws = locals.workspace!;
	const env = getEnv();
	return {
		isOwner: locals.member!.role === 'owner',
		// Two personal reading preferences for the Safe to Spend headline. Per
		// member, not per workspace: how discreetly you read your own number is
		// nobody else's setting.
		safeToSpendDisplay: locals.member!.safeToSpendDisplay,
		showRunwayMonths: locals.member!.showRunwayMonths,
		billImportEnabled: ws.billImportEnabled,
		barcodeEnabled: ws.barcodeEnabled,
		barcodeConfigured: !!env.BARCODE_LOOKUP_URL,
		locationEnabled: ws.locationEnabled,
		// Reported separately because they fail separately: a deployment can have
		// streets and no address search, or the reverse, and the card says which.
		tileConfigured: !!env.MAP_TILE_URL,
		tileAttribution: env.MAP_TILE_ATTRIBUTION,
		geocoderConfigured: !!env.GEOCODER_URL,
		// Owner-only: it's an internal address, and it's the first thing that's
		// wrong when address search silently finds nothing.
		geocoderEndpoint: locals.member!.role === 'owner' ? (env.GEOCODER_URL ?? null) : null,
		config: {
			mode: ws.aiMode,
			endpoint: ws.aiEndpoint ?? '',
			model: ws.aiModel ?? '',
			// Never send the key itself — only whether one is stored.
			apiKeySet: !!ws.aiApiKey
		}
	};
};

/** Resolve the config a form submission describes, keeping the stored key if blank. */
function configFromForm(
	out: v.InferOutput<typeof ConfigSchema>,
	stored: { aiApiKey: string | null }
): AssistConfig {
	return {
		aiMode: out.mode,
		aiEndpoint: out.endpoint || null,
		aiModel: out.model || null,
		aiApiKey: out.apiKey ? out.apiKey : stored.aiApiKey
	};
}

export const actions: Actions = {
	save: async ({ locals, request }) => {
		if (locals.member!.role !== 'owner')
			error(403, 'Only the owner can change intelligence settings');
		const parsed = v.safeParse(ConfigSchema, Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const out = parsed.output;

		if (out.mode !== 'off') {
			if (!out.endpoint) return fail(400, { error: 'An endpoint URL is required' });
			const bad = validateEndpoint(out.endpoint);
			if (bad) return fail(400, { error: bad });
			if (!out.model) return fail(400, { error: 'A model name is required' });
		}

		const db = getDb();
		const cfg = configFromForm(out, { aiApiKey: locals.workspace!.aiApiKey });
		await db
			.update(workspace)
			.set({
				aiMode: cfg.aiMode,
				aiEndpoint: cfg.aiEndpoint,
				aiModel: cfg.aiModel,
				// Off clears the key so a disabled provider leaves nothing sensitive behind.
				aiApiKey: cfg.aiMode === 'off' ? null : cfg.aiApiKey
			})
			.where(eq(workspace.id, locals.workspace!.id));
		return { ok: true };
	},

	/**
	 * Ask the geocoder how it is, and optionally whether it knows a place.
	 *
	 * The only route in the app that reports a geocoder failure out loud. Every
	 * other caller is a person recording a purchase, for whom "off", "still
	 * importing" and "that address isn't in the extract" are all correctly the
	 * same empty answer. An operator needs them apart, and this is where they
	 * get told — including, crucially, that an import in progress and a
	 * container that never started look identical from here.
	 */
	checkGeocoder: async ({ locals, request }) => {
		if (locals.member!.role !== 'owner') error(403, 'Only the owner can check the geocoder');
		const env = getEnv();
		const fields = Object.fromEntries(await request.formData());
		const probe = typeof fields.probe === 'string' ? fields.probe.slice(0, 200) : '';
		const geocoder = getGeocoder({ endpoint: env.GEOCODER_URL, email: env.GEOCODER_EMAIL });
		return { geocoder: await geocoder.checkHealth(probe) };
	},

	/** Ping the endpoint described by the form (unsaved), so it can be checked first. */
	test: async ({ locals, request }) => {
		if (locals.member!.role !== 'owner')
			error(403, 'Only the owner can test intelligence settings');
		const fields = Object.fromEntries(await request.formData());
		const refresh = fields.refresh === 'true';
		const parsed = v.safeParse(ConfigSchema, fields);
		if (!parsed.success) return fail(400, { error: parsed.issues[0].message });
		const out = parsed.output;
		if (out.mode === 'off')
			return { test: { ok: false, detail: 'Turn a provider on to test it.' } };
		if (!out.endpoint) {
			return { test: { ok: false, detail: 'Fill in the endpoint first.' } };
		}
		const bad = validateEndpoint(out.endpoint);
		if (bad) return fail(400, { error: bad });

		// For local Ollama, the connection test is the model list itself: if we can
		// reach /api/tags, the endpoint is good and we can offer the models with
		// what each one can do. The user hasn't picked a model yet at this step.
		//
		// `refresh` is the user saying "I just pulled something" — it drops the
		// cached capabilities for this endpoint so they're established again.
		// Without it a repeat test re-lists but asks about nothing, which is the
		// point of caching against each model's own stamp.
		if (out.mode === 'local') {
			let base: string;
			try {
				const u = new URL(out.endpoint);
				base = `${u.protocol}//${u.host}`;
			} catch {
				return { test: { ok: false, detail: 'Endpoint is not a valid URL' } };
			}
			try {
				const { models, capabilitiesUnavailable } = await listModels(base, { refresh });
				return {
					test: {
						ok: true,
						detail:
							models.length === 0
								? 'Connected, but no models found.'
								: capabilitiesUnavailable
									? 'Connected. This Ollama is too old to report what its models can do.'
									: 'Connected.',
						models
					}
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : 'Could not reach Ollama';
				return {
					test: {
						ok: false,
						// Connection and status errors are operator-useful and say
						// nothing about the target. A JSON parse error, though, quotes
						// a slice of whatever answered — for a mistyped internal
						// address that is a read primitive, so it gets a fixed line.
						detail: /json/i.test(msg) ? 'That endpoint answered, but not with a model list.' : msg
					}
				};
			}
		}

		// External provider: we need a model to test against.
		if (!out.model) {
			return { test: { ok: false, detail: 'Fill in the model first.' } };
		}
		const assist = getLlmAssist(configFromForm(out, { aiApiKey: locals.workspace!.aiApiKey }));
		const result = await assist.ping();
		return { test: result };
	}
};
