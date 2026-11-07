import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../utils/types";

const coreMocks = vi.hoisted(() => {
	const serviceOptions: Array<{
		apiBaseUrl: string;
		getAuthToken: () => Promise<string | undefined | null>;
	}> = [];
	return {
		getProviderSettings: vi.fn(),
		saveProviderSettings: vi.fn(),
		fetchMe: vi.fn(),
		fetchBalance: vi.fn(),
		fetchOrganizationBalance: vi.fn(),
		fetchAvailableSubscriptionPlans: vi.fn(),
		fetchCurrentUserPlan: vi.fn(),
		serviceOptions,
	};
});
const telemetryMocks = vi.hoisted(() => ({
	identifyTelemetryAccount: vi.fn(),
}));

vi.mock("@cline/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cline/core")>();
	return {
		...actual,
		ClineAccountService: class {
			constructor(options: {
				apiBaseUrl: string;
				getAuthToken: () => Promise<string | undefined | null>;
			}) {
				coreMocks.serviceOptions.push(options);
			}
			fetchMe() {
				return coreMocks.fetchMe();
			}
			fetchBalance(userId?: string) {
				return coreMocks.fetchBalance(userId);
			}
			fetchOrganizationBalance(organizationId: string) {
				return coreMocks.fetchOrganizationBalance(organizationId);
			}
			fetchAvailableSubscriptionPlans(input?: {
				type?: "individual" | "teams";
			}) {
				return coreMocks.fetchAvailableSubscriptionPlans(input);
			}
			fetchCurrentUserPlan() {
				return coreMocks.fetchCurrentUserPlan();
			}
		},
		ProviderSettingsManager: class {
			getProviderSettings(providerId: string) {
				return coreMocks.getProviderSettings(providerId);
			}
			saveProviderSettings(settings: unknown, options?: unknown) {
				coreMocks.saveProviderSettings(settings, options);
			}
		},
	};
});

vi.mock("../utils/telemetry", () => ({
	identifyTelemetryAccount: telemetryMocks.identifyTelemetryAccount,
}));

function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		providerId: "cline",
		modelId: "anthropic/claude-sonnet-4.6",
		apiKey: "",
		verbose: false,
		sandbox: false,
		thinking: false,
		outputMode: "text",
		mode: "act",
		defaultToolAutoApprove: false,
		toolPolicies: {},
		enableTools: true,
		cwd: "/tmp/workspace",
		logger: {
			debug: vi.fn(),
			log: vi.fn(),
			error: vi.fn(),
		},
		...overrides,
	} as unknown as Config;
}

describe("createClineAccountService", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		coreMocks.getProviderSettings.mockReset();
		coreMocks.saveProviderSettings.mockReset();
		coreMocks.fetchMe.mockReset();
		coreMocks.fetchBalance.mockReset();
		coreMocks.fetchOrganizationBalance.mockReset();
		coreMocks.fetchAvailableSubscriptionPlans.mockReset();
		coreMocks.fetchCurrentUserPlan.mockReset();
		coreMocks.serviceOptions.length = 0;
		telemetryMocks.identifyTelemetryAccount.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("creates the account service from the persisted account token without an OAuth token exchange", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
		coreMocks.getProviderSettings.mockReturnValue({
			provider: "cline",
			apiKey: "account-token",
		});

		const { createClineAccountService } = await import("./cline-account");
		const service = await createClineAccountService({ config: makeConfig() });

		expect(service).toBeDefined();
		// The independent cloud account uses the persisted token directly: no
		// OAuth refresh request is issued and no credentials are rewritten.
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(coreMocks.saveProviderSettings).not.toHaveBeenCalled();
		expect(await coreMocks.serviceOptions[0]?.getAuthToken()).toBe(
			"account-token",
		);
	});

	it("returns no service when no Cline account token is available", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
		coreMocks.getProviderSettings.mockReturnValue({
			provider: "cline",
			apiKey: "",
		});

		const { createClineAccountService } = await import("./cline-account");

		await expect(
			createClineAccountService({ config: makeConfig({ apiKey: "" }) }),
		).resolves.toBeUndefined();
		expect(coreMocks.serviceOptions).toHaveLength(0);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(coreMocks.saveProviderSettings).not.toHaveBeenCalled();
	});
});

