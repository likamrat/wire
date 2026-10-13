import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme } from "./helpers.mjs";
import { chooseReportScope, scanReport } from "./report-journey-helpers.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

async function setup(t, count = 0) {
    const { context } = await privateFixture(t, [fixture()]);
    const entries = [];
    for (let index = 0; index < count; index++) {
        const bundleId = `export-${randomUUID()}`;
        const folder = path.join(context.dataDir, "exports", bundleId, "files");
        await mkdir(folder, { recursive: true });
        const name = "product-report.html";
        const html = `<!doctype html><html lang="en"><body><h1>Invented report ${index + 1}</h1><p>Frozen reading fixture.</p></body></html>`;
        const manifestName = "coverage-and-redaction-manifest.json";
        const manifest = JSON.stringify({ bundleId, kind: "report", privacyReview: { reviewerConfirmed: true },
            files: { [name]: { sha256: hash(html), bytes: Buffer.byteLength(html) } } });
        await writeFile(path.join(folder, name), html);
        await writeFile(path.join(folder, manifestName), manifest);
        entries.push({ bundleId, kind: "report", bundleDir: folder, formats: ["html"], promptMode: "none",
            preparedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            selectionScope: { requestGroups: 1 }, privacyReview: { reviewerConfirmed: true },
            manifestHash: hash(manifest), files: { [name]: path.join(folder, name), [manifestName]: path.join(folder, manifestName) } });
    }
    if (entries.length) await updateBoardState(context, state => { state.exports.push(...entries); });
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => {
        await browser.close();
        runtime.server.closeAllConnections();
        await runtime.close();
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
    const requests = [], errors = [];
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    return { page, context, entries, requests };
}

async function placement(summary) {
    return summary.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y + scrollY, width: rect.width, focused: document.activeElement === node };
    });
}

