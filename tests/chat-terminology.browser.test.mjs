import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption } from "./helpers.mjs";

const original = "Original session question.\n" + "Retain this session wording exactly. ".repeat(12);
const proof = process.env.WORKIQ_CHAT_PROOFS;
async function ready(page) {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
}
async function setup(t, title = "Historical session title") {
    const records = ["one", "two", "unnamed"].map(id => {
        const row = fixture(id);
        row.sourceSessionId = `source-${id}`;
        row.sourceSessionName = id === "unnamed" ? null : title;
        row.userPrompt.text = original;
        row.userPrompt.sourceTimestamp = row.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
        if (id !== "one") { row.projectId = null; row.project = null; }
        return row;
    });
    records[0].toolCalls.push({
        ...structuredClone(records[0].toolCalls[0]), toolCallId: "failed-call", startEventId: "failed-start",
        toolSucceeded: false, reportedOutcome: "failed", apiResults: [{ statusCode: 403, errorCode: "Original session error" }],
    });
    let cleanup;
    const { context } = await privateFixture({ after: callback => { cleanup = callback; } }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 950 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Clipboard reads prohibited in terminology proof."); },
        writeText() { throw Error("Clipboard writes prohibited in terminology proof."); },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []);
            assert.ok(posts.every(route => ["/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary", "/api/assessment/detail", "/api/assessment/overview", "/api/preview", "/api/cancel-preview"].includes(route)), "No approval, export, import, clipboard or replay");
            const after = await loadBoardState(context);
            assert.equal(after.pseudonymKey, before.pseudonymKey);
            assert.deepEqual(after.exports, before.exports);
            for (const id of Object.keys(before.cards)) assert.deepEqual(after.cards[id], before.cards[id]);
        } finally { await cleanup(); }
    });
    return { page, runtime, records, context };
}

