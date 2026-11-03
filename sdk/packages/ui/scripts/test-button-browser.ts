import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { chromium, type Page } from "playwright";
import { type CSSProperties, createElement as h, type SVGProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge } from "../components/badge.js";
import { Button, buttonVariants, IconButton } from "../components/button.js";
import { Switch } from "../components/switch.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
function Icon(props: SVGProps<SVGSVGElement>) {
	return h(
		"svg",
		{ "aria-hidden": true, viewBox: "0 0 24 24", ...props },
		h("path", { d: "M6 12h12", stroke: "currentColor" }),
	);
}
// Representative cases target behavior that DOM-only tests cannot verify.
const fixture = renderToStaticMarkup(
	h(
		"div",
		{
			className: "cline-ui-theme",
			style: { fontFamily: "monospace", padding: 16 },
		},
		h(Button, { id: "managed", leadingIcon: Icon }, "Continue"),
		h(IconButton, { id: "icon", "aria-label": "Add", icon: Icon }),
		h(
			Button,
			{ id: "legacy" },
			h(Icon, { className: "size-6" }),
			"Legacy icon",
		),
		h(
			"button",
			{ id: "helper", type: "button", className: buttonVariants() },
			h(Icon),
		),
		h(
			Button,
			{
				id: "override",
				leadingIcon: Icon,
				className: "h-7 px-0 gap-0 whitespace-normal",
				style: { "--cline-ui-button-icon-size": "20px" } as CSSProperties,
			},
			"Override",
		),
		h(Button, { id: "disabled", disabled: true }, "Disabled"),
		h(Button, { id: "no-scale", pressScale: false }, "No scaling"),
		h(
			Button,
			{ id: "hidden-button", hidden: true, className: "inline-flex" },
			"Hidden",
		),
		h(IconButton, {
			id: "hidden-icon",
			hidden: true,
			"aria-label": "Hidden icon",
			icon: Icon,
		}),
		h(
			Badge,
			{ id: "hidden-badge", hidden: true, interactive: true },
			"Hidden badge",
		),
		h(
			Button,
			{ asChild: true, hidden: true },
			h("a", { id: "hidden-link", href: "#example" }, "Hidden link"),
		),
		h(Switch, {
			id: "switch",
			tone: "neutral",
			defaultChecked: true,
			"aria-label": "Notifications",
		}),
	),
);

