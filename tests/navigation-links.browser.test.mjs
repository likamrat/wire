import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";



const proofs = process.env.WIRE_LINK_PROOFS;
const slice = "layer=tool&scope=all&from=2026-09-30&to=2026-09-30&service=Calendar&project=test-project";
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
}
async function setup(t) {
    const row = fixture("navigation-links");
    row.sourceSessionName = "Synthetic navigation chat";
    row.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [row]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ url: request.url(), method: request.method() }));
    t.after(async () => {
        await browser.close();
        await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(request => new URL(request.url).origin === new URL(runtime.url).origin), "No external requests");
            assert.ok(requests.filter(request => request.method === "POST").every(request =>
                ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
                    "/api/report-artifacts/list", "/api/evaluation/automatic/summary"]
                    .includes(new URL(request.url).pathname)), "Navigation is read-only");
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#home?" + slice);
    await ready(page);
    return { page, runtime };
}
async function capture(page, name, selector) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.locator(selector).screenshot({ path: path.join(proofs, `${name}.png`) });
}
async function assertLinkStates(page, link, label, focusSelector) {
    const decoration = () => link.evaluate(node => [node, ...node.querySelectorAll("*")]
        .filter(item => item.checkVisibility()).map(item => getComputedStyle(item).textDecorationLine));
    await page.mouse.move(0, 0);
    await link.evaluate(node => node.blur());
    assert.ok((await decoration()).every(value => value === "none"), `${label}: resting link and descendants have no underline`);
    await link.hover();
    assert.ok((await decoration()).every(value => value === "none"), `${label}: hover has no underline`);
    await page.mouse.down();
    assert.ok((await decoration()).every(value => value === "none"), `${label}: pressed link has no underline`);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await link.focus();
    await page.keyboard.press("Shift");
    assert.ok((await decoration()).every(value => value === "none"), `${label}: focus has no underline`);
    assert.equal(await link.evaluate((node, selector) => {
        const ring = selector ? node.querySelector(selector) : node;
        const style = getComputedStyle(ring);
        return node.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
    }, focusSelector), true, `${label}: visible keyboard focus`);
    assert.equal(await link.evaluate(node => node.tagName === "A" && node.hasAttribute("href") && node.tabIndex === 0), true, `${label}: native link`);
}

test("the current symbol and lettering form one native Analyze link in either theme and drawer", async t => {
    const { page, runtime } = await setup(t);
    for (const [theme, width, scale] of [["light", 1200, 1], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await navigateMain(page, "reports"); await ready(page);
        const from = page.url();
        if (width < 700) {
            await page.locator("#navigationToggle").click();
            await page.waitForFunction(() => !document.querySelector("#navigationDrawer").getAnimations().length);
        }
        const brand = page.locator("#shellBrand .brand-home"), logo = brand.locator(".brand-logo:visible");
        assert.equal(await logo.count(), 1);
        assert.equal(await brand.getAttribute("href"), await page.locator('nav [data-nav="analyze"]').getAttribute("href"));
        assert.match(await brand.getAttribute("aria-label"), /WIRE.*Analyze/);
        assert.equal(await brand.locator("a,button,[tabindex]").count(), 0);
        const art = await logo.boundingBox(), target = await brand.boundingBox();
        assert.ok(art.width > 0 && art.height > 0 && target.width >= 44 && target.height >= 44);
        assert.ok(art.x >= target.x - 1 && art.y >= target.y - 1 && art.x + art.width <= target.x + target.width + 1
            && art.y + art.height <= target.y + target.height + 1);
        await assertLinkStates(page, brand, `${theme} brand`);
        const popupPromise = page.context().waitForEvent("page");
        await brand.click({ modifiers: ["Control"] });
        const other = await popupPromise;
        try {
            await ready(other);
            assert.equal(new URL(other.url()).pathname, "/");
            assert.equal(page.url(), from);
        } finally { await other.close(); }
        await brand.press("Enter"); await ready(page);
        assert.equal(new URL(page.url()).pathname, "/");
        assert.equal(await page.locator("#activityView").isVisible(), true);
        await page.goBack(); await ready(page);
        assert.equal(page.url(), from);
        assert.equal(new URL(from).origin, new URL(runtime.url).origin);
    }
});
test("new human HTML reports retain native section links without underlines", { timeout: 30000 }, async () => {
    const row = fixture("link-report"), before = structuredClone(row);
    const bundle = await buildSanitizedBundle([row], "a".repeat(64), { promptMode: "none", formats: ["html", "json"] });
    const browser = await chromium.launch(), page = await browser.newPage();
    const requests = [], errors = [];
    await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
    page.on("pageerror", error => errors.push(error.message));
    try {
        await page.setContent(bundle.files["product-report.html"]);
        for (const width of [1200, 375]) {
            await page.setViewportSize({ width, height: 1000 });
            const nav = page.getByRole("navigation", { name: "Report sections" });
            await assertLinkStates(page, nav.locator('a[href="#examples"]'), `${width} report section`);
        }
        const examples = page.locator('.report-nav a[href="#examples"]');
        await examples.focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.evaluate(() => location.hash), "#examples");
        await assertLinkStates(page, examples, "Revisited report section");
        await capture(page, "report-section-focus", ".report-nav");
        assert.deepEqual(requests, [], "Self-contained report requests no external resources");
        assert.deepEqual(errors, []);
        assert.deepEqual(row, before, "Generating new presentation does not modify captured source");
    } finally { await browser.close(); }
});
