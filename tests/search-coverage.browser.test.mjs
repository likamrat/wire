import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, unlink } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords, streamPanel } from "./live-search-fixture.mjs";
import { selectActivityOption } from "./helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createSearchWireContract, searchWireContract } from "../lib/search-wire-contract.mjs";

const analyticalTypes = ["action", "context", "interaction", "reply"];
test("coverage uses explicit affected types and fails closed for relevant or unclassified issues", () => {
    const factory = new Function("return (" + createSearchWireContract.toString() + ")")();
    const serialized = factory({ matchPolicyId: searchWireContract.matchPolicyId, types: searchWireContract.allTypes });
    for (const contract of [searchWireContract, serialized]) {
        const partial = types => ({ state: "partial", issues: [{ sourceId: "invented", code: "missing", types }] });
        assert.equal(contract.completeCoverage({ state: "ready", issues: [] }, analyticalTypes), true);
        for (const types of [["report"], ["report", "comparison"], ["setting"], ["tool", "service"]]) {
            assert.equal(contract.completeCoverage(partial(types), analyticalTypes), true);
            assert.equal(contract.completeCoverage(partial(types), contract.allTypes), false);
        }
        for (const types of [["interaction"], ["context"], ["reply"], ["action"], ["report", "reply"],
            undefined, [], ["unknown"], ["report", "report"]]) {
            assert.equal(contract.completeCoverage(partial(types), analyticalTypes), false);
        }
        for (const corpus of [{ state: "unavailable" }, { state: "stale" }, { state: "partial", issues: [] },
            { state: "partial" }, { state: "ready", issues: [{ types: ["reply"] }] }]) {
            assert.equal(contract.completeCoverage(corpus, analyticalTypes), false);
        }
        for (const types of [undefined, [], ["unknown"]]) {
            assert.equal(contract.completeCoverage({ state: "ready", issues: [] }, types), false);
        }
    }
});
async function corruptedReportFixture(t) {
    const records = searchRecords(3);
    for (const index of [0, 1]) {
        records[index].userPrompt.text = "The physician treated an injured patient in the hospital.";
        records[index].followUpPrompts = [];
        records[index].capturedAt = index ? "2026-09-30T12:00:00.000Z" : "2026-09-29T12:00:00.000Z";
        records[index].toolCalls[0].startedAt = records[index].capturedAt;
        records[index].httpRecords[0].startedAt = records[index].capturedAt;
    }
    const app = await searchFixture(t, { records, formats: ["html"] });
    await appendFile(app.bundles[0].files["product-report.html"], "\nUnapproved changed report bytes.");
    return app;
}

test("normal Analyze search remains usable when only an unrelated report is corrupt", { timeout: 30000 }, async t => {
    const cleanups = [], app = await corruptedReportFixture({ after: action => cleanups.push(action) });
    const browser = await chromium.launch(), page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); for (const cleanup of cleanups) await cleanup(); });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#wireSearch").fill("physician");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches across all pages.", { timeout: 15000 });
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText("2");
    await expect(page.locator("#wireSearchRelated")).toHaveCount(0);
    await selectActivityOption(page, "wireSearchScope", "everywhere");
    await expect(page.locator("#wireSearchCoverage")).toContainText("Some saved content is unavailable.");
    await expect(page.locator("#wireAnalysisSearchNotice")).toBeHidden();
    await expect(page.locator("#activityCount")).toHaveText("3");
    await page.locator("#wireSearch").fill("lab results");
    await expect(page.locator("#wireSearchResults")).toContainText("Only part of this text was saved.");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches across all pages.");
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#wireSearchResults")).toContainText("Only part of this text was saved.");
    assert.deepEqual(errors, []);
});

