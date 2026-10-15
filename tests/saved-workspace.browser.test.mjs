import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { privateFixture, fixture, navigateMain, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { contrast } from "./color-measurements.mjs";

const proof = process.env.WIRE_SAVED_WORKSPACE_PROOFS;
const timeContext = { timeZone: "UTC", locale: "en-US" };
async function setup(t, { count = 8, motion = "reduce" } = {}) {
    if (proof) await mkdir(proof, { recursive: true });
    const { context } = await privateFixture(t, [fixture("saved-workspace")]);
    const controller = createExportController(context), bundles = [];
    for (let index = 0; index < count; index++) {
        const state = await loadBoardState(context);
        const preview = await controller.preview("saved-workspace-fixture", undefined,
            { promptMode: "none", formats: index === 0 ? ["json", "markdown"] : ["html", "json"], timeContext },
            { kind: "all", revision: state.revision });
        await controller.review("saved-workspace-fixture", preview.previewId, true, timeContext);
        bundles.push((await controller.confirm("saved-workspace-fixture", preview.previewId, true, timeContext)).bundle);
    }
    let forbiddenSourceReads = 0;
    const refuse = async () => { forbiddenSourceReads++; throw new Error("Source/provider reads forbidden in saved workspace proof."); };
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: refuse, readSource: refuse } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true, reducedMotion: motion });
    const requests = [], errors = [], forbidden = [];
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || /\/api\/(?:collection\/now|export|preview|evaluation\/run|evaluation\/automatic\/approve)/.test(url.pathname)) {
            forbidden.push(url.pathname); return route.abort();
        }
        if (request.method() === "POST") requests.push({ path: url.pathname, body: request.postDataJSON() });
        return route.continue();
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
        assert.equal(forbiddenSourceReads, 0);
    });
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "reports");
    await page.evaluate(() => document.fonts.ready);
    return { page, bundles, context, runtime, requests };
}
async function shot(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, name + ".png"), fullPage: !await page.locator(":modal").count() });
}
const row = (page, id) => page.locator(`[data-bundle-id="${id}"]`);
const settle = page => page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().some(animation => animation.playState === "running"));

test("saved close interruption releases the old owner and respects newer focus and caller history mode", { timeout: 30000 }, async t => {
    const { page, bundles } = await setup(t, { count: 3, motion: "no-preference" });
    await page.evaluate(() => { history.scrollRestoration = "manual"; });
    await row(page, bundles[1].bundleId).locator(".saved-report-summary").click();
    await settle(page);
    await page.locator("#closeContextSidebar").click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length > 0);
    await row(page, bundles[2].bundleId).locator(".saved-report-summary").click();
    await settle(page);
    assert.match(await page.locator("#contextSidebarBody").innerText(), new RegExp(bundles[2].bundleId));
    assert.doesNotMatch(await page.locator("#contextSidebarBody").innerText(), new RegExp(bundles[1].bundleId));
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.inert), false);
    assert.equal(await page.locator("#contextSidebarFooter button").count(), 1);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#savedReportSearch").click();
    await settle(page);
    await expect(page.locator("#savedReportSearch")).toBeFocused();
    assert.equal(await page.evaluate(() => history.scrollRestoration), "manual");
    await row(page, bundles[1].bundleId).locator(".saved-report-summary").click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length > 0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await settle(page);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    assert.equal(await page.locator("#contextSidebarFooter").textContent(), "");
    assert.equal(await page.evaluate(() => history.scrollRestoration), "manual");
});

test("Back through a closing saved inspector releases inert ownership before restoring an interaction", { timeout: 20000 }, async t => {
    const { page, bundles } = await setup(t, { count: 1, motion: "no-preference" });
    await navigateMain(page, "analyze");
    await page.locator("#activityList .request-card-open").first().click();
    await settle(page);
    const origin = page.url();
    await navigateMain(page, "reports");
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await row(page, bundles[0].bundleId).locator(".saved-report-summary").click();
    await settle(page);
    const exiting = await page.evaluate(() => new Promise(resolve => {
        addEventListener("popstate", () => requestAnimationFrame(() => {
            const panel = document.querySelector("#contextSidebar"), motion = panel.getAnimations()[0];
            if (motion) { motion.pause(); motion.currentTime = 80; }
            resolve({ animated: Boolean(motion), inert: panel.inert });
        }), { once: true });
        history.back();
    }));
    assert.deepEqual(exiting, { animated: true, inert: true }, "Exercise the actual outgoing saved inspector, not its settled endpoint");
    await page.goBack();
    await expect(page).toHaveURL(origin);
    await settle(page);
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Interaction");
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.inert), false, "The successor interaction must be operable");
    assert.equal(await page.locator("#contextSidebar .saved-report-inspection,#contextSidebarParking .saved-report-inspection").count(), 0);
    await shot(page, "saved-exit-interaction-return");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
});

