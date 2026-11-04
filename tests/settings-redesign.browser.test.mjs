import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { navigateMain, navigateSettings, chooseTheme, selectActivityOption, openSourceEditor } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WIRE_SETTINGS_REDESIGN_PROOFS;
const categories = ["connection", "privacy", "display", "troubleshooting"];

async function setup(t, { unknownBilling = false, preferenceSave = false, announcementProbe = false } = {}) {
    if (proofs) await mkdir(proofs, { recursive: true });
    const cleanups = [], denied = [], errors = [], posts = [];
    const f = await evaluationFixture({ after: action => cleanups.push(action) });
    await materializeEvaluationSource(f);
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false },
        search: { modelDirectory: path.join(f.context.dataDir, "absent-settings-test-model") },
        evaluation: {
            evaluatorFactory: async () => { denied.push("provider"); throw new Error("Provider forbidden in Settings proof."); },
            readSource: async () => { denied.push("evaluation source"); throw new Error("Evaluation source forbidden in Settings proof."); },
        },
    });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const before = await loadBoardState(f.context);
    const files = [f.config.appDbPath, ...(preferenceSave ? [] : [path.join(f.context.dataDir, "collector", "config.json")]),
        ...f.inputs.map(input => path.join(f.config.sessionRoot, input.record.sourceSessionId, "events.jsonl"))];
    const bytes = await Promise.all(files.map(file => readFile(file)));
    const allowed = new Set(["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/consent",
        "/api/evaluation/automatic/summary", "/api/evaluation/automatic/setup", "/api/deletion/preview", "/api/deletion/cancel",
        "/api/recollection/sources", "/api/recollection/preview", "/api/recollection/cancel",
        "/api/search/events", "/api/search/query", "/api/search/open", "/api/record/status"]);
    if (preferenceSave) allowed.add("/api/collection/configure");
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !allowed.has(url.pathname)) {
            denied.push(`${request.method()} ${url.pathname}`);
            return route.abort("blockedbyclient");
        }
        if (request.method() === "POST") posts.push(url.pathname);
        if (announcementProbe && url.pathname === "/") {
            const response = await route.fetch(), body = await response.text();
            const marker = 'function announce(text, kind = "", retry = false) {';
            assert.equal(body.split(marker).length, 2);
            return route.fulfill({ response, body: body.replace(marker, `window.settingsAnnounceForTest = announce;\n${marker}`) });
        }
        if (unknownBilling && url.pathname === "/api/evaluation/automatic/summary") {
            const response = await route.fetch(), data = await response.json();
            data.snapshot = { ...data.snapshot, state: "paused", reason: "unknown-billing", approval: { state: "enabled" } };
            return route.fulfill({ response, json: data });
        }
        await route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []);
            assert.deepEqual(denied, [], "Only declared isolated fixture operations are permitted; never a provider or external request");
            assert.deepEqual(await Promise.all(files.map(file => readFile(file))), bytes);
            assert.deepEqual(await loadBoardState(f.context), before);
        } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
    });
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "settings");
    await expect(page.locator("#connectionTitle")).toBeFocused();
    await page.evaluate(() => document.fonts.ready);
    return { ...f, page, runtime, posts };
}

async function capture(page, name, end = false) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => !document.getAnimations().some(animation =>
        animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
    await page.evaluate(end => {
        for (const dialog of document.querySelectorAll("dialog[open], dialog[open] .assessment-dialog-body")) dialog.scrollTop = end ? dialog.scrollHeight : 0;
    }, end);
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: await page.locator("dialog[open]").count() === 0 });
    if (name.startsWith("connection-") && await page.locator("#freshActivity").isVisible()) {
        await page.locator("#freshActivity").screenshot({ path: path.join(proofs, name + "-refresh.png") });
    }
}

async function inspectSourcePaths(page) {
    await page.locator("#settingsSearch").fill("approved source paths");
    await page.locator('#settingsSearchResults a[data-setting="source-paths"]').click();
    await page.locator("#settingsSearch").press("Escape");
}

async function actionBoundary(control) {
    return control.evaluate(node => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        const rgba = value => {
            context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].map((channel, index) => index === 3 ? channel / 255 : channel);
        };
        const blend = (front, back) => front.slice(0, 3).map((channel, index) => channel * front[3] + back[index] * (1 - front[3]));
        function background(element) {
            if (!element) return [255, 255, 255];
            const fill = rgba(getComputedStyle(element).backgroundColor);
            return fill[3] === 1 ? fill.slice(0, 3) : blend(fill, background(element.parentElement));
        }
        const style = getComputedStyle(node), face = getComputedStyle(node, "::before");
        const surface = face.content !== "none" && face.zIndex === "-1" ? face : style;
        const outside = background(node.parentElement), fill = blend(rgba(surface.backgroundColor), outside);
        const border = blend(rgba(surface.borderTopColor), fill), rect = node.getBoundingClientRect();
        const rgb = value => `rgb(${value.join(",")})`;
        return { label: node.textContent.trim(), boundary: rgb(border), outside: rgb(outside), fill: rgb(fill), ink: style.color,
            borderWidth: parseFloat(surface.borderTopWidth), target: rect.height, focus: node.matches(":focus-visible"),
            outline: surface.outlineStyle !== "none" ? surface.outlineStyle : style.outlineStyle,
            bounds: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height } };
    });
}

async function geometry(page, selector = "[data-settings-section]:visible") {
    return page.locator(selector).evaluate(root => {
        const box = node => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        const visible = node => node.checkVisibility() && !node.closest(".visually-hidden");
        const target = node => node.matches("input[type=checkbox],input[type=radio]") ? node.closest("label") : node;
        function background(node) {
            while (node) {
                const value = getComputedStyle(node).backgroundColor;
                if (value !== "rgba(0, 0, 0, 0)" && value !== "transparent") return value;
                node = node.parentElement;
            }
            return getComputedStyle(document.body).backgroundColor;
        }
        const textBox = node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = range.getClientRects()[0];
            return rect ? { x: rect.x, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
        };
        const controls = [...root.querySelectorAll("button,a[href],input,summary,.ux-disabled-help[tabindex='0']")].filter(visible);
        function hitBox(node) {
            const rect = box(node);
            rect.x = Math.max(0, rect.x); rect.y = Math.max(0, rect.y);
            rect.right = Math.min(innerWidth, rect.right); rect.bottom = Math.min(innerHeight, rect.bottom);
            for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent), boundary = parent.getBoundingClientRect();
                if (style.overflowX !== "visible") {
                    rect.x = Math.max(rect.x, boundary.x + parent.clientLeft);
                    rect.right = Math.min(rect.right, boundary.x + parent.clientLeft + parent.clientWidth);
                }
                if (style.overflowY !== "visible") {
                    rect.y = Math.max(rect.y, boundary.y + parent.clientTop);
                    rect.bottom = Math.min(rect.bottom, boundary.y + parent.clientTop + parent.clientHeight);
                }
            }
            return rect;
        }
        const overlaps = [], searchOverlays = [];
        for (let index = 0; index < controls.length; index++) for (const other of controls.slice(index + 1)) {
            const first = target(controls[index]), second = target(other);
            if (first.contains(second) || second.contains(first)) continue;
            const a = hitBox(first), b = hitBox(second);
            if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) {
                const input = first.matches("input.search-capsule-input") ? first : second.matches("input.search-capsule-input") ? second : null;
                const clear = input === first ? second : first;
                // Clear occupies the native input's reserved inset, never its text region.
                if (input && clear.matches("button.search-capsule-clear") && input.parentElement === clear.parentElement) {
                    const field = box(input), button = box(clear), css = getComputedStyle(input);
                    const textEnd = field.right - parseFloat(css.paddingRight) - parseFloat(css.borderRightWidth);
                    const center = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
                    const onScreen = center.x >= 0 && center.x < innerWidth && center.y >= 0 && center.y < innerHeight;
                    const reachable = !onScreen || clear.contains(document.elementFromPoint(center.x, center.y));
                    if (button.width >= 44 && button.height >= 44 && button.x >= textEnd
                        && button.right <= field.right && button.y >= field.y && button.bottom <= field.bottom && reachable) {
                        searchOverlays.push({ input: input.id, clear: clear.id, textGap: button.x - textEnd,
                            width: button.width, height: button.height, hitTested: onScreen });
                        continue;
                    }
                }
                overlaps.push([controls[index].id || controls[index].textContent, other.id || other.textContent]);
            }
        }
        const alignment = [...root.querySelectorAll(".settings-task-row,.settings-display-field")].map(row => {
            const heading = row.querySelector("h3"), control = row.querySelector("button,a.button-link");
            if (!heading || !control) return null;
            if (control.matches(".theme-trigger")) {
                const label = textBox(heading), track = box(control.querySelector(".theme-track"));
                return label && track.x > label.right + 8 ? { label: heading.textContent,
                    difference: Math.abs((label.top + label.bottom) / 2 - (track.y + track.bottom) / 2) } : null;
            }
            const label = textBox(heading), value = textBox(control.querySelector(".select-value") || control);
            return label && value && value.x > label.right + 8 ? { label: heading.textContent, difference: Math.abs(label.bottom - value.bottom) } : null;
        }).filter(Boolean);
        const refreshTitle = root.querySelector(".fresh-activity>h3"), refreshIcon = root.querySelector("#checkActivity .wire-icon");
        if (refreshTitle && refreshIcon && visible(refreshTitle) && visible(refreshIcon)) {
            const label = textBox(refreshTitle), icon = box(refreshIcon);
            if (label && icon.x > label.right + 8) alignment.push({ label: "Recorded activity / Refresh icon",
                difference: Math.abs((label.top + label.bottom) / 2 - (icon.y + icon.bottom) / 2) });
        }
        return {
            category: root.dataset.settingsSection,
            overflow: document.documentElement.scrollWidth > innerWidth + 1 || root.scrollWidth > root.clientWidth + 1,
            heading: parseFloat(getComputedStyle(root.querySelector("h2")).fontSize),
            pageHeading: parseFloat(getComputedStyle(document.querySelector("#pageTitle")).fontSize),
            controls: controls.map(node => ({ id: node.id, text: node.textContent, ...box(target(node)) })),
            overlaps, searchOverlays,
            icons: [...root.querySelectorAll(".wire-icon")].filter(visible).map(node => {
                const owner = node.closest("button,a[href],summary"), style = getComputedStyle(node.parentElement);
                return { role: node.dataset.lucideIcon, display: box(node), target: owner ? box(owner) : null,
                    parentLineHeight: style.lineHeight, parentPadding: style.padding, parentGap: style.gap };
            }),
            text: [...root.querySelectorAll("p,label,summary,h3,dt,dd,.settings-value-label")].filter(node => visible(node) && node.textContent.trim())
                .map(node => ({ color: getComputedStyle(node).color, background: background(node), text: node.textContent })),
            alignment,
            clipped: [...root.querySelectorAll("button,label,summary,p,a")].filter(node => visible(node)
                && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)).map(node => node.id || node.textContent),
        };
    });
}

