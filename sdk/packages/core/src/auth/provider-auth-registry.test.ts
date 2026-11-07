import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatProviderOAuthApiKey,
	getPersistedProviderApiKey,
	getProviderAuthHandler,
	getProviderAuthStorageId,
	getProviderOAuthCredentialsFromSettings,
	isOAuthProvider,
	loginAndSaveProviderOAuthCredentials,
	resolveProviderApiKeyFromSettings,
} from "./provider-auth-registry";

const { loginOpenAICodex } = vi.hoisted(() => ({
	loginOpenAICodex: vi.fn(),
}));

vi.mock("./cline", () => ({
	getValidClineCredentials: vi.fn(),
	loginClineOAuth: vi.fn(),
}));

vi.mock("./oca", () => ({
	getValidOcaCredentials: vi.fn(),
	loginOcaOAuth: vi.fn(),
}));

vi.mock("./codex", () => ({
	getValidOpenAICodexCredentials: vi.fn(),
	loginOpenAICodex,
}));

describe("provider auth registry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns handlers for managed OAuth providers only", () => {
		expect(getProviderAuthHandler("oca")?.providerId).toBe("oca");
		expect(getProviderAuthHandler("openai-codex")?.providerId).toBe(
			"openai-codex",
		);
		expect(getProviderAuthHandler("openai-codex-cli")).toBeUndefined();
		expect(isOAuthProvider("openai-codex-cli")).toBe(false);
	});

	it("returns no handler for removed local Cline auth providers", () => {
		expect(getProviderAuthHandler("cline")).toBeUndefined();
		expect(getProviderAuthHandler("cline-pass")).toBeUndefined();
		expect(isOAuthProvider("cline")).toBe(false);
		expect(isOAuthProvider("cline-pass")).toBe(false);
	});

	it("returns storage provider IDs from handlers", () => {
		expect(getProviderAuthStorageId("oca")).toBe("oca");
		expect(getProviderAuthStorageId("openai-codex")).toBe("openai-codex");
		expect(getProviderAuthStorageId("openai-codex-cli")).toBeUndefined();
		expect(getProviderAuthStorageId("cline")).toBeUndefined();
		expect(getProviderAuthStorageId("cline-pass")).toBeUndefined();
	});

	it("formats Codex OAuth tokens as plain access tokens", () => {
		expect(formatProviderOAuthApiKey("openai-codex", { access: "abc" })).toBe(
			"abc",
		);
		expect(
			formatProviderOAuthApiKey("openai-codex", {
				access: "workos:abc",
			}),
		).toBe("workos:abc");
		expect(
			getPersistedProviderApiKey("openai-codex", {
				provider: "openai-codex",
				auth: { accessToken: "abc" },
			}),
		).toBe("abc");
	});

	it("does not format or prefix removed Cline providers specially", () => {
		expect(formatProviderOAuthApiKey("cline", { access: "abc" })).toBe("abc");
		expect(formatProviderOAuthApiKey("cline-pass", { access: "abc" })).toBe(
			"abc",
		);
		expect(
			formatProviderOAuthApiKey("cline", { access: "workos:abc" }),
		).toBe("workos:abc");
		expect(
			getPersistedProviderApiKey("cline-pass", {
				provider: "cline",
				auth: { accessToken: "abc" },
			}),
		).toBe("abc");
	});

	it("login/save for removed Cline providers rejects without side effects", async () => {
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "cline",
			apiKey: "manual-key",
		});
		const saveProviderSettings = vi.fn();
		const manager = {
			getProviderSettings,
			saveProviderSettings,
		} as never;

		await expect(
			loginAndSaveProviderOAuthCredentials(manager, "cline-pass", {
				callbacks: {
					onAuth: vi.fn(),
					onPrompt: vi.fn(async () => ""),
				},
			}),
		).rejects.toThrow('Provider "cline-pass" does not support OAuth login');
		await expect(
			loginAndSaveProviderOAuthCredentials(manager, "cline", {
				callbacks: {
					onAuth: vi.fn(),
					onPrompt: vi.fn(async () => ""),
				},
			}),
		).rejects.toThrow('Provider "cline" does not support OAuth login');
		expect(loginOpenAICodex).not.toHaveBeenCalled();
		expect(getProviderSettings).not.toHaveBeenCalled();
		expect(saveProviderSettings).not.toHaveBeenCalled();
	});

	it("removed Cline providers do not resolve API keys from Cline storage", () => {
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "cline",
			auth: { accessToken: "abc" },
		});
		const manager = { getProviderSettings } as never;

		expect(resolveProviderApiKeyFromSettings(manager, "cline-pass")).toBe(
			"abc",
		);
		expect(getProviderSettings).toHaveBeenCalledWith("cline-pass");
		expect(getProviderSettings).not.toHaveBeenCalledWith("cline");
	});

	it("login/save stores credentials under handler storageProviderId", async () => {
		loginOpenAICodex.mockResolvedValueOnce({
			access: "new-access",
			refresh: "new-refresh",
			expires: 4_000_000_000_000,
			accountId: "acct-new",
			metadata: { sessionStartedAtMs: 1_700_000_000_001 },
		});
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			apiKey: "manual-key",
		});
		const saveProviderSettings = vi.fn();
		const manager = {
			getProviderSettings,
			saveProviderSettings,
		} as never;

		const saved = await loginAndSaveProviderOAuthCredentials(
			manager,
			"openai-codex",
			{
				callbacks: {
					onAuth: vi.fn(),
					onPrompt: vi.fn(async () => ""),
				},
			},
		);

		expect(getProviderSettings).toHaveBeenCalledWith("openai-codex");
		expect(saved).toMatchObject({
			provider: "openai-codex",
			apiKey: "manual-key",
			auth: {
				accessToken: "new-access",
				refreshToken: "new-refresh",
				accountId: "acct-new",
				expiresAt: 4_000_000_000_000,
				metadata: { sessionStartedAtMs: 1_700_000_000_001 },
			},
		});
		expect(saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "openai-codex" }),
			{ tokenSource: "oauth" },
		);
	});

	it("login/save preserves existing auth metadata when incoming metadata is missing", async () => {
		loginOpenAICodex.mockResolvedValueOnce({
			access: "new-access",
			refresh: "new-refresh",
			expires: 4_000_000_000_000,
			accountId: "acct-new",
		});
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			auth: {
				accessToken: "old-access",
				refreshToken: "old-refresh",
				accountId: "acct-old",
				metadata: {
					provider: "openai-codex",
					sessionStartedAtMs: 1_700_000_000_003,
				},
			},
		});
		const saveProviderSettings = vi.fn();
		const manager = {
			getProviderSettings,
			saveProviderSettings,
		} as never;

		const saved = await loginAndSaveProviderOAuthCredentials(
			manager,
			"openai-codex",
			{
				callbacks: {
					onAuth: vi.fn(),
					onPrompt: vi.fn(async () => ""),
				},
			},
		);

		expect(saved).toMatchObject({
			auth: {
				accessToken: "new-access",
				metadata: {
					provider: "openai-codex",
					sessionStartedAtMs: 1_700_000_000_003,
				},
			},
		});
	});

	it("login/save does not let undefined incoming metadata erase existing metadata", async () => {
		loginOpenAICodex.mockResolvedValueOnce({
			access: "new-access",
			refresh: "new-refresh",
			expires: 4_000_000_000_000,
			accountId: "acct-new",
			metadata: { provider: undefined, tokenType: "Bearer" },
		});
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			auth: {
				accessToken: "old-access",
				refreshToken: "old-refresh",
				accountId: "acct-old",
				metadata: {
					provider: "openai-codex",
					sessionStartedAtMs: 1_700_000_000_004,
				},
			},
		});
		const saveProviderSettings = vi.fn();
		const manager = {
			getProviderSettings,
			saveProviderSettings,
		} as never;

		const saved = await loginAndSaveProviderOAuthCredentials(
			manager,
			"openai-codex",
			{
				callbacks: {
					onAuth: vi.fn(),
					onPrompt: vi.fn(async () => ""),
				},
			},
		);

		expect(saved).toMatchObject({
			auth: {
				accessToken: "new-access",
				metadata: {
					provider: "openai-codex",
					sessionStartedAtMs: 1_700_000_000_004,
					tokenType: "Bearer",
				},
			},
		});
	});

	it("reads persisted auth metadata back into OAuth credentials", () => {
		const handler = getProviderAuthHandler("openai-codex");
		const credentials =
			handler &&
			getProviderOAuthCredentialsFromSettings("openai-codex", {
				provider: "openai-codex",
				auth: {
					accessToken: "stored-access",
					refreshToken: "stored-refresh",
					expiresAt: 4_000_000_000_000,
					accountId: "acct-stored",
					metadata: { sessionStartedAtMs: 1_700_000_000_002 },
				},
			});

		expect(credentials).toMatchObject({
			access: "stored-access",
			refresh: "stored-refresh",
			expires: 4_000_000_000_000,
			accountId: "acct-stored",
			metadata: { sessionStartedAtMs: 1_700_000_000_002 },
		});
	});

	it("does not reconstruct OAuth credentials for removed Cline providers", () => {
		const settings = {
			provider: "cline" as const,
			auth: {
				accessToken: "workos:stored-access",
				refreshToken: "stored-refresh",
				expiresAt: 4_000_000_000_000,
				accountId: "acct-stored",
				metadata: { sessionStartedAtMs: 1_700_000_000_005 },
			},
		};

		expect(getProviderOAuthCredentialsFromSettings("cline", settings)).toBeNull();
		expect(
			getProviderOAuthCredentialsFromSettings("cline-pass", settings),
		).toBeNull();
	});
});
