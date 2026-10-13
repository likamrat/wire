import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, openActivitySessions } from "./helpers.mjs";

const original = "SYNTHETIC complete request\n  preserve indentation and trailing spaces  \n" +
    "Read this long request without navigating or changing report choices. ".repeat(18) +
    "\nhttps://example.invalid/" + "unbrokensyntheticpath".repeat(24) +
    "\nUnicode: \u65e5\u672c\u8a9e \u05e9\u05dc\u05d5\u05dd \ud83d\ude80\nEND_OF_RETAINED_REQUEST";

async function setup(t, prompt = { text: original, status: "full", provenance: "human-authored" }, followups) {
    const record = fixture("text-access");
    record.userPrompt = prompt;
    if (followups) record.followUpPrompts = followups;
    record.sourceSessionName = "Synthetic session " + "longunbrokentitle".repeat(20);
    record.project = "Synthetic project " + "longunbrokenproject".repeat(18);
    record.toolCalls[0].requestArgs = { command: "echo synthetic\n  echo " + "longcommand".repeat(45) + "\n" };
    const { context: store } = await privateFixture(t, [record]);
    const runtime = await startServer(store, createExportController(store), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", hasTouch: true });
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.addInitScript(() => {
        window.syntheticCopies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw new Error("Clipboard reads are not permitted."); },
            async writeText(text) { window.syntheticCopies.push(text); },
        } });
    });
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    return { page, url: runtime.url, record, store };
}

async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
}

test("request detail has one complete-text reader without navigation or report selection", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#request?request=text-access"); await ready(page);
    const intro = page.locator(".request-original");
    const control = intro.locator(".full-text-toggle");
    assert.equal(await control.count(), 1, "One obvious request-text control, without a second preview");
    assert.equal(await intro.locator(".full-text-preview").count(), 0);
    assert.equal(await control.textContent(), "Hide prompt");
    assert.equal(await intro.locator(".full-text-body pre").textContent(), original, "The interaction opens its available retained context immediately");
    const route = page.url(), selection = await page.locator("#activitySelectionSummary").textContent();
    await control.focus();
    assert.equal(await intro.locator(".full-text-body pre").textContent(), original);
    assert.equal(await control.getAttribute("aria-expanded"), "true");
    assert.equal(await control.textContent(), "Hide prompt");
    assert.equal(await control.evaluate(node => node === document.activeElement), true);
    assert.equal(page.url(), route);
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
    await intro.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.syntheticCopies), [original]);
    await control.focus(); await page.keyboard.press("Space");
    assert.equal(await intro.locator(".full-text-body").count(), 0);
    assert.equal(await control.textContent(), "Read prompt");
    await control.tap();
    assert.equal(await intro.locator(".full-text-body pre").textContent(), original);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await intro.locator(".full-text-body pre").evaluate(node => { node.style.fontSize = "32px"; });
        const text = intro.locator(".full-text-body pre");
        assert.equal(await text.textContent(), original);
        assert.equal(await text.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1 && getComputedStyle(node).maxHeight === "none"), true);
    }
});

test("long session, request and project text reflows across widths, themes and doubled text", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#activity"); await ready(page); await openActivitySessions(page);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const zoom of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => {
            document.querySelector("#text-access-zoom")?.remove();
            if (scale === 1) return;
            const sheet = document.createElement("style");
            sheet.id = "text-access-zoom";
            const nodes = [...document.querySelectorAll("body *")];
            nodes.forEach((node, index) => { node.dataset.textZoom = index; });
            sheet.textContent = nodes.map(node => `[data-text-zoom="${node.dataset.textZoom}"]{font-size:${parseFloat(getComputedStyle(node).fontSize) * scale}px!important}`).join("\n");
            document.head.append(sheet);
        }, zoom);
        const clipped = await page.locator(".session-name,.project-name,.request-link,.session-meta,.session-heading").evaluateAll(nodes =>
            nodes.filter(node => node.checkVisibility() && node.scrollWidth > node.clientWidth + 2)
                .map(node => ({ class: node.className, width: node.clientWidth, scroll: node.scrollWidth })));
        assert.deepEqual(clipped, [], `${theme} ${width}px ${zoom}x meaningful text is not clipped`);
    }
    await navigateMain(page, "home"); await ready(page);
});