async function shot(page, name) {
    if (!process.env.WIRE_REPORTS_LAYOUT_PROOFS) return;
    await mkdir(process.env.WIRE_REPORTS_LAYOUT_PROOFS, { recursive: true });
    const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    await page.evaluate(() => new Promise(resolve => {
        scrollTo({ top: 0, left: 0, behavior: "instant" });
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await page.screenshot({ path: path.join(process.env.WIRE_REPORTS_LAYOUT_PROOFS, `${name}.png`), fullPage: true });
    await page.evaluate(({ x, y }) => scrollTo(x, y), scroll);
}

async function togglePlacement(page, selector, name) {
    const details = page.locator(selector), summary = details.locator(":scope > summary");
    if (await details.evaluate(node => node.open)) await summary.click();
    await summary.focus();
    const closed = await placement(summary);
    await shot(page, `${name}-closed`);
    await summary.press("Enter");
    assert.equal(await details.evaluate(node => node.open), true);
    const opened = await placement(summary);
    await shot(page, `${name}-open`);
    await summary.press("Space");
    const reclosed = await placement(summary);
    assert.equal(await details.evaluate(node => node.open), false);
    assert.ok(Math.abs(opened.x - closed.x) <= 1 && Math.abs(opened.y - closed.y) <= 1,
        `${name}: opening moves the trigger ${JSON.stringify({ closed, opened })}`);
    assert.ok(Math.abs(reclosed.x - closed.x) <= 1 && Math.abs(reclosed.y - closed.y) <= 1,
        `${name}: closing moves the trigger ${JSON.stringify({ closed, reclosed })}`);
    assert.ok(closed.focused && opened.focused && reclosed.focused, `${name}: keyboard focus stays on the summary`);
    return { name, closed, opened, reclosed };
}

test("About saved reports stays anchored when opened and closed at the same viewport", { timeout: 30000 }, async t => {
    const { page } = await setup(t, 1);
    const summary = page.getByText("About saved reports", { exact: true });
    await summary.focus();
    const closed = await placement(summary);
    await shot(page, "baseline-closed");
    await summary.press("Enter");
    const opened = await placement(summary);
    await shot(page, "baseline-open");
    await summary.press("Space");
    const reclosed = await placement(summary);
    console.log(JSON.stringify({ viewport: page.viewportSize(), closed, opened, reclosed }));
    assert.ok(Math.abs(opened.x - closed.x) <= 1, `Opening help moved its trigger horizontally: ${JSON.stringify({ closed, opened })}`);
    assert.ok(Math.abs(opened.y - closed.y) <= 1, `Opening help moved its trigger vertically: ${JSON.stringify({ closed, opened })}`);
    assert.ok(Math.abs(reclosed.x - closed.x) <= 1 && Math.abs(reclosed.y - closed.y) <= 1, "Closing restores the same anchor");
    assert.ok(closed.focused && opened.focused && reclosed.focused, "Keyboard focus remains on the disclosure");
});

test("library help and management follow search and reading in empty, nonempty and no-match states", { timeout: 60000 }, async t => {
    const { page, context, entries, requests } = await setup(t, 2);
    const before = await loadBoardState(context);
    const frozenBefore = await Promise.all(entries.flatMap(entry => Object.values(entry.files)).map(file => readFile(file)));
    const measurements = [];
    for (const state of ["nonempty", "no-match", "empty"]) {
        if (state === "no-match") await page.locator("#savedReportSearch").fill("not-an-invented-report");
        if (state === "empty") {
            await page.locator("#clearSavedReportSearch").click();
            await updateBoardState(context, state => { state.exports = []; });
            await page.reload();
            await page.locator('#workspace[aria-busy="false"]').waitFor();
            assert.match(await page.locator("#bundleList").innerText(), /Create or continue a report.*review it before saving/);
            assert.equal(await page.getByRole("link", { name: "Create a report", exact: true }).isVisible(), true);
        }
        for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [1440, 200], [375, 100], [375, 200]]) {
            await page.setViewportSize({ width, height: 1100 });
            await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
            await page.evaluate(() => document.fonts.ready);
            const name = `${state}-${theme}-${width}-${scale}`;
            if (state === "empty") {
                assert.equal(await page.locator("#savedReportSearch").isVisible(), false);
                assert.equal(await page.locator("#savedLibraryHelp").isVisible(), false);
                assert.equal(await page.locator("#savedLibraryManagement").isVisible(), false);
                assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                await shot(page, name);
                continue;
            }
            measurements.push(await togglePlacement(page, "#savedLibraryHelp", name));
            const summary = page.locator("#savedLibraryHelp > summary");
            await summary.press("Enter");
            const geometry = await page.locator("#savedReportsPanel").evaluate(panel => {
                const box = selector => panel.querySelector(selector).getBoundingClientRect().toJSON();
                const help = panel.querySelector("#savedLibraryHelpBody");
                const measure = document.createElement("span");
                measure.style.cssText = "display:block;width:65ch;height:0";
                help.append(measure);
                const readingWidth = measure.getBoundingClientRect().width;
                measure.remove();
                return {
                    search: box("#savedReportSearch"), help: box("#savedLibraryHelp"), body: box("#savedLibraryHelpBody"),
                    list: box("#bundleList"), management: box("#savedLibraryManagement"),
                    readingWidth, fontSize: parseFloat(getComputedStyle(help).fontSize),
                    overflow: document.documentElement.scrollWidth > innerWidth + 1,
                    clipped: [...panel.querySelectorAll("summary,button,input,p")].filter(node => node.checkVisibility()
                        && ((node.tagName !== "INPUT" && node.scrollWidth > node.clientWidth + 1) || node.getBoundingClientRect().right > innerWidth + 1))
                        .map(node => node.textContent || node.id),
                };
            });
            assert.equal(geometry.overflow, false, name);
            assert.deepEqual(geometry.clipped, [], name);
            assert.ok(Math.abs(geometry.help.x - geometry.search.x) <= 1, `${name}: help starts with its search section`);
            assert.ok(geometry.help.y >= geometry.search.bottom, `${name}: the primary search comes before its help`);
            assert.ok(geometry.body.width <= geometry.readingWidth + 1, `${name}: help has a readable line length`);
            assert.ok(geometry.management.y >= geometry.list.bottom, `${name}: destructive management follows reading`);
            assert.equal(await page.locator("#deleteAllReports").isVisible(), false, `${name}: bulk deletion does not compete with opening a report`);
            if (scale === 200) assert.ok(geometry.fontSize >= 24, `${name}: text is enlarged, not shrunk to fit`);
            await summary.press("Space");
            measurements.push(await togglePlacement(page, "#savedLibraryManagement", `${name}-management`));
            await page.locator("#savedLibraryManagement > summary").focus();
            await page.keyboard.press("Enter");
            assert.equal(await page.locator("#deleteAllReports").isDisabled(), state === "empty");
            await page.locator("#savedLibraryManagement > summary").press("Space");
        }
    }
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
    const frozenAfter = await Promise.all(entries.flatMap(entry => Object.values(entry.files)).map(file => readFile(file)));
    assert.deepEqual(frozenAfter, frozenBefore);
    assert.deepEqual(requests.filter(url => /\/api\/(?:export|preview|privacy-review|collection\/now|evaluation\/run|artifact-deletion\/confirm)$/.test(url)), []);
    await page.getByRole("link", { name: "Create a report", exact: true }).click();
    assert.equal(await page.locator("#reportStage1").isVisible(), true, "The empty library retains its real narrow-screen creation path");
    if (process.env.WIRE_REPORTS_LAYOUT_PROOFS) await writeFile(path.join(process.env.WIRE_REPORTS_LAYOUT_PROOFS, "measurements.json"), JSON.stringify(measurements, null, 2));
});

test("help wraps long content without moving its summary and library reads retain pending, error and Escape recovery", { timeout: 60000 }, async t => {
    const { page, context, entries, requests } = await setup(t, 2);
    const before = await loadBoardState(context);
    const frozenBefore = await Promise.all(entries.flatMap(entry => Object.values(entry.files)).map(file => readFile(file)));
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await page.locator("#savedLibraryHelpBody").evaluate(body => {
            if (body.querySelector("[data-invented-long-help]")) return;
            const paragraph = document.createElement("p");
            paragraph.dataset.inventedLongHelp = "";
            paragraph.textContent = "An invented long explanation exercises ordinary wrapping without hiding meaning. ".repeat(6);
            body.append(paragraph);
        });
        await togglePlacement(page, "#savedLibraryHelp", `long-help-${theme}-${width}-${scale}`);
        await page.locator("#savedLibraryManagement > summary").click();
        await page.locator("#deleteAllReports").click();
        const dialog = page.locator(".deletion-dialog:modal");
        await dialog.locator(".delete-object-confirm:not([disabled])").waitFor();
        assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(node => node === document.activeElement), true);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert.equal(await dialog.count(), 0);
        assert.equal(await page.locator("#deleteAllReports").evaluate(node => node === document.activeElement), true);
        await page.locator("#savedLibraryManagement > summary").click();
        const open = page.getByRole("button", { name: "Open saved report", exact: true }).first();
        await open.click();
        await page.frameLocator(".saved-report-dialog iframe").getByRole("heading", { name: "Invented report 2", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".saved-report-dialog").waitFor({ state: "detached" });
        assert.equal(await page.locator(".saved-report-dialog").count(), 0);
        assert.equal(await open.evaluate(node => node === document.activeElement), true);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        t.after(() => release());
        await page.route("**/api/snapshot", async route => { await gate; await route.continue(); }, { times: 1 });
        await page.context().setOffline(true);
        await page.context().setOffline(false);
        await page.locator('#workspace[aria-busy="true"]').waitFor();
        assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
        assert.equal(await page.locator("#bundles > summary").innerText(), "Saved reports (2)");
        await togglePlacement(page, "#savedLibraryHelp", `pending-${theme}-${width}-${scale}`);
        await togglePlacement(page, "#savedLibraryManagement", `pending-management-${theme}-${width}-${scale}`);
        release();
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        assert.equal(await page.locator("#deleteAllReports").isDisabled(), false);
        await page.route("**/api/snapshot", route => route.abort("connectionreset"), { times: 1 });
        await page.context().setOffline(true);
        await page.context().setOffline(false);
        await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false"
            && document.querySelector("#deleteAllReports").disabled);
        assert.equal(await page.locator("#bundles > summary").innerText(), "Saved reports (2)");
        await togglePlacement(page, "#savedLibraryHelp", `error-${theme}-${width}-${scale}`);
        await togglePlacement(page, "#savedLibraryManagement", `error-management-${theme}-${width}-${scale}`);
        await page.reload();
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        assert.equal(await page.locator("#deleteAllReports").isDisabled(), false);
    }
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
    assert.deepEqual(after.exports, before.exports);
    assert.deepEqual(await Promise.all(entries.flatMap(entry => Object.values(entry.files)).map(file => readFile(file))), frozenBefore);
    assert.equal(requests.filter(url => url === "/api/artifact-deletion/confirm").length, 0);
});

test("creation disclosures retain their anchors and controls at desktop and enlarged narrow text", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    await chooseReportScope(page, "all");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        for (const selector of ["#scopeDetails", "#additionalMasking", "#reportRequests"]) {
            await togglePlacement(page, selector, `setup-${selector.slice(1)}-${theme}-${width}-${scale}`);
        }
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await scanReport(page);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        for (const selector of [".report-snapshot-details:visible", ".report-copy-inspection:visible"]) {
            await togglePlacement(page, selector, `review-${selector.split(":")[0].slice(1)}-${theme}-${width}-${scale}`);
        }
    }
});
