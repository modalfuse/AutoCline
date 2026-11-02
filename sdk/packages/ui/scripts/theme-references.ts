import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Supplied by Tailwind's default theme or by Radix on portaled content.
const externalVariables = new Set([
	"--breakpoint-lg",
	"--radix-tooltip-content-available-width",
	"--radix-dropdown-menu-content-available-height",
	"--radix-dropdown-menu-content-available-width",
	"--radix-tooltip-content-transform-origin",
]);

export function unresolvedThemeReferences(
	sources: Record<string, string>,
): string[] {
	const entries = Object.entries(sources).map(
		([file, source]) =>
			[
				file,
				source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
			] as const,
	);
	const declared = new Set(externalVariables);
	for (const [, source] of entries) {
		for (const match of source.matchAll(/(--[\w-]+)["']?\s*:/g))
			declared.add(match[1]);
	}
	const failures = new Set<string>();
	for (const [file, source] of entries) {
		for (const match of source.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
			// An explicit fallback is an optional customization point.
			if (match[2] === ")" && !declared.has(match[1]))
				failures.add(`${file}: ${match[1]}`);
		}
		// Tailwind v4 also wraps custom properties implicitly, e.g.
		// bg-(--surface) and text-(color:--foreground).
		for (const match of source.matchAll(/-\((?:[\w-]+:)?(--[\w-]+)\)/g)) {
			if (!declared.has(match[1])) failures.add(`${file}: ${match[1]}`);
		}
	}
	return [...failures].sort();
}

export function readThemeSources(packageRoot: string): Record<string, string> {
	const sources: Record<string, string> = {};
	const visit = (directory: string) => {
		for (const entry of readdirSync(join(packageRoot, directory), {
			withFileTypes: true,
		})) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (/\.(?:css|tsx?)$/.test(entry.name))
				sources[path] = readFileSync(join(packageRoot, path), "utf8");
		}
	};
	visit("theme");
	visit("components");
	return sources;
}
