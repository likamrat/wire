import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

function severityRecords() {
    const cases = [
        ["known", ["failed"], "user"],
        ["mixed", ["failed", "unknown", "partial", "succeeded"], "agent"],
        ["automatic", ["failed"], "agent"],
        ["worked", ["succeeded"], "user"],
        ["unknown", ["unknown"], "unknown"],
        ["partial", ["partial"], "user"],
        ["automatic-worked", ["succeeded"], "agent"],
        ["unknown-cause", ["failed"], "user"],
    ];
    return cases.map(([name, outcomes, actor], index) => {
        const record = fixture("severity-" + name), automatic = name.startsWith("automatic");
        const at = new Date(Date.UTC(2026, 9, 18, 12, index)).toISOString();
        record.userPrompt = {
            text: automatic ? "" : name === "unknown" ? null : "Check the workshop notes for a recorded error.",
            status: name === "unknown" ? "unavailable" : "full", sourceEventId: "severity-prompt-" + name, sourceTimestamp: at,
            authorship: { actor, basis: automatic ? "autopilot" : actor === "user" ? "source-user" : actor === "agent" ? "source-agent" : "missing-source" },
        };
        record.followUpPrompts = [];
        record.toolCalls = outcomes.map((outcome, call) => ({
            tool: automatic ? "workiq-retrieve" : "workiq-fetch",
            toolCallId: `severity-call-${name}-${call}`, startEventId: `severity-start-${name}-${call}`,
            startedAt: at, durationMs: 42 + call,
            requestArgs: automatic ? { query: "SYNTHETIC_ARGUMENT_NOT_A_PROMPT" }
                : { entityUrls: [["/teams/synthetic-team/channels", "/me/messages", "/me/drive/root", "/me/people"][call]] },
            reportedOutcome: outcome, toolSucceeded: outcome === "failed" ? false : outcome === "succeeded" ? true : null,
            apiResults: name === "worked" ? [
                { index: 0, path: "/teams/synthetic-team/channels", statusCode: 200 },
                { index: 1, path: "/teams/synthetic-team/channels", statusCode: 503 },
                { index: 2, path: "/teams/synthetic-team/channels" },
            ] : [],
            ...(outcome === "failed" && name !== "unknown-cause" ? { failureEvidence: {
                version: 1, reason: "error-details-excluded", messageStatus: "text-excluded",
                messageSignal: automatic ? "workiq-sign-in-required" : "access-denial",
            } } : {}),
        }));
        return record;
    });
}

