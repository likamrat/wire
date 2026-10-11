// Invented retained samples only, on the real application with source timers disabled.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, revealStoredRefresh } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WIRE_RECORDED_TIMING_PROOFS;
const start = Date.UTC(2026, 8, 30, 12), stamp = delta => new Date(start + delta).toISOString();
function records() {
    return ["ALPHA", "BETA"].map((name, i) => {
        const row = fixture(`timing-${name}`);
        row.sourceSessionId = `timing-source-${name}`;
        row.sourceSessionName = `Invented ${name}`;
        row.userPrompt = { ...row.userPrompt, text: `SYNTHETIC_TIMING_${name}`, sourceEventId: `prompt-${i}`, sourceTimestamp: stamp(0) };
        row.followUpPrompts = [];
        row.toolCalls = (i === 0 ? [0, 2000, 900000] : [1000, null]).map((durationMs, j) => ({
            ...structuredClone(row.toolCalls[0]), toolCallId: `call-${i}-${j}`, startEventId: `start-${i}-${j}`,
            requestArgs: durationMs === null ? {} : { entityUrls: [j === 0 ? "/me/calendarView" : "/me/messages"] },
            requestedApiPath: durationMs === null ? null : j === 0 ? "/me/calendarView" : "/me/messages",
            completionEventId: durationMs === null ? null : `end-${i}-${j}`,
            startedAt: stamp(0), completedAt: durationMs === null ? null : stamp(durationMs), durationMs,
            toolSucceeded: durationMs === null ? null : true, reportedOutcome: durationMs === null ? "unknown" : "succeeded",
        }));
        if (i === 0) row.responseTiming = recordedResponseTiming([
            { id: "prompt-0", type: "user.message", timestamp: stamp(0), data: { messageId: "prompt-0" } },
            { id: "response", type: "assistant.message", timestamp: stamp(677960), data: {
                wireResponseMetadataVersion: 1, finalAnswer: true, hasResponseText: true, hasToolRequests: false,
                turnId: "turn", originatingMessageId: "prompt-0",
            } },
            { id: "end", type: "assistant.turn_end", timestamp: stamp(677961), data: { turnId: "turn" } },
        ], row.userPrompt);
        return row;
    });
}
const ready = async page => {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#recordedTiming .recorded-timing-row")).toBeVisible();
};
async function setup(t) {
    const source = records(), cleanup = [], requests = [], errors = [], denied = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, source);
    const server = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US",
    });
    page.setDefaultTimeout(8000);
    const allowed = new Set(["/api/snapshot", "/api/collection/status", "/api/assessment/detail",
        "/api/assessment/overview", "/api/evaluation/automatic/summary"]);
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && !allowed.has(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (request.method() !== "GET") requests.push({ path: url.pathname, body: request.postDataJSON() });
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        try {
            await browser.close(); await server.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.doesNotMatch(JSON.stringify(requests), /SYNTHETIC_TIMING/);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(server.url + "#analyze"); await ready(page);
    return { page, source, context, requests };
}
const matching = page => page.locator("#recordedTiming .recorded-timing-row");
const fullCalls = page => page.locator('#homeInsights [data-timing-boundary="tool-start-to-completion"]');
async function check(page, values, coverage) {
    await expect(matching(page).locator(".assessment-value")).toHaveText(values);
    await expect(matching(page).locator(".assessment-coverage")).toHaveText(coverage);
}

test("Analyze matching-call timing follows filters/private search/refinements and Back without repooling full interactions", { timeout: 45000 }, async t => {
    const { page, source, context } = await setup(t);
    await check(page, ["1 s", "15 min 0 s"], "4 of 5 calls timed");
    await expect(fullCalls(page).locator(".assessment-coverage")).toHaveText("4 of 5 calls timed");
    const response = page.locator('#homeInsights [data-timing-boundary="recorded-request-to-final-answer"]');
    await expect(response.locator(".assessment-value")).toHaveText("11 min 17.96 s");
    await expect(response).toContainText("One sample, not overall performance");
    assert.equal(await response.locator(".timing-scale").count(), 0);
    await selectActivityOption(page, "serviceAssociationFilter", "Calendar"); await ready(page);
    await check(page, ["0 s", "1 s"], "2 of 3 calls timed");
    await expect(fullCalls(page).locator(".assessment-coverage")).toHaveText("4 of 5 calls timed");
    await expect(page.locator("#homeInsights")).toContainText("Recorded timing in full interactions");
    const calendar = page.locator('[data-percentage-card="services"] [data-category="Calendar"] .percentage-label[href]').first();
    await calendar.click(); await ready(page);
    await check(page, ["0 s", "1 s"], "2 of 2 calls timed");
    assert.match(page.url(), /withinServices=Calendar/);
    await page.locator("#activitySearch").fill("SYNTHETIC_TIMING_ALPHA"); await ready(page);
    await check(page, ["0 s"], "1 of 1 call timed");
    await expect(fullCalls(page).locator(".assessment-value")).toHaveText(["2 s", "15 min 0 s"]);
    const exact = matching(page).locator(".timing-exact");
    await exact.locator("summary").focus(); await page.keyboard.press("Enter");
    await expect(exact).toHaveAttribute("open", "");
    await expect(exact).toContainText("0 ms");
    await expect(exact).toContainText("Not shown without multiple samples");
    await page.getByRole("link", { name: "View matching calls", exact: true }).click(); await ready(page);
    await expect(page.locator("#activityList .matched-action")).toHaveCount(1);
    await page.locator("#activityList .request-link").first().click();
    await expect(page.locator('.interaction-insights [data-timing-boundary="tool-start-to-completion"] .assessment-value')).toHaveText(["2 s", "15 min 0 s"]);
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(proofs, "request-recorded-timing.png"),
            clip: await page.locator(".interaction-insights .assessment-timing").boundingBox(), fullPage: true });
    }
    await page.goBack(); await ready(page);
    await expect(page.locator("#activitySearch")).toHaveValue("SYNTHETIC_TIMING_ALPHA");
    await page.goBack(); await ready(page);
    await expect(exact).toHaveAttribute("open", "");
    await expect(page.getByRole("link", { name: "View matching calls", exact: true })).toBeFocused();
    source[0].toolCalls[0].durationMs = 3000; source[0].toolCalls[0].completedAt = stamp(3000);
    await replaceEvidence(context, () => ({ records: source, importCoverage: { counts: { includedSessions: 2, includedProjects: 1 }, roster: [] } }));
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await check(page, ["3 s"], "1 of 1 call timed");
    assert.match(page.url(), /withinServices=Calendar/);
    await page.locator("#activitySearch").fill("SYNTHETIC_TIMING_NO_MATCH"); await ready(page);
    await check(page, ["Not measured"], "0 of 0 calls timed");
    assert.equal(await matching(page).locator(".timing-scale").count(), 0);
    assert.equal(await page.getByRole("link", { name: "View matching calls", exact: true }).count(), 0);
});

