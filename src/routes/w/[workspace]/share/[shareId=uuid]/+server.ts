import { bindEndpoint } from '$lib/server/bind';
import * as h from './handlers';

export const GET = bindEndpoint(h.GET);
