import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { privateFixture } from "../support/helpers.mjs";
import { callInvestigationRecords } from "../reader/call-investigation-fixture.mjs";

test("non-tool records with unrecognized targets do not inherit the tool call’s Files identity", async t => {
    const record = callInvestigationRecords()[1];
    record.toolCalls = [record.toolCalls[10]];
    record.graphActivities = [record.graphActivities[0], record.graphActivities.at(-1)].map((row, index) => ({
        ...row, activityId: "label-owner-graph-" + index, workload: "Unknown",
        endpoint: { ...row.endpoint, path: "/unrecognized/target", label: "GET v1.0 /unrecognized/target" },
    }));
    record.httpRecords = [record.httpRecords[0]];
    record.httpRecords[0].responsePath = { path: "/unrecognized/target", query: [] };
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw Error("No providers in label-owner proof."); },
            readSource() { throw Error("No source reads in label-owner proof."); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close(); assert.deepEqual(await loadBoardState(context), before);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url + "#request?" + new URLSearchParams({request: record.scenarioId}));
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const reader = page.locator("#requestContent");
    for (const type of ["Direct Graph request site", "Explicit HTTP recorder", "Graph code reference"]) {
        const row = reader.locator(".reader-call-row").filter({has: page.locator(".reader-record-name").filter({hasText:type})});
        await expect(row).toHaveCount(1);
        const toggle = row.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        await expect(row).toContainText("/unrecognized/target");
        await expect(row).not.toContainText("Files");
        if (type === "Graph code reference") await expect(row).toContainText("Execution not observed");
    }
    await expect(reader.locator(".reader-call-services")).toContainText("Files");
});
