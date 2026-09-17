import { bindEndpoint } from '$lib/server/bind';
import { audit } from '$lib/server/audit';
import * as h from './handlers';
import type { RequestHandler } from './$types';

const post = bindEndpoint(h.POST);

// The handler is shared with the demo build, which has no log to write to, so
// the audit wraps it here: read the flag before the handler consumes the body,
// record it only once the change has landed.
export const POST: RequestHandler = async (event) => {
	const body = await event.request
		.clone()
		.json()
		.catch(() => null);
	const res = await post(event);
	if (res.ok) {
		await audit(event, {
			action: 'workspace.settings_changed',
			detail: { flag: String(body?.flag), value: body?.value === true }
		});
	}
	return res;
};
