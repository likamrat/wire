import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const original = "SYNTHETIC request beginning\n  Preserve exact indentation and trailing spaces.  \n" +
    "Inspect only the already recorded example; do not send messages or run a query. ".repeat(36) +
    "\nhttps://example.invalid/" + "unbrokenpath".repeat(65) +
    "\nUnicode: \u65e5\u672c\u8a9e \u05e9\u05dc\u05d5\u05dd \ud83d\udc69\u200d\ud83d\udcbb e\u0301\nEND_OF_RETAINED_REQUEST";

async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}

async function setup(t, arrange = record => [record]) {
    const record = fixture("investigation");
    record.sourceSessionName = "Synthetic investigation";
    record.userPrompt = { text: original, status: "full", provenance: "human-authored" };
    record.toolCalls[0] = { ...record.toolCalls[0], toolSucceeded: false, reportedOutcome: "failed", apiResults: [],
        startedAt: "2026-09-30T12:00:01Z", completedAt: "2026-09-30T12:00:04Z",
        requestedApiPath: "/me/messages", requestArgs: { entityUrls: ["/me/messages"] } };
    const records = arrange(record);
    const { context: store } = await privateFixture(t, records);
    const runtime = await startServer(store, createExportController(store), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "America/Los_Angeles" });
    page.setDefaultTimeout(5000);
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() !== "GET" && !(request.method() === "POST" && ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(new URL(request.url()).pathname))) writes.push(request.url());
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No live clipboard reads in investigation proof."); },
        writeText() { throw Error("No live clipboard writes in investigation proof."); },
    } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    });
    return { page, url: runtime.url, record, records, store };
}

test("Tool failed reaches one complete request-text location, not another shortened preview", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#activity"); await ready(page);
    await page.locator(".session-summary .result-link[data-outcome=failure]").click(); await ready(page);
    assert.equal(await page.locator(".matched-action").count(), 1);
    assert.equal(await page.locator("#activityList .session-heading,#activityList .session-meta").count(), 0, "A focused matching view does not repeat chat identity and project");
    assert.equal(await page.locator("#activityList .session-summary .recorded-results").count(), 0, "Identical source/matching totals are not repeated");
    assert.equal(await page.locator("#activityPager").isVisible(), false);
    const matchingRoute = page.url();
    await page.locator(".matched-action .text-link").click(); await ready(page);
    assert.equal(await page.locator("#requestContent .full-text-preview").count(), 0,
        "A full request page must not repeat a string-sliced request preview as primary context");
    const request = page.locator("#requestContent .request-original");
    assert.equal(await request.count(), 1);
    assert.equal(await page.locator(".request-view-context #activityCollectionLink").count(), 1);
    assert.equal(await page.locator("#activityCollectionLink").isVisible(), false);
    assert.deepEqual(await page.locator(".request-outcome-action dt").allTextContents(), ["Tool", "Service", "API path"]);
    assert.equal(await page.locator(".request-outcome-action .action-tool").textContent(), "workiq-fetch");
    assert.equal(await page.locator(".request-outcome-action .action-service").textContent(), "Mail");
    assert.equal(await page.locator(".request-outcome-action code.api-path").textContent(), "/me/messages");
    assert.equal(await page.locator(".request-recorded .request-outcome-action").count(), 1, "Exact failure/action context belongs to the named Recorded actions section");
    await request.getByRole("button", { name: "Read prompt", exact: true }).click();
    assert.equal(await request.locator("pre").textContent(), original);
    assert.equal(await page.locator("#requestContent pre").filter({ hasText: "END_OF_RETAINED_REQUEST" }).count(), 1);
    assert.match(await page.locator(".request-outcome").innerText(), /Failure cause unavailable in retained evidence/);
    assert.equal(await page.locator("#requestContent").getByText("1 Tool failed", { exact: true }).count(), 1,
        "Identical single-call outcomes do not need three adjacent totals");
    await page.locator("#contextBack").click(); await ready(page);
    assert.equal(page.url(), matchingRoute);
    assert.equal(await page.locator("#collectionNotice + #activityCollectionLink").count(), 1);
    assert.equal(await page.locator("#activityCollectionLink").isVisible(), true);
});

