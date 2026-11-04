import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";

const longProject = "Invented coastal research workspace for shared release planning, cross-team evidence review and preserving the exact reading position across both comparison periods";

function comparisonRecords(qualified) {
    const titles = ["Find the release notes", "Check the team handover", "Review the project schedule",
        "Find the design decision", "Prepare the weekly update", "Follow up on open questions"];
    return Array.from({ length: 12 }, (_, index) => {
        const record = fixture(`comparison-study-${index}`);
        const later = index >= 6, started = Date.UTC(2026, 3, (later ? 14 : 7) + index % 6, 14);
        record.title = titles[index % 6];
        record.sourceSessionId = `comparison-study-chat-${index % 3}`;
        record.sourceSessionName = ["Release preparation", "Project planning", "Team updates"][index % 3];
        record.projectId = "comparison-study";
        record.project = qualified ? longProject : "Demo workspace";
        record.capturedAt = new Date(started).toISOString();
        record.userPrompt = { text: titles[index % 6] + " and show the relevant sources.", status: "full",
            sourceEventId: `study-prompt-${index}`, sourceTimestamp: new Date(started).toISOString(),
            authorship: { actor: index % 4 === 0 ? "agent" : "user", basis: index % 4 === 0 ? "source-agent" : "source-user" } };
        record.followUpPrompts = [];
        record.toolCalls = Array.from({ length: 4 }, (_, callIndex) => {
            const ordinal = index % 6 * 4 + callIndex;
            const missing = later ? [5, 17, 22].includes(ordinal) : ordinal === 22;
            const outcome = ordinal < (later ? 4 : 3) ? "failed" : ordinal === 20 ? "partial"
                : later && ordinal === 23 ? "unknown" : "succeeded";
            const duration = missing ? null : later ? ordinal >= 19 ? 4800 : 800 + ordinal * 30 : 1400 + ordinal * 45;
            const apiPath = callIndex === 3 ? "/me/calendarView" : callIndex === 2 ? "/me/messages" : "/me/drive/root";
            return { tool: "workiq-fetch", toolCallId: `study-call-${index}-${callIndex}`,
                startEventId: `study-start-${index}-${callIndex}`, completionEventId: `study-end-${index}-${callIndex}`,
                startedAt: new Date(started + callIndex * 5000).toISOString(),
                ...(duration === null ? {} : { durationMs: duration, completedAt: new Date(started + callIndex * 5000 + duration).toISOString() }),
                requestArgs: { entityUrls: [apiPath] }, reportedOutcome: outcome,
                toolSucceeded: outcome === "succeeded" ? true : outcome === "failed" ? false : null,
                apiResults: [{ index: 0, path: apiPath, statusCode: outcome === "failed" ? 503 : 200 }],
                observedGraphHttp: false };
        });
        return record;
    });
}

