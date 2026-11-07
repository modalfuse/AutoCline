import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClineAccountAuthHandler } from "../../auth/cline-account";
import type { ProviderAuthHandler } from "../../auth/provider-auth-registry";
import { ProviderSettingsManager } from "../../services/storage/provider-settings-manager";
import {
	OAuthReauthRequiredError,
	RuntimeOAuthTokenManager,
} from "./runtime-oauth-token-manager";

const {
	getValidOpenAICodexCredentials,
	getValidClineCredentials,
	getValidOcaCredentials,
	loginClineOAuth,
} = vi.hoisted(() => ({
	getValidOpenAICodexCredentials: vi.fn(),
	getValidClineCredentials: vi.fn(),
	getValidOcaCredentials: vi.fn(),
	loginClineOAuth: vi.fn(),
}));

vi.mock("../../auth/codex", () => ({
	getValidOpenAICodexCredentials,
}));

vi.mock("../../auth/cline", () => ({
	getValidClineCredentials,
	loginClineOAuth,
}));

vi.mock("../../auth/oca", () => ({
	getValidOcaCredentials,
}));

/**
 * Cloud account credentials are resolved by cloud/sidecar callers through an
 * explicitly injected handler; the local registry intentionally has no
 * `cline`/`cline-pass` entry.
 */
function useClineAccountHandler() {
	const handler = createClineAccountAuthHandler();
	return {
		resolveAuthHandler: (providerId: string): ProviderAuthHandler | undefined =>
			providerId.trim().toLowerCase() === handler.providerId
				? handler
				: undefined,
	};
}

