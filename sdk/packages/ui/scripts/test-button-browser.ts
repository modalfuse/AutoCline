import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { chromium, type Page } from "playwright";
import {
	type CSSProperties,
	createElement as h,
	type ReactNode,
	type SVGProps,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge } from "../components/badge.js";
import {
	Button,
	type ButtonProps,
	type ButtonTone,
	type ButtonVariant,
	buttonVariants,
	IconButton,
	type IconButtonProps,
	iconButtonVariants,
} from "../components/button.js";
import { Switch } from "../components/switch.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const variants: ButtonVariant[] = ["primary", "secondary", "ghost"];
const tones: ButtonTone[] = ["accent", "neutral", "destructive"];
const sizes = [
	{
		size: "xs",
		height: 28,
		padding: 10,
		gap: 6,
		leadingPadding: 6,
		trailingPadding: 6,
		iconGap: 6,
		icon: 12,
		iconOnly: 14,
	},
	{
		size: "sm",
		height: 32,
		padding: 12,
		gap: 6,
		leadingPadding: 7.2,
		trailingPadding: 7.2,
		iconGap: 6,
		icon: 14,
		iconOnly: 16,
	},
	{
		size: "md",
		height: 36,
		padding: 14,
		gap: 8,
		leadingPadding: 8,
		trailingPadding: 8,
		iconGap: 8,
		icon: 16,
		iconOnly: 16,
	},
	{
		size: "lg",
		height: 40,
		padding: 16,
		gap: 10,
		leadingPadding: 10,
		trailingPadding: 12,
		iconGap: 10,
		icon: 16,
		iconOnly: 20,
	},
] as const;
const utilities = [
	"h-7",
	"px-0",
	"gap-0",
	"whitespace-normal",
	"size-6",
	"inline-flex",
	"flex",
];
const unmanagedIcon = (position?: "leading" | "trailing", className?: string) =>
	h(
		"svg",
		{
			"aria-hidden": true,
			"data-icon": position,
			className,
			width: 48,
			height: 32,
			viewBox: "0 0 24 24",
		},
		h("path", { d: "M6 12h12M12 6v12", stroke: "currentColor" }),
	);
