import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
const proofs = process.env.WORKIQ_ALIGNMENT_PROOFS;

function textGeometry(node) {
    if (Array.isArray(node)) return node.map(textGeometry);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), rects = [];
    while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        rects.push(...[...range.getClientRects()].map(rect => ({ x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom })));
    }
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { x: rect.x, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
        text: node.textContent, rects, fontSize: style.fontSize, lineHeight: style.lineHeight, font: style.fontFamily };
}

async function aligned(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => matchMedia("(max-width:699px)").matches ||
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")) === Math.ceil(document.querySelector("#sidebar").getBoundingClientRect().width));
    const [result, hint] = await page.locator("#periodResult,#periodHint").evaluateAll(textGeometry);
    assert.equal(result.x, hint.x, "Paragraph containers share their left edge");
    assert.equal(result.rects[0].x, hint.rects[0].x, "Visible text, not just paragraph boxes, must align");
    for (const node of [result, hint]) for (const rect of node.rects) {
        assert.ok(rect.x >= node.x - 1 && rect.right <= node.right + 1 && rect.bottom <= node.bottom + 1, JSON.stringify(node));
    }
    return { result, hint };
}

async function statusShot(page, name) {
    if (!proofs) return;
    await page.locator("#periodFeedback").evaluate(node => {
        const header = document.querySelector(".app-header").getBoundingClientRect();
        scrollTo(0, scrollY + node.getBoundingClientRect().top - header.height - 16);
    });
    await page.locator("#periodFeedback>div").first().screenshot({ path: path.join(proofs, name) });
}

async function app(t) {
    const records = Array.from({ length: 62 }, (_, index) => {
        const record = fixture(`alignment-${index}`);
        record.sourceSessionId = `alignment-chat-${index % 36}`;
        record.sourceSessionName = `Synthetic alignment chat ${index % 36}`;
        record.userPrompt.text = `Synthetic alignment request ${index}`;
        record.toolCalls = Array.from({ length: index < 33 ? 4 : 3 }, (_, call) => ({
            ...record.toolCalls[0], toolCallId: `alignment-${index}-${call}`, startEventId: `alignment-start-${index}-${call}`,
            startedAt: "2026-09-30T12:00:00Z",
        }));
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ locale: "en-US", timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    t.after(async () => {
        await browser.close();
        await runtime.close();
        for (const fn of cleanup.reverse()) await fn();
        assert.deepEqual(errors, []);
        assert.ok(posts.every(url => ["/api/snapshot", "/api/collection/status"].includes(url)), JSON.stringify(posts));
    });
    return { page, url: runtime.url };
}

test("period summary glyphs align without changing copy or chooser across themes and root text sizes", { timeout: 90000 }, async t => {
    const { page, url } = await app(t), measurements = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url); await ready(page); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const geometry = await aligned(page), chooser = await page.locator("#pageAction").evaluate(textGeometry);
        assert.equal(geometry.result.text, "219 Work IQ tool calls (All dates)");
        assert.equal(geometry.hint.text, "All retained dates · 36 Copilot chats");
        assert.equal(chooser.text, "Choose a Copilot chat");
        assert.equal(geometry.result.fontSize, `${22 * scale}px`);
        assert.equal(chooser.fontSize, await page.locator("body").evaluate(node => getComputedStyle(node).fontSize));
        assert.ok(chooser.height >= 44);
        assert.ok(chooser.x >= 0 && chooser.right <= width + 1);
        assert.equal(await page.locator("#periodResult").getAttribute("data-pending"), "false");
        assert.equal(await page.locator("#periodResult [data-progress-icon]").isVisible(), false);
        const lines = new Set(geometry.result.rects.map(rect => rect.y)).size;
        const expectedHeight = lines * parseFloat(geometry.result.lineHeight);
        // Chromium quantizes each rendered line to a 1/64px layout unit.
        assert.ok(Math.abs(geometry.result.height - expectedHeight) <= lines / 64, "An idle marker cannot add an empty wrapped line");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        measurements.push({ theme, width, scale, ...geometry, chooser });
        if (proofs) await page.locator("#periodFeedback").screenshot({ path: path.join(proofs, `aligned-${theme}-${width}-${scale}.png`) });
    }
    if (proofs) await writeFile(path.join(proofs, "alignment-matrix.json"), JSON.stringify(measurements, null, 2));
});

