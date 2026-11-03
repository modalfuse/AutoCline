import {
	hashRemoteMessages,
	readRemoteCache,
	writeRemoteCache,
} from "./remote-cache";
import {
	planRemoteCacheRead,
	revalidateRemoteCache,
} from "./remote-cache-policy";

// Glue between the pure SWR policy and the on-disk remote cache. The Hub side
// is injected so both call sites (read_session_messages and handleStart) share
// one definition of "serve cache now, refresh in background".

/** Minimum shape of the remote session manager this module needs. */
export type RemoteMessagesReader = {
	readMessages: (sessionId: string) => Promise<unknown[]>;
};

export type RemoteSessionSwaOptions = {
	environmentId: string;
	sessionId: string;
	/**
	 * Serve the cached transcript without any Hub round-trip when it was
	 * fetched within this window. `0`/omitted always revalidates in the
	 * background (the default SWR behaviour).
	 */
	maxAgeMs?: number;
	/** Hub-side transcript read; called off the critical path. */
	fetchMessages: RemoteMessagesReader["readMessages"];
	/** Called once a background refresh finds newer Hub content. */
	onRefreshed?: (messages: unknown[], meta: { updatedAt: number }) => void;
	/** Only `error` is used; a BasicLogger from @cline/core satisfies this. */
	logger?: {
		error?: (message: string, metadata?: never) => void;
	};
	now?: () => number;
};

export type RemoteSessionSwaResult = {
	messages: unknown[];
	/** True when the returned messages came from disk, not from the Hub. */
	fromCache: boolean;
	/** Resolves when any background refresh finished. */
	refresh: Promise<boolean>;
};

/**
 * Stale-while-revalidate read of one remote session's transcript.
 *
 * Warm cache: returns the cached messages synchronously and revalidates
 * against the Hub in the background; newer content is persisted and handed to
 * `onRefreshed` so the webview can be republished.
 * Cold cache: awaits the Hub, then populates the cache for the next open.
 */
export async function readRemoteSessionSwa(
	options: RemoteSessionSwaOptions,
): Promise<RemoteSessionSwaResult> {
	const now = options.now ?? Date.now;
	const environmentId = options.environmentId.trim();
	const sessionId = options.sessionId.trim();
	const cached =
		environmentId && sessionId
			? readRemoteCache(environmentId, sessionId)
			: undefined;
	const plan = planRemoteCacheRead(cached, now(), {
		maxAgeMs: options.maxAgeMs,
	});

	if (plan.mode === "fresh") {
		return {
			messages: plan.snapshot.messages,
			fromCache: true,
			refresh: Promise.resolve(false),
		};
	}

	if (plan.mode === "stale") {
		return {
			messages: plan.snapshot.messages,
			fromCache: true,
			refresh: revalidate(options),
		};
	}

	// Cold cache: Hub is authoritative but a failed/slow fetch must not block
	// the UI indefinitely. Race the fetch with a timeout so large transcripts
	// over flaky DERP can render empty initially, then persist + republish when
	// the in-flight fetch completes. The fetch promise is NOT cancelled on timeout.
	const fetchTimeout = 8000; // Raised from 3s; large sessions (1.6MB) need more headroom.
	const fetchPromise = options.fetchMessages(sessionId);
	const timeoutPromise = new Promise<never>((_, reject) =>
		setTimeout(
			() => reject(new Error("Hub message fetch timed out")),
			fetchTimeout,
		),
	);

	try {
		const messages = await Promise.race([fetchPromise, timeoutPromise]);
		persist(options, messages);
		return { messages, fromCache: false, refresh: Promise.resolve(false) };
	} catch (error) {
		// Timeout: return empty NOW so UI unblocks, but keep the fetch alive in the
		// background. If it succeeds, persist to cache and optionally republish.
		const isTimeout =
			error instanceof Error && error.message.includes("timed out");
		if (isTimeout) {
			options.logger?.error?.(
				"Hub message fetch timed out; returning empty, fetch continues in background",
				{ environmentId, sessionId, fetchTimeout } as never,
			);
			// Keep the fetch promise alive; persist on late success.
			const backgroundRefresh = fetchPromise
				.then((messages) => {
					persist(options, messages);
					// Notify caller so webview can republish cached messages.
					options.onRefreshed?.(messages, { updatedAt: Date.now() });
					return true;
				})
				.catch(() => false);
			return { messages: [], fromCache: false, refresh: backgroundRefresh };
		}
		// Non-timeout error (Hub RPC failure, network down): return empty.
		options.logger?.error?.(
			"Remote session fetch failed; returning empty messages",
			{ environmentId, sessionId, error } as never,
		);
		return { messages: [], fromCache: false, refresh: Promise.resolve(false) };
	}
}

function persist(
	options: RemoteSessionSwaOptions,
	messages: unknown[],
): boolean {
	if (!options.environmentId.trim() || !options.sessionId.trim()) return false;
	return Boolean(
		writeRemoteCache(options.environmentId, options.sessionId, messages, {
			source: "hub:readMessages",
		}),
	);
}

async function revalidate(options: RemoteSessionSwaOptions): Promise<boolean> {
	try {
		const incoming = await options.fetchMessages(options.sessionId);
		const cached = readRemoteCache(options.environmentId, options.sessionId);
		const outcome = revalidateRemoteCache(cached, {
			messages: incoming,
			hash: hashRemoteMessages(incoming),
		});
		if (!outcome.changed) return false;
		const meta = writeRemoteCache(
			options.environmentId,
			options.sessionId,
			incoming,
			{ source: "hub:readMessages:revalidate" },
		);
		options.onRefreshed?.(incoming, {
			updatedAt: meta?.updatedAt ?? Date.now(),
		});
		return true;
	} catch (error) {
		// A failed revalidation leaves the stale-but-usable cache in place.
		options.logger?.error?.("Remote session cache refresh failed", {
			environmentId: options.environmentId,
			sessionId: options.sessionId,
			error,
		} as never);
		return false;
	}
}

/** Narrow helper so callers can pass a ClineCore-like manager directly. */
export function readerOf(manager: RemoteMessagesReader): RemoteMessagesReader {
	return {
		readMessages: (sessionId: string) => manager.readMessages(sessionId),
	};
}
