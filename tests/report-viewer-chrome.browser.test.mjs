import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { reportHash } from "../lib/report-artifacts.mjs";
import { brandDarkMark } from "../lib/branding.mjs";
import { contrast, measureControlSurface } from "./color-measurements.mjs";

async function setup(t) {
    const record = fixture("viewer-chrome");
    record.capturedAt = new Date().toISOString(); record.toolCalls[0].startedAt = record.capturedAt;
    record.userPrompt.text = "Read the Cedar planning notes and keep recorded decisions separate from open questions.";
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, [record]);
    const exports = createExportController(context), bundles = [];
    for (const [title, formats] of [["Cedar older report", ["html"]], ["Cedar current report", ["html", "pdf", "json", "markdown"]]]) {
        const prepared = await exports.preview(title, undefined, { title, promptMode: "masked", formats },
            { kind: "all", revision: (await loadBoardState(context)).revision });
        await exports.review(title, prepared.previewId, true);
        bundles.push((await exports.confirm(title, prepared.previewId, true)).bundle);
    }
    const older = bundles[0], file = older.files["product-report.html"];
    const original = (await readFile(file, "utf8")).replace(' data-evidence-theme="light"', "").replace(brandDarkMark, "");
    const manifestPath = older.files["coverage-and-redaction-manifest.json"];
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files["product-report.html"] = { bytes: Buffer.byteLength(original), sha256: reportHash(original) };
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(file, original); await writeFile(manifestPath, manifestBytes);
    await updateBoardState(context, state => { state.exports.find(item => item.bundleId === older.bundleId).manifestHash = reportHash(manifestBytes); });
    const originals = new Map();
    for (const bundle of bundles) for (const file of Object.values(bundle.files)) originals.set(file, await readFile(file));
    const runtime = await startServer(context, exports, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => {
        await browser.close(); await runtime.close();
        for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes);
        for (const fn of cleanup) await fn();
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
    page.setDefaultTimeout(10000);
    const errors = [], outside = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) { outside.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
    await page.goto(runtime.url + "#reports");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    async function capture(name) {
        if (!process.env.WIRE_VIEWER_CHROME_PROOFS) return;
        await mkdir(process.env.WIRE_VIEWER_CHROME_PROOFS, { recursive: true });
        let screenshot;
        if (await page.locator("#savedReportReader iframe:visible").count()) {
            const frame = page.frameLocator("#savedReportReader iframe:visible");
            await expect(frame.locator("h1")).toBeInViewport();
            await expect.poll(async () => {
                const paint = await logoContrast(page, frame.locator(".report-brand .brand-logo:visible"));
                screenshot = paint.screenshot;
                return paint.contrast;
            }).toBeGreaterThan(1.1);
        }
        await writeFile(path.join(process.env.WIRE_VIEWER_CHROME_PROOFS, name + ".png"),
            screenshot ?? await page.screenshot({ animations: "disabled" }));
    }
    return { page, browser, url: runtime.url, bundles, originals, capture, context, exports };
}

async function logoContrast(page, logo) {
    await expect(logo).toBeInViewport();
    const geometry = await logo.evaluate(node => ({ box: node.getBoundingClientRect().toJSON(), view: {
        x: node.viewBox.baseVal.x, y: node.viewBox.baseVal.y, width: node.viewBox.baseVal.width, height: node.viewBox.baseVal.height,
    } }));
    const box = await logo.boundingBox(), screenshot = await page.screenshot({ animations: "disabled", scale: "css" });
    const colors = await page.evaluate(async ({ png, box, view }) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))]));
        const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0); bitmap.close();
        const sample = (x, y) => [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
        return { ink: sample(box.x + (260 - view.x) / view.width * box.width, box.y + (180 - view.y) / view.height * box.height),
            background: sample(box.x + 2, box.y + 2) };
    }, { png: screenshot.toString("base64"), box, view: geometry.view });
    return { ...colors, contrast: contrast(`rgb(${colors.ink})`, `rgb(${colors.background})`), screenshot };
}