for (const qualified of [false, true]) for (const motion of ["reduce", "no-preference"]) test(`late Period B Close and Back restore the exact origin (${motion}${qualified ? ", accepted restrictions" : ""})`, async t => {
    const cleanups = [];
    const { context } = await privateFixture({ after: fn => cleanups.push(fn) }, comparisonRecords(qualified));
    const beforeState = await loadBoardState(context), errors = [], denied = [];
    const server = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw Error("Provider work is forbidden in comparison return proof."); },
            readSource() { throw Error("Source reads are forbidden in comparison return proof."); },
        } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close();
            await server.close();
            assert.deepEqual(errors, []);
            assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), beforeState);
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    const page = await browser.newPage({ viewport: { width: 1408, height: 895 }, reducedMotion: motion });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(server.url).origin && (request.method() === "GET" || [
            "/api/session", "/api/session/release", "/api/snapshot", "/api/collection/status",
            "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary",
            "/api/evaluation/automatic/status", "/api/period-comparison",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname);
        return route.abort();
    });
    await page.goto(server.url + "#analyze?range=custom&from=2026-04-14&to=2026-04-20");
    await page.locator("#workspace[aria-busy=false]").waitFor();
    await page.locator("#comparePeriods").click();
    for (const [id, value] of Object.entries({ comparisonAFrom: "2026-04-07", comparisonATo: "2026-04-13",
        comparisonBFrom: "2026-04-14", comparisonBTo: "2026-04-20" })) await page.locator("#" + id).fill(value);
    if (qualified) {
        await page.locator("#openAnalyzeFilters").click();
        await selectActivityOption(page, "toolFilter", "workiq-fetch");
        await page.locator("#workspace[aria-busy=false]").waitFor();
        await selectActivityOption(page, "projectFilter", "comparison-study");
        await page.locator("#workspace[aria-busy=false]").waitFor();
        await closeAnalyzeFilters(page);
    }
    await page.locator("#applyPeriodComparison").click();
    await page.locator("#createPeriodReport:visible").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const caption = page.locator("#comparisonAcceptedScope");
    if (qualified) {
        await expect(caption).toHaveText(`Tool: workiq-fetch; Copilot project: ${longProject}`);
        assert.ok(await caption.evaluate(node => node.clientHeight > parseFloat(getComputedStyle(node).lineHeight)),
            "Accepted restrictions add real wrapped height before the reader captures its origin");
    }
    await page.locator("#comparisonRecordsB").click();
    const target = page.locator("#comparisonExactRecordsB a.text-link").last();
    const position = () => page.evaluate(() => ({
        y: scrollY, focus: document.activeElement.id, tag: document.activeElement.tagName,
        href: document.activeElement.getAttribute("href"),
        inner: document.getElementById("comparison-record-scroll-B").scrollTop,
        selected: document.getElementById("comparisonRecordsB").getAttribute("aria-selected"),
    }));
    for (const action of motion === "reduce" ? ["close", "back"] : ["close", "back", "newer-input"]) {
        await target.scrollIntoViewIfNeeded();
        await target.focus();
        const before = await position();
        assert.equal(before.focus, 'comparison-record-B-call:["comparison-study-chat-2","study-call-8-3"]');
        assert.ok(before.inner > 0);
        const box = await target.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.locator("#contextSidebar:visible").waitFor();
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations({ subtree: true })
            .every(animation => animation.playState !== "running"));
        if (action === "newer-input") await page.evaluate(() => {
            window.comparisonExitPaused = false;
            const pane = document.getElementById("contextSidebar");
            const observer = new MutationObserver(() => {
                if (!pane.inert || !pane.open) return;
                for (const node of [pane, document.getElementById("main")]) {
                    for (const animation of node.getAnimations()) animation.pause();
                }
                window.comparisonExitPaused = true;
                observer.disconnect();
            });
            observer.observe(pane, { attributes: true, attributeFilter: ["inert"] });
        });
        if (action === "back") await page.goBack();
        else await page.locator("#closeContextSidebar").click();
        let intent;
        if (action === "newer-input") {
            await page.waitForFunction(() => window.comparisonExitPaused);
            await page.keyboard.press("Tab");
            await page.locator("#createPeriodReport").focus();
            intent = await position();
            assert.equal(intent.focus, "createPeriodReport");
            assert.notEqual(intent.focus, before.focus, "The new keyboard action owns focus.");
            await page.evaluate(() => {
                for (const node of [document.getElementById("contextSidebar"), document.getElementById("main")]) {
                    for (const animation of node.getAnimations()) animation.play();
                }
            });
        }
        await page.locator("#contextSidebar").waitFor({ state: "hidden" });
        await page.locator("#createPeriodReport:visible").waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (qualified) await expect(caption).toHaveText(`Tool: workiq-fetch; Copilot project: ${longProject}`);
        const after = await position();
        if (process.env.WIRE_COMPARISON_RETURN_PROOFS) {
            await mkdir(process.env.WIRE_COMPARISON_RETURN_PROOFS, { recursive: true });
            const name = `late-b-${motion}-${action}${qualified ? "-qualified" : ""}`;
            await writeFile(path.join(process.env.WIRE_COMPARISON_RETURN_PROOFS, name + ".json"),
                JSON.stringify({ syntheticOnly: true, noStudyOverlay: true, before, intent, after }, null, 2));
            await page.screenshot({ path: path.join(process.env.WIRE_COMPARISON_RETURN_PROOFS, name + ".png") });
        }
        if (intent) {
            for (const field of ["focus", "tag", "href"]) assert.equal(after[field], intent[field]);
        } else assert.deepEqual(after, before);
    }
});
