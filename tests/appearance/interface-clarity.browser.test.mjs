import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { privateFixture } from "../support/helpers.mjs";

async function setup(t) {
    const { context, root } = await privateFixture(t);
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        search: { modelDirectory: path.join(root, "model-not-provisioned") },
        evaluation: {
            evaluatorFactory: async () => { throw new Error("Interface proof cannot run a model."); },
            readSource: async () => { throw new Error("Interface proof cannot read external sources."); },
        },
    });
    const browser = await chromium.launch();
    t.after(async () => {
        await browser.close();
        runtime.server.closeAllConnections();
        await runtime.close();
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST") writes.push(new URL(request.url()).pathname);
    });
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue() : route.abort("blockedbyclient"));
    t.after(() => assert.deepEqual(errors, []));
    async function go(hash) {
        if (page.url() === runtime.url + hash) await page.reload();
        else await page.goto(runtime.url + hash);
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        await page.evaluate(() => document.fonts.ready);
    }
    return { page, go, context, writes };
}

test("Setup presents nonzero exclusion facts without turning unavailable counts into zero", { timeout: 30000 }, async t => {
    const { page, go, writes } = await setup(t);
    let mode = "known-empty";
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), json = await response.json();
        if (mode === "mixed") Object.assign(json.exportCatalog.excluded, {
            syntheticRequestGroups: 2, duplicateEvidenceRecords: 3,
            excludedOrDuplicateEvidenceRecords: 4, unidentifiableEvidenceRecords: null,
        });
        if (mode === "missing") delete json.exportCatalog.excluded;
        await route.fulfill({ response, json });
    });
    for (const next of ["known-empty", "mixed", "missing"]) {
        mode = next;
        await go("#reports");
        await page.getByRole("button", { name: /^Activity source:/ }).click();
        const source = page.getByRole("dialog", { name: "Choose activity" });
        await source.getByText("Scope and exclusions", { exact: true }).click();
        await expect(page.locator("#scopeExclusions")).toBeVisible();
        if (next === "known-empty") {
            await expect(page.locator("#scopeExclusions")).toHaveText("No collection exclusions.");
            continue;
        }
        if (next === "missing") {
            await expect(page.locator("#scopeExclusions")).toHaveText("Collection exclusion counts unavailable.");
            continue;
        }
        assert.deepEqual(await page.locator("#scopeExclusions dl > div").evaluateAll(rows =>
            rows.map(row => [row.querySelector("dt").textContent, row.querySelector("dd").textContent])), [
            ["Synthetic request groups", "2"], ["Duplicate evidence records", "3"],
            ["Unidentifiable evidence records", "Count unavailable"],
            ["Total excluded or deduplicated evidence records", "4"],
        ]);
        await expect(page.locator("#scopeExclusions")).toContainText("Categories may overlap; do not add them.");

    }
    assert.ok(!writes.some(endpoint => ["/api/preview", "/api/privacy-review", "/api/export"].includes(endpoint)));
});