function FixtureIcon(props: SVGProps<SVGSVGElement>) {
	return h(
		"svg",
		{ viewBox: "0 0 24 24", width: 24, height: 24, ...props },
		h("path", { d: "M6 12h12M12 6v12", stroke: "currentColor" }),
	);
}
// Each named layout is exercised at every size in both text directions.
const buttonLayouts: [string, ButtonProps, ReactNode][] = [
	["text", {}, "Text only"],
	["leading", { leadingIcon: FixtureIcon }, "Leading icon"],
	["trailing", { trailingIcon: FixtureIcon }, "Trailing icon"],
	[
		"both",
		{ leadingIcon: FixtureIcon, trailingIcon: FixtureIcon },
		"Both icons",
	],
	["unmarked", {}, unmanagedIcon()],
	["wrapped", {}, h("span", { "data-icon": "leading" }, unmanagedIcon())],
	["nested", {}, h("span", null, unmanagedIcon("leading"))],
];
function button(id: string, props: ButtonProps = {}, children: ReactNode = id) {
	return h(Button, { id, key: id, ...props }, children);
}
function iconButton(
	id: string,
	props: Omit<IconButtonProps, "aria-label"> = {},
	children?: ReactNode,
) {
	return h(
		IconButton,
		{ id, key: id, "aria-label": id, icon: FixtureIcon, ...props },
		children,
	);
}
const fixtures = [
	...variants.flatMap((variant) =>
		tones.map((tone) => button(`${variant}-${tone}`, { variant, tone })),
	),
	...sizes.flatMap(({ size }) => [
		...(["button", "icon"] as const).flatMap((kind) =>
			[false, true].map((override) =>
				h(
					"button",
					{
						id: `helper-${kind}-${size}${override ? "-override" : ""}`,
						key: `helper-${kind}-${size}-${override}`,
						type: "button",
						"aria-label": "Helper icon",
						className: (kind === "button"
							? buttonVariants
							: iconButtonVariants)({ size }),
					},
					unmanagedIcon(undefined, override ? "size-6" : undefined),
				),
			),
		),
		...buttonLayouts.map(([layout, props, content]) =>
			button(`${layout}-${size}`, { size, ...props }, content),
		),
		iconButton(`icon-${size}`, { size }),
		iconButton(
			`legacy-icon-${size}`,
			{ size, icon: undefined },
			unmanagedIcon(),
		),
	]),
	...(["accent", "neutral"] as const).map((tone) =>
		h(Switch, {
			id: `switch-${tone}`,
			key: tone,
			tone,
			defaultChecked: true,
			"aria-label": `${tone} switch`,
		}),
	),
	iconButton("icon"),
	button("legacy-size-override", {}, unmanagedIcon(undefined, "size-6")),
	iconButton(
		"legacy-icon-size-override",
		{ icon: undefined },
		unmanagedIcon(undefined, "size-6"),
	),
	iconButton(
		"legacy-link",
		{ asChild: true, icon: undefined },
		h("a", { id: "legacy-icon-link", href: "#example" }, unmanagedIcon()),
	),
	button(
		"managed-with-preview",
		{ leadingIcon: FixtureIcon },
		h("span", null, unmanagedIcon()),
	),
	button("override", {
		className: "h-7 px-0 gap-0 whitespace-normal",
		leadingIcon: FixtureIcon,
		trailingIcon: FixtureIcon,
		style: { "--cline-ui-button-icon-size": "20px" } as CSSProperties,
	}),
	iconButton("icon-override", {
		className: "size-6",
		style: { "--cline-ui-button-icon-size": "18px" } as CSSProperties,
	}),
	button("no-scale", { pressScale: false }),
	button("custom-scale", { pressScale: 0.94 }),
	button("disabled", { disabled: true }),
	button("hidden-button", { hidden: true, className: "inline-flex" }),
	iconButton("hidden-icon-button", { hidden: true }),
	h(
		Badge,
		{
			id: "hidden-badge",
			key: "hidden-badge",
			hidden: true,
			interactive: true,
		},
		"Hidden badge",
	),
	button(
		"hidden-link-wrapper",
		{ asChild: true, hidden: true },
		h("a", { id: "hidden-link", href: "#example" }, "Hidden link"),
	),
	button("until-found", { hidden: true }),
	button(
		"link-wrapper",
		{ asChild: true, variant: "ghost", trailingIcon: FixtureIcon },
		h("a", { id: "link", href: "#example" }, "Link"),
	),
	button("padding-vars", {
		style: { "--cline-ui-button-padding-inline": "11px" } as CSSProperties,
	}),
	button("edge-vars", {
		leadingIcon: FixtureIcon,
		trailingIcon: FixtureIcon,
		style: {
			"--cline-ui-button-leading-padding": "6px",
			"--cline-ui-button-trailing-padding": "9px",
		} as CSSProperties,
	}),
	h(
		"button",
		{
			id: "helper",
			key: "helper",
			type: "button",
			className: buttonVariants({ variant: "secondary", tone: "neutral" }),
		},
		"Variant helper",
	),
];
const fixture = renderToStaticMarkup(
	h(
		"div",
		{
			className: "cline-ui-theme",
			style: {
				fontFamily: "monospace",
				color: "var(--foreground)",
				backgroundColor: "var(--background)",
				padding: 16,
			},
		},
		h(
			"div",
			{
				id: "surface",
				style: {
					padding: 16,
					display: "flex",
					flexWrap: "wrap",
					gap: 12,
					backgroundColor: "var(--surface-1)",
				},
			},
			...fixtures,
		),
	),
);

async function styles(page: Page, selector: string) {
	return page.locator(selector).evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			display: style.display,
			height: style.height,
			width: style.width,
			padding: style.padding,
			paddingInlineStart: style.paddingInlineStart,
			paddingInlineEnd: style.paddingInlineEnd,
			paddingLeft: style.paddingLeft,
			paddingRight: style.paddingRight,
			gap: style.gap,
			fontFamily: style.fontFamily,
			borderWidth: style.borderWidth,
			background: style.backgroundColor,
			whiteSpace: style.whiteSpace,
			textDecoration: style.textDecorationLine,
			outlineStyle: style.outlineStyle,
			outlineWidth: style.outlineWidth,
			focusVisible: element.matches(":focus-visible"),
			scale: style.scale,
		};
	});
}

