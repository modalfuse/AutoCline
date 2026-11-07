import { desktopClient, isTauriAvailable } from "@/lib/desktop-client";

export const APP_ICON_STORAGE_KEY = "cline.code.app-icon.v1";

/**
 * AutoCline uses a fixed custom brand icon, not theme-switchable variants.
 * The runtime icon switching (classic/midnight/hologram/chip) is disabled;
 * Dock/About/bundle always show the custom autocline-brand-icon.png.
 * Kept for compatibility but never applied at runtime.
 */
export const APP_ICONS = [
	{ id: "custom", label: "AutoCline" },
] as const;

export type AppIconId = (typeof APP_ICONS)[number]["id"];

export const DEFAULT_APP_ICON: AppIconId = "custom";

const RETIRED_APP_ICON_MIGRATIONS = {
	sunrise: DEFAULT_APP_ICON,
	steel: DEFAULT_APP_ICON,
	classic: DEFAULT_APP_ICON,
	midnight: DEFAULT_APP_ICON,
	hologram: DEFAULT_APP_ICON,
	chip: DEFAULT_APP_ICON,
} as const satisfies Record<string, AppIconId>;

type RetiredAppIconId = keyof typeof RETIRED_APP_ICON_MIGRATIONS;

function isRetiredAppIconId(value: unknown): value is RetiredAppIconId {
	return (
		typeof value === "string" &&
		Object.hasOwn(RETIRED_APP_ICON_MIGRATIONS, value)
	);
}

export function isAppIconId(value: unknown): value is AppIconId {
	return APP_ICONS.some((icon) => icon.id === value);
}

export function appIconAssetPath(icon: AppIconId): string {
	return `/app-icons/${icon}.png`;
}

export function appIconSurface(
	userAgent: string,
): "Dock" | "Taskbar" | "desktop" {
	if (/Windows/i.test(userAgent)) return "Taskbar";
	if (/(Macintosh|Mac OS X)/i.test(userAgent)) return "Dock";
	return "desktop";
}

export function readStoredAppIcon(): AppIconId {
	try {
		const stored = window.localStorage.getItem(APP_ICON_STORAGE_KEY);
		if (isRetiredAppIconId(stored)) {
			const migrated = RETIRED_APP_ICON_MIGRATIONS[stored];
			window.localStorage.setItem(APP_ICON_STORAGE_KEY, migrated);
			return migrated;
		}
		return isAppIconId(stored) ? stored : DEFAULT_APP_ICON;
	} catch {
		return DEFAULT_APP_ICON;
	}
}

function applyFavicon(icon: AppIconId): void {
	let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		document.head.appendChild(link);
	}
	link.href = appIconAssetPath(icon);
}

/**
 * Applies the icon to whatever this runtime can control: the Dock or taskbar
 * icon in the Tauri shell (native `set_app_icon` command, best-effort) and
 * the favicon in browser dev mode so the choice is still visible there.
 */
export async function applyAppIcon(icon: AppIconId): Promise<void> {
	if (isTauriAvailable()) {
		await desktopClient.invoke("set_app_icon", { icon });
	}
	applyFavicon(icon);
}

export async function setStoredAppIcon(icon: AppIconId): Promise<void> {
	await applyAppIcon(icon);
	try {
		window.localStorage.setItem(APP_ICON_STORAGE_KEY, icon);
	} catch {
		// Selection falls back to default next launch; applying still works.
	}
}

/**
 * No-op for AutoCline: the custom brand icon is baked into the native bundle
 * (icon.icns) and never switched at runtime. Clear any leftover Cline theme
 * preference so the Dock cannot be overwritten by old localStorage entries.
 */
export async function syncAppIcon(): Promise<void> {
	try {
		window.localStorage.removeItem(APP_ICON_STORAGE_KEY);
	} catch {
		// Storage may be unavailable; no-op is safe.
	}
	// Do NOT call applyAppIcon: AutoCline's icon is fixed in the native bundle.
}