test("full-text reading survives an incoming snapshot and Back with report membership unchanged", { timeout: 30000 }, async t => {
    const { page, url, record, store } = await setup(t);
    await page.goto(url + "#activity"); await ready(page); await openActivitySessions(page);
    const row = page.locator(".request-row").first();
    await row.locator("input[type=checkbox]").check();
    await row.locator(".full-text-toggle").click();
    await row.locator(".request-link").click(); await ready(page);
    const control = page.locator(".request-original .full-text-toggle");
    const pre = page.locator(".request-original .full-text-body pre");
    await pre.evaluate(node => window.scrollTo(0, node.offsetTop + 120));
    await control.focus();
    const before = await pre.evaluate(node => node.getBoundingClientRect().top);
    const selection = await page.locator("#activitySelectionSummary").textContent();
    const extra = fixture("new-synthetic-request");
    await replaceEvidence(store, () => ({ records: [record, extra], importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [], notes: [] } }));
    const response = page.waitForResponse(value => value.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await response; await ready(page);
    assert.equal(await control.getAttribute("aria-expanded"), "true");
    assert.equal(await control.evaluate(node => node === document.activeElement), true);
    assert.equal(await pre.textContent(), original);
    assert.equal(await pre.evaluate(node => node.getBoundingClientRect().top), before);
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator(".request-row").first().locator(".full-text-toggle").getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator(".request-row").first().locator("input").isChecked(), true);
});

test("partial and unavailable sources are explicit instead of inventing complete originals", { timeout: 30000 }, async t => {
    for (const [status, text] of [["partial", original], ["unavailable", "MUST_NOT_BE_RENDERED"], ["full", "   "]]) {
        const { page, url } = await setup(t, { status, text });
        await page.goto(url + "#request?request=text-access"); await ready(page);
        const intro = page.locator(".request-original");
        if (status === "partial") {
            assert.match(await intro.innerText(), /Only part of the original was recorded/);
            assert.equal(await intro.locator("pre").textContent(), text);
        } else {
            assert.match(await intro.innerText(), /Prompt not available/);
            assert.equal(await intro.locator(".full-text-toggle, .ux-copy").count(), 0);
            assert.doesNotMatch(await intro.innerText(), /MUST_NOT_BE_RENDERED/);
            await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
            const link = page.getByRole("link", { name: "View interaction", exact: true }).first();
            assert.equal(await link.getAttribute("aria-label"), null);
            const description = await link.getAttribute("aria-describedby");
            assert.equal(await page.locator(`[id="${description}"]`).textContent(), "Prompt not available");
        }
        await page.close();
    }
});

test("original and immediate follow-ups never copy placeholders or hide recorded-source gaps", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t, { status: "unavailable", text: null }, [
        { status: "partial", text: "SYNTHETIC retained fragment" },
        { status: "unavailable", text: null },
        { status: "full", text: "   " },
    ]);
    await page.goto(url + "#request?request=text-access"); await ready(page);
    const request = page.locator(".request-original");
    assert.match(await request.innerText(), /Prompt not available/);
    assert.equal(await request.locator(".ux-copy").count(), 0);
    assert.equal(await page.locator(".request-context-note:visible").count(), 1);
    assert.match(await page.locator(".request-context-note").innerText(), /Linked messages may be separate work/);
    for (const i of [1, 2, 3]) {
        const followup = page.locator('[data-context-kind="follow-up"]').nth(i - 1);
        if (i === 1) {
            assert.match(await followup.innerText(), /Only part of the original was recorded/);
            assert.equal(await followup.locator("pre").textContent(), "SYNTHETIC retained fragment");
        } else {
            assert.match(await followup.innerText(), /Prompt not available/);
            assert.equal(await followup.locator(".ux-copy").count(), 0);
        }
    }
    assert.deepEqual(await page.evaluate(() => window.syntheticCopies), []);
});

