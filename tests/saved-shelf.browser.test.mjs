import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, navigateMain, selectActivityOption, chooseTheme } from "./helpers.mjs";

const periods = [
    { range: "custom", from: "2025-12-29", to: "2026-01-03" },
    { range: "custom", from: "2026-10-28", to: "2026-11-09" },
    { range: "custom", from: "2026-11-07", to: "2026-11-19" },
];
async function setup(t, count, { enforced = false } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, periods.map(({ from }, i) => {
        const row = fixture("shelf-case-" + i);
        row.toolCalls[0].startedAt = row.capturedAt = from + "T18:00:00Z";
        return row;
    }));
    t.after(async () => { for (const work of cleanup.reverse()) await work(); });
    const timeContext = { locale: "en-US", timeZone: "America/Los_Angeles" };
    const controller = createExportController(context), bundles = [];
    for (let i = 0; i < count; i++) {
        const preview = await controller.preview("shelf-fixture", undefined, {
            title: "Fir field notes " + (i + 1), promptMode: "none", formats: ["html"],
            dateSelection: periods[i % 3], timeContext,
        }, { kind: "all", revision: (await loadBoardState(context)).revision });
        await controller.review("shelf-fixture", preview.previewId, true, timeContext);
        bundles.push((await controller.confirm("shelf-fixture", preview.previewId, true, timeContext)).bundle);
    }
    const access = enforced ? await createCopilotRuntimeAccess(context) : undefined;
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false }, frontend: "react", access });
    const browser = await chromium.launch();
    cleanup.push(async () => { await browser.close(); await runtime.close(); await access?.close(); });
    const profile = await browser.newContext({ viewport: { width: 1240, height: 900 }, timezoneId: "Pacific/Honolulu", reducedMotion: "reduce" });
    const page = await profile.newPage();
    page.setDefaultTimeout(7500);
    const errors = [], requests = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (r.method() === "POST") requests.push(new URL(r.url()).pathname); });
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "reports");
    return { page, context, runtime, bundles, requests };
}
const sections = page => page.getByRole("navigation", { name: "Report sections", exact: true });
const allSaved = page => sections(page).getByRole("link", { name: "Saved library", exact: true });
const overview = page => sections(page).getByRole("link", { name: "Overview", exact: true });
const recent = page => page.locator(".saved-shelf .saved-report-title");
async function holdTitle(page, key) {
    await recent(page).first().evaluate((control, key) => {
        window[key] = { control, name: control.querySelector(".saved-report-name").firstChild,
            period: control.querySelector(".saved-report-period").firstChild, label: control.getAttributeNode("aria-label") };
    }, key);
}
async function expectRetired(page, key) {
    assert.deepEqual(await page.evaluate(key => {
        const { control, name, period, label } = window[key];
        control.click();
        return [control.isConnected, name.data, period.data, label.value];
    }, key), [false, "", "", ""]);
}

test("Reports starts with two recent saved names; full-library controls retain the activated item and page", { timeout: 60000 }, async t => {
    const { page, requests, bundles } = await setup(t, 9);
    const shelf = page.locator("#savedReportsPanel");
    await expect(overview(page)).toHaveAttribute("aria-current", "page");
    await expect(recent(page).locator(".saved-report-name")).toHaveText(["Fir field notes 9", "Fir field notes 8"]);
    await expect(recent(page).locator(".saved-report-period")).toHaveText(["Nov 7–19, 2026", "Oct 28–Nov 9, 2026"]);
    assert.ok(await shelf.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector("#reportCreatePanel")) & Node.DOCUMENT_POSITION_FOLLOWING)));
    await expect(page.locator("#savedReportSearch")).toBeHidden();
    await expect(page.locator(".saved-library-row")).toHaveCount(0);
    await allSaved(page).focus();
    await page.keyboard.press("Tab");
    await expect(recent(page).first()).toBeFocused();
    await holdTitle(page, "oldShelf");
    await page.keyboard.press("Enter");
    await expect(page.locator("#savedReportReader iframe")).toBeVisible();
    await expect(sections(page)).toBeHidden();
    await expectRetired(page, "oldShelf");
    await page.getByRole("button", { name: "Back to Reports" }).click();
    await expect(recent(page).first()).toBeFocused();
    const all = allSaved(page);
    await all.click();
    await expect(all).toHaveAttribute("aria-current", "page");
    await expect(overview(page)).not.toHaveAttribute("aria-current", "page");
    await expect(page.locator("#pageTitle")).toHaveText("Saved report library");
    await expect(page.locator("#reportCreatePanel")).toBeHidden();
    await expect(page.locator("#savedReportSearch")).toBeVisible();
    await expect(page.locator(".saved-library-row")).toHaveCount(6);
    await expect(recent(page)).toHaveCount(0);
    await page.getByRole("link", { name: "Compare saved reports" }).click();
    await expect(page.locator("#comparisonWorkspace")).toBeVisible();
    await page.getByRole("link", { name: "Back to saved reports" }).click();
    await expect(page.locator("#reportCompareLink")).toBeFocused();
    await selectActivityOption(page, "savedReportOrder", "oldest");
    await expect(page.locator(".saved-report-period").first()).toHaveText("Report period: Dec 29, 2025–Jan 3, 2026");
    for (const query of ["Dec 29, 2025–Jan 3, 2026", "2025-12-29", "2026-01-03 prompts and replies left out"]) {
        await page.locator("#savedReportSearch").fill(query);
        await expect(page.locator(".saved-library-row").getByText("Fir field notes 7", { exact: true })).toBeVisible();
    }
    await page.locator("#savedReportSearch").fill("Fir field");
    await expect(page.locator("#savedReportSearchCount")).toContainText("9 of 9");
    await page.getByRole("button", { name: "Next saved reports" }).click();
    const row = page.locator(".saved-library-row").first(), title = row.locator(".saved-report-title");
    await expect(title).toContainText("Fir field notes 7");
    await title.focus();
    const top = await title.evaluate(node => node.getBoundingClientRect().top);
    await title.press("Enter");
    await expect(page.locator("#savedReportReader iframe")).toBeVisible();
    await page.getByRole("button", { name: "Back to saved reports" }).click();
    await expect(title).toBeFocused();
    await expect(page.locator("#savedReportSearch")).toHaveValue("Fir field");
    await expect(title).toContainText("Fir field notes 7");
    assert.ok(Math.abs(await title.evaluate(node => node.getBoundingClientRect().top) - top) < 3);
    const files = row.getByRole("button", { name: /^Files for/ });
    await files.click();
    const menu = page.locator(".saved-report-menu:popover-open");
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: /HTML/ }).click();
    await expect(page.locator("#savedReportReader iframe")).toBeVisible();
    await page.getByRole("button", { name: "Back to saved reports" }).click();
    await expect(files).toBeFocused();
    const inspect = row.getByRole("button", { name: "Inspect details" });
    await inspect.click();
    await expect(page.locator("#savedInspectorTitle")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inspect).toBeFocused();
    await overview(page).click();
    await expect(all).toBeFocused();
    await expect(recent(page).first()).toContainText("Fir field notes 9");
    // Alter only a disposable original: the shelf must surface the reader's actual refusal.
    const file = bundles.at(-1).files["product-report.html"], original = await readFile(file);
    await writeFile(file, Buffer.concat([original, Buffer.from("changed")]));
    await recent(page).first().click();
    await expect(page.locator("#savedReportReader")).toContainText(/could not be verified|changed|unavailable/i);
    await expect(page.locator("#savedReportReader iframe")).toHaveCount(0);
    assert.deepEqual(requests.filter(p => /^\/api\/(?:export|preview|collection\/now|artifact-deletion\/confirm)$/.test(p)), []);
});

