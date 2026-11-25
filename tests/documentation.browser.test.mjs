import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, rename } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { documentationRepository } from "./documentation-fixture.mjs";

async function setup(t, { frontend = "react", width = 752, reducedMotion = "reduce" } = {}) {
    const cleanups = [];
    t.after(async () => { for (const close of cleanups.reverse()) await close(); });
    const fixture = { after: fn => cleanups.push(fn) };
    const repo = await documentationRepository(fixture);
    const app = await searchFixture(fixture, { frontend, copilotAccess: true, reply: false, documentation: { source: repo.source() } });
    const browser = await chromium.launch();
    cleanups.push(() => browser.close());
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], outside = [];
    page.on("pageerror", error => errors.push(error.stack));
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
    await expect(page.locator("#guideSource-control")).toHaveAccessibleName("Documentation source: Installed version");
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
    const chooser = page.locator("#guideSource-control");
    const choose = async value => {
        await chooser.click();
        await page.locator(`#guideSourceMenu [data-source="${value}"]`).click();
    };
    await choose("branch:docs/report-guide");
    await expect(page.locator("#docTitle")).toHaveText("Use WIRE today");
    await expect(chooser).toHaveText(branch);
    await expect(page.getByRole("link", { name: /^View this guide on GitHub/ })).toHaveAttribute("href", new RegExp(`/blob/${published}/docs/user-guide\\.md$`));
    const enlarge = page.getByRole("button", { name: "Enlarge image: Branch illustration" });
    await enlarge.scrollIntoViewIfNeeded();
    const at = page.url(), top = await page.evaluate(() => scrollY);
    await enlarge.press("Enter");
    const viewer = page.getByRole("dialog", { name: "Guide image" });
    await expect(viewer.getByRole("img")).toHaveJSProperty("naturalWidth", 127);
    await page.keyboard.press("Escape");
    await expect(enlarge).toBeFocused();
    await expect(chooser).toHaveText(branch);
    assert.equal(page.url(), at);
    assert.equal(await page.evaluate(() => scrollY), top);

    const second = await page.context().newPage();
    await second.goto(new URL("/documentation?guide=user-guide",page.url()).href);
    await expect(second.locator("#docTitle")).toHaveText("Use WIRE");
    await second.close();
    await rename(repo.origin, repo.origin + ".offline");
    await chooser.click();
    await expect(page.locator("#guideSourceMenu [role=status]")).toContainText("Couldn't list");
    await expect(page.locator("#docTitle")).toHaveText("Use WIRE today");

    // A contributor's checkout: saved edits appear in place, marked against main.
    await page.locator('#guideSourceMenu [data-source="checkout"]').click();
    await expect(chooser).toHaveText("This checkout");
    await appendFile(path.join(repo.work, "docs", "user-guide.md"), "\nLocal preview paragraph.\n");
    await expect(page.locator(".docs-article")).toContainText("Local preview paragraph.", { timeout: 8000 });
    await expect(page.locator('.docs-tree a[data-guide="user-guide"] .docs-badge')).toHaveText("Edited");
    await expect(page.locator(".docs-article-footer")).toContainText("Local file: docs/user-guide.md (edited, differs from your last commit)");
});

