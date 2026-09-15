import { bindActions, bindLoad } from '$lib/server/bind';
import * as h from './handlers';
import { actions as recurring } from '../recurring/handlers';

export const load = bindLoad(h.load);
// A bill in the day sheet is a recurring rule. Pausing or ending it from here is
// the same action as on the Recurring page, with the same ownership check.
export const actions = bindActions({ pause: recurring.pause, end: recurring.end });