test("Settings normal entry presents all four current sections with coherent hierarchy at desktop, narrow and doubled text", { timeout: 90000 }, async t => {
    const { page } = await setup(t), measures = [];
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        for (const category of categories) {
            await navigateSettings(page, category);
            await capture(page, `${category}-${width}-${scale}x-${theme}`);
            measures.push({ theme, width, scale, ...await geometry(page) });
        }
    }
    if (proofs) await writeFile(path.join(proofs, "geometry.json"), JSON.stringify(measures, null, 2));
    for (const result of measures) {
        const context = `${result.category}/${result.theme}/${result.width}/${result.scale}`;
        assert.equal(result.overflow, false, context + " stays within the page");
        assert.deepEqual(result.clipped, [], context + " wraps rather than clipping");
        assert.deepEqual(result.overlaps, [], context + " keeps distinct hit targets separate");
        assert.ok(result.heading < result.pageHeading, context + " section heading is subordinate to the page");
        for (const control of result.controls) assert.ok(control.height >= 44 && control.width >= 44,
            `${context}: ${control.id || control.text} keeps a 44px target`);
        for (const text of result.text) assert.ok(contrast(text.color, text.background) >= 4.5, context + ": " + text.text);
        for (const row of result.alignment) assert.ok(row.difference <= 4, `${context}: ${row.label} aligns with its control text (${row.difference}px)`);
    }
});

test("Settings action boundaries remain clearly visible against their surface in both themes", { timeout: 30000 }, async t => {
    const { page } = await setup(t), measurements = [];
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const [category, selectors] of [
            ["privacy", ["#recollectActivity", '[data-settings-section=privacy] a.button-link']],
            ["connection", ["#editSource", "#pauseCollection"]],
            ["troubleshooting", ['[data-settings-section=troubleshooting] a.button-link']],
        ]) {
            await navigateSettings(page, category);
            await capture(page, `action-boundaries-${category}-${theme}`);
            for (const selector of selectors) for (const control of await page.locator(selector).all()) {
                measurements.push({ theme, category, ...await actionBoundary(control) });
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "action-boundaries.json"), JSON.stringify(measurements, null, 2));
    const faint = measurements.filter(value => value.borderWidth < 1 || contrast(value.boundary, value.outside) < 3);
    assert.deepEqual(faint.map(value => ({ theme: value.theme, label: value.label,
        boundaryContrast: contrast(value.boundary, value.outside), borderWidth: value.borderWidth })), [],
    "Enabled action shapes need a visible boundary, not a near-invisible shadow");
    for (const value of measurements) {
        assert.ok(contrast(value.ink, value.fill) >= 4.5, value.label);
        assert.ok(value.target >= 44, value.label);
    }
});