describe("loadClineAccountSnapshot", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		coreMocks.getProviderSettings.mockReset();
		coreMocks.saveProviderSettings.mockReset();
		coreMocks.fetchMe.mockReset();
		coreMocks.fetchBalance.mockReset();
		coreMocks.fetchOrganizationBalance.mockReset();
		coreMocks.fetchAvailableSubscriptionPlans.mockReset();
		coreMocks.fetchCurrentUserPlan.mockReset();
		coreMocks.serviceOptions.length = 0;
		telemetryMocks.identifyTelemetryAccount.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("identifies the loaded Cline account for telemetry and feature flags", async () => {
		coreMocks.getProviderSettings.mockReturnValue({
			provider: "cline",
			apiKey: "account-token",
		});
		const { loadClineAccountSnapshot } = await import("./cline-account");
		coreMocks.fetchMe.mockResolvedValue({
			id: "user-1",
			email: "user@example.com",
			displayName: "User One",
			photoUrl: "",
			createdAt: "",
			updatedAt: "",
			organizations: [
				{
					active: true,
					memberId: "member-1",
					name: "Acme",
					organizationId: "org-1",
					roles: ["member"],
				},
			],
		});
		coreMocks.fetchBalance.mockResolvedValue({ balance: 10, userId: "user-1" });
		coreMocks.fetchOrganizationBalance.mockResolvedValue({
			balance: 20,
			organizationId: "org-1",
		});

		await loadClineAccountSnapshot({ config: makeConfig() });

		expect(telemetryMocks.identifyTelemetryAccount).toHaveBeenCalledWith(
			{
				id: "user-1",
				email: "user@example.com",
				provider: "cline",
				organizationId: "org-1",
				organizationName: "Acme",
				memberId: "member-1",
			},
			expect.any(Object),
		);
	});

	it("links to the web app's privacy settings when the account provides a path", async () => {
		vi.stubEnv("CLINE_ENVIRONMENT", "staging");
		coreMocks.getProviderSettings.mockReturnValue({
			provider: "cline",
			apiKey: "account-token",
		});
		const { loadClineAccountSnapshot } = await import("./cline-account");
		coreMocks.fetchMe.mockResolvedValue({
			id: "user-1",
			email: "user@example.com",
			displayName: "User One",
			photoUrl: "",
			createdAt: "",
			updatedAt: "",
			organizations: [],
			dataPrivacyPath: "/dashboard/account?tab=privacy",
		});
		coreMocks.fetchBalance.mockResolvedValue({ balance: 10, userId: "user-1" });

		const snapshot = await loadClineAccountSnapshot({ config: makeConfig() });

		expect(snapshot.privacySettingsUrl).toBe(
			"https://staging-app.cline.bot/dashboard/account?tab=privacy",
		);
	});
});

describe("isClineAccountCreditsErrorMessage", () => {
	it("matches the raw insufficient_credits JSON payload from the Cline API 402", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(
			isClineAccountCreditsErrorMessage(
				'{"code":"insufficient_credits","current_balance":-0.14,"message":"Not enough credits available"}',
			),
		).toBe(true);
	});

	it("matches the insufficient_credits payload wrapped in an error prefix", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(
			isClineAccountCreditsErrorMessage(
				'Error: {"code":"insufficient_credits","current_balance":0,"message":"Not enough credits available"}',
			),
		).toBe(true);
	});

	it("matches the plain human-readable Cline API message", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(
			isClineAccountCreditsErrorMessage("Not enough credits available"),
		).toBe(true);
	});

	it("matches the legacy insufficient balance phrasing", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(
			isClineAccountCreditsErrorMessage(
				"Insufficient balance. Your Cline credits balance is $0.00.",
			),
		).toBe(true);
	});

	it("does not match unrelated errors", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(isClineAccountCreditsErrorMessage("Payment Required")).toBe(false);
		expect(
			isClineAccountCreditsErrorMessage(
				"Your credit balance is too low to access the Anthropic API.",
			),
		).toBe(false);
		expect(
			isClineAccountCreditsErrorMessage("insufficient balance on gateway"),
		).toBe(false);
	});
});
