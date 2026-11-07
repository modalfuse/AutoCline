import type { ProviderConfigFieldKey } from "@cline/core";
import { useKeyboard } from "@opentui/react";
import type { Dispatch, SetStateAction } from "react";
import type { SearchableListState } from "../../components/searchable-list";
import type { OnboardingOAuthProviderId } from "./auth";
import { FIELD_ORDER } from "./fields";
import {
	type MenuOption,
	type OnboardingStep,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./model";

export function useOnboardingKeyboard(input: {
	step: OnboardingStep;
	onExit: () => void;
	oauthProvider: string;
	activeProviderId: string;
	menuOptions: MenuOption[];
	menuSelected: number;
	providerList: SearchableListState;
	modelList: SearchableListState;
	thinkingSelected: number;
	setStep: (step: OnboardingStep) => void;
	setMenuSelected: Dispatch<SetStateAction<number>>;
	resetByoFields: () => void;
	byoFields: Partial<Record<ProviderConfigFieldKey, unknown>>;
	byoFocusedField: ProviderConfigFieldKey;
	setByoFocusedField: Dispatch<SetStateAction<ProviderConfigFieldKey>>;
	setThinkingSelected: Dispatch<SetStateAction<number>>;
	abortOAuth: () => void;
	resetAuth: () => void;
	refreshLocalCliStatus: () => void;
	startOAuthFlow: (providerId: OnboardingOAuthProviderId) => void;
	selectProvider: (providerId: string) => void;
	loadModelsForProvider: (providerId: string) => void;
	saveLocalCliConfig: () => void;
	saveByoConfig: () => void;
	saveModelSelection: () => void;
	saveThinkingLevel: (level: ThinkingLevel) => void;
}) {
	useKeyboard((key) => {
		if (input.step === "done") return;

		if (key.ctrl && key.name === "c") {
			input.onExit();
			return;
		}

		if (key.name === "escape") {
			if (input.step === "menu") return;
			if (input.step === "byo_apikey") {
				input.resetByoFields();
				input.setStep("byo_provider");
				return;
			}
			if (input.step === "byo_provider") {
				input.setStep("menu");
				input.setMenuSelected(0);
				return;
			}
			if (input.step === "local_cli_setup") {
				input.setStep("byo_provider");
				return;
			}
			if (input.step === "model_picker") {
				input.setStep("menu");
				input.setMenuSelected(0);
				return;
			}
			if (input.step === "custom_model_id") {
				input.setStep("model_picker");
				return;
			}
			if (input.step === "thinking_level") {
				input.setStep("model_picker");
				input.loadModelsForProvider(input.activeProviderId);
			}
			if (input.step === "oauth_pending") {
				input.abortOAuth();
				input.resetAuth();
				input.setStep("menu");
				input.setMenuSelected(0);
			}
			return;
		}

		if (input.step === "byo_provider") {
			if (key.name === "up" || (key.ctrl && key.name === "p")) {
				input.providerList.moveUp();
				return;
			}
			if (key.name === "down" || (key.ctrl && key.name === "n")) {
				input.providerList.moveDown();
				return;
			}
			if (key.name === "return") {
				const item = input.providerList.selectedItem;
				if (item) input.selectProvider(item.key);
			}
			return;
		}

		if (input.step === "local_cli_setup") {
			if (key.name === "r") {
				input.refreshLocalCliStatus();
				return;
			}
			if (key.name === "return") {
				input.saveLocalCliConfig();
			}
			return;
		}

		if (input.step === "byo_apikey") {
			if (key.name === "tab") {
				const visible = FIELD_ORDER.filter(
					(k) => input.byoFields[k] !== undefined,
				);
				if (visible.length > 1) {
					const idx = visible.indexOf(input.byoFocusedField);
					const nextIdx = key.shift
						? (idx - 1 + visible.length) % visible.length
						: (idx + 1) % visible.length;
					const next = visible[nextIdx];
					if (next) input.setByoFocusedField(next as ProviderConfigFieldKey);
				}
			}
			return;
		}

		if (input.step === "model_picker") {
			if (key.name === "up" || (key.ctrl && key.name === "p")) {
				input.modelList.moveUp();
				return;
			}
			if (key.name === "down" || (key.ctrl && key.name === "n")) {
				input.modelList.moveDown();
				return;
			}
			if (key.name === "return") {
				input.saveModelSelection();
			}
			return;
		}

		if (input.step === "thinking_level") {
			if (key.name === "up" || (key.ctrl && key.name === "p")) {
				input.setThinkingSelected((s) =>
					s <= 0 ? THINKING_LEVELS.length - 1 : s - 1,
				);
				return;
			}
			if (key.name === "down" || (key.ctrl && key.name === "n")) {
				input.setThinkingSelected((s) =>
					s >= THINKING_LEVELS.length - 1 ? 0 : s + 1,
				);
				return;
			}
			if (key.name === "return") {
				const level = THINKING_LEVELS[input.thinkingSelected];
				if (level) input.saveThinkingLevel(level.value);
			}
		}
	});
}