test("Settings action edges stay visible through real hover, press, focus and narrow layouts without changing roles", { timeout: 45000 }, async t => {
    const { page, posts } = await setup(t), measurements = [];
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const settle = () => page.waitForFunction(() => !document.getAnimations().some(animation =>
        animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale * 100 + "%"; }, scale);
        await chooseTheme(page, theme);
        await navigateSettings(page, "privacy");
        for (const selector of ["#recollectActivity", '[data-settings-section=privacy] a.button-link']) {
            const control = page.locator(selector), states = [];
            await control.scrollIntoViewIfNeeded();
            await page.mouse.move(0, 0); await settle();
            states.push({ state: "rest", ...await actionBoundary(control) });
            await control.hover(); await settle();
            states.push({ state: "hover", ...await actionBoundary(control) });
            await page.mouse.down(); await settle();
            states.push({ state: "pressed", ...await actionBoundary(control) });
            await page.mouse.move(0, 0); await page.mouse.up(); await settle();
            await control.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
            await expect(control).toBeFocused();
            states.push({ state: "focus", ...await actionBoundary(control) });
            assert.equal(states[3].focus, true);
            assert.equal(states[3].outline, "solid");
            assert.notEqual(states[0].fill, states[1].fill, "Hover remains distinct from rest");
            assert.notEqual(states[1].fill, states[2].fill, "Pressed remains distinct from hover");
            for (const state of states) {
                assert.ok(contrast(state.boundary, state.outside) >= 3, `${theme}/${width}/${scale}/${state.label}/${state.state}`);
                assert.ok(contrast(state.ink, state.fill) >= 4.5, state.label);
                assert.deepEqual(state.bounds, states[0].bounds, "Interaction must not resize or move the button");
            }
            measurements.push({ theme, width, scale, states });
        }
        const danger = await actionBoundary(page.locator("#deleteActivity"));
        assert.notEqual(danger.ink, measurements.at(-1).states[0].ink, "Destructive actions retain their distinct red treatment");
        assert.ok(contrast(danger.boundary, danger.outside) >= 3);
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
        await capture(page, `action-states-${theme}-${width}-${scale}x`);
        await page.locator("#recollectActivity").focus(); await page.keyboard.press("Space");
        await expect(page.locator("#recollectDialog")).toBeVisible();
        await expect(page.locator("#recollectSources input").first()).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator("#recollectDialog")).toBeHidden();
        await expect(page.locator("#recollectActivity")).toBeFocused();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const reports = page.locator('[data-settings-section=privacy] a.button-link');
        await reports.focus(); await expect(reports).toBeFocused(); await reports.press("Enter");
        await expect(page.locator("#reportsView")).toBeVisible();
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        await expect(page.locator("#saveCollection")).toBeDisabled();
        const disabled = await actionBoundary(page.locator("#saveCollection"));
        assert.ok(contrast(disabled.boundary, disabled.outside) < 3, "Disabled actions do not borrow an enabled boundary");
        await page.locator("#saveCollection").locator("..").focus();
        await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
        await expect(page.locator("#saveCollection").locator("..")).toBeFocused();
        assert.equal(await page.locator("#saveCollection").evaluate(node => getComputedStyle(node, "::before").outlineStyle), "solid");
        await openSourceEditor(page);
        const cancel = await actionBoundary(page.locator("#cancelSource"));
        assert.equal(contrast(cancel.boundary, cancel.outside), 1, "Quiet cancellation stays unboxed");
        await page.locator("#cancelSource").click();
        await navigateSettings(page, "display");
        assert.deepEqual(await page.locator("#settingsThemePreference .theme-track").evaluate(node => {
            const box = node.getBoundingClientRect(); return { width: box.width, height: box.height };
        }), { width: 76, height: 36 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.emulateMedia({ forcedColors: "active" });
    await navigateSettings(page, "privacy");
    const forced = await actionBoundary(page.locator("#recollectActivity"));
    assert.ok(contrast(forced.boundary, forced.outside) >= 3);
    await capture(page, "action-boundaries-forced-colors");
    assert.equal(posts.some(value => /\/(?:confirm|approve|set|revoke|configure|enabled|now)$/.test(value)), false);
    if (proofs) await writeFile(path.join(proofs, "action-states.json"), JSON.stringify(measurements, null, 2));
});

test("Settings button family keeps visible labels, compact faces and balanced icon/text geometry in complete rows", { timeout: 45000 }, async t => {
    const { page, posts } = await setup(t), measurements = [];
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator("#checkActivity")).toHaveText("Check GitHub");
    await expect(page.locator("#checkActivity .settings-action-label")).toBeVisible();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "idle");
    const original = await page.locator("#checkActivity").elementHandle();
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale * 100 + "%"; }, scale);
        await chooseTheme(page, theme);
        await navigateSettings(page, "connection");
        await expect(page.locator("#checkActivity")).toHaveAccessibleName("Check GitHub");
        await expect(page.locator("#freshActivity")).toContainText("Collection stays paused.");
        const value = await page.locator("#checkActivity").evaluate(node => {
            const box = node.getBoundingClientRect(), style = getComputedStyle(node), face = getComputedStyle(node, "::before");
            const label = node.querySelector(".settings-action-label"), labelBox = label.getBoundingClientRect();
            const glyph = node.querySelector(".wire-icon"), glyphBox = glyph.getBoundingClientRect(), ink = glyph.getBBox();
            const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
            context.font = style.font;
            const textInk = context.measureText(label.textContent);
            const heading = document.getElementById("freshHeading").getBoundingClientRect();
            const description = document.getElementById("settingsRefreshContext").getBoundingClientRect();
            const actions = document.getElementById("preferenceActions"), fields = document.getElementById("collectionPreferenceFields");
            const symbolHeight = ink.height * glyphBox.height / glyph.viewBox.baseVal.height;
            const line = parseFloat(style.lineHeight), inset = parseFloat(face.top), faceHeight = box.height - inset - parseFloat(face.bottom);
            return { target: { width: box.width, height: box.height }, face: { height: faceHeight, inset, radius: parseFloat(face.borderRadius) },
                text: { font: style.fontFamily, size: parseFloat(style.fontSize), line, ink: textInk.actualBoundingBoxAscent + textInk.actualBoundingBoxDescent },
                symbol: { role: glyph.dataset.lucideIcon, box: glyphBox.height, ink: symbolHeight },
                gap: labelBox.left - glyphBox.right, centering: Math.abs(glyphBox.y + glyphBox.height / 2 - (labelBox.y + labelBox.height / 2)),
                horizontalPadding: [glyphBox.left - box.left, box.right - labelBox.right],
                row: { headingY: heading.y, headingBottom: heading.bottom, buttonY: box.y, buttonRight: box.right,
                    descriptionY: description.y, descriptionBottom: description.bottom, headingRight: heading.right },
                footer: { gap: actions.getBoundingClientRect().top - fields.getBoundingClientRect().bottom, padding: parseFloat(getComputedStyle(actions).paddingTop) },
                descriptionInsideButton: node.contains(document.getElementById("settingsRefreshContext")),
                facePadding: (faceHeight - line) / 2 };
        });
        assert.ok(value.target.height >= 44);
        assert.equal(value.face.inset, 6);
        assert.equal(value.facePadding, 6, "Visible padding belongs to the label, not the entire hit target");
        assert.equal(value.face.radius, 8);
        assert.ok(value.centering <= 1);
        assert.ok(value.symbol.ink / value.text.ink >= .9 && value.symbol.ink / value.text.ink <= 1.5,
            "Painted Lucide ink stays proportional to the real label ink");
        assert.ok(value.gap >= 5 * scale && value.gap <= 6 * scale);
        for (const padding of value.horizontalPadding) assert.ok(padding >= 9 && padding <= 11);
        assert.equal(value.descriptionInsideButton, false);
        assert.deepEqual(value.footer, { gap: 16, padding: 0 }, "Form actions use one deliberate gap, not stacked padding");
        if (width === 1440) {
            assert.ok(value.row.buttonRight > value.row.headingRight);
            assert.ok(Math.abs(value.row.buttonY - value.row.headingY) <= 1, "Action aligns with the owning heading row");
        } else assert.ok(value.row.buttonY >= value.row.descriptionBottom + 7, "Narrow order is title, purpose, action");
        await capture(page, `button-family-${theme}-${width}-${scale}x`);
        measurements.push({ theme, width, scale, ...value });
        await navigateSettings(page, "privacy");
        for (const selector of ["#recollectActivity", '[data-settings-section=privacy] a.button-link']) {
            const geometry = await page.locator(selector).evaluate(node => {
                const box = node.getBoundingClientRect(), style = getComputedStyle(node), face = getComputedStyle(node, "::before");
                return { target: box.height, face: box.height - parseFloat(face.top) - parseFloat(face.bottom), line: parseFloat(style.lineHeight) };
            });
            assert.ok(geometry.target >= 44);
            assert.equal((geometry.face - geometry.line) / 2, 6);
        }
        await navigateMain(page, "analyze");
        assert.equal(await original.evaluate(node => node === document.getElementById("checkActivity")), true);
        await expect(page.locator("#checkActivity")).toHaveClass(/icon-only/);
        await expect(page.locator("#checkActivity .settings-action-label")).toBeHidden();
        await expect(page.locator("#checkActivity")).not.toBeVisible();
        await navigateMain(page, "settings");
    }
    assert.equal(posts.some(value => /\/(?:configure|enabled|now|confirm)$/.test(value)), false);
    if (proofs) await writeFile(path.join(proofs, "button-family-geometry.json"), JSON.stringify(measurements, null, 2));
});

test("Settings search locates without acting; source and preference drafts survive navigation and cancel", { timeout: 30000 }, async t => {
    const { page, runtime, posts, config } = await setup(t);
    await page.locator("#settingsSearch").fill("delete");
    await page.locator('#settingsSearchResults a[data-setting="delete-activity"]').click();
    await expect(page.locator("#deleteActivity")).toBeFocused();
    await expect(page.locator("#deleteDialog")).not.toBeVisible();
    assert.equal(posts.includes("/api/deletion/preview"), false);
    await page.locator("#settingsSearch").focus(); await page.keyboard.press("Escape");
    await expect(page.locator("#settingsSearchResults")).not.toBeVisible();
    for (const alias of ["history", "collection"]) {
        await page.goto(runtime.url + `#settings?section=${alias}`);
        await expect(page.locator("#collectionWindow-control")).toBeFocused();
    }
    await selectActivityOption(page, "collectionCadence", "15");
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await expect(page.locator("#settingsDraftStatus")).toContainText("Unsaved changes");
    await navigateSettings(page, "display");
    await navigateSettings(page, "connection");
    await expect(page.locator("#collectionCadence")).toHaveValue("15");
    await page.locator("#cancelPreferences").click();
    await expect(page.locator("#collectionCadence")).toHaveValue("5");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await openSourceEditor(page);
    await page.locator("#sourceSessions").fill(config.sessionRoot + "-draft");
    await navigateMain(page, "analyze");
    await expect(page.locator("#settingsDraftNotice")).toBeVisible();
    await page.locator("#settingsDraftNotice a").click();
    await expect(page.locator("#sourceSessions")).toHaveValue(config.sessionRoot + "-draft");
    await page.locator("#cancelSource").click();
    await expect(page.locator("#sourceSessions")).toHaveValue(config.sessionRoot);
    await expect(page.locator("#editSource")).toBeFocused();
    assert.equal(posts.some(value => /\/(?:configure|enabled|now|confirm)$/.test(value)), false);
});

