import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { replaceEvidence } from "../../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "../support/helpers.mjs";

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
    record.userPrompt = { text: original, status: "full", sourceEventId: "investigation-prompt",
        sourceTimestamp: record.capturedAt, authorship: { actor: "user", basis: "source-user" } };
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

test("a failed call opens its exact prompt, with every glyph reachable in docked and enlarged readers", { timeout: 60000 }, async t => {
    const { page, url, record } = await setup(t, record => {
        record.project = "Synthetic project " + "unbrokenproject".repeat(15);
        record.sourceSessionName = "Synthetic chat " + "\u65e5\u672c\u8a9e".repeat(24);
        return [record];
    });
    const metrics = [], proofs = process.env.WORKIQ_REQUEST_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(url + "?result=failure"); await ready(page);
    for (const [theme, width, scale] of [["light", 1440, 1], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const opener = page.locator('[data-view-key="request:investigation"] .request-card-open');
        await opener.click();
        await expect(page.locator(`[data-tool-call-id="${record.toolCalls[0].toolCallId}"]`)).toBeFocused();
        const reader = page.locator('[data-reader-section="prompt"] .prompt-preview-toggle');
        await expect(reader).toHaveAttribute("aria-expanded", "false");
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
        assert.equal(await page.locator("#requestContent [id]").evaluateAll(nodes => nodes.length === new Set(nodes.map(n => n.id)).size), true);
        await pre.focus();
        await pre.evaluate(node => {
            const range = document.createRange();
            range.setStart(node.firstChild, node.textContent.length - 23); range.collapse(true);
            const box = range.getBoundingClientRect(); document.querySelector("#contextSidebarBody").scrollBy(0, box.top - innerHeight / 2);
        });
        assert.ok(await pre.evaluate(node => {
            const range = document.createRange(); range.setStart(node.firstChild, node.textContent.length - 1); range.setEnd(node.firstChild, node.textContent.length);
            const box = range.getBoundingClientRect(); return box.bottom <= innerHeight && box.top >= 0;
        }), "The final retained character is reachable by reader scrolling");
        if (proofs && width === 375 && scale === 2) await page.screenshot({ path: path.join(proofs, `request-${theme}-375-200-last-text.png`) });
        await reader.click();
        await page.goBack(); await ready(page);
        await expect(opener).toBeFocused();
        metrics.push({ theme, viewportWidth: width, scale, ...geometry });
    }
    if (proofs) await writeFile(path.join(proofs, "text-and-layout.json"), JSON.stringify(metrics, null, 2));
});

test("a truncated original with no recorded actions remains readable without inventing a tool failure", async t => {
    const { page, url } = await setup(t, record => {
        record.userPrompt.status = "truncated";
        record.toolCalls = [];
        return [record];
    });
    await page.goto(url + "#request?request=investigation"); await ready(page);
    await expect(page.locator("#requestContent")).toContainText("No individual action details were retained.");
    const prompt = page.locator('[data-reader-section="prompt"]');
    await prompt.locator(".prompt-preview-toggle").click();
    assert.equal(await prompt.locator("pre").textContent(), original);
    await expect(prompt).toContainText("Partial text");
    await expect(page.locator("#requestContent [data-tool-call-id]")).toHaveCount(0);
});

test("a filtered failure opens the exact call among its chronological siblings without interpreting its error as markup", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t, record => {
        record.toolCalls = Array.from({ length: 8 }, (_, i) => ({
            ...structuredClone(record.toolCalls[0]), toolCallId: `mixed-${i}`, startEventId: `start-${i}`,
            startedAt: `2026-09-30T12:00:0${7 - i}Z`, toolSucceeded: i !== 5,
            reportedOutcome: i === 5 ? "failed" : "succeeded",
            apiResults: i === 5 ? [{ index: 0, statusCode: 403, errorCode: "Original_<not-markup>_\u65e5\u672c\u8a9e" }] : [],
        }));
        return [record];
    });
    await page.goto(url + "?result=failure"); await ready(page);
    const opener = page.locator('[data-view-key="request:investigation"] .request-card-open');
    await opener.click();
    const selected = page.locator('[data-tool-call-id="mixed-5"]');
    await expect(selected).toBeFocused();
    await expect(selected).toContainText("Original_<not-markup>_日本語");
    await expect(selected.locator("not-markup")).toHaveCount(0);
    const calls = page.locator('[data-reader-section="activity"] [data-tool-call-id]');
    assert.deepEqual(await calls.evaluateAll(nodes => nodes.map(node => node.dataset.toolCallId)),
        [7, 6, 5, 4, 3, 2, 1, 0].map(index => `mixed-${index}`));
    await expect(calls.first()).toContainText("Outside current view");
    await page.goBack(); await expect(opener).toBeFocused();
});