async function expectStyles(
	page: Page,
	selector: string,
	expected: Record<string, string>,
) {
	const actual = await page
		.locator(selector)
		.evaluate((element, properties) => {
			const style = getComputedStyle(element);
			return Object.fromEntries(
				properties.map((property) => [
					property,
					style.getPropertyValue(property),
				]),
			);
		}, Object.keys(expected));
	assert.deepEqual(actual, expected, selector);
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	// Shared CSS must work both with a host reset and in embedded consumers.
	for (const preflight of [true, false]) {
		const imports = preflight
			? '@import "tailwindcss";'
			: '@layer theme, base, components, utilities; @import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/utilities.css" layer(utilities);';
		const compiled = await compile(
			`${imports} @import "./theme/scoped-tokens.css"; @import "./components.css";`,
			{ base: packageRoot, onDependency() {} },
		);
		await page.setContent(
			`<style>${compiled.build(["h-7", "px-0", "gap-0", "whitespace-normal", "size-6", "inline-flex"])}</style>${fixture}`,
		);
		await page.emulateMedia({
			reducedMotion: "no-preference",
			forcedColors: "none",
		});
		await expectStyles(page, "#managed", {
			height: "36px",
			gap: "8px",
			"font-family": "monospace",
		});
		await expectStyles(page, "#managed svg:first-child", {
			width: "16px",
			height: "16px",
		});
		await expectStyles(page, "#icon", {
			width: "32px",
			height: "32px",
			padding: "0px",
		});
		await expectStyles(page, "#legacy svg", { width: "24px", height: "24px" });
		await expectStyles(page, "#helper svg", { width: "16px", height: "16px" });
		await expectStyles(page, "#override", {
			height: "28px",
			padding: "0px",
			gap: "0px",
			"white-space": "normal",
		});
		await expectStyles(page, "#override svg", {
			width: "20px",
			height: "20px",
		});
		for (const direction of ["ltr", "rtl"]) {
			await page
				.locator(".cline-ui-theme")
				.evaluate(
					(element, dir) => element.setAttribute("dir", dir),
					direction,
				);
			await expectStyles(page, "#managed", {
				"padding-inline-start": "8px",
				"padding-inline-end": "14px",
				"padding-left": direction === "rtl" ? "14px" : "8px",
				"padding-right": direction === "rtl" ? "8px" : "14px",
			});
			await expectStyles(page, "#override", {
				"padding-left": "0px",
				"padding-right": "0px",
			});
		}
		for (const id of [
			"hidden-button",
			"hidden-icon",
			"hidden-badge",
			"hidden-link",
		]) {
			await expectStyles(page, `#${id}`, { display: "none" });
			assert.equal(await page.locator(`#${id}`).boundingBox(), null, id);
		}
		// The new neutral switch must resolve its tokens in both themes, including
		// the dark thumb's matching border, rather than falling back to accent.
		await page.mouse.move(0, 0);
		for (const dark of [false, true]) {
			await page
				.locator(".cline-ui-theme")
				.evaluate(
					(element, dark) => element.classList.toggle("dark", dark),
					dark,
				);
			const colors = await page.locator("#switch").evaluate((input) => {
				const root = input.parentElement;
				if (!root) throw new Error("Missing switch fixture");
				const probe = document.createElement("span");
				root.append(probe);
				const resolve = (token: string) => {
					probe.style.color = `var(--${token})`;
					return getComputedStyle(probe).color;
				};
				const track = root.querySelector(".cline-ui-switch__track");
				const thumb = root.querySelector(".cline-ui-switch__thumb");
				if (!track || !thumb) throw new Error("Missing switch track/thumb");
				const result = {
					track:
						getComputedStyle(track).backgroundColor ===
						resolve("neutral-solid"),
					thumb:
						getComputedStyle(thumb).backgroundColor ===
						resolve("neutral-contrast"),
					darkBorder:
						getComputedStyle(thumb).boxShadow ===
						`${resolve("neutral-contrast")} 0px 0px 0px 1px`,
				};
				probe.remove();
				return result;
			});
			assert.ok(colors.track && colors.thumb, `neutral switch/dark=${dark}`);
			if (dark) assert.ok(colors.darkBorder, "neutral dark thumb border");
		}
		await page.keyboard.press("Tab");
		await page.locator("#managed").focus();
		assert.ok(
			await page
				.locator("#managed")
				.evaluate((element) => element.matches(":focus-visible")),
		);
		await expectStyles(page, "#managed", {
			"outline-style": "solid",
			"outline-width": "2px",
		});
		await page.emulateMedia({ forcedColors: "active" });
		await expectStyles(page, "#managed", {
			"outline-style": "solid",
			"outline-width": "2px",
		});
		await page.emulateMedia({ forcedColors: "none" });
		for (const [selector, expected] of [
			["#managed", "0.98"],
			["#disabled", "none"],
			["#no-scale", "none"],
		]) {
			const bounds = await page.locator(selector).boundingBox();
			assert.ok(bounds);
			await page.mouse.move(
				bounds.x + bounds.width / 2,
				bounds.y + bounds.height / 2,
			);
			await page.mouse.down();
			await page.waitForFunction(
				({ selector, expected }) =>
					getComputedStyle(document.querySelector(selector) as Element)
						.scale === expected,
				{ selector, expected },
			);
			await page.emulateMedia({ reducedMotion: "reduce" });
			await expectStyles(page, selector, { scale: "none" });
			await page.mouse.up();
			await page.emulateMedia({ reducedMotion: "no-preference" });
		}
	}
	console.log(
		"Representative controls browser checks passed with and without Preflight: managed/legacy icons, RTL, host overrides, visibility, neutral switch themes, focus, forced colors, and reduced motion.",
	);
} finally {
	await browser.close();
}