test("complete retained text and every glyph fit at all widths, themes and root text sizes", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t, record => {
        record.project = "Synthetic project " + "unbrokenproject".repeat(15);
        record.sourceSessionName = "Synthetic chat " + "\u65e5\u672c\u8a9e".repeat(24);
        return [record];
    });
    const metrics = [], proofs = process.env.WORKIQ_REQUEST_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(url + "#activity?session=test-session&result=failure"); await ready(page);
    for (const theme of ["light", "dark"]) for (const [width, panel] of [[375, null], [820, null], [1200, null], [2560, null], [2560, 420]]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        // Font changes while the detail surface is hidden must affect its first open.
        await page.evaluate(({ scale, panel }) => {
            document.documentElement.style.fontSize = `${16 * scale}px`;
            document.querySelector("#requestView").style.maxWidth = panel ? `${panel}px` : "";
        }, { scale, panel });
        await page.locator(".matched-action .text-link").click(); await ready(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        const reader = page.locator(".request-original .full-text-toggle");
        assert.equal(await reader.getAttribute("aria-expanded"), "false");
        const collapsed = await page.evaluate(() => ({
            firstActionTop: document.querySelector(".journey-item").getBoundingClientRect().top,
            outcomeTop: document.querySelector(".request-outcome").getBoundingClientRect().top,
            pageHeight: document.documentElement.scrollHeight,
        }));
        assert.ok(await page.locator(".request-original").evaluate(node =>
            Boolean(node.compareDocumentPosition(document.querySelector(".request-recorded")) & Node.DOCUMENT_POSITION_FOLLOWING)),
        "The original content leads; grouped action evidence follows it");
        if (proofs && scale === 1) {
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `request-${theme}-${width}${panel ? "-panel" : ""}-collapsed.png`), fullPage: true });
        }
        await reader.focus(); await page.keyboard.press("Enter");
        const pre = page.locator(".request-original pre");
        assert.equal(await pre.textContent(), original, "Source string equality is independent of visual geometry");
        const geometry = await pre.evaluate(node => {
            const box = node.getBoundingClientRect(), range = document.createRange(), text = node.firstChild;
            const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text.textContent)];
            const clipped = [];
            for (const part of segments) {
                if (!part.segment.trim()) continue;
                range.setStart(text, part.index); range.setEnd(text, part.index + part.segment.length);
                for (const glyph of range.getClientRects()) {
                    if (glyph.left < box.left - 1 || glyph.right > box.right + 1 || glyph.top < box.top - 1 || glyph.bottom > box.bottom + 1) clipped.push(part.index);
                }
            }
            return { clipped, width: node.clientWidth, scrollWidth: node.scrollWidth,
                height: node.clientHeight, scrollHeight: node.scrollHeight, maxHeight: getComputedStyle(node).maxHeight,
                pageOverflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.deepEqual(geometry.clipped, [], `${theme}/${width}/${scale}: every retained non-whitespace grapheme must be visible`);
        assert.ok(geometry.scrollWidth <= geometry.width + 1);
        assert.ok(geometry.scrollHeight <= geometry.height + 1);
        assert.equal(geometry.maxHeight, "none");
        assert.ok(geometry.pageOverflow <= 1, `${theme}/${width}/${scale}: no page overflow`);
        const clippedLabels = await page.locator(".request-outcome,.request-intro,.action-heading,.recorded-result-label").evaluateAll(nodes =>
            nodes.filter(n => n.checkVisibility() && n.scrollWidth > n.clientWidth + 1).map(n => n.className));
        assert.deepEqual(clippedLabels, []);
        assert.equal(await page.locator("#requestContent .full-text-preview").count(), 0);
        assert.equal(await page.locator("#requestContent [id]").evaluateAll(nodes => nodes.length === new Set(nodes.map(n => n.id)).size), true);
        await pre.focus();
        await pre.evaluate(node => {
            const range = document.createRange();
            range.setStart(node.firstChild, node.textContent.length - 23); range.collapse(true);
            const box = range.getBoundingClientRect(); window.scrollBy(0, box.top - innerHeight / 2);
        });
        assert.ok(await pre.evaluate(node => {
            const range = document.createRange(); range.setStart(node.firstChild, node.textContent.length - 1); range.setEnd(node.firstChild, node.textContent.length);
            const box = range.getBoundingClientRect(); return box.bottom <= innerHeight && box.top >= 0;
        }), "The final retained character is reachable by document scrolling");
        if (proofs && width === 375 && scale === 2) await page.screenshot({ path: path.join(proofs, `request-${theme}-375-200-last-text.png`) });
        await reader.click();
        await page.locator("#contextBack").click(); await ready(page);
        assert.equal(await page.locator(".matched-action").count(), 1);
        metrics.push({ theme, viewportWidth: width, panel, scale, ...collapsed, ...geometry });
    }
    if (proofs) await writeFile(path.join(proofs, "text-and-layout.json"), JSON.stringify(metrics, null, 2));
});

