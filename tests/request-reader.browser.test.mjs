import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme, openActivitySessions, navigateMain } from "./helpers.mjs";

const original = "SYNTHETIC coordinator message, not a human question.\n\n  Exact indentation and spaces  \n" +
    "Inspect the retained action history without executing this message. ".repeat(20) +
    "\nhttps://example.invalid/" + "unbroken".repeat(70) +
    "\nUnicode: \u65e5\u672c\u8a9e \u05e9\u05dc\u05d5\u05dd \ud83d\udc69\u200d\ud83d\udcbb e\u0301\nLAST_RECORDED_CHARACTER";

async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}

async function setup(t) {
    const record = fixture("reader");
    record.sourceSessionName = "Synthetic investigation";
    record.userPrompt = { status: "full", text: original, provenance: "recorded-user-message-origin-unverified" };
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const violations = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = url.origin === new URL(runtime.url).origin &&
            (request.method() === "GET" || ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url.pathname));
        if (allowed) await route.continue();
        else { violations.push(url.pathname); await route.abort(); }
    });
    await page.addInitScript(() => {
        window.syntheticCopies = [];
        window.copyDenied = false;
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("Clipboard reads are excluded."); },
            async writeText(text) {
                if (window.copyDenied) throw new DOMException("Synthetic clipboard denial", "NotAllowedError");
                window.syntheticCopies.push(text);
            },
        } });
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(violations, []); assert.deepEqual(errors, []);
    });
    return { page, url: runtime.url };
}

test("the complete reader has one header, deliberate exact copy and associated visible failure feedback", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#activity"); await ready(page); await openActivitySessions(page);
    await page.locator(".request-row .request-link").click(); await ready(page);
    const reader = page.locator(".request-original"), toggle = reader.locator(".full-text-toggle");
    assert.equal(await reader.locator("h2").count(), 1);
    assert.equal(await reader.locator("button").count(), 1);
    assert.equal(await toggle.textContent(), "Read");
    assert.equal(await toggle.getAttribute("aria-label"), "Read prompt");
    assert.equal(await reader.locator("pre,.ux-copy,.ux-code-toolbar").count(), 0);
    await toggle.focus(); await page.keyboard.press("Enter");
    const pre = reader.locator("pre"), copy = reader.getByRole("button", { name: "Copy prompt", exact: true });
    assert.equal(await reader.locator(".full-text-header button").count(), 2);
    assert.equal(await reader.locator(".ux-code-toolbar,.ux-code-label").count(), 0);
    assert.equal(await pre.textContent(), original);
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    const body = reader.locator(".full-text-body");
    assert.equal(await body.getAttribute("id"), await toggle.getAttribute("aria-controls"));
    assert.equal(await body.getAttribute("aria-labelledby"), await reader.locator("h2").getAttribute("id"));
    assert.equal(await body.getAttribute("role"), "region");
    const privacy = reader.locator(".full-text-privacy");
    assert.equal(await privacy.isVisible(), true);
    assert.match(await privacy.textContent(), /Private text.*system clipboard.*other apps.*masking is not applied/);
    assert.ok((await copy.getAttribute("aria-describedby")).split(" ").includes(await privacy.getAttribute("id")));
    assert.deepEqual(await page.evaluate(() => window.syntheticCopies), []);
    await pre.evaluate(node => { node.focus(); getSelection().selectAllChildren(node); });
    assert.equal(await page.evaluate(() => getSelection().toString()), original);
    await toggle.focus(); await page.keyboard.press("Tab");
    assert.equal(await copy.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.syntheticCopies.length === 1);
    assert.deepEqual(await page.evaluate(() => window.syntheticCopies), [original]);
    await page.evaluate(() => { window.copyDenied = true; });
    await copy.click();
    assert.match(await reader.getByRole("alert").textContent(), /Couldn't copy.*blocked clipboard.*manually/);
    assert.equal(await reader.getByRole("alert").isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.syntheticCopies), [original]);
    await toggle.focus(); await page.keyboard.press("Space");
    assert.equal(await reader.locator("pre,.ux-copy,.ux-copy-status").count(), 0);
    await page.keyboard.press("Enter");
    assert.equal(await pre.textContent(), original);
    assert.equal(await reader.locator("button").count(), 2);
});

