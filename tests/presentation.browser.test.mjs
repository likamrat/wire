import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { exportCatalogFor, openActivitySessions } from "./helpers.mjs";
import { reportContents } from "./report-journey-helpers.mjs";

test("synthetic report review is explicit, separate, and cannot execute markup", { timeout: 30000 }, async () => {
    const scenario = {
        scenarioId: "synthetic-request", sourceSessionId: "synthetic-session", sourceHost: "copilot-app",
        sourceSessionName: "Synthetic calendar exercise", project: "Synthetic fixtures",
        projectId: "synthetic-project", isLegacy: false, capturedAt: "2026-01-10T12:00:00Z",
        workflowState: "ready_to_export", userPrompt: { text: "SYNTHETIC ONLY: Find calendar entries.", status: "verbatim", provenance: "synthetic" },
        toolCalls: [{ tool: "workiq-fetch", toolCallId: "synthetic-call", requestedApiPath: "/me/events", requestArgs: { path: "/me/events" }, toolSucceeded: true, reportedOutcome: "succeeded", startedAt: "2026-01-10T12:00:00Z", apiResults: [] }],
    };
    const state = { boardId: "synthetic-board", revision: 1, scenarios: [scenario], exports: [], coverage: { since: "2026-01-01", until: "2026-01-31", notes: [] } };
    const requests = [];
    const preview = {
        previewId: "synthetic-preview", records: [{}],
        privacy: { allSelectedFieldsScanned: true, reviewerConfirmed: false, originatingPrompts: 1, followUpPrompts: 0, toolArgumentObjects: 1, stringsScanned: 1, categories: {}, transformation: "Synthetic technical projection.", limitations: ["Synthetic test, not human approval."] },
        files: { "product-report.md": "# Synthetic report\n\n## Calls\n\n| Path | Count |\n|---|---:|\n| /me/events | 1 |\n\n<details>\n<summary>Notes</summary>\n\n- Synthetic only\n\n</details>\n\n<script>globalThis.injected=true</script>" },
    };
    const contractModule = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    const server = createServer(async (req, res) => {
        const json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
        if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
            res.setHeader("Content-Type", "text/javascript; charset=utf-8");
            res.end(contractModule); return;
        }
        if (req.method === "GET" && req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end(renderHtmlShell("a".repeat(64), "synthetic-nonce")); return; }
        if (req.method !== "POST") { res.statusCode = 404; return json({ error: "Unsupported synthetic route." }); }
        let text = ""; for await (const chunk of req) text += chunk;
        const input = JSON.parse(text);
        if (req.url === "/api/snapshot") return json({ ...state, exportCatalog: exportCatalogFor(state.scenarios), analytics: { ...buildActivityAnalytics(state.scenarios, input), revision: state.revision } });
        if (req.url === "/api/preview") return json(preview);
        if (req.url === "/api/privacy-review") {
            requests.push({ path: req.url, input });
            assert.equal(input.disclosureReviewed, true);
            preview.privacy.reviewerConfirmed = true;
            return json(preview);
        }
        if (req.url === "/api/export") {
            requests.push({ path: req.url, input });
            assert.equal(preview.privacy.reviewerConfirmed, true);
            assert.equal(input.confirmed, true);
            const bundle = { bundleId: "synthetic-bundle", bundleDir: "SYNTHETIC: no files written", files: { "product-report.md": "synthetic-only" } };
            state.exports.push(bundle);
            state.revision += 1;
            return json({ bundle, state });
        }
        res.statusCode = 404; return json({ error: "Unsupported synthetic route." });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
        page.setDefaultTimeout(10000);
        const origin = `http://127.0.0.1:${server.address().port}`;
        const moduleResponse = await page.request.get(origin + "/assets/assessment-contract.mjs");
        assert.equal(moduleResponse.status(), 200);
        assert.match(moduleResponse.headers()["content-type"], /^text\/javascript/);
        assert.equal(await moduleResponse.text(), contractModule);
        assert.equal((await page.request.get(origin + "/unsupported")).status(), 404);
        await page.goto(origin + "/#activity");
        await page.locator(".session-toggle").waitFor();
        await openActivitySessions(page);
        await page.locator("#activityList input").check();
        await page.locator("nav [data-nav=reports]").click();
        await reportContents(page);
        await page.locator("#exportBtn").click();
        await page.locator(".attestation input").waitFor();
        assert.equal(await page.getByRole("button", { name: "3. Save locally", exact: true }).isDisabled(), true);
        await page.locator(".report-document > details > summary").first().click();
        assert.equal(await page.locator(".report-document table").count(), 1);
        assert.equal(await page.locator(".report-document script").count(), 0);
        assert.equal(await page.evaluate(() => globalThis.injected), undefined);
        assert.equal((await page.locator(".report-document").innerText()).includes("<summary>"), false);
        await page.locator(".attestation input").check();
        assert.equal(await page.getByRole("button", { name: "3. Save locally", exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
        await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
        assert.equal(requests.length, 1);
        assert.deepEqual(state.exports, [], "Disclosure review alone cannot register a saved report");
        await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
        await page.waitForFunction(() => ["saved", "unavailable", "blocked"].includes(document.querySelector("#reportsView")?.dataset.reportPhase));
        assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "saved", await page.locator("#reportStage3").innerText());
        assert.deepEqual(requests.map((item) => item.path), ["/api/privacy-review", "/api/export"]);
        assert.equal(requests[1].input.previewId, "synthetic-preview");
        assert.deepEqual(state.exports.map(bundle => bundle.bundleId), ["synthetic-bundle"]);
        assert.equal(await page.locator("#reportStage3 .report-saved-id").textContent(), "synthetic-bundle");
    } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});
