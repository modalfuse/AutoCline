import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLINE_ACCOUNT_PROVIDER_ID,
	createClineAccountAuthHandler,
} from "./cline-account";
import {
	createCredentialsFromSettings,
	getProviderAuthHandler,
	getProviderAuthStorageId,
	isOAuthProvider,
} from "./provider-auth-registry";

const { getValidClineCredentials, loginClineOAuth } = vi.hoisted(() => ({
	getValidClineCredentials: vi.fn(),
	loginClineOAuth: vi.fn(),
}));

vi.mock("./cline", () => ({
	getValidClineCredentials,
	loginClineOAuth,
}));

// The cloud account handler is intentionally NOT registered locally; the local
// registry stays exactly as-is (oca + openai-codex only).

/**
 * Mirrors the manager's injected-handler credential read path: the handler's
 * own normalize callback is the only normalization applied.
 */
function readCredentialsViaHandler(
	handler: ReturnType<typeof createClineAccountAuthHandler>,
	settings: Parameters<typeof createCredentialsFromSettings>[0],
) {
	return createCredentialsFromSettings(settings, {
		normalizeAccessToken: handler.normalizeStoredAccessToken,
	});
}

describe("createClineAccountAuthHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses the cline provider id for both identity and storage", () => {
		const handler = createClineAccountAuthHandler();

		expect(handler.providerId).toBe("cline");
		expect(CLINE_ACCOUNT_PROVIDER_ID).toBe("cline");
		expect(handler.storageProviderId).toBe("cline");
	});

	it("is not part of the local provider auth registry", () => {
		createClineAccountAuthHandler();

		expect(getProviderAuthHandler("cline")).toBeUndefined();
		expect(getProviderAuthHandler("cline-pass")).toBeUndefined();
		expect(getProviderAuthStorageId("cline")).toBeUndefined();
		expect(getProviderAuthStorageId("cline-pass")).toBeUndefined();
		expect(isOAuthProvider("cline")).toBe(false);
		expect(isOAuthProvider("cline-pass")).toBe(false);
	});

	it("adds a single workos prefix to raw access tokens", () => {
		const handler = createClineAccountAuthHandler();

		expect(
			handler.getApiKey({ provider: "cline", auth: { accessToken: "abc" } }),
		).toBe("workos:abc");
		expect(
			handler.getApiKey({
				provider: "cline",
				auth: { accessToken: "  abc  " },
			}),
		).toBe("workos:abc");
	});

	it("does not double-prefix tokens already carrying the workos prefix", () => {
		const handler = createClineAccountAuthHandler();

		expect(
			handler.getApiKey({
				provider: "cline",
				auth: { accessToken: "workos:abc" },
			}),
		).toBe("workos:abc");
		expect(
			handler.getApiKey({
				provider: "cline",
				auth: { accessToken: "WORKOS:abc" },
			}),
		).toBe("WORKOS:abc");
	});

	it("falls back to a manual API key when no access token is stored", () => {
		const handler = createClineAccountAuthHandler();

		expect(handler.getApiKey({ provider: "cline", apiKey: "manual-key" })).toBe(
			"manual-key",
		);
		expect(
			handler.getApiKey({
				provider: "cline",
				auth: { apiKey: "auth-manual-key" },
			}),
		).toBe("auth-manual-key");
		expect(handler.getApiKey({ provider: "cline" })).toBeUndefined();
		expect(handler.getApiKey(undefined)).toBeUndefined();
	});

	it("strips the workos prefix when normalizing stored tokens", () => {
		const handler = createClineAccountAuthHandler();
		const normalize = handler.normalizeStoredAccessToken;

		expect(normalize).toBeTypeOf("function");
		expect(normalize?.("workos:abc")).toBe("abc");
		expect(normalize?.("  workos:abc  ")).toBe("abc");
		expect(normalize?.("WORKOS:abc")).toBe("abc");
		expect(normalize?.("abc")).toBe("abc");
	});

	it("rebuilds credentials from persisted settings with the prefix stripped", () => {
		const handler = createClineAccountAuthHandler();

		const credentials = readCredentialsViaHandler(handler, {
			provider: "cline",
			auth: {
				accessToken: "workos:stored-access",
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

	it("returns no credentials when the refresh token is missing", () => {
		const handler = createClineAccountAuthHandler();

		expect(
			readCredentialsViaHandler(handler, {
				provider: "cline",
				apiKey: "manual-key",
			}),
		).toBeNull();
	});

	it("logs in through Cline WorkOS device auth using the configured base URL", async () => {
		const handler = createClineAccountAuthHandler();
		const callbacks = { onAuth: vi.fn() };
		loginClineOAuth.mockResolvedValueOnce({
			access: "device-access",
			refresh: "device-refresh",
			expires: 4_000_000_000_000,
		});

		const credentials = await handler.login({
			settings: {
				provider: "cline",
				baseUrl: "https://api.cline.test",
			},
			callbacks,
		});

		expect(loginClineOAuth).toHaveBeenCalledWith(
			expect.objectContaining({
				apiBaseUrl: "https://api.cline.test",
				useWorkOSDeviceAuth: true,
				callbacks,
			}),
		);
		expect(credentials).toMatchObject({ access: "device-access" });
	});

	it("refreshes with normalized (prefix-stripped) stored credentials", async () => {
		const handler = createClineAccountAuthHandler();
		getValidClineCredentials.mockResolvedValueOnce({
			access: "access-new",
			refresh: "refresh-new",
			expires: 4_000_000_000_000,
		});

		await handler.refresh({
			settings: { provider: "cline", baseUrl: "https://api.cline.test" },
			credentials: {
				access: "access-old",
				refresh: "refresh-old",
				expires: 1,
			},
			forceRefresh: true,
		});

		expect(getValidClineCredentials).toHaveBeenCalledWith(
			expect.objectContaining({
				access: "access-old",
				refresh: "refresh-old",
			}),
			expect.objectContaining({ apiBaseUrl: "https://api.cline.test" }),
			{ forceRefresh: true },
		);
	});

	it("saves credentials under cline storage with exactly one workos prefix", () => {
		const handler = createClineAccountAuthHandler();
		const saveProviderSettings = vi.fn();
		const manager = {
			getProviderSettings: vi.fn(),
			saveProviderSettings,
		} as never;

		const saved = handler.saveCredentials({
			manager,
			settings: { provider: "cline", apiKey: "manual-key" },
			credentials: {
				access: "access-new",
				refresh: "refresh-new",
				expires: 4_000_000_000_000,
				accountId: "acct-new",
				metadata: { sessionStartedAtMs: 1_700_000_000_001 },
			},
		});

		expect(saved).toMatchObject({
			provider: "cline",
			apiKey: "manual-key",
			auth: {
				accessToken: "workos:access-new",
				refreshToken: "refresh-new",
				accountId: "acct-new",
				expiresAt: 4_000_000_000_000,
				metadata: { sessionStartedAtMs: 1_700_000_000_001 },
			},
		});
		expect(saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "cline" }),
			{ tokenSource: "oauth" },
		);
	});
});
