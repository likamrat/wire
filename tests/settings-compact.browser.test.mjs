import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { navigateSettings, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WIRE_COMPACT_SETTINGS_PROOFS;
const categories = ["connection", "privacy", "display", "troubleshooting"];

async function setup(t, { unknownBilling = false } = {}) {
    const cleanups = [], denied = [], errors = [], posts = [];
    const f = await evaluationFixture({ after: action => cleanups.push(action) });
    await materializeEvaluationSource(f);
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false },
        search: { modelDirectory: path.join(f.context.dataDir, "absent-test-model") },
        evaluation: {
            evaluatorFactory: async () => { denied.push("provider"); throw new Error("No provider allowed."); },
            readSource: async () => { denied.push("evaluation source"); throw new Error("No evaluation source read allowed."); },
        },
    });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const before = await loadBoardState(f.context);
    const files = [f.config.appDbPath, path.join(f.context.dataDir, "collector", "config.json"),
        ...f.inputs.map(input => path.join(f.config.sessionRoot, input.record.sourceSessionId, "events.jsonl"))];
    const bytes = await Promise.all(files.map(file => readFile(file)));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []);
            assert.deepEqual(denied, [], "No writes, source runs or external requests");
            assert.deepEqual(await Promise.all(files.map(file => readFile(file))), bytes);
            assert.deepEqual(await loadBoardState(f.context), before, "Read-only navigation, previews and cancellation preserve all stored data");
        } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
    });
    const readOnly = new Set(["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/consent",
        "/api/evaluation/automatic/summary", "/api/evaluation/automatic/setup",
        "/api/deletion/preview", "/api/deletion/cancel", "/api/recollection/sources", "/api/recollection/preview", "/api/recollection/cancel"]);
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !readOnly.has(url.pathname)) {
            denied.push(`${request.method()} ${url.pathname}`);
            return route.abort("blockedbyclient");
        }
        if (request.method() === "POST") posts.push(url.pathname);
        if (unknownBilling && url.pathname === "/api/evaluation/automatic/summary") {
            const response = await route.fetch(), data = await response.json();
            data.snapshot = { ...data.snapshot, state: "paused", reason: "unknown-billing", approval: { state: "enabled" } };
            return route.fulfill({ response, json: data });
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#settings?section=connection");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    return { ...f, page, posts };
}

async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: true });
}

async function geometry(page) {
    return page.locator("[data-settings-section]:visible").evaluate(root => {
        const box = node => {
            const { x, y, width, height, bottom, right } = node.getBoundingClientRect();
            return { x, y, width, height, bottom, right };
        };
        const rows = [...root.querySelectorAll(":scope>.settings-task-row,:scope>.settings-reply-row,:scope>.settings-group,:scope>.fresh-activity,:scope>.display-time-field,:scope>#automaticScoreSetup>.settings-automatic-row")];
        return {
            category: root.dataset.settingsSection, pane: box(root),
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            rows: rows.map(node => ({ ...box(node), padding: getComputedStyle(node).paddingBlock })),
            copy: [...root.querySelectorAll(".settings-row-copy p")].map(node => ({
                text: node.textContent, lines: node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight),
                color: getComputedStyle(node).color, page: getComputedStyle(document.body).backgroundColor,
            })),
            clipped: [...root.querySelectorAll("button,label,summary,p,a")].filter(node => node.checkVisibility()
                && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)).map(node => node.textContent),
        };
    });
}