async function expectStyles(
	page: Page,
	selector: string,
	expected: Partial<Awaited<ReturnType<typeof styles>>>,
	context = selector,
) {
	const actual = await styles(page, selector);
	for (const [property, value] of Object.entries(expected)) {
		assert.equal(
			actual[property as keyof typeof actual],
			value,
			`${context}/${property}`,
		);
	}
}

// Resolve computed properties, theme tokens, and literal colors through the
// same browser canvas so color-mix and alpha handling match in every check.
async function sampleColors(page: Page, samples: [string, string[]][]) {
	return page.evaluate((samples) => {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas unavailable");
		return samples.map(([selector, properties]) => {
			const element = document.querySelector(selector);
			if (!element) throw new Error(`Missing color fixture: ${selector}`);
			const style = getComputedStyle(element);
			return properties.map((property) => {
				const color = style.getPropertyValue(property).trim() || property;
				if (!CSS.supports("color", color))
					throw new Error(`Invalid color: ${color}`);
				context.clearRect(0, 0, 1, 1);
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
				return Array.from(context.getImageData(0, 0, 1, 1).data);
			});
		});
	}, samples);
}

async function contrast(
	page: Page,
	selector: string,
	property: "color" | "outlineColor",
) {
	const [[behind], [fill, text]] = await sampleColors(page, [
		["#surface", ["background-color"]],
		[
			selector,
			["background-color", property === "color" ? "color" : "outline-color"],
		],
	]);
	const blend = (fg: number[], bg: number[]) =>
		fg
			.slice(0, 3)
			.map((channel, i) => channel * (fg[3] / 255) + bg[i] * (1 - fg[3] / 255));
	const luminance = (rgb: number[]) =>
		rgb.slice(0, 3).reduce((total, channel, i) => {
			const value = channel / 255;
			return (
				total +
				(value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
					[0.2126, 0.7152, 0.0722][i]
			);
		}, 0);
	const background = property === "outlineColor" ? behind : blend(fill, behind);
	const a = luminance(blend(text, background));
	const b = luminance(background);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function switchColors(
	page: Page,
	id: string,
	background: string,
	thumb: string,
) {
	const [[expectedTrack, expectedThumb], [track], [knob]] = await sampleColors(
		page,
		[
			[
				`#${id}`,
				[`--${background}`, thumb === "white" ? "white" : `--${thumb}`],
			],
			[`#${id} + .cline-ui-switch__track`, ["background-color"]],
			[
				`#${id} + .cline-ui-switch__track .cline-ui-switch__thumb`,
				["background-color"],
			],
		],
	);
	return { track, thumb: knob, expectedTrack, expectedThumb };
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	let checkedPairs = 0;
	let checkedLayouts = 0;
	let checkedSwitchStates = 0;
	let minimumContrast = Infinity;
	for (const preflight of [true, false]) {
		const imports = preflight
			? '@import "tailwindcss";'
			: '@layer theme, base, components, utilities; @import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/utilities.css" layer(utilities);';
		const compiled = await compile(
			`${imports} @import "./theme/scoped-tokens.css"; @import "./components.css";`,
			{ base: packageRoot, onDependency() {} },
		);
		await page.setContent(
			`<style>${compiled.build(utilities)}</style>${fixture}`,
		);
		await page.emulateMedia({
			reducedMotion: "no-preference",
			forcedColors: "none",
		});
		for (const id of [
			"hidden-button",
			"hidden-icon-button",
			"hidden-badge",
			"hidden-link",
		]) {
			const control = page.locator(`#${id}`);
			assert.equal(
				(await styles(page, `#${id}`)).display,
				"none",
				`${id}/preflight=${preflight}`,
			);
			assert.equal(await control.boundingBox(), null);
			await control.evaluate((element) => element.removeAttribute("hidden"));
			assert.notEqual(
				await control.boundingBox(),
				null,
				`${id} can be shown again`,
			);
			await control.evaluate((element) =>
				element.setAttribute("hidden", "until-found"),
			);
			assert.notEqual(
				(await styles(page, `#${id}`)).display,
				"none",
				`${id} supports find-in-page visibility`,
			);
			await control.evaluate((element) => element.setAttribute("hidden", ""));
		}
		await page.locator("#until-found").evaluate((element) => {
			element.setAttribute("hidden", "until-found");
		});
		assert.notEqual((await styles(page, "#until-found")).display, "none");
		await expectStyles(page, "#ghost-neutral", {
			borderWidth: "0px",
			background: "rgba(0, 0, 0, 0)",
			fontFamily: "monospace",
		});
		await expectStyles(page, "#icon", { padding: "0px" });
		await expectStyles(page, "#link", { textDecoration: "none" });
		await expectStyles(page, "#helper", { height: "36px" });
		await expectStyles(page, "#padding-vars", {
			paddingInlineStart: "11px",
			paddingInlineEnd: "11px",
		});
		await expectStyles(page, "#edge-vars", {
			paddingInlineStart: "6px",
			paddingInlineEnd: "9px",
		});
		for (const direction of ["ltr", "rtl"]) {
			await page.locator(".cline-ui-theme").evaluate((element, direction) => {
				element.setAttribute("dir", direction);
			}, direction);
			for (const size of sizes) {
				for (const [layout, start, end, gap] of [
					["text", size.padding, size.padding, size.gap],
					["leading", size.leadingPadding, size.padding, size.iconGap],
					["trailing", size.padding, size.trailingPadding, size.iconGap],
					["both", size.leadingPadding, size.trailingPadding, size.iconGap],
					["unmarked", size.padding, size.padding, size.gap],
					["wrapped", size.padding, size.padding, size.gap],
					["nested", size.padding, size.padding, size.gap],
				] as const) {
					const selector = `#${layout}-${size.size}`;
					await expectStyles(
						page,
						selector,
						{
							height: `${size.height}px`,
							paddingInlineStart: `${start}px`,
							paddingInlineEnd: `${end}px`,
							paddingLeft: `${direction === "rtl" ? end : start}px`,
							paddingRight: `${direction === "rtl" ? start : end}px`,
							gap: `${gap}px`,
						},
						`${selector}/${direction}/preflight=${preflight}`,
					);
					checkedLayouts++;
				}
				for (const layout of ["unmarked", "wrapped", "nested"]) {
					await expectStyles(page, `#${layout}-${size.size} svg`, {
						width: `${size.icon}px`,
						height: `${size.icon}px`,
					});
				}
				for (const layout of ["icon", "legacy-icon"]) {
					await expectStyles(page, `#${layout}-${size.size}`, {
						height: `${size.height}px`,
						width: `${size.height}px`,
						padding: "0px",
						gap: "0px",
					});
					checkedLayouts++;
				}
				for (const [kind, expected] of [
					["button", size.icon],
					["icon", size.iconOnly],
				] as const) {
					for (const override of [false, true]) {
						const selector = `#helper-${kind}-${size.size}${override ? "-override" : ""} svg`;
						const pixels = `${override ? 24 : expected}px`;
						await expectStyles(page, selector, {
							width: pixels,
							height: pixels,
						});
					}
				}
				for (const [selector, expected] of [
					[`#leading-${size.size} svg`, size.icon],
					[`#icon-${size.size} svg`, size.iconOnly],
					[`#legacy-icon-${size.size} svg`, size.iconOnly],
				] as const) {
					await expectStyles(page, selector, {
						width: `${expected}px`,
						height: `${expected}px`,
					});
				}
			}
			await expectStyles(page, "#link", {
				paddingInlineStart: "14px",
				paddingInlineEnd: "8px",
			});
		}
		await page.locator(".cline-ui-theme").evaluate((element) => {
			element.setAttribute("dir", "ltr");
		});
		await expectStyles(page, "#override", {
			height: "28px",
			padding: "0px",
			gap: "0px",
			whiteSpace: "normal",
		});
		for (const [selector, width, height] of [
			["#override svg:first-child", 20, 20],
			["#icon-override svg", 18, 18],
			["#icon-override", 24, 24],
			["#legacy-size-override svg", 24, 24],
			["#legacy-icon-size-override svg", 24, 24],
			["#legacy-icon-link", 32, 32],
			["#legacy-icon-link svg", 16, 16],
			["#managed-with-preview span svg", 48, 32],
		] as const) {
			await expectStyles(page, selector, {
				width: `${width}px`,
				height: `${height}px`,
			});
		}

		for (const mode of ["light", "dark"]) {
			await page
				.locator(".cline-ui-theme")
				.evaluate(
					(element, dark) => element.classList.toggle("dark", dark),
					mode === "dark",
				);
			for (const surface of ["surface-1", "surface-2", "surface-3"]) {
				await page.locator("#surface").evaluate((element, surface) => {
					(element as HTMLElement).style.backgroundColor = `var(--${surface})`;
				}, surface);
				for (const variant of variants)
					for (const tone of tones) {
						const selector = `#${variant}-${tone}`;
						for (const hover of [false, true]) {
							if (hover) await page.locator(selector).hover();
							else await page.mouse.move(0, 0);
							const ratio = await contrast(page, selector, "color");
							assert.ok(
								ratio >= 4.5,
								`${mode}/${surface}/${variant}/${tone}/${hover ? "hover" : "rest"}: ${ratio.toFixed(2)}:1`,
							);
							minimumContrast = Math.min(minimumContrast, ratio);
							checkedPairs++;
						}
					}
				for (const tone of ["accent", "neutral"] as const) {
					const id = `switch-${tone}`;
					const input = page.locator(`#${id}`);
					const [on, onHover, onThumb] =
						tone === "accent"
							? ["primary", "primary-emphasis", "primary-foreground"]
							: ["neutral-solid", "neutral-solid-hover", "neutral-contrast"];
					const disabledThumb = "cline-ui-switch-disabled-thumb-background";
					for (const [checked, hover, disabled, background, thumb] of [
						[false, false, false, "cline-ui-switch-off-background", "white"],
						[
							false,
							true,
							false,
							"cline-ui-switch-off-hover-background",
							"white",
						],
						[true, false, false, on, onThumb],
						[true, true, false, onHover, onThumb],
						[false, false, true, "surface-hover-darker", disabledThumb],
						[true, false, true, "surface-hover-darker", disabledThumb],
					] as const) {
						await input.evaluate((element) => {
							(element as HTMLInputElement).disabled = false;
						});
						await input.setChecked(checked);
						await input.evaluate((element, disabled) => {
							(element as HTMLInputElement).disabled = disabled;
						}, disabled);
						if (hover) await input.hover();
						else await page.mouse.move(0, 0);
						const colors = await switchColors(page, id, background, thumb);
						const context = `${id}/${mode}/${surface}/checked=${checked}/hover=${hover}/disabled=${disabled}/preflight=${preflight}`;
						assert.deepEqual(
							colors.track,
							colors.expectedTrack,
							`${context} track`,
						);
						assert.deepEqual(
							colors.thumb,
							colors.expectedThumb,
							`${context} thumb`,
						);
						checkedSwitchStates++;
					}
					await input.evaluate((element) => {
						(element as HTMLInputElement).disabled = false;
					});
					await page.mouse.move(0, 0);
					await page.keyboard.press("Tab");
					await input.focus();
					const trackSelector = `#${id} + .cline-ui-switch__track`;
					const focus = await styles(page, trackSelector);
					assert.equal(focus.outlineStyle, "solid");
					assert.equal(focus.outlineWidth, "2px");
					assert.ok(
						(await contrast(page, trackSelector, "outlineColor")) >= 3,
						`${id} focus contrast`,
					);
				}
				await page.locator("#ghost-neutral").focus();
				assert.ok(
					(await contrast(page, "#ghost-neutral", "outlineColor")) >= 3,
				);
			}
		}

		await page.locator("#primary-accent").focus();
		await page.keyboard.press("Tab");
		const focused = page.locator(":focus");
		assert.ok(
			await focused.evaluate((element) => element.matches(":focus-visible")),
		);
		await page.emulateMedia({ forcedColors: "active" });
		const forced = await styles(page, ":focus");
		assert.equal(forced.outlineStyle, "solid");
		assert.equal(forced.outlineWidth, "2px");
		await page.emulateMedia({ forcedColors: "none" });

		for (const [selector, expected] of [
			["#primary-accent", "0.98"],
			["#custom-scale", "0.94"],
			["#no-scale", "none"],
			["#disabled", "none"],
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
			assert.equal((await styles(page, selector)).scale, "none");
			await page.mouse.up();
			await page.emulateMedia({ reducedMotion: "no-preference" });
		}
	}
	console.log(
		`Button browser checks passed with and without Preflight: ${checkedLayouts} LTR/RTL icon layouts, ${checkedSwitchStates} accent/neutral switch states, ${checkedPairs} text contrast pairs (minimum ${minimumContrast.toFixed(2)}:1), hidden controls, focus, forced colors, overrides, and reduced motion.`,
	);
} finally {
	await browser.close();
}