for (const [width, mode, reducedMotion] of [[1440,"light","no-preference"],[568,"dark","reduce"]]) {
    test(`one workspace picker keeps the ${width}px article steady during slow, failed and retried branch reads`, async t => {
        const {page,repo} = await setup(t,{width,reducedMotion});
        await page.evaluate(theme=>document.documentElement.dataset.evidenceTheme=theme,mode);
        const branch = "docs/reporting/preview-with-a-long-branch-name-to-check-wrapping";
        await repo.publish("docs/branch-only.md","# Branch-only guide\n\n## Saved copies\n\nRead your saved copy here.", "Add preview guide",branch);
        await repo.publish("docs/README.md","# WIRE documentation\n\nBranch library.\n\n## Guide tasks\n\n[Open a branch-only guide](branch-only.md).","Change guide index",branch);
        await page.goto(new URL("/documentation",page.url()).href);
        await page.evaluate(theme=>document.documentElement.dataset.evidenceTheme=theme,mode);
        const picker=page.locator("#guideSource-control"), menu=page.getByRole("dialog",{name:"Documentation sources"});
        await expect(picker).toBeVisible();
        await expect(page.locator(".docs-article #guideSource-control")).toHaveCount(0);
        const start=await page.evaluate(()=>{
            window.fixturePicker = document.querySelector("#guideSource-control");
            window.fixtureArticle = document.querySelector(".docs-article");
            return [document.querySelector("#docTitle"),document.querySelector(".app-header")].map(n=>n.getBoundingClientRect().top).concat(scrollY);
        });
        const unchanged = async () => {
            assert.deepEqual(await page.evaluate(()=>[document.querySelector("#docTitle"),document.querySelector(".app-header")].map(n=>n.getBoundingClientRect().top).concat(scrollY)),start);
            assert.equal(await page.evaluate(()=>document.querySelector("#guideSource-control")===window.fixturePicker && document.querySelector(".docs-article")===window.fixtureArticle),true);
        };
        const fetched=Promise.withResolvers(), release=Promise.withResolvers();
        let calls=0;
        await page.route("**/api/documentation/branches",async route=>{
            if (++calls===1) {fetched.resolve();await release.promise;await route.fulfill({status:503,json:{error:"Couldn't list WIRE branches. Check your network and Git access, then try again."}});}
            else await route.continue();
        });
        await picker.hover(); await expect(page.locator("#evidence-tooltip")).toContainText("Switch the guides");
        await picker.focus();await picker.press("Enter");
        try {
            await fetched.promise;await expect(menu.getByRole("searchbox")).toBeFocused();
            await expect(menu.getByRole("status")).toHaveText("Loading branches…");
            await unchanged();
        } finally { release.resolve(); }
        await expect(menu.getByRole("status")).toContainText("Couldn't list");
        await unchanged();await menu.getByRole("button",{name:"Try again"}).click();
        const row=menu.locator(`[data-source="branch:${branch}"]`);
        await expect(row).toBeVisible();await unchanged();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await expect(page.locator("#message")).not.toContainText("Branches loaded");
        await menu.getByRole("searchbox").fill("absent-choice");
        await expect(menu.getByRole("status")).toHaveText("No matching branches.");
        await page.keyboard.press("Escape");await expect(picker).toBeFocused();
        await unchanged();await picker.click();await expect(row).toBeVisible();
        await row.focus();await row.press("Enter");await expect(menu).toBeHidden();
        await expect(picker).toBeFocused();await expect(picker).toHaveText(branch);
        await expect(page.locator(".docs-article")).toContainText("Branch library.");
        assert.equal(await page.evaluate(()=>document.querySelector("#guideSource-control")===window.fixturePicker),true);
        const listCalls=calls;
        await page.getByRole("link",{name:"Open a branch-only guide",exact:true}).click();
        await expect(page.locator("#docTitle")).toHaveText("Branch-only guide");
        await page.goBack();await expect(page.locator(".docs-article")).toContainText("Branch library.");
        await expect(picker).toHaveText(branch);
        await page.getByRole("link",{name:"Open a branch-only guide",exact:true}).click();
        await expect(page.locator("#docTitle")).toHaveText("Branch-only guide");
        assert.equal(calls,listCalls,"normal navigation doesn't fetch the branch list");
        await picker.click();await menu.locator('[data-source="installed"]').click();
        await expect(picker).toHaveText("Installed version");
        await expect(page.locator("#docTitle")).toHaveText("WIRE documentation");
        await expect(page.locator(".docs-library-note")).toContainText("isn't in the selected source");
        await expect(page).toHaveURL(/\/documentation$/);
        await expect(picker).toBeFocused();
    });
}

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

test("Documentation panels independently give their space to the current guide", async t => {
    const { page } = await setup(t, { width: 1536, reducedMotion: "no-preference" });
    await page.locator('nav a[data-nav="documentation"]').click();
    await page.locator('.docs-tree a[data-guide="user-guide"]').click();
    const outline = page.getByRole("navigation", { name: "On this page", exact: true });
    await outline.getByRole("link", { name: "Trends", exact: true }).click();
    const address = page.url(), anchor = heading(page, "trends");
    await expect(anchor).toBeFocused();
    await expect.poll(() => anchor.evaluate(n => Math.abs(n.getBoundingClientRect().top -
        parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) - parseFloat(getComputedStyle(n).scrollMarginTop)))).toBeLessThan(2);
    await inView(page, "trends");
    const top = (await anchor.boundingBox()).y;
    const left = page.locator('.docs-left-toggle > summary');
    const right = page.locator('.docs-outline-inline > summary');
    const tree = page.getByRole("navigation", { name: "Guides", exact: true });
    const article = page.locator(".docs-article");
    const width = async () => (await article.boundingBox()).width;
    const initial = await width();
    for (const [toggle, pane, other] of [[left, tree, outline], [right, outline, tree]]) {
        await toggle.press("Enter");
        await expect(pane).toBeHidden();
        await expect(other).toBeVisible();
        await expect.poll(width).toBeGreaterThan(initial + 120);
        await expect(toggle).toBeFocused();
        await toggle.press("Space");
        await expect(pane).toBeVisible();
        await expect.poll(width).toBeCloseTo(initial, 0);
    }
    await left.click(); await right.click();
    await expect.poll(width).toBeGreaterThan(initial + 320);
    await expect.poll(async () => Math.abs((await anchor.boundingBox()).y - top)).toBeLessThan(5);
    assert.equal(page.url(), address);
    await expect(page.locator("#guideSource-control")).toHaveAccessibleName("Documentation source: Installed version");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(tree).toBeHidden(); await expect(outline).toBeHidden();
    await left.press("Enter"); await expect(tree).toBeVisible();
    await right.press("Enter"); await expect(outline).toBeVisible();
    await right.press("Space"); await left.press("Space");
    await page.setViewportSize({ width: 1536, height: 900 });
    await expect(tree).toBeHidden(); await expect(outline).toBeHidden();
    await left.press("Enter"); await right.press("Enter");
    await expect.poll(width).toBeCloseTo(initial, 0);
});
