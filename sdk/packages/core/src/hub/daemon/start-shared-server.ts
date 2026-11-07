import { resolveClineBuildEnv } from "@cline/shared";
import { resolveHubEndpointOptions } from "../discovery/defaults";
import { resolveHubListenConfig } from "../discovery/hub-config";
import {
	resolveProductionHubOwnerContext,
	resolveSharedHubOwnerContext,
} from "../discovery/workspace";
import {
	type EnsuredHubWebSocketServerResult,
	type EnsureHubWebSocketServerOptions,
	ensureHubWebSocketServer,
	type HubWebSocketServer,
	type HubWebSocketServerOptions,
	startHubWebSocketServer,
} from "../server";

export type HubServer = HubWebSocketServer;
export type EnsureHubServerResult = EnsuredHubWebSocketServerResult;

export interface StartHubServerOptions
	extends Omit<HubWebSocketServerOptions, "owner"> {}

export interface EnsureHubServerOptions
	extends Omit<EnsureHubWebSocketServerOptions, "owner"> {}

function resolveDefaultHubOwnerContext() {
	return resolveClineBuildEnv() === "production"
		? resolveProductionHubOwnerContext()
		: resolveSharedHubOwnerContext();
}

function shouldAllowDefaultPortFallback(hasExplicitPort: boolean): boolean {
	return resolveClineBuildEnv() !== "production" && !hasExplicitPort;
}

/**
 * Start a hub WebSocket server bound to the default owner context for the
 * current build environment. Callers that need a custom owner should invoke
 * {@link startHubWebSocketServer} directly.
 */
export async function startHubServer(
	options: StartHubServerOptions,
): Promise<HubServer> {
	const endpoint = resolveHubEndpointOptions({
		host: options.host,
		port: options.port,
		pathname: options.pathname,
	});
	// Resolve from `~/.config/cline/hub.json` when the caller did not pass a
	// list, so an in-process Hub binds the same addresses as a daemon does.
	const listenHosts =
		options.listenHosts && options.listenHosts.length > 0
			? options.listenHosts
			: resolveHubListenConfig({
					defaultPort: endpoint.port,
					defaultPathname: endpoint.pathname,
				}).hosts;
	return await startHubWebSocketServer({
		...options,
		...endpoint,
		listenHosts,
		owner: resolveDefaultHubOwnerContext(),
	});
}

/**
 * Ensure a hub WebSocket server is running in the default owner context for the
 * current build environment, reusing a compatible in-process instance when available.
 */
export async function ensureHubServer(
	options: EnsureHubServerOptions,
): Promise<EnsureHubServerResult> {
	const hasExplicitPort =
		options.port !== undefined || !!process.env.CLINE_HUB_PORT?.trim();
	const endpoint = resolveHubEndpointOptions({
		host: options.host,
		port: options.port,
		pathname: options.pathname,
	});
	const listenHosts =
		options.listenHosts && options.listenHosts.length > 0
			? options.listenHosts
			: resolveHubListenConfig({
					defaultPort: endpoint.port,
					defaultPathname: endpoint.pathname,
				}).hosts;
	return await ensureHubWebSocketServer({
		...options,
		...endpoint,
		listenHosts,
		allowPortFallback:
			options.allowPortFallback ??
			shouldAllowDefaultPortFallback(hasExplicitPort),
		owner: resolveDefaultHubOwnerContext(),
	});
}