test("type-scoped analytical coverage reaches both periods and reports but fails on relevant missing text", { timeout: 40000 }, async t => {
    const app = await corruptedReportFixture(t), panel = await streamPanel(app.runtime, { purpose: "analysis" });
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "physician", requestId: 0, types: analyticalTypes });
    const result = await panel.wait(event => event.event === "results" && event.requestId === 0);
    assert.equal(result.status.corpus.state, "partial", "Global navigation coverage must stay honest.");
    assert.ok(result.status.corpus.issues.every(issue => issue.types.length === 1 && issue.types[0] === "report"));
    assert.equal(searchWireContract.completeCoverage(result.status.corpus, analyticalTypes), true);
    assert.equal(searchWireContract.validResults(result), true);
    assert.deepEqual(result.matches.hits.map(hit => hit.target.href).sort(), ["#request?request=search-0", "#request?request=search-1"]);
    const state = await loadBoardState(app.context);
    const input = receipt => ({
        schemaVersion: 1, expectedRevision: state.revision,
        options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-29", to: "2026-09-29" }, later: { from: "2026-09-30", to: "2026-09-30" } },
        semanticSelection: { receipt }, withinServices: [],
    });
    const compared = await panel.api("/api/period-comparison", input(result.matches.receipt));
    assert.equal(compared.code, 200, compared.body.error);
    assert.deepEqual(compared.body.periods.baseline.scenarioIds, ["search-0"]);
    assert.deepEqual(compared.body.periods.later.scenarioIds, ["search-1"]);
    const preview = await panel.api("/api/preview", {
        periodComparison: compared.body, semanticSelection: { receipt: result.matches.receipt },
        options: { promptMode: "none", formats: ["json"], timeContext: compared.body.timeContext },
    });
    assert.equal(preview.code, 200, preview.body.error);
    assert.equal(preview.body.snapshot.periodComparison.periods.baseline.rows.length, 1);
    assert.equal(preview.body.snapshot.periodComparison.periods.later.rows.length, 1);
    await panel.api("/api/cancel-preview", { previewId: preview.body.previewId });
    await panel.api("/api/search/query", { query: "physician", requestId: 1 });
    const allTypes = await panel.wait(event => event.event === "results" && event.requestId === 1);
    assert.equal((await panel.api("/api/period-comparison", input(allTypes.matches.receipt))).code, 428,
        "A request including the corrupt report must not silently shrink its requested types.");
    await replaceEvidence(app.context, records => ({
        records: records.map((record, index) => index === 2 ? { ...record, userPrompt: { ...record.userPrompt, text: null, status: "unavailable" } } : record),
        importCoverage: state.importCoverage,
    }));
    app.runtime.search.invalidate();
    await panel.api("/api/search/query", { query: "physician", requestId: 2, types: analyticalTypes });
    const missing = await panel.wait(event => event.event === "results" && event.requestId === 2);
    const current = await loadBoardState(app.context);
    assert.equal((await panel.api("/api/period-comparison",
        { ...input(missing.matches.receipt), expectedRevision: current.revision })).code, 428,
        "Missing activity outside the matching rows still prevents complete analytical membership.");
    assert.ok(missing.status.corpus.issues.some(issue => issue.code === "text-unavailable" && issue.types.includes("interaction")));
});

test("missing authorized replies still block analytical coverage despite complete matching activity", { timeout: 20000 }, async t => {
    const app = await searchFixture(t);
    const state = await loadBoardState(app.context);
    await unlink(path.join(app.context.dataDir, "assessment-evidence", state.personalEvaluation.captures[0].payloadFile));
    const panel = await streamPanel(app.runtime, { purpose: "analysis" });
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "physician", requestId: 0, types: analyticalTypes });
    const result = await panel.wait(event => event.event === "results");
    assert.ok(result.matches.total > 0);
    assert.ok(result.status.corpus.issues.some(issue => issue.types.includes("reply")));
    assert.equal(searchWireContract.completeCoverage(result.status.corpus, analyticalTypes), false);
    const compared = await panel.api("/api/period-comparison", {
        schemaVersion: 1, expectedRevision: state.revision,
        options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-29", to: "2026-09-29" }, later: { from: "2026-09-30", to: "2026-09-30" } },
        semanticSelection: { receipt: result.matches.receipt }, withinServices: [],
    });
    assert.equal(compared.code, 428);
});