test("saved inspection preserves paged sorted origins, real motion anchors, history and same-panel switching", { timeout: 30000 }, async t => {
    const { page, bundles, requests, runtime } = await setup(t, { motion: "no-preference" });
    await page.locator("#savedReportSearch").fill("No prompts");
    await selectActivityOption(page, "savedReportOrder", "oldest");
    await page.getByRole("button", { name: "Next saved reports", exact: true }).click();
    const a = row(page, bundles[6].bundleId), b = row(page, bundles[7].bundleId);
    const trigger = a.locator(".saved-report-summary");
    await trigger.scrollIntoViewIfNeeded();
    const box = await trigger.boundingBox(), top = await a.evaluate(node => node.getBoundingClientRect().top);
    const originalBTop = await b.evaluate(node => node.getBoundingClientRect().top);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length > 0);
    if (proof) {
        await page.locator("#contextSidebar").evaluate(node => { const motion = node.getAnimations()[0]; motion.pause(); motion.currentTime = 80; });
        await page.screenshot({ path: path.join(proof, "inspector-entering-80ms.png") });
        await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].play());
    }
    const frames = await page.evaluate(id => new Promise(resolve => {
        const positions = [], sample = () => {
            positions.push(document.querySelector(`[data-bundle-id="${id}"]`).getBoundingClientRect().top);
            if (document.querySelector("#contextSidebar").getAnimations().some(a => a.playState === "running")) requestAnimationFrame(sample);
            else resolve(positions);
        }; sample();
    }), bundles[6].bundleId);
    assert.ok(frames.every(value => Math.abs(value - top) < 3), JSON.stringify({ top, frames }));
    assert.equal(await page.locator("#contextSidebar").getAttribute("data-mode"), "docked");
    assert.equal(requests.some(item => ["/api/report/open", "/api/artifact-file"].includes(item.path)), false);
    await shot(page, "library-page-two-inspector-light");
    await b.locator(".saved-report-summary").click();
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.getAnimations().length), 0, "Switching metadata does not replay entrance");
    assert.match(await page.locator("#contextSidebarBody").innerText(), new RegExp(bundles[7].bundleId));
    await page.locator("#closeContextSidebar").click();
    if (proof) {
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length > 0);
        await page.locator("#contextSidebar").evaluate(node => { const motion = node.getAnimations()[0]; motion.pause(); motion.currentTime = 80; });
        await page.screenshot({ path: path.join(proof, "inspector-exiting-80ms.png") });
        await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].play());
    }
    await settle(page);
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await expect(b.locator(".saved-report-summary")).toBeFocused();
    assert.ok(Math.abs(await b.evaluate(node => node.getBoundingClientRect().top) - originalBTop) < 3, "Back restores the original full-width library anchor");
    assert.equal(await page.evaluate(() => history.scrollRestoration), "auto");
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "No prompts");
    assert.equal(await page.locator("#savedReportOrder").inputValue(), "oldest");
    assert.match(await page.locator("#bundleList").innerText(), /7-8 of 8/);
    await page.goForward();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await settle(page);
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator("#savedReportReader iframe")).toBeVisible();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await expect(page.locator("#savedReaderTitle")).toBeFocused();
    assert.equal(await page.locator("#savedReportReader").evaluate(node => node.getBoundingClientRect().width > 1000), true);
    await shot(page, "main-frozen-reader-light");
    await page.goBack();
    await expect(page.locator("#contextSidebarFooter button")).toBeFocused();
    assert.match(await page.locator("#bundleList").innerText(), /7-8 of 8/);
    await page.goForward();
    await expect(page.locator("#savedReportReader iframe")).toBeVisible();
    await page.reload();
    await expect(page.locator("#savedReportReader iframe")).toBeVisible();
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await expect(page.locator("#savedReportReader")).toBeHidden();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    assert.equal(new URL(page.url()).origin, new URL(runtime.url).origin);
    assert.doesNotMatch(page.url(), /No.prompts|savedEntry|receipt/);
});

