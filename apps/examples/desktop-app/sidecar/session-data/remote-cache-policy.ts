import type { RemoteCacheSnapshot } from "./remote-cache";

// Stale-while-revalidate policy for remote session transcripts.
//
// Kept free of I/O and Hub clients so the decision logic can be unit tested
// directly (and re-used by both the read_session_messages command and the
// chat-session handleStart path).

/** Refresh a warm snapshot in the background at most once per this window. */
export const REMOTE_CACHE_REFRESH_MIN_INTERVAL_MS = 5_000;

export type RemoteCacheReadPlan =
	/** No usable cache — the caller must await the Hub. */
	| { mode: "miss" }
	/** Cache is fresh enough that a Hub round-trip can be skipped entirely. */
	| { mode: "fresh"; snapshot: RemoteCacheSnapshot }
	/** Serve the snapshot now, kick a background Hub refresh. */
	| { mode: "stale"; snapshot: RemoteCacheSnapshot };

export type RemoteCacheRevalidateOutcome =
	/** Hub returned the same transcript the cache already holds. */
	| { changed: false; snapshot: RemoteCacheSnapshot }
	/** Hub returned a different transcript; write it and republish to the UI. */
	| { changed: true; snapshot: RemoteCacheSnapshot };

export function isRemoteCacheFresh(
	snapshot: Pick<RemoteCacheSnapshot, "fetchedAt">,
	now: number,
	maxAgeMs: number,
): boolean {
	if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;
	const fetchedAt = snapshot.fetchedAt;
	if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return false;
	// Clock skew (a cache written "in the future" by a previous run) must not
	// pin the entry as fresh forever.
	const age = now - fetchedAt;
	return age >= 0 && age < maxAgeMs;
}

export function planRemoteCacheRead(
	snapshot: RemoteCacheSnapshot | undefined,
	now: number,
	options: {
		/** Serve without any Hub round-trip when the snapshot is this young. */
		maxAgeMs?: number;
	},
): RemoteCacheReadPlan {
	if (!snapshot) return { mode: "miss" };
	const maxAgeMs = options.maxAgeMs ?? 0;
	return isRemoteCacheFresh(snapshot, now, maxAgeMs)
		? { mode: "fresh", snapshot }
		: { mode: "stale", snapshot };
}

/**
 * Compare a Hub response with the cached snapshot.
 *
 * `updatedAt` from the Hub is preferred when present because both sides agree
 * on it; otherwise the content hash decides. A hash change on an identical
 * message list is still a real change (e.g. metadata rewrites), so it wins.
 */
export function revalidateRemoteCache(
	cached: RemoteCacheSnapshot | undefined,
	incoming: {
		messages: unknown[];
		hash: string;
		updatedAt?: number;
	},
): RemoteCacheRevalidateOutcome {
	if (!cached) {
		return {
			changed: true,
			snapshot: {
				environmentId: "",
				sessionId: "",
				messages: incoming.messages,
				updatedAt: incoming.updatedAt ?? 0,
				fetchedAt: 0,
				source: "hub:readMessages",
				messageCount: incoming.messages.length,
				hash: incoming.hash,
			},
		};
	}
	const hubUpdatedAt = incoming.updatedAt;
	const changed =
		incoming.hash !== cached.hash ||
		(typeof hubUpdatedAt === "number" &&
			Number.isFinite(hubUpdatedAt) &&
			hubUpdatedAt > cached.updatedAt);
	return {
		changed,
		snapshot: changed
			? {
					...cached,
					messages: incoming.messages,
					messageCount: incoming.messages.length,
					hash: incoming.hash,
					updatedAt: hubUpdatedAt ?? cached.updatedAt,
					fetchedAt: cached.fetchedAt,
				}
			: cached,
	};
}
