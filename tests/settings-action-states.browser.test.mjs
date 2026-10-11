import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, navigateMain, navigateSettings, chooseTheme } from "./helpers.mjs";
import { contrast, rgb } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_ACTION_STATE_PROOFS;

async function paint(locator) {
    return locator.evaluate(node => {
        const style = getComputedStyle(node), marker = getComputedStyle(node, "::before");
        const surface = marker.content !== "none" && marker.zIndex === "-1" ? marker : style;
        const { x, y, width, height } = node.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node);
        return {
            text: node.textContent.trim(), current: node.getAttribute("aria-current"),
            hover: node.matches(":hover"), focus: node.matches(":focus-visible"),
            background: surface.backgroundColor, color: style.color, border: surface.borderColor,
            outline: style.outlineStyle, outlineWidth: style.outlineWidth,
            danger: style.getPropertyValue("--danger").trim(), paper: style.getPropertyValue("--paper").trim(),
            marker: { content: marker.content, background: marker.backgroundColor, width: marker.width },
            bounds: { x, y, width, height }, clipped: node.scrollWidth > node.clientWidth,
            textFits: [...range.getClientRects()].every(rect => rect.left >= x && rect.right <= x + width + 1),
        };
    });
}

async function setup(t, seed) {
    const cleanups = [];
    let runtime, browser;
    const errors = [], blocked = [], calls = [];
    t.after(async () => {
        try { await browser?.close(); }
        finally {
            try { await runtime?.close(); }
            finally { for (const cleanup of cleanups) await cleanup(); }
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(blocked, [], "Only isolated local reads, previews and cancellation are allowed; never a mutation or external request");
    });
    const { context } = await privateFixture({ after: cleanup => cleanups.push(cleanup) });
    const controller = createExportController(context);
    if (seed) await seed(context, controller);
    runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1466, height: 1000 }, reducedMotion: "reduce" });
    const allowed = new Set(["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/consent",
        "/api/deletion/preview", "/api/deletion/cancel", "/api/artifact-deletion/preview", "/api/artifact-deletion/cancel"]);
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !allowed.has(url.pathname)) {
            blocked.push(`${request.method()} ${url.pathname}`);
            return route.abort();
        }
        if (request.method() === "POST") calls.push(url.pathname);
        return route.continue();
    });
    await page.goto(runtime.url + "#settings?section=connection");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    if (proofs) await mkdir(proofs, { recursive: true });
    return { page, context, calls };
}

const color = value => value.startsWith("color(srgb ")
    ? `rgb(${value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel * 255).join(",")})` : value;

function assertDanger(value, label) {
    assert.deepEqual(rgb(value.color), rgb(value.danger), `${label}: semantic danger text`);
    assert.deepEqual(rgb(value.border), rgb(value.danger), `${label}: semantic danger boundary`);
    assert.notDeepEqual(rgb(color(value.background)), rgb(value.danger), `${label}: no solid danger fill`);
    assert.ok(contrast(value.color, color(value.background)) >= 4.5, `${label}: readable text`);
    assert.ok(contrast(value.border, color(value.background)) >= 3, `${label}: visible boundary`);
    assert.equal(value.clipped, false, label);
    assert.equal(value.textFits, true, label);
    assert.ok(value.bounds.height >= 44, label);
}