test("compact shelf reflows at doubled text, Search opens the full library, and gating scrubs connected and prior owners", { timeout: 45000 }, async t => {
    const { page, runtime, requests } = await setup(t, 3, { enforced: true });
    for (const [theme, width, scale] of [["light", 1240, 100], ["dark", 375, 200]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 920 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale + "%"; }, scale);
        await page.evaluate(() => document.fonts.ready);
        await expect(overview(page)).toHaveCSS("border-bottom-style", "solid");
        assert.ok(await sections(page).getByRole("link").evaluateAll(links => links.every(link => {
            const rect = link.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44;
        })));
        const bounds = await recent(page).evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, clipped: node.scrollWidth > node.clientWidth + 1 };
        }));
        assert.equal(bounds.length, 2);
        assert.ok(bounds.every(r => r.left >= 0 && r.right <= width && !r.clipped));
        if (width === 375) assert.ok(bounds[1].top >= bounds[0].bottom);
        else assert.equal(bounds[1].top, bounds[0].top);
        if (process.env.WIRE_SHELF_PROOFS) {
            await mkdir(process.env.WIRE_SHELF_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_SHELF_PROOFS, `reports-shelf-${theme}.png`) });
        }
    }
    await page.setViewportSize({ width: 1240, height: 920 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await holdTitle(page, "oldShelf");
    await page.locator("#wireSearch").fill("Saved reports");
    await page.locator("#wireSearchResults button").filter({ hasText: "Saved reports" }).first().click();
    await expect(page.locator("#savedReportSearch")).toBeVisible();
    await expectRetired(page, "oldShelf");
    await overview(page).click();
    await holdTitle(page, "activeShelf");
    const controller = await page.context().newPage();
    await controller.goto(runtime.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    const savedRequests = () => requests.filter(p => /report-artifacts|\/api\/(?:export|preview|artifact-deletion)/.test(p));
    const before = savedRequests();
    await expectRetired(page, "oldShelf");
    await expectRetired(page, "activeShelf");
    assert.deepEqual(savedRequests(), before);
});

test("the public library reloads, a lost private filter requires explicit recovery, and an empty shelf is distinct from New report", async t => {
    const { page, context } = await setup(t, 1);
    await allSaved(page).click();
    await page.reload();
    await expect(page.locator("#savedReportSearch")).toBeVisible();
    await page.locator("#savedReportSearch").fill("Fir field");
    await expect(page.locator("#savedReportSearchCount")).toContainText("1 of 1");
    await page.reload();
    const recover = page.getByRole("button", { name: "Open this view without the private selection" });
    await expect(recover).toBeVisible();
    await expect(page.locator("#bundleList .saved-report-title")).toHaveCount(0);
    await recover.click();
    await expect(page.locator("#savedReportSearch")).toBeVisible();
    await expect(page.locator("#savedReportSearch")).toHaveValue("");
    await page.locator(".saved-library-row").getByRole("button", { name: "Delete report", exact: true }).click();
    const confirm = page.locator('[aria-labelledby="savedArtifactDeleteTitle"]');
    await expect(confirm).toHaveAttribute("aria-busy", "false");
    await confirm.getByRole("button", { name: "Delete report", exact: true }).click();
    await expect(page.locator("#bundleList")).toHaveText("No saved reports.");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await overview(page).click();
    await expect(page.locator("#bundleList")).toContainText("No saved reports yet.");
    await expect(allSaved(page)).toBeVisible();
    const shelf = await page.locator("#savedReportsPanel").boundingBox(), creation = await page.locator("#reportCreatePanel").boundingBox();
    assert.ok(creation.y - (shelf.y + shelf.height) >= 16);
});
