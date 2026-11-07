import {
	type ITelemetryService,
	isOAuthProvider,
	loginLocalProvider,
	type ProviderSettingsManager,
	saveLocalProviderOAuthCredentials,
} from "@cline/core";
import open from "../../../utils/open";

export type OnboardingOAuthProviderId = string;

export function isOnboardingOAuthProviderId(
	providerId: string,
): providerId is OnboardingOAuthProviderId {
	return isOAuthProvider(providerId);
}

export function runOAuthAuthFlow(input: {
	providerId: OnboardingOAuthProviderId;
	providerSettingsManager: ProviderSettingsManager;
	isAborted: () => boolean;
	setStatus: (status: string) => void;
	setAuthUrl: (url: string) => void;
	setError: (error: string) => void;
	onComplete: (providerId: OnboardingOAuthProviderId) => void;
	telemetry?: ITelemetryService;
}): void {
	const existing = input.providerSettingsManager.getProviderSettings(
		input.providerId,
	);

	loginLocalProvider(
		input.providerId,
		existing,
		(url: string) => {
			input.setAuthUrl(url);
			input.setStatus("Waiting for sign-in...");
			try {
				void open(url, { wait: false }).catch(() => {
					input.setStatus("Could not open browser. Visit the URL below.");
				});
			} catch {
				input.setStatus("Could not open browser. Visit the URL below.");
			}
		},
		input.telemetry,
	)
		.then((credentials) => {
			if (input.isAborted()) return;
			saveLocalProviderOAuthCredentials(
				input.providerSettingsManager,
				input.providerId,
				existing,
				credentials,
			);
			input.onComplete(input.providerId);
		})
		.catch((err: unknown) => {
			if (input.isAborted()) return;
			input.setError(err instanceof Error ? err.message : String(err));
			input.setStatus("Authentication failed");
		});
}