test("Settings current location, transient hover and keyboard focus are distinct; destructive entry is explicit", { timeout: 60000 }, async t => {
    const { page, context } = await setup(t);
    const evidence = [];
    const before = await loadBoardState(context);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await navigateSettings(page, "connection");
        const current = page.locator("#settingsCategoryNav [data-category=connection]");
        const other = page.locator("#settingsCategoryNav [data-category=privacy]");
        await page.mouse.move(1, 1);
        const rest = await paint(current);
        if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-settings-rest.png`) });
        await current.hover();
        const hover = await paint(current);
        await page.mouse.move(1, 1);
        const departure = await paint(current);
        await other.hover();
        const inactiveHover = await paint(other);
        await page.mouse.move(1, 1);
        const inactiveRest = await paint(other);
        await other.focus();
        await page.keyboard.press("Shift+Tab");
        await expect(current).toBeFocused();
        const focus = await paint(current);
        if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-settings-focus.png`) });
        await page.keyboard.press("Enter");
        for (const category of ["display", "ai", "privacy", "troubleshooting", "connection"]) {
            await navigateSettings(page, category);
            await expect(page.locator("#settingsCategoryNav [aria-current=page]")).toHaveAttribute("data-category", category);
            await expect(page.locator("[data-settings-section]:visible")).toHaveAttribute("data-settings-section", category);
        }
        await page.goBack();
        await expect(page.locator("#settingsCategoryNav [aria-current=page]")).toHaveAttribute("data-category", "troubleshooting");
        await page.goForward();
        await expect(page.locator("#settingsCategoryNav [aria-current=page]")).toHaveAttribute("data-category", "connection");
        await page.reload();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#settingsCategoryNav [aria-current=page]")).toHaveAttribute("data-category", "connection");
        await navigateSettings(page, "data");
        const entry = await paint(page.locator("#deleteActivity"));
        if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-data-actions.png`) });
        await page.locator("#deleteActivity").click();
        await expect(page.locator("#deleteCancel")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#deleteActivity")).toBeFocused();
        evidence.push({ theme, rest, hover, departure, inactiveHover, inactiveRest, focus, entry });
    }
    if (proofs) await writeFile(path.join(proofs, "states.json"), JSON.stringify(evidence, null, 2));
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
    assert.equal((await loadBoardState(context)).deletion, undefined);
    for (const item of evidence) {
        assert.equal(item.rest.current, "page");
        assert.equal(item.departure.hover, false);
        assert.equal(item.departure.background, item.rest.background, "Pointer departure restores the current location, not a stale hover");
        assert.equal(item.inactiveRest.current, null);
        assert.notEqual(item.inactiveRest.background, item.inactiveHover.background);
        assert.notEqual(item.rest.background, item.hover.background, "Current category must have separate hover feedback");
        assert.notEqual(item.rest.background, item.inactiveHover.background, "Current location must not look like another row's hover");
        assert.equal(item.rest.marker.content, '""');
        assert.equal(item.rest.marker.width, "3px");
        assert.equal(item.inactiveHover.marker.content, "none", "Hover cannot borrow the persistent location marker");
        assert.ok(contrast(item.rest.marker.background, item.rest.background) >= 3);
        assert.deepEqual(item.rest.bounds, item.hover.bounds);
        assert.deepEqual(item.rest.bounds, item.focus.bounds);
        assert.equal(item.focus.focus, true);
        assert.equal(item.focus.outline, "solid");
        assert.ok(parseFloat(item.focus.outlineWidth) >= 2);
        assert.equal(item.entry.text, "Delete collected activity", "Steady action label is complete without authored continuation dots");
        assertDanger(item.entry, item.theme);
    }
});

test("danger entries and separate confirmation stay readable, stable and cancellable at narrow/enlarged layouts", { timeout: 60000 }, async t => {
    const { page, context, calls } = await setup(t);
    const before = await loadBoardState(context), measurements = [];
    const evidenceFile = path.join(context.dataDir, "private-evidence", before.evidenceFile);
    const originalBytes = await readFile(evidenceFile);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1466]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await navigateSettings(page, "data");
        if (await page.locator("#settingsCategorySummary").isVisible()) {
            if (!await page.locator("#settingsCategories").evaluate(node => node.open)) await page.locator("#settingsCategorySummary").click();
            for (const link of await page.locator("#settingsCategoryNav a").all()) {
                const value = await paint(link);
                assert.equal(value.clipped, false);
                assert.equal(value.textFits, true);
                assert.ok(value.bounds.height >= 44);
            }
            await expect(page.locator("#settingsCategoryNav [aria-current=page]")).toHaveAttribute("data-category", "data");
            await page.locator("#settingsCategorySummary").click();
        }
        const entry = page.locator("#deleteActivity"), label = `${theme}/${width}/${scale}`;
        await entry.scrollIntoViewIfNeeded();
        await page.mouse.move(1, 1);
        const rest = await paint(entry);
        assertDanger(rest, label);
        assert.deepEqual(rgb(rest.background), rgb(rest.paper), `${label}: neutral resting fill`);
        await entry.hover();
        const hovered = await paint(entry);
        assertDanger(hovered, label);
        assert.deepEqual(hovered.bounds, rest.bounds);
        await page.mouse.down();
        const pressed = await paint(entry);
        assertDanger(pressed, label);
        assert.deepEqual(pressed.bounds, rest.bounds);
        await page.mouse.move(1, 1);
        await page.mouse.up();
        await entry.focus();
        await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
        const focused = await paint(entry);
        assert.equal(focused.focus, true);
        assert.equal(focused.outline, "solid");
        assert.ok(parseFloat(focused.outlineWidth) >= 2);
        const recollect = await paint(page.locator("#recollectActivity"));
        assert.equal(recollect.text, "Recollect from approved sources");
        assert.equal(recollect.clipped, false);
        assert.equal(recollect.textFits, true);
        assert.notDeepEqual(rgb(recollect.color), rgb(recollect.danger), "Recollection is not destructive");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await entry.click();
        await expect(page.locator("#deleteCancel")).toBeFocused();
        await expect(page.locator("#deleteRange")).toBeChecked();
        await expect(page.locator("#deleteFrom")).toHaveValue("");
        await expect(page.locator("#deleteConfirm")).toBeDisabled();
        await page.locator("#deleteAll").check();
        await page.locator("#deletePreview").click();
        await expect(page.locator("#deleteConfirmation")).toBeVisible();
        await expect(page.locator("#deleteConfirm")).toHaveText("Delete 1 record");
        await page.locator("#deleteConfirmation details>summary").click();
        await expect(page.locator("#deleteConfirmation")).toContainText("Source approval and collection preferences stay unchanged.");
        await expect(page.getByText(/Source approval and collection preferences stay unchanged/)).toBeVisible();
        await page.locator("#deleteConfirmation details>summary").click();
        const confirm = await paint(page.locator("#deleteConfirm"));
        assertDanger(confirm, label + "/confirmation");
        assert.equal(await page.locator("#deletePreview").getAttribute("class"), null);
        assert.equal(calls.some(route => route.endsWith("/confirm")), false);
        if (proofs && (width === 1466 && scale === 1 || width === 375 && scale === 2)) {
            await page.screenshot({ path: path.join(proofs, `${theme}-${width}-${scale}-confirmation.png`) });
        }
        await page.locator("#deleteCancel").click();
        await expect(entry).toBeFocused();
        await entry.click();
        await page.keyboard.press("Escape");
        await expect(entry).toBeFocused();
        measurements.push({ label, rest, hovered, pressed, focused, recollect, confirm });
        if (proofs && (width === 1466 && scale === 1 || width === 375 && scale === 2)) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `${theme}-${width}-${scale}-actions.png`), fullPage: true });
        }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await navigateMain(page, "activity");
    assertDanger(await paint(page.locator("#activityDeleteShortcut")), "Activity entry");
    await page.locator("#activityDeleteShortcut").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#activityDeleteShortcut")).toBeFocused();
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.exports, before.exports);
    assert.equal(after.deletion, undefined);
    assert.deepEqual(await readFile(evidenceFile), originalBytes, "No evidence bytes change while opening, previewing or cancelling");
    if (proofs) await writeFile(path.join(proofs, "danger-layouts.json"), JSON.stringify(measurements, null, 2));
});

test("saved report and comparison entries use the same danger treatment without deleting on open or Escape", { timeout: 30000 }, async t => {
    const { page, context, calls } = await setup(t, async (context, controller) => {
        const saved = [];
        for (let index = 0; index < 2; index++) {
            const state = await loadBoardState(context);
            const preview = await controller.preview("synthetic-action-state", undefined, { promptMode: "none", formats: ["json"] }, { kind: "all", revision: state.revision });
            await controller.review("synthetic-action-state", preview.previewId, true);
            saved.push((await controller.confirm("synthetic-action-state", preview.previewId, true)).bundle);
        }
        const preview = await controller.previewComparison("synthetic-action-state", saved[0].bundleId, saved[1].bundleId, { formats: ["json"] });
        await controller.reviewComparison("synthetic-action-state", preview.previewId, true);
        await controller.confirmComparison("synthetic-action-state", preview.previewId, true);
    });
    const before = await loadBoardState(context);
    const files = before.exports.flatMap(bundle => Object.values(bundle.files));
    const originalBytes = await Promise.all(files.map(file => readFile(file)));
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await navigateMain(page, "reports");
        if (!await page.locator("#bundles").evaluate(node => node.open)) await page.locator("#bundles > summary").click();
        for (const name of ["Delete report", "Delete saved comparison"]) {
            const entry = page.locator("#bundleList").getByRole("button", { name, exact: true, includeHidden: true }).first();
            const disclosure = entry.locator("xpath=ancestor::details[1]");
            if (!await disclosure.evaluate(node => node.open)) await disclosure.locator(":scope > summary").click();
            assertDanger(await paint(entry), `${theme}/${name}`);
            await entry.click();
            const confirm = page.locator(".delete-object-confirm");
            await expect(confirm).toBeEnabled();
            assertDanger(await paint(confirm), `${theme}/${name}/confirm`);
            await expect(page.locator("dialog[open]").getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
            if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-${name.replaceAll(" ", "-")}.png`) });
            await page.keyboard.press("Escape");
            await expect(confirm).toBeHidden();
            await expect(entry).toBeFocused();
        }
    }
    assert.equal(calls.some(route => route.endsWith("/confirm")), false);
    assert.deepEqual((await loadBoardState(context)).exports, before.exports);
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), originalBytes);
});

