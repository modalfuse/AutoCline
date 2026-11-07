import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_HUB_HOST,
	DEFAULT_HUB_PATHNAME,
	DEFAULT_HUB_PORT,
} from "../discovery/defaults";
import type { EnsureHubServerOptions } from "./start-shared-server";

const {
	mockEnsureHubWebSocketServer,
	mockResolveHubEndpointOptions,
	mockResolveClineBuildEnv,
	mockResolveProductionHubOwnerContext,
	mockResolveSharedHubOwnerContext,
	mockStartHubWebSocketServer,
} = vi.hoisted(() => ({
	mockEnsureHubWebSocketServer: vi.fn(async () => ({
		url: "ws://127.0.0.1:25463/hub",
		authToken: "token",
		action: "started",
	})),
	mockResolveHubEndpointOptions: vi.fn(
		(options: { host?: string; port?: number; pathname?: string }) => ({
			host: options.host ?? "127.0.0.1",
			port: options.port ?? 25463,
			pathname: options.pathname ?? "/hub",
		}),
	),
	mockResolveClineBuildEnv: vi.fn(() => "production"),
	mockResolveProductionHubOwnerContext: vi.fn(() => ({
		ownerId: "production",
		discoveryPath: "/tmp/cline-data/locks/hub/production.json",
	})),
	mockResolveSharedHubOwnerContext: vi.fn(() => ({
		ownerId: "shared",
		discoveryPath: "/tmp/cline-data/locks/hub/owners/shared.json",
	})),
	mockStartHubWebSocketServer: vi.fn(),
}));

// Partial mock: the real `discovery/defaults.ts` reads CLINE_HUB_PORT /
// DEV_PORT straight from `@cline/shared`, so only the build-env probe is
// replaced and every other real export is preserved.
vi.mock("@cline/shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cline/shared")>();
	return {
		...actual,
		resolveClineBuildEnv: mockResolveClineBuildEnv,
	};
});

// Partial mock: `hub-config.ts` reads DEFAULT_HUB_HOST/PATHNAME from the real
// module for its loopback fallback, so only the endpoint resolver is replaced.
vi.mock("../discovery/defaults", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../discovery/defaults")>();
	return {
		...actual,
		resolveHubEndpointOptions: mockResolveHubEndpointOptions,
	};
});

vi.mock("../discovery/workspace", () => ({
	resolveProductionHubOwnerContext: mockResolveProductionHubOwnerContext,
	resolveSharedHubOwnerContext: mockResolveSharedHubOwnerContext,
}));

vi.mock("../server", () => ({
	ensureHubWebSocketServer: mockEnsureHubWebSocketServer,
	startHubWebSocketServer: mockStartHubWebSocketServer,
}));

const originalHubPort = process.env.CLINE_HUB_PORT;
const runtimeHandlers =
	{} as unknown as EnsureHubServerOptions["runtimeHandlers"];

describe("ensureHubServer", () => {
	afterEach(() => {
		mockEnsureHubWebSocketServer.mockClear();
		mockResolveHubEndpointOptions.mockClear();
		mockResolveClineBuildEnv.mockClear();
		mockResolveClineBuildEnv.mockReturnValue("production");
		mockResolveProductionHubOwnerContext.mockClear();
		mockResolveSharedHubOwnerContext.mockClear();
		mockStartHubWebSocketServer.mockClear();
		if (originalHubPort === undefined) {
			delete process.env.CLINE_HUB_PORT;
		} else {
			process.env.CLINE_HUB_PORT = originalHubPort;
		}
	});

	it("does not allow port fallback by default in production", async () => {
		delete process.env.CLINE_HUB_PORT;
		const { ensureHubServer } = await import("./start-shared-server");

		await ensureHubServer({ runtimeHandlers });

		expect(mockEnsureHubWebSocketServer).toHaveBeenCalledWith(
			expect.objectContaining({
				allowPortFallback: false,
				owner: expect.objectContaining({
					discoveryPath: "/tmp/cline-data/locks/hub/production.json",
				}),
			}),
		);
		// The listen-config fallback (no ~/.config/cline/hub.json) must not
		// widen the endpoint: the real loopback host/pathname defaults and the
		// resolved port survive into the listener options.
		expect(mockEnsureHubWebSocketServer).toHaveBeenCalledWith(
			expect.objectContaining({
				host: DEFAULT_HUB_HOST,
				port: DEFAULT_HUB_PORT,
				pathname: DEFAULT_HUB_PATHNAME,
				listenHosts: [DEFAULT_HUB_HOST],
			}),
		);
	});

	it("allows port fallback by default in development when no port is explicit", async () => {
		delete process.env.CLINE_HUB_PORT;
		mockResolveClineBuildEnv.mockReturnValue("development");
		const { ensureHubServer } = await import("./start-shared-server");

		await ensureHubServer({ runtimeHandlers });

		expect(mockEnsureHubWebSocketServer).toHaveBeenCalledWith(
			expect.objectContaining({
				allowPortFallback: true,
				owner: expect.objectContaining({
					discoveryPath: "/tmp/cline-data/locks/hub/owners/shared.json",
				}),
			}),
		);
		expect(mockEnsureHubWebSocketServer).toHaveBeenCalledWith(
			expect.objectContaining({
				host: DEFAULT_HUB_HOST,
				port: DEFAULT_HUB_PORT,
				pathname: DEFAULT_HUB_PATHNAME,
				listenHosts: [DEFAULT_HUB_HOST],
			}),
		);
	});

	it("does not default port fallback when a port option is explicit", async () => {
		delete process.env.CLINE_HUB_PORT;
		const { ensureHubServer } = await import("./start-shared-server");

		await ensureHubServer({ port: 30000, runtimeHandlers });

		expect(mockEnsureHubWebSocketServer).toHaveBeenCalledWith(
			expect.objectContaining({
				port: 30000,
				allowPortFallback: false,
			}),
		);
	});

	it("does not default port fallback when CLINE_HUB_PORT is explicit", async () => {
		process.env.CLINE_HUB_PORT = "30001";
		const { ensureHubServer } = await import("./start-shared-server");

		await ensureHubServer({ runtimeHandlers });

		expect(mockEnsureHubWebSocketServer).toHaveBeenCalledWith(
			expect.objectContaining({
				allowPortFallback: false,
			}),
		);
	});
});