test("Settings expanded permission, source, unknown billing and privacy previews stay readable without authorizing work", { timeout: 90000 }, async t => {
    const { page, posts } = await setup(t, { unknownBilling: true }), measures = [];
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await navigateSettings(page, "connection");
        await openSourceEditor(page);
        await capture(page, `source-editor-${width}-${scale}x-${theme}`);
        measures.push({ theme, width, scale, ...await geometry(page) });
        await page.locator("#cancelSource").click();
        await navigateSettings(page, "privacy");
        const checkbox = page.locator("#assessmentSetup input[type=checkbox]");
        await checkbox.check();
        await expect(page.locator(".assessment-capture-details")).toContainText("This does not send them to another service.");
        await capture(page, `reply-draft-${width}-${scale}x-${theme}`);
        measures.push({ theme, width, scale, ...await geometry(page) });
        await page.getByRole("button", { name: "Discard change", exact: true }).click();
        await expect(checkbox).not.toBeChecked();
        await expect(checkbox).toBeFocused();
        await page.locator("#deleteActivity").click();
        await expect(page.locator("#deleteCancel")).toBeFocused();
        await page.locator("#deleteAll").check();
        await page.locator("#deletePreview").click();
        await expect(page.locator("#deleteConfirmation")).toBeVisible();
        await capture(page, `deletion-preview-${width}-${scale}x-${theme}`);
        measures.push({ theme, width, scale, ...await geometry(page, "#deleteDialog") });
        await page.locator("#deleteCancel").click();
        await expect(page.locator("#deleteActivity")).toBeFocused();
        await page.locator("#recollectActivity").click();
        await expect(page.locator("#recollectSources input").first()).toBeVisible();
        await capture(page, `recollection-scope-${width}-${scale}x-${theme}`);
        measures.push({ theme, width, scale, ...await geometry(page, "#recollectDialog") });
        await page.locator("#recollectClose").click();
        await expect(page.locator("#recollectActivity")).toBeFocused();
        await expect(page.locator("#automaticScoreSetup,[data-category=ai]")).toHaveCount(0);
    }
    if (proofs) await writeFile(path.join(proofs, "expanded-geometry.json"), JSON.stringify(measures, null, 2));
    for (const result of measures) {
        assert.equal(result.overflow, false, JSON.stringify(result));
        assert.deepEqual(result.clipped, []);
        assert.deepEqual(result.overlaps, [], "Expanded controls never overlap adjacent hit targets");
        for (const control of result.controls) assert.ok(control.height >= 44, `${control.id || control.text} keeps a 44px target`);
        for (const text of result.text) assert.ok(contrast(text.color, text.background) >= 4.5, text.text);
    }
    assert.equal(posts.some(value => /\/(?:confirm|approve|set|revoke|now)$/.test(value)), false);
});

test("Settings global Search preserves old phrases and receipt-bound focus; Display remains browser-local", { timeout: 45000 }, async t => {
    const { page, posts } = await setup(t);
    for (const [query, title, target] of [
        ["Delete collected activity", "Review deletion", "#deleteActivity"],
        ["Initial history window", "History to include", "#collectionWindow-control"],
        ["Time zone", "Time zone", "#displayTimeZone-control"],
    ]) {
        await page.locator("#wireSearch").fill(query);
        await selectActivityOption(page, "wireSearchType", "setting");
        const row = page.locator("#wireSearchResults button").filter({ has: page.locator(".wire-search-title", { hasText: title }) });
        await expect(row).toHaveCount(1);
        await row.click();
        await expect(page.locator(target)).toBeFocused();
        await expect(page.locator("#deleteDialog")).not.toBeVisible();
    }
    await expect(page.locator("#sidebarMotionPreference")).toHaveCount(0);
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#sidebarMotionPreference")).toHaveCount(0);
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.sidebar-motion")), null);
    await selectActivityOption(page, "displayTimeZone", "UTC");
    await expect(page.locator("#displayTimeZone")).toHaveValue("UTC");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.time-zone")), "UTC");
    assert.equal(posts.some(value => /\/(?:confirm|approve|set|revoke|configure|enabled|now)$/.test(value)), false);
});

test("Settings source errors and pending unknown saves retain visible recovery without replay", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    let writes = 0, release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/collection/configure", async route => {
        writes++;
        await held;
        await route.abort("failed");
    });
    await selectActivityOption(page, "collectionCadence", "15");
    await page.locator("#saveCollection").click();
    await expect(page.locator("#collectionCadence")).toBeDisabled();
    await expect(page.locator("#settingsDraftStatus")).toContainText("Saving");
    const pendingGeometry = await geometry(page);
    assert.deepEqual(pendingGeometry.overlaps, []);
    assert.deepEqual(pendingGeometry.clipped, []);
    if (proofs) await writeFile(path.join(proofs, "pending-geometry.json"), JSON.stringify(pendingGeometry, null, 2));
    await capture(page, "connection-save-pending");
    await page.locator('#settingsCategoryNav a[data-category="privacy"]').click();
    await expect(page.locator("[data-settings-section=connection]")).toBeVisible();
    await expect(page.locator("#message")).toContainText("Wait for the current local save to finish");
    release();
    await expect(page.locator("#reloadSettings")).toBeVisible();
    await expect(page.locator("#settingsMessage")).toContainText("unconfirmed");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await expect(page.locator("#message")).toBeHidden();
    await expect(page.locator("#reloadSettings")).toBeEnabled();
    await expect(page.locator("[data-settings-section=connection]")).toBeVisible();
    await capture(page, "connection-save-unknown");
    await page.locator("#reloadSettings").click();
    await expect(page.locator("#reloadSettings")).not.toBeVisible();
    assert.equal(writes, 1, "Read-only recovery never resubmits the save");
    await page.locator("#cancelPreferences").click();
    await page.route("**/api/collection/status", route => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic status read unavailable." }),
    }));
    const failedRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/collection/status" && response.status() === 503);
    await page.reload();
    await failedRead;
    await expect(page.locator("#settingsConnectionError")).toContainText("could not be read");
    await expect(page.locator("#reloadSettings")).toBeVisible();
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await capture(page, `connection-status-error-${width}-${theme}`);
        const layout = await geometry(page);
        assert.equal(layout.overflow, false);
        assert.deepEqual(layout.clipped, []);
        assert.deepEqual(layout.overlaps, []);
    }
    assert.equal(writes, 1);
});

test("settled Settings save retires its blocked-history announcement without replaying navigation", { timeout: 30000 }, async t => {
    const { page, runtime } = await setup(t, { preferenceSave: true });
    const held = Promise.withResolvers();
    let writes = 0;
    t.after(() => held.resolve());
    await page.route("**/api/collection/configure", async route => {
        writes++;
        await held.promise;
        await route.fallback();
    });
    await selectActivityOption(page, "collectionCadence", "15");
    await page.locator("#saveCollection").click();
    await expect(page.locator("#collectionCadence")).toBeDisabled();
    await page.evaluate(() => { location.hash = "#settings?section=privacy"; });
    await expect(page.locator("#message.pending-save")).toContainText("Wait for the current local save to finish");
    await expect(page.locator("[data-settings-section=connection]")).toBeVisible();
    await expect(page).toHaveURL(/#settings\?section=connection$/);
    held.resolve();
    await expect(page.locator("#settingsMessage")).toContainText("Preferences saved.");
    await expect(page.locator("#message")).toBeHidden();
    await expect(page.locator("[data-settings-section=connection]")).toBeVisible();
    assert.equal((await runtime.collector.status()).config.pollSeconds, 15);
    assert.equal(writes, 1);
    await navigateSettings(page, "privacy");
    await expect(page.locator("[data-settings-section=privacy]")).toBeVisible();
    assert.equal(writes, 1);
});

test("unknown Settings save preserves an unrelated newer announcement", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { announcementProbe: true });
    const held = Promise.withResolvers();
    let writes = 0;
    t.after(() => held.resolve());
    await page.route("**/api/collection/configure", async route => {
        writes++;
        await held.promise;
        await route.abort("failed");
    });
    await selectActivityOption(page, "collectionCadence", "15");
    await page.locator("#saveCollection").click();
    await expect(page.locator("#collectionCadence")).toBeDisabled();
    await page.locator('#settingsCategoryNav a[data-category="privacy"]').click();
    await expect(page.locator("#message.pending-save")).toBeVisible();
    await page.evaluate(() => settingsAnnounceForTest("Synthetic newer status.", "stale"));
    held.resolve();
    await expect(page.locator("#settingsMessage")).toContainText("unconfirmed");
    await expect(page.locator("#reloadSettings")).toBeEnabled();
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await expect(page.locator("#message.stale")).toHaveText("Synthetic newer status.");
    await expect(page.locator("#message")).toBeVisible();
    assert.equal(writes, 1);
});

