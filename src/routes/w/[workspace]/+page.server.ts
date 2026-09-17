import { isRedirect } from '@sveltejs/kit';
import { bindActions, bindLoad } from '$lib/server/bind';
import { audit } from '$lib/server/audit';
import * as h from './handlers';
import type { Actions } from './$types';

export const load = bindLoad(h.load);

const bound = bindActions(h.actions);

export const actions = {
	...bound,
	// Success is a redirect, so that is what marks the deletion as done. The
	// log has no foreign keys, so this row outlives the workspace it names.
	deleteWorkspace: async (event) => {
		const ws = event.locals.workspace!;
		try {
			return await bound.deleteWorkspace(event);
		} catch (e) {
			if (isRedirect(e)) {
				await audit(event, {
					action: 'workspace.deleted',
					detail: { name: ws.name, slug: ws.slug }
				});
			}
			throw e;
		}
	}
} satisfies Actions;
