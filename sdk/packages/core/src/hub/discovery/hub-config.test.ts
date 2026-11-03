import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildHubListenUrls,
	defaultHubConfigPath,
	HUB_LISTEN_HOSTS_ENV,
	isWildcardListenHost,
	parseHubConfig,
	resolveHubListenConfig,
	validateListenHosts,
} from "./hub-config";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hub-config-test-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function writeConfig(document: unknown): string {
	const dir = join(home, ".config", "cline");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "hub.json");
	writeFileSync(path, JSON.stringify(document));
	return path;
}

const TAILSCALE = "100.101.163.69";

describe("parseHubConfig", () => {
	it("reads listenHosts, listenUrls, port and pathname", () => {
		expect(
			parseHubConfig(
				JSON.stringify({
					port: 25463,
					pathname: "/hub",
					listenHosts: ["127.0.0.1", TAILSCALE],
					listenUrls: ["ws://127.0.0.1:25463/hub"],
				}),
			),
		).toEqual({
			port: 25463,
			pathname: "/hub",
			listenHosts: ["127.0.0.1", TAILSCALE],
			hosts: undefined,
			listenUrls: ["ws://127.0.0.1:25463/hub"],
		});
	});

	it("rejects a non-array listenHosts and a bad port", () => {
		expect(() =>
			parseHubConfig(JSON.stringify({ listenHosts: "127.0.0.1" })),
		).toThrow(/"listenHosts" must be an array of strings/);
		expect(() => parseHubConfig(JSON.stringify({ port: 70_000 }))).toThrow(
			/"port" must be an integer/,
		);
	});

	it("rejects malformed JSON", () => {
		expect(() => parseHubConfig("{not json")).toThrow(/not valid JSON/);
	});
});

describe("validateListenHosts", () => {
	it("rejects every wildcard spelling", () => {
		expect(isWildcardListenHost("0.0.0.0")).toBe(true);
		expect(isWildcardListenHost("::")).toBe(true);
		expect(isWildcardListenHost("[::]")).toBe(true);
		expect(isWildcardListenHost("127.0.0.1")).toBe(false);
		expect(() => validateListenHosts(["127.0.0.1", "0.0.0.0"], "test")).toThrow(
			/wildcard address/,
		);
		expect(() => validateListenHosts(["::"], "test")).toThrow(/wildcard address/);
	});

	it("rejects an empty list and URLs passed as hosts", () => {
		expect(() => validateListenHosts([], "test")).toThrow(/names no hosts/);
		expect(() =>
			validateListenHosts(["ws://127.0.0.1:25463/hub"], "test"),
		).toThrow(/must be a bare address or hostname/);
	});

	it("keeps config order and de-duplicates", () => {
		expect(
			validateListenHosts([TAILSCALE, "127.0.0.1", TAILSCALE, " "], "test"),
		).toEqual([TAILSCALE, "127.0.0.1"]);
	});
});

describe("resolveHubListenConfig", () => {
	it("binds the file list and derives URLs from hosts + port", () => {
		writeConfig({ port: 25463, listenHosts: ["127.0.0.1", TAILSCALE] });
		const config = resolveHubListenConfig({
			env: { HOME: home },
			defaultPort: 1111,
		});
		expect(config.source).toBe("file");
		expect(config.hosts).toEqual(["127.0.0.1", TAILSCALE]);
		expect(config.port).toBe(25463);
		expect(config.urls).toEqual([
			"ws://127.0.0.1:25463/hub",
			`ws://${TAILSCALE}:25463/hub`,
		]);
	});

	it("uses the file's listenUrls verbatim when present", () => {
		const urls = ["ws://127.0.0.1:25463/hub", `ws://${TAILSCALE}:25463/hub`];
		writeConfig({
			port: 25463,
			listenHosts: ["127.0.0.1", TAILSCALE],
			listenUrls: urls,
		});
		expect(
			resolveHubListenConfig({ env: { HOME: home }, defaultPort: 0 }).urls,
		).toEqual(urls);
	});

	it("accepts the `hosts` alias and derives hosts from listenUrls", () => {
		writeConfig({ hosts: [TAILSCALE] });
		expect(
			resolveHubListenConfig({ env: { HOME: home }, defaultPort: 25463 }).hosts,
		).toEqual([TAILSCALE]);

		rmSync(join(home, ".config"), { recursive: true, force: true });
		writeConfig({ listenUrls: [`ws://${TAILSCALE}:25463/hub`] });
		expect(
			resolveHubListenConfig({ env: { HOME: home }, defaultPort: 25463 }).hosts,
		).toEqual([TAILSCALE]);
	});

	it("refuses to start when the file asks for a wildcard", () => {
		writeConfig({ port: 25463, listenHosts: ["0.0.0.0", TAILSCALE] });
		expect(() =>
			resolveHubListenConfig({ env: { HOME: home }, defaultPort: 25463 }),
		).toThrow(/wildcard address/);
	});

	it("lets CLINE_HUB_LISTEN_HOSTS replace the file list", () => {
		writeConfig({ port: 25463, listenHosts: ["127.0.0.1", TAILSCALE] });
		const config = resolveHubListenConfig({
			env: { HOME: home, [HUB_LISTEN_HOSTS_ENV]: `127.0.0.1, ${TAILSCALE}` },
			defaultPort: 25463,
		});
		expect(config.source).toBe("env");
		expect(config.hosts).toEqual(["127.0.0.1", TAILSCALE]);
		expect(() =>
			resolveHubListenConfig({
				env: { HOME: home, [HUB_LISTEN_HOSTS_ENV]: "0.0.0.0" },
				defaultPort: 25463,
			}),
		).toThrow(/wildcard address/);
	});

	it("falls back to loopback when no configuration exists", () => {
		const config = resolveHubListenConfig({
			env: { HOME: home },
			defaultPort: 25463,
		});
		expect(config.source).toBe("default");
		expect(config.hosts).toEqual(["127.0.0.1"]);
		expect(config.urls).toEqual(["ws://127.0.0.1:25463/hub"]);
	});

	it("honors an explicit config path and fails when it is missing", () => {
		const path = writeConfig({ listenHosts: [TAILSCALE], port: 20000 });
		expect(
			resolveHubListenConfig({
				env: { HOME: home },
				configPath: path,
				defaultPort: 25463,
			}).hosts,
		).toEqual([TAILSCALE]);
		expect(() =>
			resolveHubListenConfig({
				env: { HOME: home },
				configPath: join(home, "nope.json"),
				defaultPort: 25463,
			}),
		).toThrow(/not found/);
	});

	it("resolves the documented default path", () => {
		expect(defaultHubConfigPath({ env: { HOME: home } })).toBe(
			join(home, ".config", "cline", "hub.json"),
		);
		expect(
			defaultHubConfigPath({ env: { HOME: home, XDG_CONFIG_HOME: "/xdg" } }),
		).toBe("/xdg/cline/hub.json");
	});
});

describe("buildHubListenUrls", () => {
	it("brackets IPv6 literals", () => {
		expect(buildHubListenUrls(["::1"], 25463)).toEqual(["ws://[::1]:25463/hub"]);
	});
});