test("pending and failed period text stay aligned while applied counts and native chooser navigation remain unchanged", { timeout: 60000 }, async t => {
    const { page, url } = await app(t);
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.goto(url + "#home?from=2026-09-01&to=2026-10-01"); await ready(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const before = await aligned(page), count = await page.locator("#activityCount").innerText();
    let release, entered;
    const hold = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { entered = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        entered(); await hold;
        await route.fulfill({ status: 500, json: { error: "Synthetic alignment read failed." } });
    }, { times: 1 });
    await page.locator("#fromFilter").fill("2027-01-01");
    await page.locator("#toFilter").fill("2027-01-02");
    await page.locator("#applyDates").click(); await requested;
    await aligned(page);
    assert.equal(await page.locator("#periodHint").innerText(), before.hint.text, "Pending scope still describes the accepted snapshot");
    assert.equal(await page.locator("#activityCount").innerText(), count);
    assert.equal(await page.locator("#periodResult").innerText(), "219 Work IQ tool calls (Sep 1 - Oct 1, 2026)");
    assert.equal(await page.locator("#periodResult .pending-indicator").isVisible(), true);
    assert.equal(await page.locator("#periodResult .pending-indicator").getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator("#pageAction").getAttribute("aria-disabled"), "true");
    await statusShot(page, "aligned-pending-375-2.png");
    release(); await ready(page);
    await aligned(page);
    assert.match(await page.locator("#periodResult").innerText(), /^Previous results: 219 Work IQ tool calls/);
    assert.equal(await page.locator("#activityCount").innerText(), count);
    assert.match(await page.locator("#periodHint").innerText(), /update failed.*last applied period/i);
    assert.equal(await page.locator("#periodResult .pending-indicator").count(), 0);
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    await statusShot(page, "aligned-error-375-2.png");
    await page.locator("#fromFilter").fill("2026-09-01");
    await page.locator("#toFilter").fill("2026-10-01");
    await page.locator("#applyDates").click(); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    await page.locator("#pageAction").focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.match(page.url(), /#activity/);
    assert.equal(await page.locator("#fromFilter").inputValue(), "2026-09-01");
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    await page.goBack(); await ready(page); await aligned(page);
    assert.match(page.url(), /#home/);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
});

test("shared pending text keeps its leading edge while generated button slots and existing icons keep their positions", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 375, height: 1000 }, reducedMotion: "reduce" });
        await page.setContent(`<style>${styles}</style><main><p id="status"></p><button id="plain">Reload</button><button id="icon">Check</button><a id="link" href="#activity">Activity</a><span id="roleButton" role="button" tabindex="0">Action</span></main>`);
        await page.addScriptTag({ content: `const ux = (${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});window.testUX = ux;document.querySelector("#icon").prepend(ux.icon("check"));` });
        for (const font of ["system-ui", "serif"]) for (const scale of [1, 2]) for (const text of ["0 Work IQ tool calls.", "1 Work IQ tool call.", "1,234,567 Work IQ tool calls.", "Sources unavailable. Previous results are still shown."]) {
            await page.evaluate(({ text, scale, font }) => {
                document.documentElement.style.fontSize = `${scale * 100}%`;
                document.querySelector("main").style.fontFamily = font;
                document.querySelector("#status").textContent = text;
            }, { text, scale, font });
            await page.evaluate(() => document.fonts.ready);
            const baseline = await page.locator("#status").evaluate(textGeometry);
            let controls;
            for (const pending of [false, true, false]) {
                await page.evaluate(pending => {
                    for (const id of ["status", "plain", "icon", "link", "roleButton"]) window.testUX.pending(document.getElementById(id), pending);
                }, pending);
                const status = await page.locator("#status").evaluate(textGeometry);
                assert.equal(status.rects[0].x, baseline.rects[0].x);
                assert.equal(status.text, text);
                if (!pending) assert.equal(status.height, baseline.height, "Plain text has no idle progress gutter or empty line");
                assert.equal(await page.locator("#status [data-progress-icon]").count(), 1);
                assert.equal(await page.locator("#status [data-progress-icon]").isVisible(), pending);
                assert.equal(await page.locator("#plain").evaluate(node => node.firstChild.matches(".progress-slot")), true);
                for (const id of ["link", "roleButton"]) assert.equal(await page.locator(`#${id}`).evaluate(node => node.firstChild.matches(".progress-slot") && !node.firstChild.classList.contains("progress-slot-trailing")), true);
                assert.equal(await page.locator("#icon").evaluate(node => node.firstChild.matches(".fluent-icon")), true);
                assert.equal(await page.locator("#icon .progress-slot").count(), 0);
                assert.equal(await page.locator("#plain").getAttribute("aria-busy"), String(pending));
                assert.equal(await page.locator("#icon>.fluent-icon").getAttribute("data-fluent-icon"),
                    pending ? "spinner_ios_20_regular" : "checkmark_20_regular");
                assert.equal(await page.locator("#plain .progress-slot>.fluent-icon").getAttribute("data-fluent-icon"), "spinner_ios_16_regular");
                const slot = await page.locator("#plain").evaluate(node => {
                    const marker = node.querySelector(".progress-slot").getBoundingClientRect();
                    const range = document.createRange();
                    range.selectNode([...node.childNodes].find(child => child.nodeType === 3 && child.textContent.trim()));
                    const label = range.getBoundingClientRect(), box = node.getBoundingClientRect();
                    return { marker: marker.toJSON(), label: label.toJSON(), box: box.toJSON() };
                });
                assert.equal(slot.marker.width, 16); assert.equal(slot.marker.height, 16);
                assert.ok(slot.marker.right + 3 <= slot.label.x, "The official progress glyph never overlaps the button label");
                assert.ok(Math.abs(slot.label.x + slot.label.width / 2 - slot.box.x - slot.box.width / 2) < 1,
                    "A generated progress slot preserves the centered label");
                const geometry = await page.locator("#plain,#icon,#link,#roleButton").evaluateAll(nodes => nodes.map(node => {
                    const rect = node.getBoundingClientRect();
                    return { width: rect.width, height: rect.height };
                }));
                controls ??= geometry;
                assert.deepEqual(geometry, controls, "Interactive controls keep their reserved slot geometry while pending changes");
            }
        }
    } finally {
        await browser.close();
    }
});