describe("RuntimeOAuthTokenManager", () => {
	let testDir: string;
	afterEach(() => rmSync(testDir, { recursive: true, force: true }));
	beforeEach(() => {
		vi.resetAllMocks();
		testDir = mkdtempSync(join(tmpdir(), "oauth-manager-test-"));
	});

	it("refreshes and persists OpenAI Codex OAuth credentials", async () => {
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			auth: {
				accessToken: "access-old",
				refreshToken: "refresh-old",
				expiresAt: Date.now() - 1_000,
				accountId: "acct-old",
			},
		});
		const saveProviderSettings = vi.fn();

		getValidOpenAICodexCredentials.mockResolvedValueOnce({
			access: "access-new",
			refresh: "refresh-new",
			expires: 4_000_000_000_000,
			accountId: "acct-new",
		});

		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: {
				getFilePath: () => join(testDir, "providers.json"),
				getProviderSettings,
				saveProviderSettings,
			} as never,
		});

		const result = await manager.resolveProviderApiKey({
			providerId: "openai-codex",
		});

		expect(result).toMatchObject({
			apiKey: "access-new",
			accountId: "acct-new",
			refreshed: true,
		});
		expect(saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				auth: expect.objectContaining({
					accessToken: "access-new",
					refreshToken: "refresh-new",
					accountId: "acct-new",
					expiresAt: 4_000_000_000_000,
				}),
			}),
			{ setLastUsed: false, tokenSource: "oauth" },
		);
	});

	it("resolves the cloud account OAuth handler using Cline storage and WorkOS formatting", async () => {
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "cline",
			baseUrl: "https://api.cline.test",
			auth: {
				accessToken: "workos:access-old",
				refreshToken: "refresh-old",
				expiresAt: Date.now() - 1_000,
				accountId: "acct-old",
			},
		});
		const saveProviderSettings = vi.fn();

		getValidClineCredentials.mockResolvedValueOnce({
			access: "access-new",
			refresh: "refresh-new",
			expires: 4_000_000_000_000,
			accountId: "acct-new",
		});

		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: {
				getFilePath: () => join(testDir, "providers.json"),
				getProviderSettings,
				saveProviderSettings,
			} as never,
			...useClineAccountHandler(),
		});

		const result = await manager.resolveProviderApiKey({ providerId: "cline" });

		expect(getProviderSettings).toHaveBeenCalledWith("cline");
		expect(getValidClineCredentials).toHaveBeenCalledWith(
			expect.objectContaining({
				access: "access-old",
				refresh: "refresh-old",
			}),
			expect.objectContaining({ apiBaseUrl: "https://api.cline.test" }),
			{ forceRefresh: false },
		);
		expect(result).toMatchObject({
			apiKey: "workos:access-new",
			accountId: "acct-new",
			refreshed: true,
		});
		expect(saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cline",
				auth: expect.objectContaining({
					accessToken: "workos:access-new",
					refreshToken: "refresh-new",
					accountId: "acct-new",
					expiresAt: 4_000_000_000_000,
				}),
			}),
			{ setLastUsed: false, tokenSource: "oauth" },
		);
	});

	it("returns null for local cline/cline-pass providers without an injected handler", async () => {
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "cline",
			auth: {
				accessToken: "workos:access-old",
				refreshToken: "refresh-old",
				expiresAt: Date.now() - 1_000,
			},
		});
		const saveProviderSettings = vi.fn();
		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: {
				getFilePath: () => join(testDir, "providers.json"),
				getProviderSettings,
				saveProviderSettings,
			} as never,
		});

		expect(
			await manager.resolveProviderApiKey({ providerId: "cline" }),
		).toBeNull();
		expect(
			await manager.resolveProviderApiKey({ providerId: "cline-pass" }),
		).toBeNull();
		expect(getValidClineCredentials).not.toHaveBeenCalled();
		expect(saveProviderSettings).not.toHaveBeenCalled();
	});

	it("throws re-auth required when refresh returns null", async () => {
		getValidOpenAICodexCredentials.mockResolvedValueOnce(null);
		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: {
				getFilePath: () => join(testDir, "providers.json"),
				getProviderSettings: vi.fn().mockReturnValue({
					provider: "openai-codex",
					auth: {
						accessToken: "access-old",
						refreshToken: "refresh-old",
						expiresAt: Date.now() - 1_000,
					},
				}),
				saveProviderSettings: vi.fn(),
			} as never,
		});

		await expect(
			manager.resolveProviderApiKey({ providerId: "openai-codex" }),
		).rejects.toBeInstanceOf(OAuthReauthRequiredError);
	});

	it("de-duplicates concurrent refresh calls per provider", async () => {
		const refreshBarrier = Promise.resolve().then(() => ({
			access: "access-new",
			refresh: "refresh-new",
			expires: Date.now() + 60_000,
		}));
		getValidOpenAICodexCredentials.mockImplementationOnce(
			async () => refreshBarrier,
		);

		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: {
				getFilePath: () => join(testDir, "providers.json"),
				getProviderSettings: vi.fn().mockReturnValue({
					provider: "openai-codex",
					auth: {
						accessToken: "access-old",
						refreshToken: "refresh-old",
						expiresAt: Date.now() - 1_000,
					},
				}),
				saveProviderSettings: vi.fn(),
			} as never,
		});

		const [first, second] = await Promise.all([
			manager.resolveProviderApiKey({ providerId: "openai-codex" }),
			manager.resolveProviderApiKey({ providerId: "openai-codex" }),
		]);

		expect(first?.apiKey).toBe("access-new");
		expect(second?.apiKey).toBe("access-new");
		expect(getValidOpenAICodexCredentials).toHaveBeenCalledTimes(1);
	});

	it("coordinates independent managers and does not force-refresh a token another manager just rotated", async () => {
		const settings = new ProviderSettingsManager({
			filePath: join(testDir, "providers.json"),
		});
		settings.saveProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "old",
				refreshToken: "single-use",
				expiresAt: 1,
				accountId: "account-a",
			},
		});
		let finish!: () => void;
		getValidClineCredentials.mockImplementation(
			async (credentials, _options, { forceRefresh }) => {
				if (!forceRefresh && credentials.access === "new") return credentials;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return {
					access: "new",
					refresh: "rotated",
					expires: Date.now() + 3_600_000,
					accountId: "account-a",
				};
			},
		);
		const first = new RuntimeOAuthTokenManager({
			providerSettingsManager: settings,
			...useClineAccountHandler(),
		});
		const second = new RuntimeOAuthTokenManager({
			providerSettingsManager: settings,
			...useClineAccountHandler(),
		});
		const a = first.resolveProviderApiKey({
			providerId: "cline",
			forceRefresh: true,
		});
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		const b = second.resolveProviderApiKey({
			providerId: "cline",
			forceRefresh: true,
		});
		finish();
		expect((await Promise.all([a, b])).map((result) => result?.apiKey)).toEqual(
			["workos:new", "workos:new"],
		);
		expect(getValidClineCredentials.mock.calls[1][2]).toEqual({
			forceRefresh: false,
		});
	});

	it("does not restore credentials when the user signs out during refresh", async () => {
		const settings = new ProviderSettingsManager({
			filePath: join(testDir, "providers.json"),
		});
		settings.saveProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "old",
				refreshToken: "single-use",
				expiresAt: 1,
				accountId: "account-a",
			},
		});
		let finish!: () => void;
		getValidClineCredentials.mockImplementation(async () => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return {
				access: "new",
				refresh: "rotated",
				expires: Date.now() + 3_600_000,
				accountId: "account-a",
			};
		});
		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: settings,
			...useClineAccountHandler(),
		});
		const result = manager.resolveProviderApiKey({ providerId: "cline" });
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		settings.saveProviderSettings({ provider: "cline", auth: {} });
		finish();
		expect(await result).toBeNull();
		expect(
			settings.getProviderSettings("cline")?.auth?.accessToken,
		).toBeUndefined();
	});
});