test("empty, incomplete and unavailable originals do not invent text or tool failures", { timeout: 30000 }, async t => {
    for (const [status, text] of [["full", "Short exact request\n  second line  "], ["partial", original], ["truncated", original], ["unavailable", "MUST_NOT_APPEAR"], ["full", ""]]) {
        const { page, url } = await setup(t, record => {
            record.sourceSessionName = null; record.project = null; record.projectId = null;
            record.userPrompt = { status, text }; record.toolCalls = []; record.followUpPrompts = [];
            return [record];
        });
        await page.goto(url + "#request?request=investigation"); await ready(page);
        assert.match(await page.locator(".journey-pages").innerText(), /No individual action details were retained/);
        assert.equal(await page.locator(".action-error").count(), 0);
        const request = page.locator(".request-original");
        if (status === "unavailable" || text === "") {
            assert.match(await request.innerText(), /Prompt not available/);
            assert.equal(await request.locator("button,pre").count(), 0);
            assert.doesNotMatch(await request.innerText(), /MUST_NOT_APPEAR/);
        } else {
            const toggle = request.locator(".full-text-toggle");
            if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
            assert.equal(await request.locator("pre").textContent(), text);
            if (status !== "full") {
                assert.match(await request.innerText(), /Partial text/);
                await request.locator(".reader-details > summary").click();
                assert.match(await request.innerText(), /Only part of the original was recorded/);
            }
        }
        await page.close();
    }
});

test("mixed outcomes keep exact errors, distinct scopes and chronological bounded actions", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t, record => {
        record.toolCalls = Array.from({ length: 8 }, (_, i) => ({
            ...structuredClone(record.toolCalls[0]), toolCallId: `mixed-${i}`, startEventId: `start-${i}`,
            startedAt: `2026-09-30T12:00:0${7 - i}Z`, toolSucceeded: i !== 5,
            reportedOutcome: i === 5 ? "failed" : "succeeded",
            apiResults: i === 5 ? [{ index: 0, statusCode: 403, errorCode: "Original_<not-markup>_\u65e5\u672c\u8a9e" }] : [],
        }));
        return [record];
    });
    await page.goto(url + "#activity?session=test-session&result=failure"); await ready(page);
    assert.equal(await page.locator(".matched-action").count(), 1);
    assert.match(await page.locator(".matched-action .action-error").textContent(), /Original_<not-markup>_\u65e5\u672c\u8a9e/);
    await page.locator(".matched-action .text-link").click(); await ready(page);
    assert.match(await page.locator(".request-matching").textContent(), /1 of 8 Work IQ tool calls/);
    assert.match(await page.locator(".full-request-results").textContent(), /8 Work IQ tool calls.*7 Worked.*1 Tool failed.*1 tool-returned API result/s);
    assert.equal(await page.locator(".journey-item").count(), 6);
    assert.equal(await page.locator(".journey-item").nth(2).locator(".action-error").textContent(), "Reported HTTP 403: Original_<not-markup>_\u65e5\u672c\u8a9e");
    assert.match(await page.locator(".journey-item").nth(2).locator(".action-context").textContent(), /1 matching/);
    assert.match(await page.locator(".journey-item").nth(0).locator(".action-context").textContent(), /Outside current view/);
    assert.equal(await page.locator(".journey-item not-markup").count(), 0);
    assert.deepEqual(await page.locator(".journey-item").evaluateAll(nodes => nodes.map(node => node.dataset.toolCallId)), ["mixed-7", "mixed-6", "mixed-5", "mixed-4", "mixed-3", "mixed-2"]);
    await page.locator(".journey-item").first().getByText("Technical details", { exact: true }).click();
    assert.match(await page.locator(".journey-item").first().locator("dt").filter({ hasText: /^Started$/ }).locator("+ dd").textContent(), /5:00:00 AM/);
    await page.getByRole("button", { name: "Next action records", exact: true }).click();
    assert.equal(await page.locator(".journey-item").count(), 2);
});

