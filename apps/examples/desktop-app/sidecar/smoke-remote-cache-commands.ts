import { connectRemoteSessionRuntime, getSidecarContextOwner } from "./context";
import { remoteCacheDir } from "./session-data/remote-cache";
import type { SidecarContext } from "./types";

// ---------------------------------------------------------------------------
// Smoke-only RPCs for scripts/smoke-remote-cache-live.ts
// ---------------------------------------------------------------------------
//
// The live smoke test needs to exercise the real `read_session_messages`
// remote branch against the local Hub without a real SSH host. These hooks let
// the script register a synthetic SSH runtime bound to the local Hub and then
// take the Hub away, so the "warm cache answers with the Hub unreachable"
// property can be observed end to end.
//
// Everything here is inert unless CLINE_SMOKE_REMOTE_CACHE=1.

export const SMOKE_REMOTE_CACHE_ENV = "CLINE_SMOKE_REMOTE_CACHE";

export type SmokeRemoteCacheHooks = {
	bindRemoteEnvironment: (args: {
		environmentId: string;
		endpoint: string;
		workspaceRoot: string;
		sessionIds: string[];
	}) => Promise<{ bound: number }>;
	setRemoteHubReachable: (args: {
		environmentId: string;
		reachable: boolean;
	}) => Promise<{ reachable: boolean }>;
	appendHubMessage: (args: {
		environmentId: string;
		sessionId: string;
		text: string;
	}) => Promise<{ ok: boolean }>;
	waitForRefresh: (args: {
		environmentId: string;
		sessionId: string;
		timeoutMs?: number;
	}) => Promise<{ refreshed: boolean; cachedAt?: number }>;
	remoteCachePath: (args: { environmentId: string; sessionId: string }) => {
		path: string;
	};
};

/**
 * Replace a binding's Hub client/session manager with a wrapper that can be
 * made unreachable mid-test while still speaking the real protocol when up.
 */
type Simulation = {
	reachable: boolean;
	refreshed: boolean;
	cachedAt?: number;
	/** Hub replies captured while `reachable` was true, per session. */
	lastReplies: Map<string, unknown[]>;
};

// handleCommand re-scopes `ctx` to the requested environment before dispatch,
// so the hooks are a single owner-bound instance instead of a per-context map.
const simulations = new WeakMap<SidecarContext, Map<string, Simulation>>();
let hooksOwner: SidecarContext | undefined;

// Commands run against the per-environment sidecar context, while the runtime
// bindings live on the owning context, so always resolve through the owner.
function simulationFor(
	ctx: SidecarContext,
	environmentId: string,
): Simulation | undefined {
	return simulations
		.get(hooksOwner ?? getSidecarContextOwner(ctx))
		?.get(environmentId);
}

function setSimulation(
	ctx: SidecarContext,
	environmentId: string,
	simulation: Simulation,
): void {
	const owner = hooksOwner ?? getSidecarContextOwner(ctx);
	const byEnvironment = simulations.get(owner) ?? new Map<string, Simulation>();
	byEnvironment.set(environmentId, simulation);
	simulations.set(owner, byEnvironment);
}

export function createSmokeRemoteCacheHooks(
	ctx: SidecarContext,
): SmokeRemoteCacheHooks {
	return {
		async bindRemoteEnvironment(args) {
			const simulation: Simulation = {
				reachable: true,
				refreshed: false,
				lastReplies: new Map(),
			};
			setSimulation(ctx, args.environmentId, simulation);
			const binding = await connectRemoteSessionRuntime(ctx, {
				profile: {
					id: args.environmentId,
					name: `AutoCline smoke (${args.environmentId})`,
					host: new URL(args.endpoint).host.replace(/:\d+$/, ""),
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				profileId: args.environmentId,
				state: "connected",
				endpoint: args.endpoint,
				authToken: "",
				workspaceRoot: args.workspaceRoot,
				homeDir: args.workspaceRoot,
				platform: "linux",
				arch: "x64",
				remoteHubUrl: args.endpoint,
				localPort: Number(new URL(args.endpoint).port) || 25463,
				connectedAt: new Date().toISOString(),
			});

			// Route every Hub command through the simulation so `reachable: false`
			// behaves exactly like a dropped remote host (transport timeout).
			const baseCommand = binding.hubClient.command.bind(binding.hubClient);
			binding.hubClient.command = (async (
				command: string,
				payload?: Record<string, unknown>,
			) => {
				if (!simulation.reachable) {
					throw Object.assign(new Error("hub_command_timeout"), {
						code: "hub_command_timeout",
					});
				}
				const reply = await baseCommand(command as never, payload);
				const target = String(payload?.sessionId ?? "");
				const messages = (
					reply as unknown as { result?: { messages?: unknown[] } }
				).result?.messages;
				if (target && Array.isArray(messages)) {
					simulation.lastReplies.set(target, messages);
				}
				return reply;
			}) as typeof binding.hubClient.command;

			// Observe the remote manager's own transcript reads so the script can
			// tell when a background revalidation has run.
			const baseRead = binding.sessionManager.readMessages.bind(
				binding.sessionManager,
			);
			binding.sessionManager.readMessages = (async (sessionId: string) => {
				const messages = await baseRead(sessionId);
				simulation.lastReplies.set(sessionId, messages);
				if (JSON.stringify(messages).includes("post-cache hub update")) {
					simulation.refreshed = true;
					simulation.cachedAt = Date.now();
				}
				return messages;
			}) as typeof binding.sessionManager.readMessages;

			binding.unsubscribeSessionEvents();
			binding.unsubscribeSessionEvents = () => {};
			return { bound: args.sessionIds.length };
		},
		async setRemoteHubReachable(args) {
			const simulation = simulationFor(ctx, args.environmentId);
			if (!simulation) throw new Error("no smoke simulation bound");
			simulation.reachable = args.reachable;
			return { reachable: simulation.reachable };
		},
		async appendHubMessage(args) {
			const simulation = simulationFor(ctx, args.environmentId);
			if (!simulation) throw new Error("no smoke simulation bound");
			// Simulate a hub-side transcript change by rewriting what the Hub
			// returns for this session on the next read.
			const previous = simulation.lastReplies.get(args.sessionId) ?? [];
			simulation.lastReplies.set(args.sessionId, [
				...(previous as Record<string, unknown>[]),
				{
					role: "assistant",
					content: [{ type: "text", text: args.text }],
					ts: Date.now(),
				},
			]);
			simulation.refreshed = false;
			const binding = ctx.runtimeBindings.get(args.environmentId);
			if (!binding) throw new Error("no remote binding");
			binding.sessionManager.readMessages = (async () =>
				simulation.lastReplies.get(args.sessionId) ??
				[]) as typeof binding.sessionManager.readMessages;
			return { ok: true };
		},
		async waitForRefresh(args) {
			const simulation = simulationFor(ctx, args.environmentId);
			const deadline = Date.now() + (args.timeoutMs ?? 10_000);
			while (Date.now() < deadline) {
				if (simulation?.refreshed) {
					return { refreshed: true, cachedAt: simulation.cachedAt };
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return { refreshed: false };
		},
		remoteCachePath(args) {
			return { path: remoteCacheDir(args.environmentId, args.sessionId) };
		},
	};
}

export function registerSmokeRemoteCacheCommands(ctx: SidecarContext): void {
	if (process.env[SMOKE_REMOTE_CACHE_ENV] !== "1") return;
	if (ctx.smokeRemoteCache) return;
	hooksOwner = getSidecarContextOwner(ctx);
	ctx.smokeRemoteCache = createSmokeRemoteCacheHooks(hooksOwner);
}