test("Settings disclosure, search-empty and popup controls remain reachable without diagnostic or privacy execution", { timeout: 60000 }, async t => {
    const { page, posts } = await setup(t);
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await navigateSettings(page, "troubleshooting");
        for (const id of ["serviceProvenanceHelp", "authorProvenanceHelp", "settingsSearchDetails"]) {
            const details = page.locator("#" + id);
            if (!await details.evaluate(node => node.open)) await details.locator("summary").click();
        }
        await capture(page, `troubleshooting-expanded-${width}-${theme}`);
        await page.locator("#settingsSearch").fill("no-such-setting");
        await expect(page.locator("#settingsSearchCount")).toContainText("No settings match");
        await capture(page, `settings-empty-search-${width}-${theme}`);
        await page.locator("#settingsSearch").press("Escape");
        await expect(page.locator("#settingsSearch")).toHaveValue("");
        await navigateSettings(page, "display");
        for (const id of ["displayTimeZone"]) {
            const trigger = page.locator(`#${id}-control`);
            await trigger.focus();
            await page.keyboard.press("Enter");
            await expect(trigger).toHaveAttribute("aria-expanded", "true");
            const box = await page.locator(".select-popup").boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
            await capture(page, `${id}-options-${width}-${theme}`);
            await page.keyboard.press("Escape");
            await expect(trigger).toBeFocused();
        }
    }
    await page.locator(".settings-status-link a").click();
    await expect(page.locator("#collectionStatusView")).toBeVisible();
    for (const id of ["collectionSetup", "recorderDiagnostics"]) {
        const details = page.locator("#" + id);
        if (!await details.evaluate(node => node.open)) await details.locator("summary").click();
    }
    await expect(page.locator("#recorderPurpose")).toContainText("not collection");
    await capture(page, "collection-status-expanded");
    assert.equal(posts.includes("/api/record"), false);
});

test("Settings saved preferences persist in the isolated source without resuming collection or changing evidence", { timeout: 30000 }, async t => {
    const { page, runtime, posts, config } = await setup(t, { preferenceSave: true });
    await selectActivityOption(page, "collectionCadence", "15");
    await expect(page.locator("#settingsDraftStatus")).toContainText("Unsaved changes");
    await capture(page, "connection-preferences-dirty");
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Preferences saved.");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    const status = await runtime.collector.status();
    assert.equal(status.config.pollSeconds, 15);
    assert.equal(status.config.appDbPath, config.appDbPath);
    assert.equal(status.config.enabled, false);
    await capture(page, "connection-preferences-saved");
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#collectionCadence")).toHaveValue("15");
    assert.equal(posts.filter(value => value === "/api/collection/configure").length, 1);
    assert.equal(posts.some(value => /\/(?:confirm|approve|set|revoke|enabled|now)$/.test(value)), false);
});

test("Settings distinguishes labels, source permission and collection state without redundant headings", { timeout: 30000 }, async t => {
    const { page, posts } = await setup(t), measurements = [];
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await expect(page.locator("#connectionSourceTitle")).toHaveText("GitHub Copilot app");
        await expect(page.locator("#connectionSource").getByText("WIRE uses the GitHub Copilot app by default.", { exact: true })).toHaveCount(0);
        await expect(page.locator("#connectionSource")).not.toContainText("Source permission");
        await expect(page.locator("#approvedConnection")).toBeVisible();
        await expect(page.locator("#connectionStatus")).toHaveText("Paused");
        await expect(page.locator("#connectionSource").getByText("GitHub Copilot app", { exact: true })).toHaveCount(1);
        await inspectSourcePaths(page);
        const paths = await page.locator(".settings-paths").evaluate(root => {
            const labels = [...root.querySelectorAll("dt")], values = [...root.querySelectorAll("dd")];
            return labels.map((label, index) => ({
                labelColor: getComputedStyle(label).color, valueColor: getComputedStyle(values[index]).color,
                labelLeft: label.getBoundingClientRect().left, valueLeft: values[index].getBoundingClientRect().left,
                labelBottom: label.getBoundingClientRect().bottom, valueTop: values[index].getBoundingClientRect().top,
                value: values[index].textContent, selectable: getComputedStyle(values[index]).userSelect !== "none",
            }));
        });
        for (const item of paths) {
            assert.notEqual(item.labelColor, item.valueColor);
            assert.equal(item.labelLeft, item.valueLeft);
            assert.ok(item.valueTop >= item.labelBottom);
            assert.ok(item.valueTop - item.labelBottom <= 6, "Read-only source values have no utility-sized blank line");
            assert.equal(item.selectable, true);
            assert.ok(item.value.length > 0);
        }
        measurements.push({ theme, paths });
        await capture(page, `source-labels-${theme}`);
        await expect(page.locator("#automaticScoreSetup,[data-category=ai]")).toHaveCount(0);
        await navigateSettings(page, "connection");
    }
    if (proofs) await writeFile(path.join(proofs, "label-value-geometry.json"), JSON.stringify(measurements, null, 2));
    assert.equal(posts.some(value => /\/(?:confirm|approve|set|revoke|configure|enabled|now)$/.test(value)), false);
});

test("Settings unapproved-source presentation reviews paths without granting permission", { timeout: 30000 }, async t => {
    const { page, runtime, config, posts } = await setup(t);
    const status = { ...await runtime.collector.status(), config: null, connected: false, state: "not-configured",
        suggestedSource: { appDbPath: config.appDbPath, sessionRoot: config.sessionRoot, windowDays: 30, pollSeconds: 5 } };
    // Simulate disconnection without letting default-source discovery inspect the user's machine.
    await page.route("**/api/collection/status", route => route.fulfill({ json: status }));
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), data = await response.json();
        await route.fulfill({ response, json: { ...data, collection: status } });
    });
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#connectionStatus")).toHaveText("Not connected");
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await capture(page, `source-unapproved-${width}-${theme}`);
        await page.locator("#reviewSource").click();
        await expect(page.locator("#sourceDatabase")).toBeFocused();
        await expect(page.locator("#sourceDatabase")).toHaveValue(config.appDbPath);
        await expect(page.locator("#connectCollection")).toBeEnabled();
        await expect(page.locator("#sourceSuggestion")).toBeHidden();
        await expect(page.locator("#approvalScope")).toContainText("original prompts");
        await capture(page, `source-permission-review-${width}-${theme}`);
        const measure = await geometry(page);
        assert.equal(measure.overflow, false);
        assert.deepEqual(measure.clipped, []);
        await page.locator("#cancelSource").click();
        await expect(page.locator("#reviewSource")).toBeFocused();
        await expect(page.locator("#sourceEditor")).not.toBeVisible();
    }
    assert.equal(posts.some(value => /\/(?:configure|enabled|now)$/.test(value)), false);
});