test("compact Settings keeps four current categories readable, bounded and actionable without shrinking type", { timeout: 60000 }, async t => {
    const { page } = await setup(t), measures = [];
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of ["light", "dark"]) for (const width of [1440, 820, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        for (const category of categories) {
            await navigateSettings(page, category);
            const value = await geometry(page);
            assert.equal(value.overflow, false);
            assert.deepEqual(value.clipped, []);
            for (const copy of value.copy) {
                assert.ok(copy.lines <= 2, "Ordinary guidance never becomes a four-line narrow column");
                assert.ok(contrast(copy.color, copy.page) >= 4.5);
            }
            for (let index = 1; index < value.rows.length; index++) {
                assert.ok(value.rows[index].y - value.rows[index - 1].bottom <= 1, "One divider, not stacked margins and padding between peer rows");
            }
            if (width === 1440) {
                const limits = { connection: 490, privacy: 430, ai: 165, display: 225, troubleshooting: 375 };
                assert.ok(value.pane.height <= limits[category], `${category} pane stays compact: ${value.pane.height}`);
            }
            measures.push({ theme, width, ...value });
            await capture(page, `${category}-${width}-${theme}`);
        }
    }
    for (const category of categories) {
        await navigateSettings(page, category);
        await page.evaluate(() => {
            document.documentElement.style.fontSize = "200%";
            for (const node of document.querySelectorAll("[data-settings-section]:not([hidden]) h3,[data-settings-section]:not([hidden]) .settings-row-copy p")) {
                const stress = document.createElement("span");
                stress.dataset.textStress = "";
                stress.textContent = " Extended translated setting label with an unusually long descriptive name";
                node.append(stress);
            }
        });
        const value = await geometry(page);
        assert.equal(value.overflow, false);
        assert.deepEqual(value.clipped, [], "Enlargement wraps instead of clipping");
        await page.evaluate(() => {
            document.documentElement.style.fontSize = "";
            for (const node of document.querySelectorAll("[data-text-stress]")) node.remove();
        });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigateSettings(page, "privacy");
    const copyWidth = await page.locator("#recollectActivityHelp").evaluate(node => ({
        copy: node.getBoundingClientRect().width, row: node.closest(".settings-task-row").getBoundingClientRect().width,
    }));
    assert.ok(copyWidth.copy >= Math.min(copyWidth.row, 432), "Guidance uses the available row, not the fixed label column");
    for (const selector of ["#deleteActivity", "#recollectActivity", '[data-settings-section=privacy] a[href="#reports"]']) {
        const action = page.locator(selector);
        const paint = await action.evaluate(node => {
            const before = getComputedStyle(node, "::before"), style = getComputedStyle(node);
            return { height: node.getBoundingClientRect().height, border: before.borderTopWidth, color: style.color, fill: before.backgroundColor };
        });
        assert.ok(paint.height >= 44);
        assert.equal(paint.border, "1px", "Actions have a visible painted boundary");
        assert.ok(contrast(paint.color, paint.fill) >= 4.5);
    }
    const reports = page.locator('[data-settings-section=privacy] a[href="#reports"]');
    await reports.focus();
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    await expect(reports).toBeFocused();
    assert.equal(await reports.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
    await page.keyboard.press("Enter");
    await expect(page.locator("#reportsView")).toBeVisible();
    await page.goBack();
    await expect(page.locator("[data-settings-section=privacy]")).toBeVisible();
    if (proofs) await writeFile(path.join(proofs, "measurements.json"), JSON.stringify(measures, null, 2));
});

test("consequences appear before independent confirmation; cancel never changes activity or grants approval", { timeout: 60000 }, async t => {
    const { page, posts } = await setup(t);
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await navigateSettings(page, "privacy");
        const checkbox = page.locator("#assessmentSetup input[type=checkbox]");
        await checkbox.check();
        await expect(page.locator(".assessment-capture-details")).toBeVisible();
        await expect(page.locator(".assessment-capture-details")).toContainText("Nothing is sent for AI review");
        await capture(page, `response-permission-${width}-${theme}`);
        await page.getByRole("button", { name: "Discard change", exact: true }).click();
        await expect(checkbox).not.toBeChecked();
        await expect(checkbox).toBeFocused();
        await page.locator("#deleteActivity").click();
        await expect(page.locator("#deleteCancel")).toBeFocused();
        await expect(page.locator("#deleteConfirm")).toBeDisabled();
        await page.locator("#deleteAll").check();
        await page.locator("#deletePreview").click();
        await expect(page.locator("#deleteConfirmation")).toBeVisible();
        await expect(page.locator("#deleteConfirmation .delete-irreversible")).toContainText("cannot be undone");
        await expect(page.locator("#deleteBoundary")).toContainText("not your Copilot chats or source files");
        await page.locator("#deleteConfirmation details>summary").click();
        await expect(page.locator("#deleteConfirmation")).toContainText("Saved reports");
        await expect(page.locator("#deleteConfirmation")).toContainText("Source approval and collection preferences stay unchanged");
        await page.locator("#deleteConfirmation details>summary").click();
        await capture(page, `deletion-preview-${width}-${theme}`);
        await page.locator("#deleteCancel").click();
        await expect(page.locator("#deleteActivity")).toBeFocused();
        await page.locator("#recollectActivity").click();
        await expect(page.locator("#recollectSources input[type=checkbox]").first()).toBeVisible();
        await page.locator("#recollectSources input[type=checkbox]").first().check();
        await page.locator("#recollectFrom").fill(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
        await page.locator("#recollectTo").fill(new Date().toISOString().slice(0, 10));
        await page.locator("#recollectPreview").click();
        await expect(page.locator("#recollectConfirmation")).toBeVisible();
        await expect(page.locator("#recollectPreserved")).toContainText("Saved reports");
        if (!await page.locator("#recollectAvailabilityToggle").evaluate(node => node.parentElement.open)) {
            await page.locator("#recollectAvailabilityToggle").click();
        }
        await expect(page.locator("#recollectPolicy")).toBeVisible();
        await expect(page.locator("#recollectPolicy")).toContainText("cannot be recovered");
        await capture(page, `recollection-preview-${width}-${theme}`);
        await page.locator("#recollectClose").click();
        await expect(page.locator("#recollectActivity")).toBeFocused();
        await expect(page.locator("#automaticScoreSetup,[data-category=ai]")).toHaveCount(0);
    }
    assert.equal(posts.some(route => /\/(?:confirm|set|approve|revoke|now|configure)$/.test(route)), false);
});

test("retirement does not restore scoring controls for a stale unknown-billing client", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { unknownBilling: true });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await expect(page.locator("#automaticScoreReview,#automaticScoreSetup,[data-category=ai]")).toHaveCount(0);
        assert.deepEqual((await geometry(page)).clipped, []);
        assert.equal((await geometry(page)).overflow, false);
        if (scale === 1) await capture(page, `unknown-billing-${width}-${theme}`);
    }
});

