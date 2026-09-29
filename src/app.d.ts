import type { SessionRow, SessionUser } from '$lib/server/auth/session';
import type { MemberRow, WorkspaceRow } from '$lib/repo/workspaces';
import type { Db } from '$lib/db/types';
import type { AppDeps } from '$lib/ports/deps';

declare global {
	/** Injected by vite `define`. True only in the static demo build. */
	const __DEMO__: boolean;
	/** Injected by vite `define`. Fingerprint of the demo's seed snapshot. */
	const __DEMO_SEED_ID__: string;

	namespace App {
		interface Locals {
			user: SessionUser | null;
			session: SessionRow | null;
			/** Set only on /w/[workspace] routes, after membership is verified. */
			workspace: WorkspaceRow | null;
			member: MemberRow | null;
			/** The composition root's output, so handlers receive their
			 *  dependencies instead of importing a specific implementation. */
			db: Db;
			deps: AppDeps;
		}
		interface Error {
			message: string;
			/** Set by handleError for unexpected failures, so the page can quote it. */
			errorId?: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
