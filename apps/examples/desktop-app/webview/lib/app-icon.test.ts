// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, isTauriAvailable } = vi.hoisted(() => ({
	invoke: vi.fn(),
	isTauriAvailable: vi.fn(() => false),
}));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke },
	isTauriAvailable,
}));

import {
	APP_ICON_STORAGE_KEY,
	appIconAssetPath,
	appIconSurface,
	DEFAULT_APP_ICON,
	isAppIconId,
	readStoredAppIcon,
	setStoredAppIcon,
	syncAppIcon,
} from "./app-icon";

afterEach(() => {
	window.localStorage.clear();
	document.querySelector('link[rel="icon"]')?.remove();
	invoke.mockReset();
	isTauriAvailable.mockReturnValue(false);
});

describe("app icon", () => {
	it("defaults to the custom AutoCline icon and validates stored values", () => {
		expect(DEFAULT_APP_ICON).toBe("custom");
		expect(readStoredAppIcon()).toBe(DEFAULT_APP_ICON);
		window.localStorage.setItem(APP_ICON_STORAGE_KEY, "bogus");
		expect(readStoredAppIcon()).toBe(DEFAULT_APP_ICON);
		window.localStorage.setItem(APP_ICON_STORAGE_KEY, "toString");
		expect(readStoredAppIcon()).toBe(DEFAULT_APP_ICON);
		expect(isAppIconId("custom")).toBe(true);
		expect(isAppIconId("classic")).toBe(false);
		expect(isAppIconId("midnight")).toBe(false);
		expect(isAppIconId("steel")).toBe(false);
		expect(isAppIconId("sunrise")).toBe(false);
		expect(isAppIconId("bogus")).toBe(false);
	});

	it.each([
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Taskbar"],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Dock"],
		["Mozilla/5.0 (X11; Linux x86_64)", "desktop"],
	])("names the app icon surface for %s", (userAgent, surface) => {
		expect(appIconSurface(userAgent)).toBe(surface);
	});

	it.each([
		["sunrise", "custom"],
		["steel", "custom"],
		["classic", "custom"],
		["midnight", "custom"],
	])("migrates the retired/legacy %s preference to %s", (retired, replacement) => {
		window.localStorage.setItem(APP_ICON_STORAGE_KEY, retired);

		expect(readStoredAppIcon()).toBe(replacement);
		expect(window.localStorage.getItem(APP_ICON_STORAGE_KEY)).toBe(replacement);
	});

	it("persists the choice and swaps the favicon in browser mode", async () => {
		await setStoredAppIcon("classic");
		expect(window.localStorage.getItem(APP_ICON_STORAGE_KEY)).toBe("classic");
		expect(
			document
				.querySelector<HTMLLinkElement>('link[rel="icon"]')
				?.getAttribute("href"),
		).toBe(appIconAssetPath("classic"));
		expect(invoke).not.toHaveBeenCalled();
	});

	it("routes through the native command in the Tauri shell", async () => {
		isTauriAvailable.mockReturnValue(true);
		invoke.mockResolvedValue(true);
		await setStoredAppIcon("midnight");
		expect(invoke).toHaveBeenCalledWith("set_app_icon", { icon: "midnight" });
	});

	it("does not persist a native selection that fails to apply", async () => {
		isTauriAvailable.mockReturnValue(true);
		invoke.mockRejectedValue(new Error("native update failed"));

		await expect(setStoredAppIcon("classic")).rejects.toThrow(
			"native update failed",
		);
		expect(window.localStorage.getItem(APP_ICON_STORAGE_KEY)).toBeNull();
	});

	it("leaves the favicon unchanged when native application fails", async () => {
		isTauriAvailable.mockReturnValue(true);
		invoke.mockRejectedValue(new Error("native update failed"));

		await expect(setStoredAppIcon("classic")).rejects.toThrow();
		expect(document.querySelector('link[rel="icon"]')).toBeNull();
	});

	it("clears stored preference without applying theme icon (AutoCline uses fixed custom icon)", async () => {
		isTauriAvailable.mockReturnValue(true);
		invoke.mockResolvedValue(true);
		window.localStorage.setItem(APP_ICON_STORAGE_KEY, "classic");
		await syncAppIcon();
		// syncAppIcon is now a no-op for AutoCline: it only clears old localStorage,
		// does not call set_app_icon because the custom icon is baked into the bundle.
		expect(invoke).not.toHaveBeenCalled();
		expect(window.localStorage.getItem(APP_ICON_STORAGE_KEY)).toBeNull();
	});
});