test("Settings utility and disabled-help hit areas preserve reading geometry through hover and keyboard focus", { timeout: 45000 }, async t => {
    const { page } = await setup(t), measurements = [];
    async function readingBoxes() {
        return page.locator("#settingsView").evaluate(root => [...root.querySelectorAll("h3,.settings-field label,.settings-paths dt,.settings-paths dd,.settings-row-copy p")]
            .filter(node => node.checkVisibility()).map(node => {
                const rect = node.getBoundingClientRect();
                return { text: node.textContent, x: rect.x, y: rect.y + scrollY, width: rect.width, height: rect.height };
            }));
    }
    await inspectSourcePaths(page);
    await page.locator("#settingsSearch").fill("no-such-setting");
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        for (const control of [page.locator("#clearSettingsSearch"), page.locator("#saveCollection").locator("..")]) {
            await control.scrollIntoViewIfNeeded();
            const before = await readingBoxes();
            await control.hover();
            assert.deepEqual(await readingBoxes(), before, "Hover cannot move labels, paths or helpers");
            await page.keyboard.press("Tab");
            await control.focus();
            await expect(control).toBeFocused();
            assert.deepEqual(await readingBoxes(), before, "Focus cannot add utility-sized spacing");
            assert.equal(await control.evaluate(node => node.matches(".ux-disabled-help")
                ? getComputedStyle(node.querySelector("button"), "::before").outlineStyle : getComputedStyle(node).outlineStyle), "solid");
            const bounds = await control.boundingBox();
            assert.ok(bounds.height >= 44 && bounds.width >= 44);
        }
        const measure = await geometry(page, "#settingsView");
        assert.deepEqual(measure.overlaps, []);
        assert.deepEqual(measure.clipped, []);
        measurements.push({ theme, width, scale, ...measure });
    }
    const input = page.locator("#settingsSearch"), clear = page.locator("#clearSettingsSearch");
    await clear.scrollIntoViewIfNeeded();
    const safe = await geometry(page, "#settingsView");
    assert.deepEqual(safe.overlaps, []);
    assert.ok(safe.searchOverlays.some(value => value.input === "settingsSearch" && value.hitTested && value.textGap >= 0));
    await input.evaluate(node => { node.style.paddingRight = "0px"; });
    try {
        const unsafe = await geometry(page, "#settingsView");
        assert.ok(unsafe.overlaps.some(pair => pair.includes("settingsSearch") && pair.includes("clearSettingsSearch")),
            "Missing text clearance must still fail the overlap check");
    } finally { await input.evaluate(node => node.style.removeProperty("padding-right")); }
    await clear.click();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    if (proofs) await writeFile(path.join(proofs, "utility-geometry.json"), JSON.stringify(measurements, null, 2));
});

test("Settings Refresh is one task without a help gate and preserves read-only detail identity across navigation", { timeout: 60000 }, async t => {
    const { page, runtime, context } = await setup(t), observations = [];
    let sourceChecks = 0, snapshotReads = 0, release;
    const pending = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/snapshot") snapshotReads++; });
    const status = await runtime.collector.status(), state = await loadBoardState(context);
    await page.route("**/api/collection/now", async route => {
        sourceChecks++;
        await pending;
        return route.fulfill({ json: { ...status, check: {
            schemaVersion: 2, id: "settings-partial-check", revision: state.revision, configVersion: status.configVersion,
            startedAt: new Date(Date.now() - 500).toISOString(), completedAt: new Date().toISOString(),
            outcome: "partial", changes: { added: 0, updated: 0, items: [] }, sourcesChecked: 1, eligibleSources: 2,
            pendingSources: 1, partialSources: 0, skippedSources: 0,
            coverage: { unavailable: 1, groups: { "missing-history": 1 } },
        } } });
    });
    await expect(page.locator("#freshHelp")).not.toBeVisible();
    await expect(page.locator("#settingsRefreshContext")).toContainText("Collection stays paused");
    const refreshBounds = await page.locator("#checkActivity").boundingBox();
    await page.locator("#checkActivity").click({ position: { x: refreshBounds.width / 2, y: 2 } });
    await expect(page.locator("#checkActivity")).toBeDisabled();
    await expect(page.locator("#checkActivity")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#checkActivity")).toHaveText("Check GitHub");
    await expect(page.locator("#settingsDraftStatus")).toBeHidden();
    assert.equal((await page.locator("#checkActivity").boundingBox()).width, refreshBounds.width);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale * 100 + "%"; }, scale);
        await chooseTheme(page, theme);
        await capture(page, `connection-refresh-pending-${theme}-${width}-${scale}x`);
        assert.equal(await page.locator("#checkActivity .wire-icon").evaluate(node => node.getBoundingClientRect().width), 16 * scale);
        const layout = await geometry(page);
        assert.equal(layout.overflow, false);
        assert.deepEqual(layout.clipped, []);
        assert.deepEqual(layout.overlaps, []);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    assert.equal(sourceChecks, 1);
    release();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "partial");
    await expect(page.locator("#freshCheckDetails")).toContainText("Partial check");
    await expect(page.locator("#freshCheckDetails")).not.toBeVisible();
    await expect(page.locator("#freshCoverageDetails")).not.toBeVisible();
    await expect(page.locator("#freshStatus")).toHaveText("No additional activity in this check.");
    await expect(page.locator("#settingsRefreshDetails")).toHaveCount(0);
    await expect(page.locator("#freshCheckDetails")).toContainText("Checked 1 of 2");
    await expect(page.locator("#freshCheckDetails")).toContainText("1 still reading");
    await expect(page.locator("#freshCoverageAnnouncement")).toBeVisible();
    await expect(page.locator("#freshCoverageAnnouncement")).toContainText("more history remains to read");
    await expect(page.locator("#freshIssues")).toBeHidden();
    assert.equal(sourceChecks, 1);
    await page.evaluate(() => {
        window.settingsDetailIdentity = ["freshCheckDetails", "freshCoverageDetails", "freshResult", "checkActivity"]
            .map(id => document.getElementById(id));
    });
    async function observe(name) {
        const value = await page.evaluate(() => ({
            identity: window.settingsDetailIdentity.every(node => node === document.getElementById(node.id)),
            detailHome: document.getElementById("freshCheckDetails").parentElement.id,
            resultLast: document.querySelector(".fresh-controls").lastElementChild.id,
            helpOpen: document.getElementById("freshHelp").open,
            helpHidden: document.getElementById("freshHelp").hidden,
            checkId: document.getElementById("freshCoverageDetails").dataset.checkId,
        }));
        assert.equal(value.identity, true);
        assert.equal(value.resultLast, "freshResult");
        assert.equal(value.checkId, "settings-partial-check");
        observations.push({ name, sourceChecks, snapshotReads, ...value });
        return value;
    }
    const readsBefore = snapshotReads;
    assert.equal((await observe("Connection")).detailHome, "freshHelpBody");
    await navigateSettings(page, "display");
    assert.equal((await observe("Display")).detailHome, "freshHelpBody");
    await navigateMain(page, "collection-status");
    assert.equal((await observe("Collection status")).helpHidden, false);
    if (!await page.locator("#freshHelp").evaluate(node => node.open)) await page.locator("#freshHelp > summary").click();
    await page.goBack();
    await expect(page.locator("[data-settings-section=display]")).toBeVisible();
    await page.goBack();
    await expect(page.locator("[data-settings-section=connection]")).toBeVisible();
    const restored = await observe("Back to Connection");
    assert.equal(restored.detailHome, "freshHelpBody");
    assert.equal(restored.helpOpen, true, "Hiding the gate does not discard the other surface's disclosure state");
    assert.equal(sourceChecks, 1, "Navigation never repeats a source check");
    assert.equal(snapshotReads, readsBefore, "Moving read-only details requires no snapshot read");
    await expect(page.locator("#checkActivity")).toBeVisible();
    await expect(page.locator("#refreshBtn")).not.toBeVisible();
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await capture(page, `connection-partial-${width}-${theme}`);
    }
    await selectActivityOption(page, "collectionCadence", "15");
    await expect(page.locator("#checkActivity")).toBeDisabled();
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale * 100 + "%"; }, scale);
        await chooseTheme(page, theme);
        await expect(page.locator("#freshStoredRead")).toBeDisabled();
        const layout = await geometry(page);
        assert.equal(layout.overflow, false);
        assert.deepEqual(layout.clipped, []);
        assert.deepEqual(layout.overlaps, []);
        await capture(page, `connection-refresh-disabled-${theme}-${width}-${scale}x`);
    }
    await page.locator("#cancelPreferences").click();
    await expect(page.locator("#checkActivity")).toBeEnabled();
    if (proofs) await writeFile(path.join(proofs, "refresh-navigation.json"), JSON.stringify(observations, null, 2));
});