test("chat wording across the real date, analysis, result, request, report and issue journey", { timeout: 60000 }, async t => {
    const { page, runtime } = await setup(t);
    const model = createCollectionStatus();
    const coverage = model.coverage([{ sessionId: "missing", name: "Historical session title", eligible: true }],
        [{ sessionId: "missing", errorCode: "ENOENT", error: "Original session error", lastAttemptAt: "2026-10-05T01:00:00Z" }]);
    const status = {
        revision: 1, connected: true, state: "collecting-on-interval", lastCheckedAt: "2026-10-05T01:00:00Z",
        config: { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state", pollSeconds: 5, windowDays: 30 },
        historyCoverage: coverage.summary, historyIssues: coverage.issues,
        discovery: { counts: { sessions: 3, dispositions: { eligible: 1, archived: 2 } } },
    };
    await page.route("**/api/collection/status", route => route.fulfill({ json: status }));
    await page.goto(runtime.url); await ready(page);
    assert.match(await page.locator("#pageTitle").innerText(), /Work IQ in your Copilot chats/);
    assert.match(await page.locator("#periodResult").innerText(), /3 Copilot chats \/ 3 request groups with 4 Work IQ tool calls/);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-30");
    await page.locator("#toFilter").fill("2026-09-30");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click(); await ready(page);
    await page.getByRole("link", { name: "Choose a Copilot chat", exact: true }).click(); await ready(page);
    assert.equal(await page.getByRole("searchbox", { name: "Find a Copilot chat or request group", exact: true }).count(), 1);
    const group = page.locator('[data-session-id="source-one"]');
    assert.match(await page.locator("#pageIntro").innerText(), /GitHub Copilot chats/);
    assert.deepEqual(await group.locator(".session-title").evaluate(node => [...node.children].map(child => child.textContent)),
        ["Copilot chat name", "Historical session title"]);
    assert.equal(await group.getByRole("button", { name: "Copilot chat name Historical session title", exact: true }).count(), 1);
    await group.getByRole("link", { name: "Open analysis for GitHub Copilot chat: Historical session title", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#pageTitle").innerText(), "Historical session title", "Recorded titles are not renamed");
    assert.equal(await page.locator("#pageIdentity").isVisible(), false);
    assert.equal(await page.locator("#pageTitle").textContent(), "Historical session title");
    assert.match(await page.locator("#periodResult").innerText(), /This Copilot chat: 1 request group with 2 Work IQ tool calls/);
    assert.equal(await page.getByRole("region", { name: "Copilot chat analysis", exact: true }).count(), 1);
    for (const [outcome, count] of [["success", 1], ["failure", 1]]) {
        const link = page.locator(`#sessionAnalysis .result-link[data-outcome=${outcome}]`);
        assert.match(await link.getAttribute("aria-label"), /GitHub Copilot chat Historical session title/);
        await link.hover();
        assert.match(await page.getByRole("tooltip").innerText(), /this Copilot chat and scope/);
        await page.keyboard.press("Escape");
        await link.click(); await ready(page);
        assert.equal(await page.locator(".matched-action").count(), count);
        assert.equal(new URLSearchParams(page.url().split("?")[1]).get("session"), "source-one");
    }
    assert.match(await page.locator(".action-error").innerText(), /Original session error/, "Raw error evidence stays verbatim");
    await page.locator(".matched-action").getByRole("link", { name: "View interaction" }).click(); await ready(page);
    assert.match(await page.locator("#breadcrumbs").innerText(), /Copilot chats.*GitHub Copilot chat/s);
    assert.equal(await page.locator("#breadcrumbs").getByRole("link", { name: "GitHub Copilot chat: Historical session title", exact: true }).count(), 1);
    assert.match(await page.locator(".request-intro").innerText(), /GitHub Copilot chat: Historical session title/);
    const read = page.locator(".request-original .full-text-toggle");
    if (await read.getAttribute("aria-expanded") === "false") await read.click();
    assert.equal(await page.locator(".request-original .full-text-body pre").textContent(), original);
    await page.getByRole("link", { name: "GitHub Copilot chat: Historical session title", exact: true }).click(); await ready(page);
    await page.getByRole("button", { name: "Create report for this Copilot chat", exact: true }).click();
    assert.match(await page.locator(".report-entry-context").innerText(), /Historical session title/);
    assert.equal(await page.getByRole("button", { name: "Back to Copilot chat", exact: true }).count(), 1);
    assert.equal(await page.locator("#promptOptions").isVisible(), false);
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    assert.equal(await page.locator("#reportStage2 #promptOptions").isVisible(), true);
    assert.equal(await page.locator("[name=promptMode]").count(), 3);
    assert.equal(await page.locator("#formatOptions input").count(), 4);
    await page.getByRole("button", { name: "Prepare report", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    assert.match(await page.locator("#reportScopeChoiceHelp").textContent(), /interactions you choose/);
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
    assert.equal(await page.getByRole("button", { name: "Save report", exact: true, includeHidden: true }).isDisabled(), true);
    await navigateMain(page, "settings"); await ready(page);
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    assert.match(await page.locator("#connectionTitle").locator("..").innerText(), /GitHub Copilot chat source/);
    await navigateMain(page, "collection-status");
    await page.locator(".history-reason > summary").click();
    await page.locator(".history-issue > summary").click();
    assert.match(await page.locator("#collectionIssueLabel").innerText(), /1 Copilot chat\b/);
    assert.match(await page.locator("#collectionIssueCounts").innerText(), /1 unavailable/);
    assert.match(await page.locator(".history-issue-detail").innerText(), /No evidence has been collected for this Copilot chat/);
    assert.match(await page.locator(".history-issue-identity").innerText(), /Historical session title.*Copilot chat without a project/s);
    assert.equal(await page.locator("#sourceEditor").isVisible(), false);
});

test("chat names stay primary while accessible captions preserve keyboard disclosure in both themes and enlarged narrow layouts", { timeout: 60000 }, async t => {
    const title = "Historical session title " + "longunbrokentoken".repeat(10) + " \u65e5\u672c\u8a9e \u2014 \u00e9vidence";
    const { page, runtime, records } = await setup(t, title);
    const measurements = [];
    if (proof) await mkdir(proof, { recursive: true });
    await page.goto(runtime.url + "#activity"); await ready(page);
    const group = page.locator('[data-session-id="source-one"]');
    const toggle = group.getByRole("button", { name: "Copilot chat name " + title, exact: true });
    const project = await group.locator(".project-context").textContent();
    const summary = await group.locator(".session-summary").textContent();
    const controls = await toggle.getAttribute("aria-controls");
    const describedBy = await toggle.getAttribute("aria-describedby");
    for (const theme of ["light", "dark"]) for (const width of [375, 1200]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 950 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        assert.deepEqual(await group.locator(".session-title").evaluate(node => [...node.children].map(child => child.textContent)),
            ["Copilot chat name", title], "Accessible caption precedes the exact original title");
        assert.equal(await group.locator(".session-label + .session-name.copilot-chat-name").count(), 1);
        const geometry = await group.locator(".session-title").evaluate(node => {
            const [label, name] = node.children;
            const color = document.createElement("span");
            color.style.color = "var(--copilot-chat-title)";
            node.append(color);
            const tokenColor = getComputedStyle(color).color;
            color.remove();
            return {
                clipped: [node, name].some(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1),
                captionHidden: label.classList.contains("visually-hidden"),
                titleColor: getComputedStyle(name).color, tokenColor, weight: getComputedStyle(name).fontWeight,
            };
        });
        assert.equal(geometry.clipped, false, `${theme}/${width}/${scale}: no clipped label/title`);
        assert.equal(geometry.captionHidden, true, `${theme}/${width}/${scale}: redundant caption is not displayed`);
        assert.equal(geometry.titleColor, geometry.tokenColor);
        assert.equal(geometry.weight, "600");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await group.locator(".project-context").textContent(), project);
        assert.equal(await group.locator(".session-summary").textContent(), summary);
        assert.match(summary, /1 request group with 2 Work IQ tool calls/);
        assert.equal(await toggle.getAttribute("aria-controls"), controls);
        assert.equal(await toggle.getAttribute("aria-describedby"), describedBy);
        assert.equal(await toggle.locator("svg").count(), 1);
        await toggle.focus();
        assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        await toggle.press("Enter");
        assert.equal(await toggle.getAttribute("aria-expanded"), "true");
        assert.equal(await page.locator(`[id="${controls}"]`).isVisible(), true);
        await toggle.press("Space");
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        assert.equal(await page.locator(`[id="${controls}"]`).isVisible(), false);
        measurements.push({ theme, width, scale, ...geometry });
        if (proof) await group.screenshot({ path: path.join(proof, `chat-name-${theme}-${width}-${scale}x.png`) });
    }
    await group.getByRole("link", { name: "Open analysis for GitHub Copilot chat: " + title, exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#pageIdentity").isVisible(), false);
    assert.equal(await page.locator("#pageTitle").textContent(), title);
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("session"), "source-one");
    assert.equal(records[0].sourceSessionName, title);
    if (proof) await writeFile(path.join(proof, "chat-name-bounds.json"), JSON.stringify(measurements, null, 2));
});

test("authored labels fit both themes at 375/820/1200 and 200% text; empty and unknown names stay explicit", { timeout: 120000 }, async t => {
    const { page, runtime, context, records } = await setup(t);
    const measurements = [];
    if (proof) await mkdir(proof, { recursive: true });
    for (const view of ["home", "activity", "activity?session=source-unnamed", "request?request=one", "reports", "settings"]) {
        await page.goto(runtime.url + "#" + view); await ready(page);
        if (view === "activity") {
            assert.equal(await page.locator('[data-session-id="source-unnamed"] .session-name').innerText(), "Copilot chat name not recorded");
            assert.equal(await page.locator('[data-session-id="source-two"] .project-context').innerText(), "Copilot chat without a project");
        }
        if (view === "settings") await page.getByRole("button", { name: "Review source & connect", exact: true }).click();
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const scale of [1, 2]) {
            await page.setViewportSize({ width, height: 950 });
            await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
            const clipped = await page.locator("#pageTitle,#pageIntro,#pageIdentity,#periodResult,#activityListSummary,.session-label,.session-name,#sourceEditor label,#createSessionReport,#pageAction,.session-toggle,.session-drill,.report-entry-actions button").evaluateAll(nodes =>
                nodes.filter(node => !node.closest(".visually-hidden") && node.checkVisibility() && (node.scrollWidth > node.clientWidth + 2 || node.scrollHeight > node.clientHeight + 2))
                    .map(node => ({ id: node.id, cls: node.className, text: node.textContent })));
            assert.deepEqual(clipped, [], `${view}/${theme}/${width}/${scale}`);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            measurements.push({ view, theme, width, scale, clipped: clipped.length });
            if (proof && (scale === 1 || width === 375)) {
                await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
                await page.screenshot({ path: path.join(proof, `${view.replaceAll(/[?=]/g, "-")}-${theme}-${width}-${scale}x.png`), fullPage: true });
            }
        }
    }
    await page.goto(runtime.url + "#home?from=2027-01-01&to=2027-01-02"); await ready(page);
    assert.match(await page.locator("#periodResult").innerText(), /0 Copilot chats \/ 0 request groups with 0 Work IQ tool calls/);
    assert.equal(await page.locator("#pageAction").isVisible(), false);
    const unknown = fixture("unknown");
    unknown.sourceSessionId = null; unknown.sourceSessionName = null; unknown.projectId = null; unknown.project = null;
    await replaceEvidence(context, () => ({ records: [...records, unknown], importCoverage: { counts: {}, roster: [] } }));
    await page.goto(runtime.url + "#request?request=unknown"); await ready(page);
    assert.match(await page.locator(".request-intro").innerText(), /Source Copilot chat not recorded/);
    assert.equal(await page.locator("#breadcrumbs").getByRole("link", { name: /GitHub Copilot chat/ }).count(), 0);
    assert.match(await page.locator(".request-intro .project-context").innerText(), /Project not recorded/);
    if (proof) await writeFile(path.join(proof, "label-bounds.json"), JSON.stringify(measurements, null, 2));
});