test("reading and report membership are separate, preserve focus and return routes, and never auto-select", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#activity?session=test-session"); await ready(page);
    const origin = page.url();
    await page.locator(".request-row .request-link").click(); await ready(page);
    const toggle = page.locator(".request-original .full-text-toggle"), pick = page.locator("#requestReportToggle");
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "No requests selected");
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    assert.equal(await page.locator(".request-actions button").count(), 1);
    assert.equal(await page.locator(".request-actions a").count(), 0);
    assert.equal(await page.getByRole("link", { name: "Review selected requests", exact: true }).count(), 0);
    assert.equal(await pick.evaluate(node => node.classList.contains("primary")), false);
    assert.equal(await page.locator(".interaction-insights").evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".request-original")) & Node.DOCUMENT_POSITION_FOLLOWING)), true,
        "Interaction insights precede the full Prompt; report controls remain separate");
    assert.equal(await page.locator(".journey-pages").evaluate(node => node.nextElementSibling.classList.contains("request-actions")), true);
    await toggle.click();
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "No requests selected");
    await pick.focus(); await page.keyboard.press("Enter");
    assert.equal(await pick.textContent(), "Remove from report");
    assert.equal(await pick.evaluate(node => node === document.activeElement), true);
    assert.match(await page.locator(".request-actions").textContent(), /This request is selected/);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator(".request-original pre").textContent(), original);
    const review = page.locator("#activitySelectionContext #pageAction");
    assert.equal(await review.isVisible(), true);
    assert.equal(await review.textContent(), "Review selection");
    assert.equal(await review.evaluate(node => node.tagName), "A");
    assert.match(await review.getAttribute("href"), /^#reports/);
    assert.match(await page.locator("#activitySelectionSummary").textContent(), /1 request group included/);
    await review.focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.equal(await page.locator("#reportsView").isVisible(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 request group included/);
    await page.goBack(); await ready(page);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await pick.click();
    assert.equal(await pick.textContent(), "Add to report");
    assert.equal(await pick.evaluate(node => node === document.activeElement), true);
    assert.equal(await review.isVisible(), false);
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "No requests selected");
    await toggle.click();
    await page.locator("#contextBack").click(); await ready(page);
    assert.equal(page.url(), origin);
    assert.equal(await page.locator(".request-row input").isChecked(), false);
    await page.locator(".request-row .request-link").click(); await ready(page);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
});

test("reader and reporting hierarchy reflows in light and navy at all widths and 100/200 percent root text", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t), metrics = [], proofs = process.env.WORKIQ_READER_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(url + "#request?request=reader"); await ready(page);
    const reader = page.locator(".request-original"), toggle = reader.locator(".full-text-toggle");
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        for (const open of [false, true]) {
            if (await toggle.getAttribute("aria-expanded") !== String(open)) await toggle.click();
            await page.evaluate(() => scrollTo(0, 0));
            const measure = await reader.evaluate(node => {
                const bounds = element => {
                    const { x, y, width, height } = element.getBoundingClientRect();
                    return { x, y, width, height };
                };
                const header = node.querySelector(".full-text-header"), pre = node.querySelector("pre");
                return {
                    header: bounds(header), controlCount: header.querySelectorAll("button").length,
                    controls: [...header.querySelectorAll("button")].map(control => ({
                        ...bounds(control), fontSize: getComputedStyle(control).fontSize,
                        overflow: control.scrollWidth - control.clientWidth,
                    })),
                    readerFont: pre ? getComputedStyle(pre).fontSize : null,
                    bodyFont: getComputedStyle(document.body).fontSize,
                    overflow: document.documentElement.scrollWidth - innerWidth,
                    readerOverflow: pre ? pre.scrollWidth - pre.clientWidth : 0,
                    headings: node.querySelectorAll("h2").length,
                    reportAfterActions: Boolean(document.querySelector(".journey-pages").compareDocumentPosition(document.querySelector(".request-actions")) & Node.DOCUMENT_POSITION_FOLLOWING),
                };
            });
            assert.equal(measure.controlCount, open ? 2 : 1);
            assert.equal(measure.headings, 1);
            assert.equal(measure.reportAfterActions, true);
            assert.ok(measure.overflow <= 1 && measure.readerOverflow <= 1, `${theme}/${width}/${scale}/${open}: text never clips`);
            for (const control of measure.controls) {
                assert.ok(control.width >= 44 && control.height >= 44);
                assert.ok(control.overflow <= 1);
            }
            if (open) {
                assert.equal(measure.readerFont, measure.bodyFont);
                assert.equal(await reader.locator("pre").textContent(), original);
                const header = measure.header;
                assert.ok(measure.controls.every(control => control.y >= header.y && control.y + control.height <= header.y + header.height + 1));
                assert.ok(Math.abs(measure.controls[0].y + measure.controls[0].height / 2 - measure.controls[1].y - measure.controls[1].height / 2) <= 1,
                    "Hide and Copy stay together rather than orphaning Copy on a separate row");
            }
            if (proofs && [375, 1200].includes(width)) {
                const name = `reader-${theme}-${width}-${scale}x-${open ? "expanded" : "collapsed"}`;
                await page.screenshot({ path: path.join(proofs, name + "-whole.png"), fullPage: true });
                await reader.screenshot({ path: path.join(proofs, name + "-reader.png") });
            }
            metrics.push({ theme, width, rootTextScale: scale, open, ...measure });
        }
    }
    if (proofs) await writeFile(path.join(proofs, "reader-layout.json"), JSON.stringify(metrics, null, 2));
});

test("inclusion from a broader report scope is not mislabeled as an individually selected request", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#request?request=reader"); await ready(page);
    await navigateMain(page, "reports"); await ready(page);
    await page.locator("#reportCreateLink").click();
    await page.locator('[name="reportScope"][value="all"]').check();
    await page.goBack(); await ready(page);
    assert.match(await page.locator(".request-actions").textContent(), /included through the current report scope/);
    assert.equal(await page.locator("#requestReportToggle").textContent(), "Add to report");
    assert.equal(await page.locator("#activitySelectionContext #pageAction").isVisible(), true);
});
