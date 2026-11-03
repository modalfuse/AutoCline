import type {
	RemoteEnvironmentConnection,
	RemoteEnvironmentProfile,
	RemoteEnvironmentService,
} from "@cline/core";

/**
 * AutoCline Desktop → Hub connection (v1.2 §9.3 / §9.3.1, decision t848u).
 *
 * The Desktop sidecar connects to a Hub ONLY through the stable URLs named in
 * the remote environment profile (`hubUrls[]`, or the single legacy `hubUrl`).
 * There is no SSH `-L` tunnel and no per-session random localhost forward: the
 * same model the Grok bot uses to reach hp02 (Tailscale endpoint + token).
 * When no URL answers, the connect fails and lists everything it tried.
 */

export interface HubEndpointCandidate {
	/** The URL the desktop client dials. */
	endpoint: string;
	/**
	 * The Hub URL as the remote host sees it. Differs from `endpoint` when the
	 * profile names a hostname that resolves to the same Hub.
	 */
	hubUrl: string;
}

const SUPPORTED_PROTOCOLS = new Set(["ws:", "wss:"]);

/** Normalizes one configured Hub URL, rejecting anything that is not ws(s). */
export function normalizeHubUrl(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return trimmed;
	}
	if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
		return trimmed;
	}
	return parsed.toString();
}

/**
 * The ordered URL list a profile may connect through. `hubUrls` wins; the
 * legacy single `hubUrl` is accepted so older profile files keep working.
 */
export function resolveHubUrlList(
	profile: Pick<RemoteEnvironmentProfile, "hubUrls" | "hubUrl">,
): string[] {
	const urls: string[] = [];
	for (const candidate of [...(profile.hubUrls ?? []), profile.hubUrl]) {
		const normalized = normalizeHubUrl(candidate);
		if (normalized && !urls.includes(normalized)) {
			urls.push(normalized);
		}
	}
	return urls;
}

/** True when the profile routes the session to a Hub over the network. */
export function isHubRemoteProfile(
	profile: Pick<RemoteEnvironmentProfile, "hubUrls" | "hubUrl">,
): boolean {
	return resolveHubUrlList(profile).length > 0;
}

export function describeHubEndpoints(urls: string[]): string {
	return urls.length > 0 ? urls.join(", ") : "(none configured)";
}

/**
 * Fails a Hub-mode connect with an actionable message. Called when the
 * profile names Hub URLs but the connected runtime did not publish one, or
 * when none of the URLs answered.
 */
export function hubConnectError(
	profile: Pick<RemoteEnvironmentProfile, "name">,
	urls: string[],
	detail?: string,
): Error {
	const reason = detail ? ` The last error was: ${detail}` : "";
	return new Error(
		`Could not reach the AutoCline Hub for "${profile.name}". Tried: ${describeHubEndpoints(urls)}.${reason} ` +
			"AutoCline connects to the Hub directly at the configured address (for example the host's Tailscale IP); it does not open SSH tunnels. " +
			"Check that the Hub is running, that this machine can reach that address, and that hubUrls in ~/.cline/data/settings/remote-environments.json is correct.",
	);
}

export type HubRemoteConnectResult =
	| { kind: "connected"; connection: RemoteEnvironmentConnection }
	| { kind: "not_hub_mode" }
	| { kind: "failed"; error: Error };

/**
 * Connects a remote environment profile in Hub mode (direct). Non-Hub profiles
 * (no `hubUrls`/`hubUrl`) are reported as `not_hub_mode` so the caller can
 * surface a clear error instead of silently falling back to a tunnel.
 */
export async function connectRemoteEnvironmentDirect(
	service: Pick<RemoteEnvironmentService, "connect">,
	profile: Pick<RemoteEnvironmentProfile, "name" | "hubUrls" | "hubUrl"> & {
		id: string;
	},
): Promise<HubRemoteConnectResult> {
	const urls = resolveHubUrlList(profile);
	if (urls.length === 0) {
		return { kind: "not_hub_mode" };
	}
	try {
		const connection = await service.connect(profile.id);
		if (!connection.endpoint?.trim()) {
			return {
				kind: "failed",
				error: hubConnectError(profile, urls, "no Hub endpoint was published"),
			};
		}
		return { kind: "connected", connection };
	} catch (error) {
		return {
			kind: "failed",
			error: hubConnectError(
				profile,
				urls,
				error instanceof Error ? error.message : String(error),
			),
		};
	}
}