test("known failure copy and icon are red without repainting other outcomes or context", async t => {
    const cleanup = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, severityRecords());
    let expectedState = await loadBoardState(context);
    const errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw Error("Provider work denied in failure-emphasis proof."); },
            readSource() { throw Error("Source reads denied in failure-emphasis proof."); },
        } });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce",
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), expectedState);
        } finally { for (const fn of cleanup) await fn(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/session", "/api/session/release", "/api/snapshot", "/api/collection/status",
            "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await page.goto(runtime.url + "#analyze");
    await page.locator("#workspace[aria-busy=false]").waitFor();
    const proofs = process.env.WIRE_FAILURE_EMPHASIS_PROOFS, observations = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    async function settled() {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => document.getAnimations().every(animation =>
            animation.playState !== "running" || !Number.isFinite(animation.effect.getComputedTiming().iterations)));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function capture(name) {
        if (!proofs) return;
        await page.mouse.move(0, 0);
        await page.evaluate(() => scrollTo(0, 0));
        await settled();
        await page.screenshot({ path: path.join(proofs, name + "-page.png"), fullPage: true });
        const clip = await page.locator("#activityList").evaluate(node => {
            const box = node.getBoundingClientRect();
            return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height };
        });
        await page.screenshot({ path: path.join(proofs, name + "-list.png"), fullPage: true, clip });
    }
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale * 16 + "px"; }, scale);
        await page.evaluate(() => document.fonts.ready);
        const data = await page.locator(".request-card-open").evaluateAll(cards => cards.map(card => {
            const color = selector => { const node = card.querySelector(selector); return node ? getComputedStyle(node).color : null; };
            const problem = card.querySelector(".request-card-problem");
            return { name: new URLSearchParams(card.hash.split("?")[1]).get("request").replace("severity-", ""),
                text: problem.textContent, outcome: problem.dataset.outcome,
                copy: color(".request-card-problem > span"), icon: color(".request-card-problem > .wire-icon"),
                qualifications: color(".request-card-result-qualifications"),
                qualificationText: card.querySelector(".request-card-result-qualifications")?.textContent ?? null,
                author: color(".request-card-origin"), prompt: color(".request-card-prompt"),
                category: color(".service-cue"), metadata: color(".request-card-summary"),
                failureParts: [...problem.querySelectorAll(".request-card-failure-text")].map(node => getComputedStyle(node).color) };
        }));
        const role = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--chart-failure").trim());
        const failure = "rgb(" + role.slice(1).match(/../g).map(value => parseInt(value, 16)).join(", ") + ")";
        await page.locator('.request-card-open[href*="request=severity-known"]').hover();
        const hovered = await page.locator('.request-card-open[href*="request=severity-known"] .request-card-problem > span')
            .evaluate(node => getComputedStyle(node).color);
        observations.push({ theme, width, scale, failure, hovered, data });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await capture(`${theme}-${width}-${scale}`);
    }
    if (proofs) await writeFile(path.join(proofs, "computed-colors.json"), JSON.stringify(observations, null, 2));
    for (const { theme, width, failure, hovered, data } of observations) {
        assert.equal(hovered, failure, `${theme}/${width}: failure stays red on hover`);
        for (const name of ["known", "mixed", "automatic", "unknown-cause"]) {
            const item = data.find(item => item.name === name);
            assert.equal(item.copy, failure, `${theme}/${width}/${name}: actual failure copy`);
            assert.equal(item.icon, failure, `${theme}/${width}/${name}: failure icon`);
            for (const role of ["author", "prompt", "category", "metadata"]) assert.notEqual(item[role], failure, `${name}: preserve ${role}`);
        }
        const mixed = data.find(item => item.name === "mixed");
        assert.notEqual(mixed.qualifications, null);
        assert.notEqual(mixed.qualifications, failure);
        assert.match(mixed.qualificationText, /No result recorded/);
        assert.match(mixed.qualificationText, /Partly worked/);
        for (const name of ["worked", "unknown", "partial", "automatic-worked"]) {
            const item = data.find(item => item.name === name);
            assert.notEqual(item.copy, failure, `${name}: not a recorded failure`);
            assert.deepEqual(item.failureParts, []);
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
    await settled();
    const mixed = page.locator('.request-card-open[href*="request=severity-mixed"]');
    await mixed.click();
    await settled();
    const readerColors = await page.locator("#requestContent .reader-call-row .recorded-result").evaluateAll(nodes =>
        nodes.map(node => ({ outcome: node.dataset.outcome, color: getComputedStyle(node).color })));
    const darkFailure = observations.find(item => item.theme === "dark").failure;
    assert.equal(await mixed.locator(".request-card-result-copy").evaluate(node => getComputedStyle(node).color), darkFailure);
    for (const item of readerColors) assert.equal(item.color === darkFailure, item.outcome === "failure");
    if (proofs) await page.screenshot({ path: path.join(proofs, "mixed-native-reader.png") });
    await page.goBack();
    await selectActivityOption(page, "outcomeFilter", "success");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(mixed.locator(".request-card-problem")).toHaveText("Matching tool call worked.");
    await expect(mixed.locator(".request-card-failure-text")).toHaveCount(0);
    await closeAnalyzeFilters(page);
    await page.goto(runtime.url + "#analyze?layer=reported-api");
    await page.locator("#workspace[aria-busy=false]").waitFor();
    const apiCard = page.locator('.request-card-open[href*="request=severity-worked"]');
    await expect(apiCard.locator('[data-result-outcome="success"]')).toContainText("HTTP 2xx");
    await expect(apiCard.locator('[data-result-outcome="failure"]')).toContainText("Error result");
    await expect(apiCard.locator('[data-result-outcome="unknown"]')).toContainText("No status recorded");
    assert.notEqual(await apiCard.locator('[data-result-outcome="success"]').evaluate(node => getComputedStyle(node).color), darkFailure);
    assert.notEqual(await apiCard.locator('[data-result-outcome="unknown"]').evaluate(node => getComputedStyle(node).color), darkFailure);
    assert.equal(await apiCard.locator('[data-result-outcome="failure"]').evaluate(node => getComputedStyle(node).color), darkFailure);
    await page.goto(runtime.url + "#analyze");
    await page.locator("#workspace[aria-busy=false]").waitFor();
    const unknown = page.locator('[data-view-key="request:severity-unknown"] .request-card-open');
    await unknown.click();
    await expect(page.locator('#requestContent [data-tool-call-id="severity-call-unknown-0"] [data-outcome="unknown"]')).toBeVisible();
    const updated = severityRecords();
    Object.assign(updated.find(record => record.scenarioId === "severity-unknown").toolCalls[0], {
        reportedOutcome: "failed", toolSucceeded: false,
        failureEvidence: { version: 1, reason: "error-details-excluded", messageStatus: "sensitive-excluded" },
    });
    await replaceEvidence(context, () => ({ records: updated }));
    expectedState = await loadBoardState(context);
    const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await read;
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(unknown.locator(".request-card-failure-text")).toContainText("Error details omitted for privacy");
    assert.equal(await unknown.locator(".request-card-result-copy").evaluate(node => getComputedStyle(node).color), darkFailure);
    const updatedFailure = page.locator('#requestContent [data-tool-call-id="severity-call-unknown-0"] [data-outcome="failure"]');
    await expect(updatedFailure).toContainText("Error details omitted for privacy");
    assert.equal(await updatedFailure.evaluate(node => getComputedStyle(node).color), darkFailure);
    await settled();
    if (proofs) await page.screenshot({ path: path.join(proofs, "updated-native-reader.png") });
    await page.goBack();
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const known = page.locator('.request-card-open[href*="request=severity-known"]');
        await expect(known.locator(".request-card-problem")).toContainText("Tool call failed");
        const forced = await known.locator(".request-card-problem > span").evaluate(node => {
            let surface = node;
            while (getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement;
            return { color: getComputedStyle(node).color, background: getComputedStyle(surface).backgroundColor,
                adjust: getComputedStyle(node).forcedColorAdjust };
        });
        assert.ok(contrast(forced.color, forced.background) >= 4.5);
        assert.equal(forced.adjust, "auto");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await capture("forced-colors-" + theme);
    }
});