test("request disclosure survives polling and stale reads without mounting an old request's text", { timeout: 30000 }, async t => {
    const { page, url, records, store } = await setup(t, record => {
        const other = fixture("other-request");
        other.userPrompt.text = "Different retained original";
        return [record, other];
    });

    await page.goto(url + "#request?request=investigation"); await ready(page);
    await page.locator(".request-original .full-text-toggle").click();
    const toggle = page.locator(".request-original .full-text-toggle");
    await toggle.focus();
    await replaceEvidence(store, () => ({ records, importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await read; await ready(page);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator(".request-original pre").textContent(), original);
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Synthetic read unavailable" } }));
    const failed = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.status() === 503);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await failed;
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    assert.equal(await page.locator(".request-original pre").textContent(), original);
    await page.unroute("**/api/snapshot");
    await page.goto(url + "#request?request=other-request"); await ready(page);
    assert.equal(await page.locator(".request-original pre").textContent(), "Different retained original");
    assert.equal(await page.locator(".request-original pre").count(), 1);
});

test("a delayed snapshot cannot restore the previous request reader after navigation", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t, record => {
        const other = fixture("other-request");
        other.userPrompt.text = "Second exact request is not the old disclosure.";
        return [record, other];
    });
    await page.goto(url + "#request?request=investigation"); await ready(page);
    await page.locator(".request-original .full-text-toggle").click();
    let release, intercepted;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { intercepted = resolve; });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        intercepted();
        await gate;
        await route.fulfill({ response });
    }, { times: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await started;
    await page.locator(".request-original .full-text-toggle").click();
    await page.evaluate(() => { location.hash = "#request?request=other-request"; });
    const applied = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    release();
    await applied; await ready(page);
    await page.waitForFunction(() => document.querySelector(".request-original pre")?.textContent === "Second exact request is not the old disclosure.");
    assert.equal(await page.locator(".request-original pre").count(), 1);
    assert.doesNotMatch(await page.locator(".request-original").textContent(), /END_OF_RETAINED_REQUEST/);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator(".request-original .full-text-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".request-original pre").count(), 0);
});

test("selected exact request text survives rebuild but never transfers to changed text", { timeout: 30000 }, async t => {
    const { page, url, record, store } = await setup(t);
    await page.goto(url + "#request?request=investigation"); await ready(page);
    await page.locator(".request-original .full-text-toggle").click();
    const selectText = () => page.locator(".request-original pre").evaluate(node => {
        node.focus();
        getSelection().setBaseAndExtent(node.firstChild, 20, node.firstChild, 60);
        return getSelection().toString();
    });
    const selection = await selectText();
    const poll = async records => {
        await replaceEvidence(store, () => ({ records, importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
        const response = page.waitForResponse(value => value.url().endsWith("/api/snapshot"));
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await response; await ready(page);
    };
    await poll([record, fixture("new-request")]);
    assert.equal(await page.evaluate(() => getSelection().toString()), selection);
    assert.equal(await page.locator(".request-original pre").evaluate(node => node === document.activeElement), true);
    const changed = structuredClone(record);
    changed.userPrompt.text = "Changed source identity and text; never reuse another selection.";
    await poll([changed]);
    assert.equal(await page.locator(".request-original pre").textContent(), changed.userPrompt.text);
    assert.equal(await page.evaluate(() => getSelection().toString()), "");
});
