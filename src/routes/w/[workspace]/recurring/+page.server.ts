import { bindActions, bindLoad } from '$lib/server/bind';
import * as h from './handlers';

export const load = bindLoad(h.load);
// No purchase is written here, so a change can be announced to everyone.
export const actions = bindActions(h.actions, { announce: true });
