import { isConcealedFrom } from '$lib/domain/visibility/seal';

/**
 * In-process pub/sub for SSE. Single app container — no Redis, no queue.
 * Seal filtering happens here, per subscriber: a concealed member's stream
 * simply never carries the event.
 */

export interface WorkspaceEvent {
	type: 'purchase';
	purchaseId: string;
	sealedUntil: Date | null;
	sealedFromMemberIds: string[];
}

interface Subscriber {
	memberId: string;
	send: (json: string) => void;
}

const subscribers = new Map<string, Set<Subscriber>>();

export function subscribe(workspaceId: string, subscriber: Subscriber): () => void {
	let set = subscribers.get(workspaceId);
	if (!set) {
		set = new Set();
		subscribers.set(workspaceId, set);
	}
	set.add(subscriber);
	return () => {
		set.delete(subscriber);
		if (set.size === 0) subscribers.delete(workspaceId);
	};
}

export function publish(workspaceId: string, event: WorkspaceEvent, now: Date): void {
	const set = subscribers.get(workspaceId);
	if (!set) return;
	const payload = JSON.stringify({ type: event.type, id: event.purchaseId });
	for (const sub of set) {
		if (isConcealedFrom(event, sub.memberId, now)) continue;
		try {
			sub.send(payload);
		} catch {
			// Dead stream. The abort handler normally unsubscribes, but it may
			// never fire (aborted socket, no close event) — drop it here too so
			// the set can't grow without bound.
			set.delete(sub);
		}
	}
	if (set.size === 0) subscribers.delete(workspaceId);
}

/**
 * "Something in this workspace changed" — for writes that aren't purchases: a
 * bucket topped up, income added, a budget or a recurring plan edited. They
 * carry nothing sealable, so every member's stream gets them; the client only
 * ever treats a message as a cue to reload what it is showing.
 *
 * Never used for a purchase write: those go through `publish`, whose seal
 * filter keeps even the timing of a change to a sealed purchase away from the
 * person it is hidden from.
 */
export function publishChange(workspaceId: string): void {
	const set = subscribers.get(workspaceId);
	if (!set) return;
	const payload = JSON.stringify({ type: 'workspace' });
	for (const sub of set) {
		try {
			sub.send(payload);
		} catch {
			set.delete(sub);
		}
	}
	if (set.size === 0) subscribers.delete(workspaceId);
}
