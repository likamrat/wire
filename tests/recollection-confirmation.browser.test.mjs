import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, rename } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { navigateMain, navigateSettings } from "./helpers.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";

for (const [change, title] of [
    ["unrelated", "accepts an unrelated Copilot metadata edit"],
    ["selected", "explains a changed selected mapping without calling it uncertain"],
    ["replacement", "refuses a replacement database with identical mappings"],
    ["expiry", "retires an expired decision without sending a confirmation"],
]) {
    test(`recovery confirmation ${title}`, async t => {
        const f = await recollectionFixture(t);
        await f.collector.setEnabled(true);
        await f.stop();
        const timestamp = `${f.firstDay}T14:00:00.000Z`;
        await appendFile(f.files[0], [
            { id: "new-prompt", type: "user.message", data: { content: "Check one invented item." } },
            { id: "new-start", type: "tool.execution_start", data: { toolCallId: "new-call", toolName: "workiq-fetch", arguments: { entityUrls: ["/me/messages"] } } },
            { id: "new-end", type: "tool.execution_complete", data: { toolCallId: "new-call", success: true } },
        ].map(e => JSON.stringify({ ...e, timestamp }) + "\n").join(""));
        let access, runtime, browser;
        try {
            runtime = await startServer(f.context, createExportController(f.context), { port: 0,
                frontend: "bundled", collector: { timers: false }, createAccess: async () => access = await createCopilotRuntimeAccess(f.context) });
            browser = await chromium.launch();
            const page = await browser.newPage({ reducedMotion: "reduce", timezoneId: "UTC" });
            await page.route("**/*", route => new URL(route.request().url()).origin === new URL(runtime.url).origin ? route.continue() : route.abort());
            await page.goto(runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
            await navigateMain(page, "settings"); await navigateSettings(page, "data");
            await page.locator("#recollectActivity").click();
            await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
            await page.locator("#recollectFrom").fill(f.firstDay); await page.locator("#recollectTo").fill(f.firstDay);
            const response = action => page.waitForResponse(r => new URL(r.url()).pathname === "/api/recollection/" + action);
            if (change === "expiry") await page.route("**/api/recollection/preview", async route => {
                const res = await route.fetch(), body = await res.json();
                await route.fulfill({ response: res, json: { ...body, expiresAt: new Date(Date.now() + 250).toISOString() } });
            });
            const previewed = response("preview");
            await page.locator("#recollectPreview").click();
            const preview = await (await previewed).json();
            assert.equal(preview.counts.newRecords, 1);
            if (change === "expiry") {
                await expect(page.locator("#recollectStatus")).toContainText("The preview expired. Nothing was saved.");
                await expect(page.locator("#recollectConfirm")).toBeHidden();
                assert.equal((await loadBoardState(f.context)).recollection?.operations?.[preview.operationId], undefined);
                return;
            }
            if (change === "replacement") {
                await copyFile(f.dbPath, f.dbPath + ".replacement");
                await rename(f.dbPath + ".replacement", f.dbPath);
            } else {
                const db = new DatabaseSync(f.dbPath);
                try { db.prepare("UPDATE sessions SET title=? WHERE id=?").run("Renamed invented chat", change === "selected" ? f.sourceId : f.otherSourceId); }
                finally { db.close(); }
            }
            const confirmed = response("confirm");
            await page.locator("#recollectConfirm").click();
            const res = await confirmed, body = await res.json();
            const refused = change !== "unrelated";
            assert.equal(res.status(), refused ? 409 : 200, JSON.stringify(body));
            const state = await loadBoardState(f.context), mark = state.recollection?.operations?.[preview.operationId];
            const added = state.evidence.flatMap(r => r.toolCalls).filter(c => c.toolCallId === "new-call");
            if (refused) {
                assert.equal(mark, undefined); assert.equal(added.length, 0);
                assert.equal(body.code, "RECOLLECTION_SELECTION_CHANGED");
                assert.deepEqual(body.recollection, { operationId: preview.operationId, outcome: "not-saved" });
                await expect(page.locator("#recollectStatus")).toContainText("selected chat");
                await expect(page.locator("#recollectStatus")).toContainText("Nothing was saved");
                await expect(page.locator("#recollectCheck")).toBeHidden();
            } else {
                assert.equal(mark.phase, "complete"); assert.equal(added.length, 1);
                assert.equal(added[0].recollection.operationId, preview.operationId);
                await expect(page.locator("#recollectTitle")).toHaveText("1 record read again");
            }
        } finally { await browser?.close(); await runtime?.close(); await access?.close(); }
    });
}