test("category motion measurement executes with zero screenshot captures", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    let screenshots = 0;
    page.screenshot = async () => { screenshots++; throw new Error("Screenshots invalidate motion measurement."); };
    await page.evaluate(() => scrollTo(0, 0));
    for (const category of categories) {
        const link = page.locator(`#settingsCategoryNav [data-category=${category}]`), before = await link.boundingBox();
        await page.evaluate(() => {
            window.settingsFrames = [];
            const start = performance.now();
            function sample(now) {
                const rect = document.querySelector(".settings-rail").getBoundingClientRect();
                window.settingsFrames.push([rect.x, rect.y]);
                if (now - start < 300) requestAnimationFrame(sample);
                else window.settingsMotionDone = true;
            }
            window.settingsMotionDone = false;
            requestAnimationFrame(sample);
        });
        await page.mouse.click(before.x + 20, before.y + before.height / 2);
        await page.waitForFunction(() => window.settingsMotionDone);
        const frames = await page.evaluate(() => window.settingsFrames);
        for (const axis of [0, 1]) assert.ok(Math.max(...frames.map(frame => frame[axis])) - Math.min(...frames.map(frame => frame[axis])) <= 1,
            "The category rail stays stationary throughout navigation");
        await expect(page.locator(`[data-settings-section=${category}]`)).toBeVisible();
    }
    assert.equal(screenshots, 0, "Executed zero-capture path, not a CRLF-sensitive source rewrite");
    t.diagnostic("Motion measurement executed: 4 category clicks, screenshot calls = 0.");
});

test("a failed connection status read labels last-known settings and recovers by reading, never writing", { timeout: 30000 }, async t => {
    const { page, posts } = await setup(t);
    await expect(page.locator("#connectionStatus")).toHaveText("Paused");
    await expect(page.locator("#pauseCollection")).toBeEnabled();
    let failing = true;
    await page.route("**/api/collection/status", route => failing
        ? route.fulfill({ status: 503, json: { error: "Invented collection status unavailable." } }) : route.continue());
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status") && response.status() === 503);
    await capture(page, "connection-read-failure");
    await expect(page.locator('#settingsView [role=alert]:visible')).toContainText("Connection status could not be read");
    await expect(page.locator("#connectionStatus")).toHaveText("Last known: Paused");
    await expect(page.locator("#connectionApproval")).toHaveText("Previously approved");
    await expect(page.locator("#pauseCollection")).toBeDisabled();
    await expect(page.locator("#reloadSettings")).toBeVisible();
    await page.locator("#reloadSettings").click();
    await expect(page.locator("#connectionStatus")).toHaveText("Last known: Paused");
    await expect(page.locator("#reloadSettings")).toBeEnabled();
    for (const theme of ["light", "dark"]) for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await expect(page.locator("#settingsConnectionError")).toBeVisible();
        assert.equal((await geometry(page)).overflow, false);
        await capture(page, `connection-read-failure-${width}-${theme}`);
    }
    await navigateSettings(page, "display");
    await expect(page.locator("#settingsConnectionError")).toBeHidden();
    await page.goBack();
    await expect(page.locator("#settingsConnectionError")).toBeVisible();
    await expect(page.locator("#pauseCollection")).toBeDisabled();
    await selectActivityOption(page, "collectionWindow", "7");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await capture(page, "connection-read-failure-draft");
    failing = false;
    await page.locator("#reloadSettings").click();
    await expect(page.locator("#connectionStatus")).toHaveText("Paused");
    await expect(page.locator("#reloadSettings")).toBeHidden();
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await expect(page.locator('#settingsView [role=alert]:visible')).toHaveCount(0);
    await page.locator("#cancelPreferences").click();
    await expect(page.locator("#collectionWindow")).toHaveValue("30");
    await expect(page.locator("#pauseCollection")).toBeEnabled();
    assert.equal(posts.some(route => /\/(?:confirm|set|approve|revoke|now|configure|enabled)$/.test(route)), false);
});