test("Source review combines paths and preferences in one decision without granting fresh permission for preference-only edits", { timeout: 30000 }, async t => {
    const { page, config, runtime, posts } = await setup(t, { preferenceSave: true });
    await expect(page.locator("#viewApprovedSource")).not.toBeVisible();
    await page.locator("#editSource").click();
    await expect(page.locator("#sourceDatabase")).toBeFocused();
    await expect(page.locator("#sourceEditor #collectionWindow-control")).toBeVisible();
    await expect(page.locator("#sourceEditor #collectionCadence-control")).toBeVisible();
    await expect(page.locator("#preferenceActions")).not.toBeVisible();
    await expect(page.locator("#connectCollection")).toHaveText("Save preferences");
    await expect(page.locator("#connectCollection")).toBeDisabled();
    await selectActivityOption(page, "collectionCadence", "15");
    await expect(page.locator("#connectCollection")).toBeEnabled();
    await page.locator("#settingsSearch").fill("Save preferences");
    await page.locator('#settingsSearchResults a[data-setting="save-preferences"]').click();
    await expect(page.locator("#connectCollection")).toBeFocused();
    assert.equal(posts.filter(value => value === "/api/collection/configure").length, 0, "The old save destination only focuses the consolidated decision");
    await page.locator("#settingsSearch").press("Escape");
    await page.locator("#wireSearch").fill("Save preferences");
    await selectActivityOption(page, "wireSearchType", "setting");
    await page.locator("#wireSearchResults button").filter({ has: page.locator(".wire-search-title", { hasText: "Save preferences" }) }).click();
    await expect(page.locator("#connectCollection")).toBeFocused();
    assert.equal(posts.filter(value => value === "/api/collection/configure").length, 0, "Receipt-bound Search also only locates the same-source decision");
    await capture(page, "connection-source-preference-decision");
    await page.locator("#connectCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Preferences saved.");
    await expect(page.locator("#sourceEditor")).not.toBeVisible();
    await expect(page.locator("#connectionPreferences #collectionCadence-control")).toBeVisible();
    const status = await runtime.collector.status();
    assert.equal(status.config.enabled, false);
    assert.equal(status.config.appDbPath, config.appDbPath);
    assert.equal(status.config.pollSeconds, 15);
    await page.locator("#editSource").click();
    await page.locator("#sourceSessions").fill(config.sessionRoot + "-draft");
    await expect(page.locator("#connectCollection")).toHaveText("Approve and switch source");
    await expect(page.locator("#approvalScope")).toContainText("Collection stays paused");
    await page.locator("#wireSearch").fill("Save preferences");
    await page.locator("#wireSearchResults button").filter({ has: page.locator(".wire-search-title", { hasText: "Save preferences" }) }).click();
    await expect(page.locator("#settingsDraftStatus")).toBeFocused();
    await expect(page.locator("#connectCollection")).not.toBeFocused();
    assert.equal(posts.filter(value => value === "/api/collection/configure").length, 1, "A source-change draft is not presented or submitted as a preference-only save");
    await capture(page, "connection-source-permission-decision");
    await page.locator("#cancelSource").click();
    await expect(page.locator("#editSource")).toBeFocused();
    await expect(page.locator("#sourceSessions")).toHaveValue(config.sessionRoot);
    await expect(page.locator("#collectionCadence")).toHaveValue("15");
    assert.equal(posts.filter(value => value === "/api/collection/configure").length, 1);
    assert.equal(posts.some(value => /\/(?:enabled|now)$/.test(value)), false);
});

for (const problem of ["unknown", "source-error"]) test(`Settings ${problem} Refresh recovery retains one action and no-replay navigation`, { timeout: 30000 }, async t => {
    const { page, runtime } = await setup(t);
    let sourceChecks = 0, snapshotReads = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/snapshot") snapshotReads++; });
    await page.route("**/api/collection/now", route => {
        sourceChecks++;
        return route.fulfill({ status: 422, json: { error: "Synthetic source paths need attention.", code: "source_paths_invalid" } });
    });

    if (problem === "unknown") {
        await page.evaluate(() => sessionStorage.setItem("workiq-evidence.source-check.v1", "pending"));
        await page.reload();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#freshContextMessage")).toContainText("will not be repeated");
        await expect(page.locator("#settingsRefreshContext")).toBeHidden();
        await expect(page.locator("#checkActivity")).not.toBeVisible();
        await expect(page.locator("#refreshBtn")).toBeVisible();
    } else {
        await page.locator("#checkActivity").click();
        await expect(page.locator("#freshStatus")).toHaveText("Source paths need attention.");
        await expect(page.locator("#checkActivity")).toBeVisible();
        await expect(page.locator("#refreshBtn")).not.toBeVisible();
    }
    const original = { sourceChecks, snapshotReads, status: await page.locator("#freshStatus").textContent(),
        context: await page.locator("#freshContextMessage").textContent() };
    await page.evaluate(() => { window.settingsRecoveryNode = document.getElementById("freshResult"); });
    await navigateSettings(page, "display");
    await navigateMain(page, "analyze");
    await page.goBack();
    await expect(page.locator("[data-settings-section=display]")).toBeVisible();
    await page.goBack();
    await expect(page.locator("[data-settings-section=connection]")).toBeVisible();
    assert.equal(sourceChecks, original.sourceChecks);
    assert.equal(snapshotReads, original.snapshotReads);
    await expect(page.locator("#freshStatus")).toHaveText(original.status);
    await expect(page.locator("#freshContextMessage")).toHaveText(original.context);
    assert.equal(await page.evaluate(() => window.settingsRecoveryNode === document.getElementById("freshResult")), true);
    await expect(page.locator("#freshActivity #checkActivity:visible,#freshActivity #refreshBtn:visible")).toHaveCount(1);
    const recovery = page.locator("#freshActivity #checkActivity:visible,#freshActivity #refreshBtn:visible");
    await expect(recovery).toHaveText("Read stored activity");
    await expect(recovery).toHaveAccessibleName("Read stored activity");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale * 100 + "%"; }, scale);
        await chooseTheme(page, theme);
        const layout = await geometry(page);
        assert.equal(layout.overflow, false);
        assert.deepEqual(layout.clipped, []);
        assert.deepEqual(layout.overlaps, []);
        await capture(page, `connection-${problem}-${width}-${scale}x-${theme}`);
    }
    assert.equal((await runtime.collector.status()).config.enabled, false);
    const readsBeforeRecovery = snapshotReads;
    await recovery.click();
    await expect.poll(() => snapshotReads).toBeGreaterThan(readsBeforeRecovery);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    assert.equal(sourceChecks, original.sourceChecks, "The labelled stored-read recovery never repeats the source check");
    if (proofs) await writeFile(path.join(proofs, `refresh-${problem}-navigation.json`), JSON.stringify({
        ...original, finalSourceChecks: sourceChecks, finalSnapshotReads: snapshotReads,
        explicitRecoveryReads: snapshotReads - readsBeforeRecovery,
    }, null, 2));
});

test("Troubleshooting converges collection investigation but keeps the unrelated HTTP diagnostic distinct", { timeout: 30000 }, async t => {
    const { page, posts } = await setup(t);
    await navigateSettings(page, "troubleshooting");
    await expect(page.locator('#settingsView a[href="#collection-status"]:visible')).toHaveCount(1);
    await expect(page.locator('#settingsView a[href="#collection-status?setting=issues"]:visible')).toHaveCount(0);
    await expect(page.locator('#settingsView a[href="#collection-status?setting=collection-details"]:visible')).toHaveCount(0);
    const diagnostic = page.locator('#settingsView a[href="#collection-status?setting=network-diagnostic"]');
    await expect(diagnostic).toBeVisible();
    await diagnostic.click();
    await expect(page.locator("#recorderDiagnostics")).toHaveAttribute("open", "");
    await expect(page.locator("#recorderDiagnostics > summary")).toBeFocused();
    await expect(page.locator("#recorderPurpose")).toContainText("not collection");
    assert.equal(posts.includes("/api/record"), false);
    await page.goBack();
    await expect(page.locator("[data-settings-section=troubleshooting]")).toBeVisible();
    await page.locator('#settingsView a[href="#collection-status"]:visible').click();
    await expect(page.locator("#collectionStatusView")).toBeVisible();
    assert.equal(posts.some(value => /\/(?:record|confirm|approve|configure|enabled|now)$/.test(value)), false);
});