test("pending destructive confirmation stays readable and locked without forwarding a mutation", { timeout: 30000 }, async t => {
    for (const theme of ["light", "dark"]) {
        const { page, context } = await setup(t), before = await loadBoardState(context);
        await chooseTheme(page, theme);
        let release;
        const held = new Promise(resolve => { release = resolve; });
        t.after(release);
        let intercepted = 0;
        await page.route("**/api/deletion/confirm", async route => {
            intercepted++;
            await held;
            await route.fulfill({ status: 503, json: { error: "Synthetic pending confirmation: no mutation was forwarded." } });
        });
        await navigateSettings(page, "data");
        await page.locator("#deleteActivity").click();
        await page.locator("#deleteAll").check();
        await page.locator("#deletePreview").click();
        const confirm = page.locator("#deleteConfirm");
        await expect(confirm).toBeEnabled();
        const beforePaint = await paint(confirm);
        await confirm.click();
        await expect(confirm).toHaveAttribute("aria-busy", "true");
        await expect(confirm).toBeDisabled();
        await expect(page.locator("#deleteCancel")).toBeDisabled();
        const pending = await paint(confirm);
        assert.equal(pending.bounds.width, beforePaint.bounds.width);
        assert.equal(pending.bounds.height, beforePaint.bounds.height);
        assert.equal(pending.textFits, true);
        assert.ok(contrast(pending.color, pending.background) >= 4.5, "Disabled pending text remains readable");
        await expect(confirm.locator(".pending-indicator")).toBeVisible();
        if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-pending.png`) });
        await page.keyboard.press("Escape");
        await expect(page.locator("#deleteDialog")).toBeVisible();
        assert.equal(intercepted, 1);
        release();
        await expect(page.locator("#deleteCheck")).toBeVisible();
        await page.locator("#deleteCancel").click();
        await page.unroute("**/api/deletion/confirm");
        assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
        assert.equal((await loadBoardState(context)).deletion, undefined);
    }
});