test("timing component is compact, exact and legible in both themes at desktop and narrow doubled text", { timeout: 45000 }, async t => {
    const { page } = await setup(t), proof = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const exact = matching(page).locator(".timing-exact");
        if (!await exact.evaluate(node => node.open)) await exact.locator("summary").click();
        await exact.locator("summary").focus();
        await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
        const metrics = await page.locator("#recordedTiming").evaluate(root => {
            const nodes = [...root.querySelectorAll("*:not(.timing-track)")].filter(node => node.checkVisibility());
            const clipped = nodes.filter(node => node.clientWidth && node.scrollWidth > node.clientWidth + 1).map(node => node.className);
            const colors = [".assessment-value", ".timing-boundary", ".assessment-unavailable-reason", ".timing-scale-key"].map(selector => {
                const node = root.querySelector(selector);
                return { selector, fg: getComputedStyle(node).color, bg: getComputedStyle(document.body).backgroundColor };
            });
            const track = root.querySelector(".timing-track").getBoundingClientRect();
            const median = root.querySelector(".timing-median").getBoundingClientRect();
            const p95 = root.querySelector(".timing-p95").getBoundingClientRect();
            const scale = root.querySelector(".timing-scale").getBoundingClientRect();
            const summary = root.querySelector("summary"), focus = getComputedStyle(summary);
            const target = summary.getBoundingClientRect();
            return { clipped, colors, overflow: document.documentElement.scrollWidth - innerWidth,
                values: [...root.querySelectorAll(".assessment-value")].map(node => node.textContent),
                coverage: root.querySelector(".assessment-coverage").textContent,
                exact: root.querySelector(".timing-exact-facts").innerText,
                targets: [...root.querySelectorAll("summary,a")].map(node => node.getBoundingClientRect().height),
                medianFraction: (median.x + median.width / 2 - track.x) / track.width,
                p95Fraction: (p95.x + p95.width / 2 - track.x) / track.width,
                marksFit: median.left >= scale.left && p95.right <= scale.right,
                focusVisible: summary.contains(document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2)),
                focus: { width: focus.outlineWidth, style: focus.outlineStyle, color: focus.outlineColor } };
        });
        assert.deepEqual(metrics.clipped, []); assert.ok(metrics.overflow <= 1);
        assert.ok(metrics.targets.every(height => height >= 44));
        assert.ok(Math.abs(metrics.medianFraction - 1000 / 900000) < .001);
        assert.ok(Math.abs(metrics.p95Fraction - 1) < .001);
        assert.ok(metrics.marksFit);
        assert.notEqual(metrics.focus.style, "none"); assert.ok(parseFloat(metrics.focus.width) >= 2);
        assert.ok(metrics.focusVisible, "Keyboard-focused timing disclosure is not covered by the sticky header");
        for (const color of metrics.colors) assert.ok(contrast(color.fg, color.bg) >= 4.5, `${theme} ${color.selector}`);
        await expect(exact).toContainText("1000 ms");
        await expect(exact).toContainText("900000 ms");
        await expect(exact).toContainText("tool-start-to-completion");
        proof.push({ theme, width, scale, ...metrics });
        if (proofs) {
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `recorded-timing-${theme}-${width}-${scale}.png`),
                clip: await page.locator("#recordedTiming").boundingBox(), fullPage: true });
            await writeFile(path.join(proofs, `recorded-timing-${theme}-${width}-${scale}.txt`), await page.locator("#recordedTiming").ariaSnapshot());
        }
    }
    if (proofs) await writeFile(path.join(proofs, "numeric-visual-proof.json"), JSON.stringify(proof, null, 2));
});