test("older Report reading chooses visible WIRE artwork without changing original files", { timeout: 60000 }, async t => {
    const { page, bundles, originals, capture } = await setup(t), reader = page.locator("#savedReportReader");
    const measurements = [];
    await page.getByRole("button", { name: "View report: Cedar older report", exact: true }).click();
    const report = reader.frameLocator("iframe");
    await expect(report.locator("h1")).toHaveText("Cedar older report");
    for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme }); await chooseTheme(page, theme);
        const mark = report.locator(".report-brand .brand-logo:visible");
        const measured = await logoContrast(page, mark);
        measurements.push({ theme, ink: measured.ink, background: measured.background, contrast: measured.contrast });
        await capture("older-report-" + theme);
        assert.ok(measured.contrast >= 3, JSON.stringify({ theme, ink: measured.ink, background: measured.background, contrast: measured.contrast }));
        assert.ok((await logoContrast(page, page.locator("#shellBrand .brand-logo:visible"))).contrast >= 3);
    }
    await selectActivityOption(page, "savedReaderFormat", "html");
    await expect(reader.frameLocator("iframe:visible").locator("h1")).toHaveText("Cedar older report");
    await expect(reader.frameLocator("iframe:visible").locator("[data-wire-reading-brand]")).toHaveCount(0);
    await capture("older-original-html-unchanged-dark");
    await reader.getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(await reader.locator("pre:visible").textContent(), originals.get(bundles[0].files["product-report.html"]).toString());
    const download = page.waitForEvent("download");
    await reader.getByRole("button", { name: "Download", exact: true }).click();
    assert.deepEqual(await readFile(await (await download).path()), originals.get(bundles[0].files["product-report.html"]));
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    await page.getByRole("button", { name: "View report: Cedar current report", exact: true }).click();
    for (const format of ["report", "html", "markdown", "pdf"]) {
        await selectActivityOption(page, "savedReaderFormat", format);
        if (format === "pdf") await reader.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        else {
            const mark = format === "markdown" ? reader.locator(".saved-report-mark .brand-logo:visible")
                : reader.frameLocator(".saved-file-preview:visible iframe").locator(".report-brand .brand-logo:visible");
            assert.ok((await logoContrast(page, mark)).contrast >= 3, format);
        }
        await capture("current-" + format + "-dark-shell");
    }
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    await page.locator('[data-report-preset="all"]').click();
    const prepared = page.frameLocator(".report-contained-frame");
    await expect(prepared.locator("h1")).toHaveText("All activity");
    const mark = prepared.locator(".report-brand .brand-logo:visible");
    assert.ok((await logoContrast(page, mark)).contrast >= 3);
    await capture("prepared-report-dark");
    if (process.env.WIRE_VIEWER_CHROME_PROOFS) await writeFile(path.join(process.env.WIRE_VIEWER_CHROME_PROOFS, "logo-contrast.json"), JSON.stringify(measurements, null, 2));
});