test("request disclosure survives polling and stale reads without mounting an old request's text", { timeout: 30000 }, async t => {
    const { page, url, records, store } = await setup(t, record => {
        const other = fixture("other-request");
        other.userPrompt.text = "Different retained original";
        return [record, other];
    });

    await page.goto(url + "#request?request=investigation"); await ready(page);
    await page.locator("[data-reader-section=prompt] .prompt-preview-toggle").click();
    const toggle = page.locator("[data-reader-section=prompt] .prompt-preview-toggle");
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await replaceEvidence(store, () => ({ records, importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await read; await ready(page);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await expect(toggle).toBeFocused();
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
    await page.locator("[data-reader-section=prompt] .prompt-preview-toggle").click();
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
    await page.locator("[data-reader-section=prompt] .prompt-preview-toggle").click();
    await page.evaluate(() => { location.hash = "#request?request=other-request"; });
    const applied = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    release();
    await applied; await ready(page);
    await page.waitForFunction(() => document.querySelector(".request-original pre")?.textContent === "Second exact request is not the old disclosure.");
    assert.equal(await page.locator(".request-original pre").count(), 1);
    assert.doesNotMatch(await page.locator(".request-original").textContent(), /END_OF_RETAINED_REQUEST/);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator("[data-reader-section=prompt] .prompt-preview-toggle").getAttribute("aria-expanded"), "false");
    await expect(page.locator(".request-original pre")).toHaveClass(/prompt-preview-clamped/);
});

test("selected exact request text survives rebuild but never transfers to changed text", { timeout: 30000 }, async t => {
    const { page, url, record, store } = await setup(t);
    await page.goto(url + "#request?request=investigation"); await ready(page);
    await page.locator("[data-reader-section=prompt] .prompt-preview-toggle").click();
    const prompt = page.locator(".request-original pre");
    await prompt.dblclick({ position: { x: 18, y: 12 } });
    const selection = await page.evaluate(() => getSelection().toString());
    assert.ok(selection.trim() && original.includes(selection));
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
    changed.userPrompt.sourceEventId = "replacement-prompt";
    changed.userPrompt.text = "Changed source identity and text; never reuse another selection.";
    await poll([changed]);
    await expect(page.locator(".request-original pre")).toHaveCount(0);
    assert.equal(await page.evaluate(() => getSelection().toString()), "");
    await expect(page.locator("#workspace")).not.toContainText(changed.userPrompt.text);

    for (const missing of ["sourceSessionId", "sourceEventId"]) {
        const app = await setup(t, record => {
            if (missing === "sourceSessionId") delete record.sourceSessionId;
            else delete record.userPrompt.sourceEventId;
            return [record];
        });
        await app.page.goto(app.url + "#request?request=investigation"); await ready(app.page);
        await app.page.locator("[data-reader-section=prompt] .prompt-preview-toggle").click();
        const unbound = app.page.locator(".request-original pre");
        await unbound.dblclick({ position: { x: 18, y: 12 } });
        assert.ok(await app.page.evaluate(() => getSelection().toString().trim()));
        await replaceEvidence(app.store, () => ({ records: [app.record, fixture("unrelated")],
            importCoverage: { counts: { includedSessions: 2 }, roster: [] } }));
        const refreshed = app.page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
        await app.page.evaluate(() => dispatchEvent(new Event("online")));
        await refreshed; await ready(app.page);
        assert.equal(await unbound.textContent(), original, `${missing}: the record remains readable`);
        assert.equal(await app.page.evaluate(() => getSelection().toString()), "", `${missing}: no borrowed selection`);
    }
});
