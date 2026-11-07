// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	hasCompletedOnboarding,
	markOnboardingCompleted,
	ONBOARDING_RESET_EVENT,
	ONBOARDING_STORAGE_KEY,
	parseOnboardingStorage,
	resetOnboarding,
} from "./onboarding";

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("parseOnboardingStorage", () => {
	it("treats missing or malformed payloads as not completed", () => {
		expect(parseOnboardingStorage(null).completedAt).toBeNull();
		expect(parseOnboardingStorage("").completedAt).toBeNull();
		expect(parseOnboardingStorage("not json").completedAt).toBeNull();
		expect(parseOnboardingStorage("[]").completedAt).toBeNull();
		expect(parseOnboardingStorage('{"completedAt":42}').completedAt).toBeNull();
		expect(
			parseOnboardingStorage('{"completedAt":" "}').completedAt,
		).toBeNull();
	});

	it("keeps a valid completion timestamp", () => {
		expect(
			parseOnboardingStorage('{"completedAt":"2026-07-22T00:00:00.000Z"}')
				.completedAt,
		).toBe("2026-07-22T00:00:00.000Z");
	});
});

describe("onboarding state round-trip", () => {
	it("starts empty, auto-completes on first check, then resets", () => {
		// Storage starts empty: nothing written yet.
		expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
		expect(
			parseOnboardingStorage(
				window.localStorage.getItem(ONBOARDING_STORAGE_KEY),
			).completedAt,
		).toBeNull();

		// AutoCline skips the stock sign-in onboarding, so the first automatic
		// check reports completion AND persists an exact ISO timestamp.
		expect(hasCompletedOnboarding()).toBe(true);
		const autoCompletedAt = parseOnboardingStorage(
			window.localStorage.getItem(ONBOARDING_STORAGE_KEY),
		).completedAt;
		expect(autoCompletedAt).not.toBeNull();
		expect(autoCompletedAt).toBe(new Date(autoCompletedAt as string).toISOString());

		// Explicit completion persists a fresh, well-formed timestamp that is
		// still read back as completed.
		markOnboardingCompleted();
		const explicitCompletedAt = parseOnboardingStorage(
			window.localStorage.getItem(ONBOARDING_STORAGE_KEY),
		).completedAt;
		expect(explicitCompletedAt).not.toBeNull();
		expect(explicitCompletedAt).toBe(
			new Date(explicitCompletedAt as string).toISOString(),
		);
		expect(hasCompletedOnboarding()).toBe(true);

		// Reset removes the stored key (and fires the reset event).
		resetOnboarding();
		expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
		expect(
			parseOnboardingStorage(
				window.localStorage.getItem(ONBOARDING_STORAGE_KEY),
			).completedAt,
		).toBeNull();

		// The next automatic check completes again and re-persists storage.
		expect(hasCompletedOnboarding()).toBe(true);
		expect(
			parseOnboardingStorage(
				window.localStorage.getItem(ONBOARDING_STORAGE_KEY),
			).completedAt,
		).not.toBeNull();
	});

	it("dispatches the reset event so the app shell can replay in place", () => {
		const onReset = vi.fn();
		window.addEventListener(ONBOARDING_RESET_EVENT, onReset);
		try {
			resetOnboarding();
			expect(onReset).toHaveBeenCalledTimes(1);
		} finally {
			window.removeEventListener(ONBOARDING_RESET_EVENT, onReset);
		}
	});

	it("treats unreadable storage as completed so the flow cannot trap the user", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("storage disabled");
		});
		expect(hasCompletedOnboarding()).toBe(true);
	});
});
