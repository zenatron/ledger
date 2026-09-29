import { bindActions, bindLoad } from '$lib/server/bind';
import * as h from './handlers';

export const load = bindLoad(h.load);
export const actions = bindActions(h.actions);
