import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { diagnosticRecords } from "./diagnostic-bundles-fixture.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { executeAction, startServer } from "../lib/server.mjs";
import { loadBoardState, resolveDataDir } from "../lib/store.mjs";
import { contrast, visibleInk } from "./color-measurements.mjs";

async function fixtureServer(t, frontend) {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, diagnosticRecords());
    t.after(async () => { for (const fn of cleanup.reverse()) await fn(); });
    const access = await createCopilotRuntimeAccess(context);
    cleanup.push(() => access.close());
    const server = await startServer(context, createExportController(context), { port: 0, frontend, access, collector: { timers: false } });
    cleanup.push(() => server.close());
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.setFixedTime(new Date("2026-11-20T12:00:00Z"));
    return { context, server, page, errors };
}

test("Package these failures previews, saves locally and opens the verified bundle in Reports", { timeout: 120000 }, async t => {
    const { context, server, page, errors } = await fixtureServer(t, "bundled");
    const proofs = process.env.WIRE_DIAGNOSTIC_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    const before = await loadBoardState(context);
    await page.goto(server.url + "#analyze?range=custom&from=2026-11-16&to=2026-11-19");
    const trigger = page.getByRole("button", { name: "Package these failures" });
    await expect(trigger).toBeVisible();
    await expect(page.locator(".analyze-outcome-summary #diagnosticPackageAction")).toBeVisible();

    await trigger.click();
    const sheet = page.getByRole("dialog", { name: "Package these failures" });
    await expect(sheet.getByText("9 of 23 Work IQ tool calls failed, in 5 failure groups.", { exact: false })).toBeVisible();
    await expect(sheet.locator(".diagnostic-cluster").first()).toContainText("workiq-fetch on /me/messages");
    await expect(sheet.locator(".diagnostic-cluster").first()).toContainText("HTTP 403");
    await expect(sheet.locator(".diagnostic-cluster").first()).toContainText("Access is denied. Check credentials and try again.");
    await expect(sheet.locator(".diagnostic-cluster").first().locator(".percentage-value")).toHaveText("33.3% (3)");
    await expect(sheet.getByText("Nothing is sent or uploaded.", { exact: false })).toHaveCount(1);
    await expect(sheet.getByRole("radio", { name: /Complete/ })).toBeChecked();
    await expect(sheet.getByText(/No failure rate: WIRE doesn.t keep the replies/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
    assert.deepEqual(await readdir(resolveDataDir(context)).then(names => names.includes("diagnostics")), false, "Preview writes nothing");

    await trigger.click();
    await sheet.getByRole("radio", { name: /External/ }).check();
    await expect(sheet.getByRole("radio", { name: /External/ })).toBeChecked();
    await expect(sheet.getByRole("button", { name: "Save bundle" })).toBeEnabled();
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
        const ink = await page.evaluate(visibleInk);
        const scoped = await page.evaluate(() => [...document.querySelectorAll("#diagnosticPackageSheet *")].map(node => node.id || node.tagName + "." + node.className));
        const owned = new Set(scoped);
        const checked = ink.filter(row => owned.has(row.target));
        assert.ok(checked.length > 20, `${theme}: package preview text measured`);
        assert.deepEqual(checked.filter(row => contrast(row.ink, row.background) < 4.5), [], `${theme} package preview text contrast`);
        if (proofs) await page.screenshot({ path: path.join(proofs, `package-preview-${theme}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset.evidenceTheme = "light"; });
    await sheet.getByRole("button", { name: "Save bundle" }).click();
    await expect(sheet.getByText("Bundle saved on this device.")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Open in Reports" })).toBeFocused();

    const { bundles } = await executeAction(context, {}, "test", "get_diagnostic_bundles", {});
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].profile, "external");
    const opened = await executeAction(context, {}, "test", "get_diagnostic_bundle", { bundleId: bundles[0].bundleId });
    const throttled = opened.clusters.find(cluster => cluster.errorCodes.includes("TooManyRequests"));
    await executeAction(context, {}, "test", "record_diagnostic_audit_result", { bundleId: bundles[0].bundleId, clusterId: throttled.id,
        verdict: "infra-transient", workItemUrl: "https://dev.azure.example/items/42" });

    await sheet.getByRole("button", { name: "Open in Reports" }).click();
    const reader = page.locator("#diagnosticBundleReader");
    await expect(reader.getByRole("heading", { name: "Work IQ failures, Nov 16–19, 2026" })).toBeVisible();
    await expect(reader.locator(".saved-markdown h1")).toContainText("MCP diagnostic");
    const audited = reader.locator(".diagnostic-cluster", { hasText: "TooManyRequests" });
    await expect(audited).toContainText("Audit: Transient infrastructure");
    await expect(audited.getByRole("link", { name: /Work item/ })).toHaveAttribute("href", "https://dev.azure.example/items/42");
    await expect(reader.locator(".diagnostic-cluster", { hasText: "ErrorAccessDenied" })).toContainText("No audit result recorded.");
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
        const ink = await page.evaluate(visibleInk);
        const owned = new Set(await page.evaluate(() => [...document.querySelectorAll("#diagnosticBundleReader > :not(.diagnostic-report) *")]
            .map(node => node.id || node.tagName + "." + node.className)));
        const checked = ink.filter(row => owned.has(row.target) && !row.code);
        assert.ok(checked.length > 20, `${theme}: bundle reader text measured`);
        assert.deepEqual(checked.filter(row => contrast(row.ink, row.background) < 4.5), [], `${theme} bundle reader text contrast`);
        if (proofs) await page.screenshot({ path: path.join(proofs, `reports-reader-${theme}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.dataset.evidenceTheme = "light"; });

    await reader.getByRole("button", { name: "Back to saved reports" }).click();
    const open = page.getByRole("button", { name: "Open Work IQ failures, Nov 16–19, 2026" });
    await expect(open).toBeFocused();
    const row = page.locator(".diagnostic-library-row");
    await expect(row).toContainText("23 tool calls · Failed 39.1% (9)");
    await expect(row).toContainText("Complete · External · 1 of 5 groups audited");
    if (proofs) await page.screenshot({ path: path.join(proofs, "reports-library.png") });

    await row.getByRole("button", { name: /^Delete Work IQ failures/ }).click();
    const confirm = page.getByRole("dialog", { name: "Delete diagnostic bundle" });
    await expect(confirm).toContainText("Saved reports, report drafts and collected activity stay.");
    await page.keyboard.press("Escape");
    await expect(row.getByRole("button", { name: /^Delete Work IQ failures/ })).toBeFocused();
    await row.getByRole("button", { name: /^Delete Work IQ failures/ }).click();
    await confirm.getByRole("button", { name: "Delete bundle" }).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator("#diagnosticBundles")).toBeHidden();
    assert.deepEqual((await executeAction(context, {}, "test", "get_diagnostic_bundles", {})).bundles, []);
    const after = await loadBoardState(context);
    assert.deepEqual(after.exports, before.exports);
    assert.equal(after.evidence.length, before.evidence.length);
    assert.deepEqual(errors, []);
});

test("Reports refuses an altered bundle and the React renderer offers the same Analyze action", { timeout: 90000 }, async t => {
    const { context, server, page, errors } = await fixtureServer(t, "react");
    const saved = await executeAction(context, {}, "test", "save_diagnostic_bundle", { from: "2026-11-16", to: "2026-11-19",
        timeContext: { timeZone: "UTC", locale: "en-US" } });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(saved.files.report, "\nChanged after Save.\n");
    await page.goto(server.url + "#analyze?range=custom&from=2026-11-16&to=2026-11-19");
    await expect(page.getByRole("button", { name: "Package these failures" })).toBeVisible();
    await page.goto(server.url + "#reports?task=library");
    await page.getByRole("button", { name: "Open Work IQ failures, Nov 16–19, 2026" }).click();
    const reader = page.locator("#diagnosticBundleReader");
    await expect(reader.getByRole("heading", { name: "WIRE won't open this bundle" })).toBeVisible();
    await expect(reader.getByRole("alert")).toContainText("report.md was modified");
    await expect(reader.locator(".saved-markdown")).toHaveCount(0);
    assert.deepEqual(errors, []);
});