test("saved inspectors and main documents reflow with accessible controls in both themes, narrow doubled text and short height", { timeout: 30000 }, async t => {
    const { page, bundles } = await setup(t, { count: 2 });
    const cases = [[1440, 900, 100], [820, 700, 100], [375, 812, 100], [375, 812, 200], [820, 420, 200]];
    for (const theme of ["light", "dark"]) for (const [width, height, size] of cases) {
        await page.setViewportSize({ width, height });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, size);
        await chooseTheme(page, theme);
        await row(page, bundles[1].bundleId).locator(".saved-report-summary").tap();
        const measurements = await page.locator("#contextSidebar").evaluate(panel => {
            const rect = node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height, top: box.top, bottom: box.bottom }; };
            const text = panel.querySelector("dt");
            const style = getComputedStyle(text), valueStyle = getComputedStyle(text.nextElementSibling);
            return { overflow: document.documentElement.scrollWidth > innerWidth + 1 || panel.scrollWidth > panel.clientWidth + 1,
                body: rect(document.querySelector("#contextSidebarBody")), close: rect(document.querySelector("#closeContextSidebar")),
                footer: rect(document.querySelector("#contextSidebarFooter")), button: rect(document.querySelector("#contextSidebarFooter button")),
                foreground: style.color, background: getComputedStyle(panel).backgroundColor,
                equalType: style.font === valueStyle.font, weight: style.fontWeight, modal: panel.matches(":modal") };
        });
        assert.equal(measurements.overflow, false, JSON.stringify({ theme, width, size, measurements }));
        assert.ok(measurements.close.width >= 44 && measurements.close.height >= 44);
        assert.ok(measurements.button.height >= 44 && measurements.footer.bottom <= height + 1);
        assert.ok(measurements.body.height >= 80);
        assert.equal(measurements.equalType, true); assert.equal(measurements.weight, "400");
        assert.ok(contrast(measurements.foreground, measurements.background) >= 4.5);
        if (measurements.modal) {
            await page.locator("#savedReportSearch").evaluate(node => node.focus());
            assert.equal(await page.locator("#savedReportSearch").evaluate(node => node === document.activeElement), false);
        }
        await shot(page, `inspector-${theme}-${width}-${height}-${size}`);
        await page.locator("#contextSidebarFooter button").tap();
        await expect(page.locator("#savedReportReader iframe")).toBeVisible();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await expect(page.locator("#savedReaderTitle")).toBeFocused();
        assert.equal(await page.locator("#savedReportReader iframe").getAttribute("sandbox"), "");
        assert.equal(await page.locator("#savedReportReader iframe").getAttribute("referrerpolicy"), "no-referrer");
        await shot(page, `reader-${theme}-${width}-${height}-${size}`);
        await page.getByRole("button", { name: "Back to report library", exact: true }).click();
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
    }
});

test("pending downloads belong to their inspector, failed HTML offers verified alternatives, and legacy direct entry stays frozen", { timeout: 30000 }, async t => {
    const { page, bundles, context, runtime } = await setup(t, { count: 3 });
    const a = bundles[1], b = bundles[2], downloads = [];
    const bytes = await readFile(a.files["product-report.html"]);
    page.on("download", item => downloads.push(item.suggestedFilename()));
    await row(page, a.bundleId).locator(".saved-report-summary").click();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/artifact-file", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#contextSidebar").getByRole("button", { name: `Download product-report.json for ${a.bundleId}`, exact: true }).click();
    await entered.promise;
    await row(page, b.bundleId).locator(".saved-report-summary").click();
    const finished = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    release.resolve(); await finished;
    assert.deepEqual(downloads, []);
    assert.match(await page.locator("#contextSidebar").innerText(), new RegExp(b.bundleId));
    await page.locator("#closeContextSidebar").click();
    await writeFile(a.files["product-report.html"], Buffer.concat([bytes, Buffer.from("\nUNREVIEWED CHANGE")]));
    await row(page, a.bundleId).getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator("#savedReportReader .error")).toContainText("changed");
    assert.equal(await page.locator("#savedReportReader iframe").count(), 0);
    const download = page.waitForEvent("download");
    await page.locator("#savedReportReader").getByRole("button", { name: `Download product-report.json for ${a.bundleId}`, exact: true }).click();
    assert.equal((await download).suggestedFilename(), "product-report.json");
    await writeFile(a.files["product-report.html"], bytes);
    await page.goto(runtime.url + "#report?bundle=" + a.bundleId);
    await expect(page.locator("#savedReportReader iframe")).toBeVisible();
    assert.equal(await page.locator("#reportCreatePanel").isVisible(), false);
    await updateBoardState(context, state => { state.exports = state.exports.filter(item => item.bundleId !== a.bundleId); });
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(page.locator("#savedReportReader .error")).toContainText("no longer available");
    assert.equal(await page.locator("#savedReportReader iframe,#savedReportReader .report-file-action").count(), 0);
    assert.deepEqual(await readFile(a.files["product-report.html"]), bytes);
});
