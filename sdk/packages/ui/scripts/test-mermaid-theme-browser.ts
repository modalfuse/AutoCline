import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { chromium } from "playwright";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const compiled = await compile('@import "./theme/scoped-tokens.css";', {
	base: packageRoot,
	onDependency() {},
});
const built = await Bun.build({
	entrypoints: [`${packageRoot}/components/mermaid-dom.ts`],
	format: "esm",
	target: "browser",
	external: ["mermaid"],
});
assert(built.success, "Mermaid browser fixture must bundle successfully");
const bundle = await built.outputs[0].text();
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.setContent(
		`<style>${compiled.build([])}</style><section id="scope" class="cline-ui-theme"><figure id="diagram"></figure></section><figure id="legacy"></figure>`,
	);
	const results = await page.evaluate(async (source) => {
		const url = URL.createObjectURL(
			new Blob([source], { type: "text/javascript" }),
		);
		const { readMermaidTheme, observeThemeChanges } = await import(url);
		URL.revokeObjectURL(url);
		const scope = document.getElementById("scope");
		const diagram = document.getElementById("diagram");
		const legacy = document.getElementById("legacy");
		if (!scope || !diagram || !legacy) throw new Error("Missing theme fixture");
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const context = canvas.getContext("2d");
		function composite(color: string, background = "#ffffff") {
			if (!context) throw new Error("Canvas is unavailable");
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = background;
			context.fillRect(0, 0, 1, 1);
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			return `#${Array.from(context.getImageData(0, 0, 1, 1).data)
				.slice(0, 3)
				.map((channel) => channel.toString(16).padStart(2, "0"))
				.join("")}`;
		}
		const modes = [];
		let changes = 0;
		let observed = readMermaidTheme(diagram);
		const stop = observeThemeChanges(() => {
			changes += 1;
			observed = readMermaidTheme(diagram);
		}, diagram);
		for (const mode of ["light", "dark"]) {
			scope.classList.toggle("dark", mode === "dark");
			await Promise.resolve();
			const style = getComputedStyle(diagram);
			modes.push({
				mode,
				actual: readMermaidTheme(diagram).tokens.background,
				expected: composite(style.getPropertyValue("--card-surface")),
			});
		}
		const scopedUpdate = { changes, mode: observed.mode };
		diagram.style.setProperty(
			"--card-surface",
			"color-mix(in srgb, rgb(255 0 0 / 0.5), transparent)",
		);
		await Promise.resolve();
		const style = getComputedStyle(diagram);
		const translucentOverride = {
			actual: observed.tokens.background,
			expected: composite(
				style.getPropertyValue("--card-surface"),
				composite(style.getPropertyValue("--background")),
			),
		};
		stop();
		legacy.style.setProperty("--background", "#ffffff");
		legacy.style.setProperty(
			"--card",
			"color-mix(in srgb, rgb(0 0 0 / 0.1), transparent)",
		);
		return {
			modes,
			scopedUpdate,
			translucentOverride,
			legacy: readMermaidTheme(legacy).tokens.background,
		};
	}, bundle);
	for (const { mode, actual, expected } of results.modes) {
		assert.equal(actual, expected, `${mode} diagram uses the opaque surface`);
	}
	assert(results.scopedUpdate.changes > 0, "Scoped theme updates are observed");
	assert.equal(results.scopedUpdate.mode, "dark");
	assert.equal(
		results.translucentOverride.actual,
		results.translucentOverride.expected,
		"Translucent color-mix overrides are composited before PNG export",
	);
	assert.equal(results.legacy, "#f2f2f2", "Legacy card colors are composited");
	console.log("Mermaid opaque surfaces and scoped theme updates passed.");
} finally {
	await browser.close();
}