test("request excerpts are compact content with separate native navigation at every supported width and text size", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t, { text: original, status: "full", provenance: "coordinator-message" });
    await page.goto(url + "#activity"); await ready(page); await openActivitySessions(page);
    const row = page.locator(".request-row").first(), content = row.locator(".full-text");
    const excerpt = content.locator(".full-text-preview"), link = content.getByRole("link", { name: "View interaction", exact: true });
    assert.equal(await content.locator(".full-text-preview-label").textContent(), "Prompt");
    assert.equal(await content.getByRole("button", { name: "About prompt author", exact: true }).count(), 1);
    assert.equal(await excerpt.evaluate(node => node.tagName), "P");
    assert.equal(await content.locator("a").count(), 1);
    assert.equal(await row.locator(".request-meta").getByText("Request excerpt", { exact: true }).count(), 0);
    assert.equal(await link.getAttribute("aria-label"), null, "The action's name describes its destination, not private message text");
    assert.equal(await link.getAttribute("aria-describedby"), await excerpt.getAttribute("id"));
    assert.match(await link.getAttribute("href"), /^#request\?request=text-access/);
    assert.equal(await content.locator("a button,button a").count(), 0);
    const proofs = process.env.WORKIQ_EXCERPT_PROOFS, metrics = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const measure = await content.evaluate(node => {
            const excerpt = node.querySelector(".full-text-preview"), label = node.querySelector(".full-text-preview-label"), link = node.querySelector("a"), control = node.querySelector(".full-text-toggle");
            const sample = item => {
                const style = getComputedStyle(item), box = item.getBoundingClientRect();
                return { font: parseFloat(style.fontSize), width: box.width, height: box.height, x: box.x, y: box.y, right: box.right, bottom: box.bottom,
                    overflow: item.scrollWidth - item.clientWidth, underline: style.textDecorationLine, maxWidth: parseFloat(style.maxWidth) };
            };
            const a = link.getBoundingClientRect(), b = control.getBoundingClientRect();
            return { label: sample(label), excerpt: sample(excerpt), link: sample(link), control: sample(control),
                bodyFont: parseFloat(getComputedStyle(document.body).fontSize), pageOverflow: document.documentElement.scrollWidth - innerWidth,
                actionsOverlap: Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1 };
        });
        assert.equal(measure.excerpt.font, measure.bodyFont);
        assert.equal(measure.link.font, measure.bodyFont);
        assert.equal(measure.control.font, measure.bodyFont);
        assert.ok(measure.label.font <= measure.bodyFont);
        assert.equal(measure.excerpt.underline, "none");
        assert.ok(measure.excerpt.width <= measure.excerpt.maxWidth + 1, "Readable measure is enforced, not merely set on a parent");
        assert.ok(measure.link.height >= 44 && measure.control.height >= 24);
        assert.ok(measure.pageOverflow <= 1 && [measure.excerpt, measure.link, measure.control].every(item => item.overflow <= 1), `${theme}/${width}/${scale}: no horizontal clipping`);
        assert.equal(measure.actionsOverlap, false);
        if (width >= 1200 && scale === 1) assert.ok(measure.excerpt.height <= 96, "At most four ordinary lines, not a paragraph-sized control");
        if (proofs) await content.screenshot({ path: path.join(proofs, `excerpt-${theme}-${width}-${scale}x.png`) });
        metrics.push({ theme, width, rootTextScale: scale, ...measure });
    }
    if (proofs) await writeFile(path.join(proofs, "excerpt-layout.json"), JSON.stringify(metrics, null, 2));
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
    await row.locator("input[type=checkbox]").check();
    const route = page.url(), selection = await page.locator("#activitySelectionSummary").textContent();
    const toggle = content.locator(".full-text-toggle");
    await toggle.focus(); await page.keyboard.press("Enter");
    assert.equal(await content.locator("pre").textContent(), original);
    assert.equal(await link.isVisible(), true, "Opening full text never removes navigation");
    assert.equal(page.url(), route);
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
    await toggle.press("Space");
    await link.focus();
    assert.equal(await link.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== "none"), true);
    await page.keyboard.press("Enter"); await ready(page);
    assert.equal(await page.locator(".request-original").count(), 1);
    await page.goBack(); await ready(page);
    assert.equal(await row.locator("input[type=checkbox]").isChecked(), true);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
});

test("short, missing, partial and long URL request excerpts keep literal content and honest availability", { timeout: 30000 }, async t => {
    for (const [status, text] of [["full", "Short recorded message"], ["unavailable", "DO_NOT_DISPLAY"], ["partial", "Retained fragment"], ["full", "https://example.invalid/" + "longurl".repeat(50)]]) {
        const { page, url } = await setup(t, { status, text, provenance: "recorded-user-message-origin-unverified" });
        await page.goto(url + "#activity"); await ready(page); await openActivitySessions(page);
        const content = page.locator(".request-row .full-text").first();
        assert.equal(await content.locator(".full-text-preview-label").textContent(), "Prompt");
        assert.equal(await content.getByRole("link", { name: "View interaction", exact: true }).count(), 1);
        if (status === "unavailable") {
            assert.equal(await content.locator(".full-text-preview").textContent(), "Prompt not available");
            assert.equal(await content.locator(".full-text-toggle,.ux-copy,pre").count(), 0);
            assert.doesNotMatch(await content.innerText(), /DO_NOT_DISPLAY/);
        } else if (text.length < 170) {
            assert.equal(await content.locator(".full-text-preview").textContent(), text);
            assert.equal(await content.locator(".full-text-toggle").count(), 0);
        } else {
            await content.locator(".full-text-toggle").click();
            assert.equal(await content.locator("pre").textContent(), text);
        }
        if (status === "partial") assert.match(await content.innerText(), /Only part of the original was recorded/);
        await page.close();
    }
});
