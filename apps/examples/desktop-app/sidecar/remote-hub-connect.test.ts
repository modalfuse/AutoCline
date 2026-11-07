import type {
	RemoteEnvironmentConnection,
	RemoteEnvironmentService,
} from "@cline/core";
import { describe, expect, it, vi } from "vitest";
import {
	connectRemoteEnvironmentDirect,
	describeHubEndpoints,
	hubConnectError,
	isHubRemoteProfile,
	normalizeHubUrl,
	resolveHubUrlList,
} from "./remote-hub-connect";

const TAILSCALE_URL = "ws://100.101.163.69:25463/hub";
const LOOPBACK_URL = "ws://127.0.0.1:25463/hub";

function connection(endpoint: string): RemoteEnvironmentConnection {
	return {
		profile: {
			id: "hp02",
			name: "hp02",
			host: "hp02",
			hubUrls: [endpoint],
			createdAt: "2026-11-03T00:00:00.000Z",
			updatedAt: "2026-11-03T00:00:00.000Z",
		},
		profileId: "hp02",
		state: "connected",
		endpoint,
		authToken: "token",
		workspaceRoot: "/home/joe",
		homeDir: "/home/joe",
		platform: "linux",
		arch: "x64",
		remoteHubUrl: LOOPBACK_URL,
		localPort: 25463,
		connectedAt: "2026-11-03T00:00:00.000Z",
	};
}

describe("resolveHubUrlList", () => {
	it("keeps configured order and normalizes entries", () => {
		expect(
			resolveHubUrlList({
				hubUrls: [` ${TAILSCALE_URL} `, "", LOOPBACK_URL, TAILSCALE_URL],
			}),
		).toEqual([TAILSCALE_URL, LOOPBACK_URL]);
	});

	it("accepts the legacy single hubUrl after hubUrls", () => {
		expect(
			resolveHubUrlList({
				hubUrls: [TAILSCALE_URL],
				hubUrl: LOOPBACK_URL,
			}),
		).toEqual([TAILSCALE_URL, LOOPBACK_URL]);
	});

	it("reports no URLs for an SSH-only profile", () => {
		expect(resolveHubUrlList({})).toEqual([]);
		expect(isHubRemoteProfile({})).toBe(false);
		expect(isHubRemoteProfile({ hubUrls: [TAILSCALE_URL] })).toBe(true);
	});

	it("drops blank and undefined entries", () => {
		expect(normalizeHubUrl("   ")).toBeUndefined();
		expect(normalizeHubUrl(undefined)).toBeUndefined();
		expect(normalizeHubUrl("wss://hub.example.com/hub")).toBe(
			"wss://hub.example.com/hub",
		);
	});
});

describe("hubConnectError", () => {
	it("lists every URL and states that no tunnel is used", () => {
		const error = hubConnectError({ name: "hp02" }, [
			TAILSCALE_URL,
			LOOPBACK_URL,
		]);
		expect(error.message).toContain(`Tried: ${TAILSCALE_URL}, ${LOOPBACK_URL}`);
		expect(error.message).toContain("does not open SSH tunnels");
		expect(error.message).toContain("hubUrls");
	});

	it("explains an empty list", () => {
		expect(hubConnectError({ name: "hp02" }, []).message).toContain(
			"Tried: (none configured)",
		);
		expect(describeHubEndpoints([])).toBe("(none configured)");
	});
});

describe("connectRemoteEnvironmentDirect", () => {
	it("connects through the configured URL without any tunnel", async () => {
		const connect = vi.fn(async () => connection(TAILSCALE_URL));
		const result = await connectRemoteEnvironmentDirect(
			{ connect } as unknown as RemoteEnvironmentService,
			{ id: "hp02", name: "hp02", hubUrls: [TAILSCALE_URL] },
		);
		expect(result.kind).toBe("connected");
		if (result.kind === "connected") {
			expect(result.connection.endpoint).toBe(TAILSCALE_URL);
		}
		expect(connect).toHaveBeenCalledWith("hp02");
	});

	it("refuses a profile without hubUrls instead of tunnelling", async () => {
		const connect = vi.fn();
		const result = await connectRemoteEnvironmentDirect(
			{ connect } as unknown as RemoteEnvironmentService,
			{ id: "hp02", name: "hp02" },
		);
		expect(result.kind).toBe("not_hub_mode");
		expect(connect).not.toHaveBeenCalled();
	});

	it("turns a failed direct connect into an actionable error", async () => {
		const result = await connectRemoteEnvironmentDirect(
			{
				connect: async () => {
					throw new Error("ECONNREFUSED");
				},
			} as unknown as RemoteEnvironmentService,
			{ id: "hp02", name: "hp02", hubUrls: [TAILSCALE_URL] },
		);
		expect(result.kind).toBe("failed");
		if (result.kind === "failed") {
			expect(result.error.message).toContain(TAILSCALE_URL);
			expect(result.error.message).toContain("ECONNREFUSED");
		}
	});
});