test("The unified source decision retains pending, rejected, read-result and cancel boundaries", { timeout: 30000 }, async t => {
    const { page, config, runtime } = await setup(t);
    let writes = 0, release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/collection/configure", async route => {
        writes++;
        await held;
        await route.fulfill({ status: 422, json: { error: "Synthetic source validation failed." } });
    });
    await page.locator("#editSource").click();
    await page.locator("#sourceSessions").fill(config.sessionRoot + "-draft");
    await selectActivityOption(page, "collectionCadence", "15");
    await page.locator("#connectCollection").click();
    for (const id of ["sourceDatabase", "sourceSessions", "collectionWindow", "collectionCadence", "cancelSource"]) {
        await expect(page.locator("#" + id)).toBeDisabled();
    }
    await page.locator('#settingsCategoryNav a[data-category="privacy"]').click();
    await expect(page.locator("#sourceEditor")).toBeVisible();
    await capture(page, "connection-source-switch-pending");
    release();
    await expect(page.locator("#settingsMessage")).toContainText("Synthetic source validation failed");
    await expect(page.locator("#reloadSettings")).toBeVisible();
    await expect(page.locator("#connectCollection")).toBeDisabled();
    await expect(page.locator("#sourceSessions")).toHaveValue(config.sessionRoot + "-draft");
    await capture(page, "connection-source-switch-rejected");
    await page.locator("#reloadSettings").click();
    await expect(page.locator("#reloadSettings")).not.toBeVisible();
    assert.equal(writes, 1, "Reading the result never retries source approval");
    await page.locator("#cancelSource").click();
    await expect(page.locator("#editSource")).toBeFocused();
    await expect(page.locator("#sourceSessions")).toHaveValue(config.sessionRoot);
    await expect(page.locator("#collectionCadence")).toHaveValue("5");
    assert.equal((await runtime.collector.status()).config.sessionRoot, config.sessionRoot);
    assert.equal((await runtime.collector.status()).config.enabled, false);
    await capture(page, "connection-source-switch-cancelled");
});

test("Refresh explains the effect of incomplete history without making diagnostics the user's task", { timeout: 30000 }, async t => {
    const { page, runtime, context } = await setup(t);
    const status = await runtime.collector.status(), state = await loadBoardState(context);
    let checks = 0;
    await page.route("**/api/collection/now", route => {
        checks++;
        return route.fulfill({ json: { ...status, check: {
            schemaVersion: 2, id: "human-impact-check", revision: state.revision, configVersion: status.configVersion,
            startedAt: "2026-10-23T10:27:01.958Z", completedAt: "2026-10-23T10:27:02.205Z",
            outcome: "partial", changes: { added: 0, updated: 0, items: [] }, sourcesChecked: 1158, eligibleSources: 1158,
            pendingSources: 0, partialSources: 0, skippedSources: 0,
            coverage: { eligible: 1158, unavailable: 19, limited: 101, affected: 120,
                groups: { missing: 19, truncated: 16, oversized: 28, context: 57 } },
        } } });
    });
    await page.locator("#checkActivity").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "partial");
    await expect(page.locator("#freshStatus")).toHaveText("No additional activity in this check.");
    await expect(page.locator("#freshCoverageAnnouncement")).toHaveText("GitHub history: 19 Copilot chats unavailable; 101 Copilot chats incomplete.");
    await expect(page.locator("#settingsRefreshDetails")).toHaveCount(0);
    await expect(page.locator("#freshIssues")).toBeHidden();
    const visible = await page.locator("#freshActivity").innerText();
    assert.doesNotMatch(visible, /19 unavailable|101 with limits|Checked 1,158|History coverage is incomplete/);
    assert.doesNotMatch(visible, /up to date|No action is needed|Repair source/i);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 1], [390, 2]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const layout = await geometry(page);
        assert.equal(layout.overflow, false);
        assert.deepEqual(layout.clipped, []);
        assert.deepEqual(layout.overlaps, []);
        await capture(page, `human-impact-${theme}-${width}-${scale}x`);
        if (proofs && width === 1440) {
            const html = await page.evaluate(() => {
                const copy = document.documentElement.cloneNode(true);
                copy.querySelectorAll("script").forEach(node => node.remove());
                return "<!doctype html>" + copy.outerHTML;
            });
            await writeFile(path.join(proofs, `human-impact-${theme}.html`), html);
        }
    }
    await page.locator("#settingsStatusLink a").click();
    await page.locator("#freshHelp>summary").click();
    await expect(page.locator("#freshCheckDetails")).toContainText("1,158");
    await expect(page.locator("#freshCoverageDetails")).toContainText("19 Copilot chats");
    await expect(page.locator("#freshCoverageDetails")).toContainText("57 Copilot chats");
    await expect(page.locator("#freshCoverageDetails")).toContainText("64 MiB");
    await expect(page.locator("#freshCoverageDetails")).toContainText("1 MiB");
    assert.equal(checks, 1, "Inspecting affected history must not retry collection");
});

test("Refresh renders context-only gaps and pending reads without inventing unreadable history", { timeout: 30000 }, async t => {
    const { page, runtime, context } = await setup(t);
    const status = await runtime.collector.status(), state = await loadBoardState(context);
    let checks = 0;
    await page.route("**/api/collection/now", route => {
        checks++;
        return route.fulfill({ json: { ...status, check: {
            schemaVersion: 2, id: "context-pending-check", revision: state.revision, configVersion: status.configVersion,
            startedAt: "2026-10-23T10:27:01.958Z", completedAt: "2026-10-23T10:27:02.205Z",
            outcome: "partial", changes: { added: 0, updated: 0, items: [] },
            sourcesChecked: 3, eligibleSources: 3, pendingSources: 1, partialSources: 0, skippedSources: 0,
            coverage: { eligible: 3, readable: 3, pending: 1, unavailable: 0, limited: 3, affected: 3, groups: { context: 3 } },
        } } });
    });
    await page.locator("#checkActivity").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "partial");
    await expect(page.locator("#freshStatus")).toHaveText("No additional activity in this check.");
    await expect(page.locator("#freshCoverageAnnouncement")).toContainText("3 Copilot chats incomplete");
    await expect(page.locator("#freshCoverageAnnouncement")).toContainText("more history remains to read");
    assert.doesNotMatch(await page.locator("#freshCoverageAnnouncement").innerText(), /couldn't be read|couldn't be fully included/);
    await expect(page.locator("#settingsRefreshDetails")).toHaveCount(0);
    await expect(page.locator("#freshIssues")).toBeHidden();
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const layout = await geometry(page);
    assert.equal(layout.overflow, false);
    assert.deepEqual(layout.clipped, []);
    assert.deepEqual(layout.overlaps, []);
    await page.locator("#settingsStatusLink a").click();
    await page.locator("#freshHelp>summary").click();
    await expect(page.locator("#freshCheckDetails")).toContainText("1 still reading");
    await expect(page.locator("#freshCoverageDetails")).toContainText("3 Copilot chats");
    assert.equal(checks, 1);
});

test("Refresh keeps missing checked-scope counts explicit rather than inventing complete coverage", { timeout: 30000 }, async t => {
    const { page, runtime, context } = await setup(t);
    const status = await runtime.collector.status(), state = await loadBoardState(context);
    await page.route("**/api/collection/now", route => route.fulfill({ json: { ...status, check: {
        schemaVersion: 2, id: "settings-counts-unavailable", revision: state.revision, configVersion: status.configVersion,
        completedAt: new Date().toISOString(), outcome: "partial",
        changes: { added: 0, updated: 0, items: [] }, coverage: { unavailable: 1 },
    } } }));
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshStatus")).toHaveText("No additional activity in this check.");
    await expect(page.locator("#freshCheckDetails")).toContainText("Checked chat counts are unavailable.");
    await expect(page.locator("#freshCheckDetails")).toContainText("1 unavailable");
    await expect(page.locator("#freshCoverageAnnouncement")).toBeVisible();
    await expect(page.locator("#freshCoverageAnnouncement")).toHaveText("GitHub history: 1 Copilot chat unavailable.");
    await expect(page.locator("#freshIssues")).toBeHidden();
    await capture(page, "connection-counts-unavailable");
    await page.locator("#settingsStatusLink a").click();
    await page.locator("#freshHelp>summary").click();
    await expect(page.locator("#freshCoverageDetails")).toContainText("No per-reason breakdown was retained for this check.");
});