test("file modes are compact distinct segments with preserved keyboard and file semantics", { timeout: 60000 }, async t => {
    const { page, bundles, originals, capture } = await setup(t), reader = page.locator("#savedReportReader");
    await page.getByRole("button", { name: "View report: Cedar current report", exact: true }).click();
    for (const format of ["html", "markdown", "json", "manifest"]) {
        await selectActivityOption(page, "savedReaderFormat", format);
        const modes = reader.getByRole("group", { name: "File view", exact: true });
        const name = ["json", "manifest"].includes(format) ? "Tree" : "Preview";
        const preview = modes.getByRole("button", { name, exact: true }), source = modes.getByRole("button", { name: "Source", exact: true });
        await expect(preview).toHaveAttribute("aria-pressed", "true");
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            await capture(`modes-${format}-${theme}`);
            const group = await modes.boundingBox(), controls = await modes.getByRole("button").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
            assert.ok(group.width <= 104 && controls.every(box => box.width >= 44 && box.height >= 44), JSON.stringify({ group, controls }));
            const active = await preview.evaluate(measureControlSurface), track = await modes.evaluate(node => getComputedStyle(node).backgroundColor);
            assert.ok(contrast(active.face, track) >= 1.3, JSON.stringify({ active, track }));
            await source.focus(); await page.keyboard.press("Enter");
            await expect(source).toHaveAttribute("aria-pressed", "true"); await expect(source).toBeFocused();
            if (format === "html") await capture("source-focus-" + theme);
            const filename = format === "manifest" ? "coverage-and-redaction-manifest.json" : "product-report." + (format === "markdown" ? "md" : format);
            assert.equal(await reader.locator("pre:visible").textContent(), originals.get(bundles[1].files[filename]).toString());
            await preview.click(); await expect(preview).toHaveAttribute("aria-pressed", "true");
            await source.hover();
            await expect(source).toHaveAttribute("aria-pressed", "false");
            if (format === "html") await capture("source-hover-" + theme);
        }
    }
    await page.setViewportSize({ width: 390, height: 950 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const modes = reader.getByRole("group", { name: "File view", exact: true });
    await modes.getByRole("button", { name: "Source", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(modes.getByRole("button", { name: "Source", exact: true })).toBeFocused();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await capture("modes-manifest-narrow-focus");
});

test("saved rows expose aligned text treatment and labeled inspect/delete actions", { timeout: 60000 }, async t => {
    const { page, browser, url, bundles, capture, context, exports } = await setup(t);
    for (const [title, mode] of [["Cedar planning decisions and unresolved release handoffs across multiple teams", "original"], ["Cedar report without prompts", "none"]]) {
        const prepared = await exports.preview(title, undefined, { title, promptMode: mode, formats: ["html"] },
            { kind: "all", revision: (await loadBoardState(context)).revision });
        await exports.review(title, prepared.previewId, true);
        await exports.confirm(title, prepared.previewId, true);
    }
    const comparison = await exports.previewComparison("row-comparison", bundles[0].bundleId, bundles[1].bundleId, { formats: ["html"] });
    await exports.reviewComparison("row-comparison", comparison.previewId, true);
    await exports.confirmComparison("row-comparison", comparison.previewId, true);
    await updateBoardState(context, state => { delete state.exports.find(entry => entry.bundleId === bundles[0].bundleId).promptMode; });
    const before = await loadBoardState(context), bytes = new Map();
    for (const entry of before.exports) for (const file of Object.values(entry.files)) bytes.set(file, await readFile(file));
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const rows = page.locator(".saved-library-row");
    const current = rows.filter({ hasText: "Cedar current report" });
    await expect(current.locator(".saved-report-privacy")).toContainText("Personal details hidden where detected");
    await expect(rows.filter({ hasText: "Cedar older report" }).locator(".saved-report-privacy")).toContainText("Text treatment not recorded");
    await expect(rows.filter({ hasText: "Cedar planning decisions" }).locator(".saved-report-privacy")).toContainText("Chat details kept");
    await expect(rows.filter({ hasText: "Cedar report without prompts" }).locator(".saved-report-privacy")).toContainText("Prompts and replies left out");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const privacyColumns = await rows.locator(".saved-report-privacy").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
        assert.ok(Math.max(...privacyColumns) - Math.min(...privacyColumns) < 1);
        const text = await current.locator(".saved-report-privacy").evaluate(measureControlSurface);
        assert.ok(contrast(text.ink, text.face) >= 4.5);
        await expect(current.locator(".saved-report-privacy")).toHaveCSS("font-weight", "400");
        assert.equal(await rows.locator(".saved-report-actions").evaluateAll(nodes => nodes.every(node => {
            const [inspect, remove] = [...node.children].map(button => button.getBoundingClientRect());
            return Math.abs(inspect.y - remove.y) < 1;
        })), true);
        await expect(current.getByRole("button", { name: "Inspect details", exact: true })).toBeVisible();
        await expect(current.getByRole("button", { name: "Delete report", exact: true })).toBeVisible();
        await capture("library-" + theme);
    }
    const inspect = current.getByRole("button", { name: "Inspect details", exact: true });
    await inspect.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.getByRole("button", { name: "Close saved report details", exact: true }).click();
    await expect(inspect).toBeFocused();
    await current.getByRole("button", { name: "Delete report", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Cedar current report");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(current.getByRole("button", { name: "Delete report", exact: true })).toBeFocused();
    await expect(rows.getByRole("button", { name: "Delete saved comparison", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 950 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await current.scrollIntoViewIfNeeded();
    await expect(current.locator(".saved-report-privacy")).toContainText("Personal details hidden where detected");
    await expect(current.getByRole("button", { name: "Inspect details", exact: true })).toBeVisible();
    await expect(current.getByRole("button", { name: "Delete report", exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await capture("library-narrow");
    const touch = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
    await touch.goto(url + "#reports");
    await expect(touch.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const touchRow = touch.locator(".saved-library-row").filter({ hasText: "Cedar current report" });
    await touchRow.getByRole("button", { name: "Inspect details", exact: true }).tap();
    await expect(touch.locator("#contextSidebar[open]")).toBeVisible();
    await touch.getByRole("button", { name: "Close saved report details", exact: true }).tap();
    await touchRow.getByRole("button", { name: "Delete report", exact: true }).tap();
    await touch.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(touchRow.getByRole("button", { name: "Delete report", exact: true })).toBeVisible();
    await touch.close();
    assert.deepEqual(await loadBoardState(context), before);
    for (const [file, value] of bytes) assert.deepEqual(await readFile(file), value);
});
