import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, rename } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { documentationRepository } from "./documentation-fixture.mjs";

async function setup(t, { frontend = "react", width = 752 } = {}) {
    const cleanups = [];
    t.after(async () => { for (const close of cleanups.reverse()) await close(); });
    const fixture = { after: fn => cleanups.push(fn) };
    const repo = await documentationRepository(fixture);
    const app = await searchFixture(fixture, { frontend, copilotAccess: true, reply: false, documentation: { source: repo.source() } });
    const browser = await chromium.launch();
    cleanups.push(() => browser.close());
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], outside = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(app.runtime.url).origin) { outside.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, [], "Documentation makes no requests beyond WIRE"); });
    await page.goto(app.runtime.url);
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    return { page, repo, app };
}
const heading = (page, id) => page.locator(`#documentationView [id="user-content-${id}"]`);
async function inView(page, id) {
    await expect.poll(async () => (await heading(page, id).boundingBox())?.y ?? -1).toBeGreaterThan(0);
    assert.ok((await heading(page, id).boundingBox()).y < 260, `${id} is at the top of the reading area`);
}

test("Documentation keeps installed guides pinned, preserves ordinary Back, and previews a pushed branch on demand", async t => {
    const { page, repo } = await setup(t);
    // The entry sits at the bottom of the sidebar, directly above the account block.
    const entry = page.locator('.navigation-bottom > nav.documentation-navigation a[data-nav="documentation"]');
    await expect(entry).toBeVisible();
    assert.equal(await entry.evaluate(node => Boolean(node.closest("nav").compareDocumentPosition(document.getElementById("navigationFooter")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    assert.ok((await entry.boundingBox()).y + (await entry.boundingBox()).height <= (await page.locator("#navigationFooter").boundingBox()).y);
    await entry.focus();
    await entry.press("Enter");
    await expect(page).toHaveURL(/\/documentation$/);
    await expect(page).toHaveTitle("Documentation | WIRE");
    await expect(page.locator("#docTitle")).toHaveText("WIRE documentation");
    await expect(page.locator("#docTitle")).toBeFocused();
    await expect(entry).toHaveAttribute("aria-current", "page");
    // At 752px the guide tree folds behind "All guides"; the active guide lists its sections.
    await page.locator(".docs-left-toggle > summary").click();
    await page.locator('.docs-tree a[data-guide="user-guide"]').click();
    await expect(page).toHaveURL(/\/documentation\?guide=user-guide$/);
    await expect(page.locator("#docTitle")).toHaveText("Use WIRE");
    await expect(page.locator(".docs-source")).toContainText(repo.head().slice(0, 7));
    await expect(page.locator("#docTitle")).toBeFocused();
    await expect(page.locator('.docs-tree a[data-guide="user-guide"]')).toHaveAttribute("aria-current", "page");
    assert.ok(await page.locator(".docs-tree-sections a").count() > 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    // Section links are document anchors: #trends must not be read as the old Trends address.
    const contents = page.locator(".docs-outline-inline > summary");
    const trends = page.locator('.docs-outline-inline a[data-fragment="trends"]').first();
    await contents.press("Enter");
    await trends.press("Enter");
    await expect(page).toHaveURL(/\/documentation\?guide=user-guide#trends$/);
    await inView(page, "trends");
    await expect(heading(page, "trends")).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/\/documentation\?guide=user-guide$/);
    await expect(trends).toBeFocused();
    await page.goBack();
    await expect(page.locator("#docTitle")).toHaveText("WIRE documentation");
    await expect(page.locator('.docs-tree a[data-guide="user-guide"]')).toBeFocused();
    await page.goForward();
    await expect(page.locator("#docTitle")).toHaveText("Use WIRE");
    await page.goto(new URL("/documentation?guide=user-guide#trends", page.url()).href);
    await expect(page.locator("#docTitle")).toHaveText("Use WIRE");
    await inView(page, "trends");
    await expect(page).toHaveURL(/\/documentation\?guide=user-guide#trends$/);

    // Collapsing the sidebar gives the guide the freed width.
    const narrow = (await page.locator("#documentationView").boundingBox()).width;
    await page.locator("#navigationCollapse").click();
    await expect.poll(async () => (await page.locator("#documentationView").boundingBox()).width).toBeGreaterThan(narrow + 120);
    await expect(entry).toBeVisible();

    const branch = "docs/report-guide";
    await repo.publish("docs/images/preview.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="127" height="32"></svg>', "Add preview artwork", branch);
    const published = await repo.publish("docs/user-guide.md", "# Use WIRE today\n\nNewer guidance.\n\n## Trends\n\n![Branch illustration](images/preview.svg)\n","Preview guide",branch);
    const chooser = page.locator("#guideSource");
    const choose = async value => {
        await page.locator("#guideSource-control").click();
        await page.locator(`.select-popup [role=option][data-value="${value}"]`).click();
    };
    await choose("branches");
    await choose("branch:docs/report-guide");
    await expect(page.locator("#docTitle")).toHaveText("Use WIRE today");
    await expect(page.locator(".docs-source")).toContainText(published.slice(0, 7));
    await expect(page.getByRole("link", { name: /^View this guide on GitHub/ })).toHaveAttribute("href", new RegExp(`/blob/${published}/docs/user-guide\\.md$`));
    const enlarge = page.getByRole("button", { name: "Enlarge image: Branch illustration" });
    await enlarge.scrollIntoViewIfNeeded();
    const at = page.url(), top = await page.evaluate(() => scrollY);
    await enlarge.press("Enter");
    const viewer = page.getByRole("dialog", { name: "Guide image" });
    await expect(viewer.getByRole("img")).toHaveJSProperty("naturalWidth", 127);
    await page.keyboard.press("Escape");
    await expect(enlarge).toBeFocused();
    await expect(chooser).toHaveValue("branch:docs/report-guide");
    assert.equal(page.url(), at);
    assert.equal(await page.evaluate(() => scrollY), top);

    const second = await page.context().newPage();
    await second.goto(new URL("/documentation?guide=user-guide",page.url()).href);
    await expect(second.locator("#docTitle")).toHaveText("Use WIRE");
    await second.close();
    await rename(repo.origin, repo.origin + ".offline");
    await choose("branches");
    await expect(page.locator(".docs-source [role=status]")).toContainText("Couldn't list");
    await expect(page.locator("#docTitle")).toHaveText("Use WIRE today");

    // A contributor's checkout: saved edits appear in place, marked against main.
    await choose("checkout");
    await expect(page.locator(".docs-source-local")).toContainText("Previewing this checkout");
    await expect(chooser).toHaveValue("checkout");
    await appendFile(path.join(repo.work, "docs", "user-guide.md"), "\nLocal preview paragraph.\n");
    await expect(page.locator(".docs-article")).toContainText("Local preview paragraph.", { timeout: 8000 });
    await expect(page.locator('.docs-tree a[data-guide="user-guide"] .docs-badge')).toHaveText("Edited");
    await expect(page.locator(".docs-article-footer")).toContainText("Local file: docs/user-guide.md (edited, differs from your last commit)");
});

test("guides render GitHub Markdown safely, with images from the same revision and checked links", async t => {
    const { page, repo } = await setup(t, { width: 1440 });
    await page.goto(new URL("/documentation?guide=rendering-check", page.url()).href);
    await expect(page.locator("#docTitle")).toHaveText("Rendering check");
    const article = page.locator(".docs-article");

    await expect(article.locator('[id="user-content-repeated-heading-1"]')).toHaveCount(1);
    await expect(article.locator('[id="user-content-punctuation-quotes-commas--ampersands--dashes-too"]')).toHaveCount(1);
    await expect(page.locator(".docs-right .docs-outline")).toContainText("Repeated heading");
    await expect(article.locator(".docs-inline-contents")).toHaveCount(1);
    await expect(article.locator(".docs-inline-contents")).toBeHidden();

    await expect(article.locator('.doc-table[role="region"] table th')).toHaveText(["Column", "Alignment", "Number"]);
    await expect(article.locator(".doc-code pre")).toContainText("npm run build");
    await expect(article.getByRole("button", { name: "Copy code" })).toHaveCount(1);
    await expect(article).toContainText("🚀");
    await expect(article.locator(".doc-footnotes")).toContainText("The footnote.");
    await expect(article.locator(".doc-alert-warning")).toContainText("Urgent information.");
    await expect(article.locator(".doc-task input[type=checkbox]")).toHaveCount(2);
    assert.equal(await article.locator(".doc-task input[type=checkbox]").evaluateAll(nodes => nodes.every(node => node.disabled)), true);

    const image = article.locator('img[alt="Trends overview"]');
    await expect(image).toHaveAttribute("src", /^\/api\/documentation\/asset\/[a-f0-9]{64}\/docs\/images\/trends-overview\.png$/);
    await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
    await image.scrollIntoViewIfNeeded();
    const imageButton = article.getByRole("button", { name: "Enlarge image: Trends overview" });
    const address = page.url(), origin = await page.evaluate(() => scrollY);
    await imageButton.press("Enter");
    const viewer = page.getByRole("dialog", { name: "Guide image" });
    await expect(viewer).toBeVisible();
    assert.equal(await viewer.locator("img").evaluate(node => node.src), await image.evaluate(node => node.currentSrc));
    await expect(viewer.getByRole("button", { name: "Close image" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(imageButton).toBeFocused();
    assert.equal(page.url(), address);
    assert.equal(await page.evaluate(() => scrollY), origin);
    await expect(article.locator('.doc-image-note[role="note"]')).toContainText("Hosted on img.shields.io");
    await expect(article.getByRole("img", { name: "Image unavailable: Image with a handler" })).toHaveCount(1);

    await expect(article.getByRole("link", { name: "Development" })).toHaveAttribute("href", "/documentation?guide=development");
    await expect(article.getByRole("link", { name: "Trends in the user guide" })).toHaveAttribute("href", "/documentation?guide=user-guide#trends");
    await expect(article.getByRole("link", { name: /^Contributing/ })).toHaveAttribute("href", "/documentation?guide=contributing");
    await expect(article.getByRole("link", { name: /^helpers/ })).toHaveAttribute("href", `https://github.com/likamrat/wire/blob/${repo.head()}/tests/helpers.mjs`);
    const outside = article.getByRole("link", { name: /^GitHub Docs/ });
    await expect(outside).toHaveAttribute("target", "_blank");
    await expect(outside).toHaveAttribute("rel", "noopener noreferrer");
    await expect(article.locator(".doc-missing-link")).toHaveCount(2);

    // Raw HTML from a guide never runs or takes over the page.
    assert.deepEqual(await page.evaluate(() => [window.__docsScript, window.__docsOnError, window.__docsLink]), [undefined, undefined, undefined]);
    await expect(article.locator("script, [onerror], [style], a[href^='javascript']")).toHaveCount(0);
    await expect(article).toContainText("Overlay attempt");

    await article.getByRole("link", { name: "jump to the second one" }).click();
    await expect(page).toHaveURL(/#repeated-heading-1$/);
    await inView(page, "repeated-heading-1");
    await page.locator('.docs-right a[data-fragment="tables"]').click();
    await inView(page, "tables");
    await expect(page.locator('.docs-right a[data-fragment="tables"]')).toHaveAttribute("aria-current", "location");
});

test("the bundled renderer offers the same Documentation entry", async t => {
    const { page } = await setup(t, { frontend: "bundled", width: 1440 });
    const entry = page.locator('.navigation-bottom > nav.documentation-navigation a[data-nav="documentation"]');
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page.locator("#docTitle")).toHaveText("WIRE documentation");
    await expect(page.locator(".docs-tree")).toBeVisible();
    await page.locator('.docs-tree a[data-guide="readme"]').click();
    const compareImage = page.getByRole("button", { name: /^Enlarge image: Compare with call results/ });
    await page.setViewportSize({ width: 390, height: 800 });
    await compareImage.scrollIntoViewIfNeeded();
    const origin = await page.evaluate(() => scrollY);
    await compareImage.click();
    const viewer = page.getByRole("dialog", { name: "Guide image" });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator("img")).toHaveAttribute("src", /\/docs\/images\/compare-periods\.png$/);
    await viewer.getByRole("button", { name: "Actual size" }).click();
    await expect.poll(() => viewer.locator("img").evaluate(i => i.clientWidth)).toBeGreaterThan(390);
    await viewer.getByRole("button", { name: "Close image" }).click();
    await expect(compareImage).toBeFocused();
    assert.equal(await page.evaluate(() => scrollY), origin);
    const next = page.getByRole("link", { name: "Next: Use WIRE" });
    await next.press("Enter");
    await expect(page.locator("#docTitle")).toHaveText("Use WIRE");
    const previous = page.getByRole("link", { name: "Previous: Work IQ Request Explorer" });
    await previous.press("Enter");
    await expect(page.locator("#docTitle")).toHaveText("Work IQ Request Explorer");
    await expect(page.locator('.docs-pager [rel="prev"]')).toHaveCount(0);
});
