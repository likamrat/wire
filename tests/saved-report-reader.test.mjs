import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, symlink, rename, unlink, truncate } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixture, privateFixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedReportDocument, reportHash } from "../lib/report-artifacts.mjs";
import * as reportArtifacts from "../lib/report-artifacts.mjs";
import { artifactDeletionKey } from "../lib/deletion-identities.mjs";
import { chooseReportScope, reportContents, scanReport, openReportLibrary } from "./report-journey-helpers.mjs";

async function save(exports, context, formats = ["html", "json"]) {
    const state = await loadBoardState(context);
    const preview = await exports.preview("saved-reader", undefined, { promptMode: "none", formats },
        { kind: "all", revision: state.revision });
    await exports.review("saved-reader", preview.previewId, true);
    return (await exports.confirm("saved-reader", preview.previewId, true)).bundle;
}

test("saved reports without HTML open their declared text or offer an explicit PDF download without downgrading broken HTML", { timeout: 45000 }, async t => {
    const { context } = await privateFixture(t, [fixture("saved-format-reading")]);
    const controller = createExportController(context), bundles = [];
    for (const formats of [["json"], ["markdown"], ["pdf"], ["html", "json"], ["html", "json"]]) bundles.push(await save(controller, context, formats));
    await updateBoardState(context, state => { delete state.exports.find(entry => entry.bundleId === bundles[4].bundleId).formats; });
    const savedBytes = new Map();
    for (const bundle of bundles) for (const file of Object.values(bundle.files)) savedBytes.set(file, await readFile(file));
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage(), calls = [], downloads = [];
    page.on("request", request => { if (request.method() === "POST") calls.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
    page.on("download", download => downloads.push(download));
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    for (const [index, bundle] of bundles.slice(0, 3).entries()) {
        if (index) await page.getByRole("button", { name: "Back to report library", exact: true }).click();
        await page.locator(`#bundleList [data-bundle-id="${bundle.bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
        const reader = page.locator("#savedReportReader");
        await reader.getByRole("button", { name: "Download", exact: true }).waitFor();
        assert.equal(await page.locator("#pageTitle").textContent(), bundle.title);
        assert.equal(downloads.length, 0, "Open must not download or run a PDF");
        if (index < 2) {
            const text = await reader.locator("pre").textContent();
            assert.equal(text, savedBytes.get(bundle.files[index ? "product-report.md" : "product-report.json"]).toString("utf8"));
        } else {
            assert.match(await reader.textContent(), /saved as PDF/);
            assert.equal(await reader.locator("iframe,object,embed").count(), 0);
            const ready = page.waitForEvent("download");
            await reader.getByRole("button", { name: "Download", exact: true }).click();
            assert.equal((await ready).suggestedFilename(), "product-report.pdf");
        }
    }
    assert.equal(downloads.length, 1);
    for (const [file, bytes] of savedBytes) assert.deepEqual(await readFile(file), bytes);
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.locator(`#bundleList [data-bundle-id="${bundles[4].bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: bundles[4].title, level: 1, exact: true }).waitFor();
    assert.equal(calls.some(call => call.path === "/api/report-original"), false, "Missing optional formats does not downgrade a verified HTML read");
    assert.equal(await page.locator("#savedReportReader .saved-report-downloads").count(), 0,
        "Do not offer a download that the stricter format-inventory endpoint cannot validate");
    const broken = bundles[3];
    await writeFile(broken.files["product-report.html"], "changed saved HTML");
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    const start = calls.length;
    await page.locator(`#bundleList [data-bundle-id="${broken.bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator("#savedReportReader .error").waitFor();
    assert.equal(await page.getByRole("button", { name: "View original", exact: true }).count(), 0);
    assert.equal(await page.locator("#savedReportReader pre, #savedReportReader iframe").count(), 0);
    assert.equal(calls.slice(start).some(call => call.path === "/api/report-original" || call.path === "/api/artifact-file"), false,
        "Declared but broken HTML must not fall through to JSON, PDF or legacy-original");
});

async function legacyReport(context, title = "Release exercise - recorded requests and follow-up") {
    const bundleId = `export-${randomUUID()}`, bundleDir = path.join(context.dataDir, "exports", bundleId, "files");
    const formats = ["html", "pdf", "json", "markdown"], preparedAt = "2026-10-12T12:00:00.000Z";
    const snapshot = { schemaVersion: 3, bundleId, preparedAt, promptMode: "none", formats, records: [] };
    const content = {
        "product-report.html": "<!doctype html><html lang=\"en\"><title>Archived exercise</title><body><h1>Archived exercise</h1><p>INVENTED_LEGACY_ORIGINAL</p></body></html>",
        "product-report.pdf": "%PDF-1.4\n% Invented original download\n",
        "product-report.json": JSON.stringify(snapshot),
        "product-report.md": "# Archived exercise\n\nINVENTED_LEGACY_ORIGINAL\n",
    };
    const manifest = {
        schemaVersion: 3, bundleId, preparedAt, promptMode: "none", formats,
        snapshotHash: reportHash(JSON.stringify(snapshot)), privacyReview: { reviewerConfirmed: true },
        files: Object.fromEntries(Object.entries(content).map(([name, text]) => [name, { bytes: Buffer.byteLength(text), sha256: reportHash(text) }])),
    };
    content["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest);
    await mkdir(bundleDir, { recursive: true });
    for (const [name, text] of Object.entries(content)) await writeFile(path.join(bundleDir, name), text);
    const entry = {
        bundleId, kind: "report", title, preparedAt, formats, promptMode: "none", bundleDir,
        privacyReview: { reviewerConfirmed: true },
        files: Object.fromEntries(Object.keys(content).map(name => [name, path.join(bundleDir, name)])),
        selectionScope: { kind: "selected", requestGroups: 3 },
    };
    await updateBoardState(context, state => { state.exports.push(entry); });
    return { entry, content, manifest };
}

test("explicit legacy-original reading recognizes the supported unanchored v3 format without certifying it", async t => {
    const { context } = await privateFixture(t, [fixture("legacy-original")]);
    const { entry, content } = await legacyReport(context);
    const state = await loadBoardState(context), before = JSON.stringify(state);
    const result = await reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "report", "html");
    assert.equal(result.source, "legacy-original");
    assert.equal(result.verification, "unverified");
    assert.equal(result.artifact.bundleId, entry.bundleId);
    assert.equal(result.artifact.title, entry.title);
    assert.equal(result.currentDigest, reportHash(content["product-report.html"]));
    assert.equal(result.bytes.toString("utf8"), content["product-report.html"]);
    assert.equal(result.manifestHash, undefined);
    assert.equal(result.artifact.comparisonEligibility, undefined);
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    for (const [name, text] of Object.entries(content)) assert.equal(await readFile(entry.files[name], "utf8"), text);
    await assert.rejects(readSavedReportDocument(context, state, entry.bundleId), /saved disclosure approval cannot be verified/);
});

test("legacy-original eligibility rejects partial, malformed, false and mismatched verification", async t => {
    const { context } = await privateFixture(t, [fixture("legacy-eligibility")]);
    const { entry, content, manifest } = await legacyReport(context);
    const state = await loadBoardState(context);
    for (const change of [
        value => { value.manifestHash = null; },
        value => { value.manifestHash = "a".repeat(64); },
        value => { value.snapshotHash = "a".repeat(64); },
        value => { value.evaluationFactsHash = "a".repeat(64); },
        value => { value.reportType = "period-comparison"; },
        value => { value.privacyReview.reviewerConfirmed = false; },
        value => { value.privacyReview.reviewerConfirmed = "true"; },
        value => { value.privacyReview.reviewedAt = null; },
        value => { value.privacyReview.reviewedAt = "2026-10-12T12:00:00.000Z"; },
        value => { value.privacyReview = null; },
        value => { value.formats = ["html", "html"]; },
    ]) {
        const altered = structuredClone(state);
        change(altered.exports.find(value => value.bundleId === entry.bundleId));
        await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, altered, entry.bundleId, "report", "html"));
    }
    const metadataFile = entry.files["coverage-and-redaction-manifest.json"];
    for (const change of [
        value => { value.kind = "report"; },
        value => { value.kind = "comparison"; },
        value => { value.bundleId = `export-${randomUUID()}`; },
        value => { value.schemaVersion = 2; },
        value => { value.snapshotHash = "not-a-hash"; },
        value => { value.privacyReview.reviewerConfirmed = false; },
        value => { value.privacyReview = { reviewerConfirmed: "true" }; },
        value => { value.privacyReview.reviewedAt = null; },
        value => { value.privacyReview.reviewedAt = "2026-10-12T12:00:00.000Z"; },
        value => { value.evaluationFacts = {}; },
        value => { value.sourceReports = []; },
        value => { value.fileHashes = {}; },
        value => { value.files["product-report.html"].bytes = "42"; },
        value => { value.files["product-report.html"].sha256 = "not-a-hash"; },
        value => { value.files["product-report.html"].sha256 = "0".repeat(64); },
        value => { value.files["product-report.html"].extra = true; },
        value => { delete value.files["product-report.html"]; },
    ]) {
        const altered = structuredClone(manifest);
        change(altered);
        await writeFile(metadataFile, JSON.stringify(altered));
        await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "report", "html"));
    }
    await writeFile(metadataFile, content["coverage-and-redaction-manifest.json"]);
    assert.equal((await reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "report", "html")).verification, "unverified");
    for (const [name, text] of Object.entries(content)) assert.equal(await readFile(entry.files[name], "utf8"), text);
});

test("legacy-original reads keep managed ownership, link, size, encoding and current-identity fences", async t => {
    const { context } = await privateFixture(t, [fixture("legacy-file-guards")]);
    const { entry, content, manifest } = await legacyReport(context), state = await loadBoardState(context);
    const read = value => reportArtifacts.readLegacyReportOriginal(context, value, entry.bundleId, "report", "html");
    await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, state, `export-${randomUUID()}`, "report", "html"), /no longer available/);
    await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "comparison", "html"), /legacy report/);
    await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "report", "../html"), /Choose an HTML/);
    const deleted = structuredClone(state);
    deleted.artifactDeletion = { identities: [artifactDeletionKey("report", entry.bundleId)] };
    await assert.rejects(read(deleted), /no longer available/);
    const foreign = structuredClone(state);
    foreign.exports[0].files["product-report.html"] = path.join(context.dataDir, "outside.html");
    await assert.rejects(read(foreign), /outside its registered bundle/);
    const held = read(state);
    state.exports[0].title = "Changed while reading";
    await assert.rejects(held, /changed during this read/);
    state.exports[0].title = entry.title;
    const result = await read(state), replaced = structuredClone(state);
    replaced.exports[0].title = "Later indexed identity";
    assert.throws(() => reportArtifacts.assertLegacyReportOriginalCurrent(replaced, result.binding), /changed during this read/);
    const file = entry.files["product-report.html"], metadataFile = entry.files["coverage-and-redaction-manifest.json"];
    await truncate(file, reportArtifacts.SAVED_REPORT_MAX_BYTES + 1);
    await assert.rejects(read(state), /too large/);
    await writeFile(file, Buffer.from([0xff, 0xfe, 0xff]));
    const invalidText = structuredClone(manifest);
    invalidText.files["product-report.html"] = { bytes: 3, sha256: reportHash(Buffer.from([0xff, 0xfe, 0xff])) };
    await writeFile(metadataFile, JSON.stringify(invalidText));
    await assert.rejects(read(state), /not valid UTF-8/);
    await writeFile(file, content["product-report.html"]);
    await writeFile(metadataFile, content["coverage-and-redaction-manifest.json"]);
    const parked = entry.bundleDir + "-original";
    await rename(entry.bundleDir, parked);
    try {
        await symlink(parked, entry.bundleDir, process.platform === "win32" ? "junction" : "dir");
        try { await assert.rejects(read(state), /Linked report folders/); }
        finally { await unlink(entry.bundleDir); }
    } finally { await rename(parked, entry.bundleDir); }
    for (const [name, text] of Object.entries(content)) assert.equal(await readFile(entry.files[name], "utf8"), text);
    assert.equal((await read(state)).verification, "unverified");
});

test("the explicit legacy-original endpoint is capability-gated, closed and read-only", async t => {
    const { context } = await privateFixture(t, [fixture("legacy-api")]);
    const { entry, content } = await legacyReport(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const origin = new URL(runtime.url).origin;
    const post = (route, body, capability, requestOrigin = origin) => fetch(origin + route, {
        method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json",
            ...(capability ? { "X-Board-Capability": capability } : {}) }, body: JSON.stringify(body),
    });
    const input = { bundleId: entry.bundleId, kind: "report", format: "html" };
    assert.equal((await post("/api/report-original", input)).status, 403);
    const { capability } = await (await post("/api/session", {})).json();
    assert.equal((await post("/api/report-original", input, "a".repeat(64))).status, 403);
    assert.equal((await post("/api/report-original", input, capability, "https://foreign.example.invalid")).status, 403);
    const before = JSON.stringify(await loadBoardState(context));
    for (const format of ["html", "json", "markdown", "pdf"]) {
        const response = await post("/api/report-original", { ...input, format }, capability);
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.source, "legacy-original");
        assert.equal(result.verification, "unverified");
        assert.equal(result.currentDigest, reportHash(Buffer.from(result.data, "base64")));
        assert.equal(Buffer.from(result.data, "base64").toString("utf8"), content[result.name]);
        assert.equal(result.binding, undefined);
        assert.equal(result.manifestHash, undefined);
        assert.equal(result.artifact.comparisonEligibility, undefined);
    }
    for (const [change, status] of [[{ bundleId: `export-${randomUUID()}` }, 404], [{ kind: "comparison" }, 422],
        [{ format: "manifest" }, 422], [{ path: entry.files["product-report.html"] }, 400]]) {
        assert.equal((await post("/api/report-original", { ...input, ...change }, capability)).status, status);
    }
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    for (const [name, text] of Object.entries(content)) assert.equal(await readFile(entry.files[name], "utf8"), text);
});

test("a legacy report keeps its real title and an intentional unavailable state without inventing disclosure", { timeout: 30000 }, async t => {
    const { context } = await privateFixture(t, [fixture("legacy-report-view")]);
    const { entry, content } = await legacyReport(context);
    const { title } = entry, file = entry.files["product-report.html"], original = content["product-report.html"];
    const before = JSON.stringify(await loadBoardState(context));
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const reads = [];
    page.on("request", request => { if (request.method() === "POST") reads.push(new URL(request.url()).pathname); });
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(await page.locator(".saved-report-name").textContent(), title);
    await page.locator(".saved-report-summary").click();
    assert.equal(await page.locator("#contextSidebarTitle").textContent(), title);
    const opened = page.waitForResponse(response => response.url().endsWith("/api/report/open"));
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
    assert.equal((await opened).status(), 422, "Existing verified Open must still refuse a missing disclosure manifest");
    await page.locator("#savedReportReader .saved-reader-issue").waitFor();
    assert.equal(await page.locator("#savedReportReader iframe").count(), 0);
    assert.equal(reads.includes("/api/report-original"), false, "Verified failure never automatically reads an original");
    await page.getByRole("button", { name: "View original", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").getByText("INVENTED_LEGACY_ORIGINAL", { exact: true }).waitFor();
    assert.equal(await page.locator("#savedReportReader iframe").getAttribute("sandbox"), "");
    assert.match(await page.locator("#savedReportReader .saved-reader-caption").textContent(), /Unverified original/);
    assert.equal(reads.filter(route => route === "/api/report-original").length, 1);
    if (process.env.WIRE_LEGACY_REPORT_PROOFS) {
        await mkdir(process.env.WIRE_LEGACY_REPORT_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_LEGACY_REPORT_PROOFS, "legacy-open.png"), fullPage: true });
    }
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), title);
    assert.equal(await page.locator("#main").getByRole("heading", { name: title, exact: true }).count(), 1);
});

test("legacy original HTML is inert and late original reads cannot survive Back or changed indexed identity", { timeout: 30000 }, async t => {
    const { context } = await privateFixture(t, [fixture("legacy-inert")]);
    const { entry, manifest } = await legacyReport(context);
    const html = '<!doctype html><html><body><h1>Original archive</h1><p>ORIGINAL_VISIBLE_CANARY</p><script>parent.legacyRan=true</script><img src="https://foreign.example.invalid/image"><a href="https://foreign.example.invalid/leave">External</a><iframe src="https://foreign.example.invalid/frame"></iframe><form action="https://foreign.example.invalid/form"><button>Submit</button></form></body></html>';
    const metadataFile = entry.files["coverage-and-redaction-manifest.json"];
    manifest.files["product-report.html"] = { bytes: Buffer.byteLength(html), sha256: reportHash(html) };
    const metadata = JSON.stringify(manifest);
    await writeFile(entry.files["product-report.html"], html); await writeFile(metadataFile, metadata);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const external = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) {
            external.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    await page.goto(runtime.url + "#reports"); await page.locator('#workspace[aria-busy="false"]').waitFor();
    const open = page.getByRole("button", { name: "Open saved report", exact: true });
    await open.click();
    const view = page.getByRole("button", { name: "View original", exact: true });
    await view.click();
    const frame = page.frameLocator("#savedReportReader iframe");
    await frame.getByText("ORIGINAL_VISIBLE_CANARY", { exact: true }).waitFor();
    assert.equal(await page.locator("#savedReportReader iframe").getAttribute("sandbox"), "");
    assert.equal(await frame.locator("script,iframe,object,embed,base").count(), 0);
    assert.equal(await frame.locator("a[href]").count(), 0);
    assert.match(await frame.locator('meta[http-equiv="Content-Security-Policy"]').first().getAttribute("content"), /default-src 'none'.*form-action 'none'/);
    const location = page.url();
    await frame.getByRole("button", { name: "Submit", exact: true }).click();
    assert.equal(page.url(), location);
    await frame.getByText("ORIGINAL_VISIBLE_CANARY", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.legacyRan), undefined);
    assert.deepEqual(external, []);
    async function holdRead() {
        const pending = Promise.withResolvers(), release = Promise.withResolvers(), delivered = Promise.withResolvers();
        t.after(() => release.resolve());
        await page.route("**/api/report-original", async route => {
            const response = await route.fetch(); pending.resolve();
            await release.promise; await route.fulfill({ response }); delivered.resolve();
        }, { times: 1 });
        await view.click(); await pending.promise;
        return { release: () => release.resolve(), delivered: delivered.promise };
    }
    const backRead = await holdRead();
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    backRead.release(); await backRead.delivered;
    assert.equal(await page.locator("#savedReportReader iframe").count(), 0);
    assert.equal(await open.evaluate(node => node === document.activeElement), true);
    await open.click(); await view.waitFor();
    const changedRead = await holdRead();
    await updateBoardState(context, state => { state.exports[0].title = "Changed archive identity"; });
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await refreshed; await page.locator('#workspace[aria-busy="false"]').waitFor();
    changedRead.release(); await changedRead.delivered;
    assert.equal(await page.locator("#savedReportReader iframe").count(), 0);
    assert.match(await page.locator("#savedReportReader").textContent(), /changed|no longer available/);
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await open.click(); await view.waitFor();
    const metadataRead = await holdRead();
    await updateBoardState(context, state => { state.exports[0].preparedAtDisplay = "Changed preparation label"; });
    const metadataRefresh = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await metadataRefresh; await page.locator('#workspace[aria-busy="false"]').waitFor();
    metadataRead.release(); await metadataRead.delivered;
    await page.locator("#savedReportReader .error").waitFor();
    assert.equal(await page.locator("#savedReportReader iframe").count(), 0, "Metadata-only index changes also fence a late original");
    assert.equal(await readFile(entry.files["product-report.html"], "utf8"), html);
    assert.equal(await readFile(metadataFile, "utf8"), metadata);
    assert.equal((await loadBoardState(context)).exports[0].manifestHash, undefined);
    assert.deepEqual(external, []);
});

test("saved HTML reader verifies exact bytes, registered ownership, disclosure, integrity and availability", async t => {
    const { context } = await privateFixture(t), exports = createExportController(context), bundle = await save(exports, context);
    let state = await loadBoardState(context);
    const bytes = await readFile(bundle.files["product-report.html"]), before = JSON.stringify(state);
    const value = await readSavedReportDocument(context, state, bundle.bundleId);
    assert.equal(value.html, bytes.toString("utf8")); assert.equal(value.sha256, reportHash(bytes));
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    const noHtml = await save(exports, context, ["json"]);
    state = await loadBoardState(context);
    await assert.rejects(readSavedReportDocument(context, state, noHtml.bundleId), /HTML was not saved/);
    await assert.rejects(readSavedReportDocument(context, { ...state, exports: [] }, bundle.bundleId), /no longer available/);
    const forged = structuredClone(state), entry = forged.exports.find(item => item.bundleId === bundle.bundleId);
    entry.files["product-report.html"] = path.join(context.dataDir, "outside.html");
    await assert.rejects(readSavedReportDocument(context, forged, bundle.bundleId), /outside its registered bundle/);
    entry.files["product-report.html"] = bundle.files["product-report.html"]; entry.kind = "comparison";
    await assert.rejects(readSavedReportDocument(context, forged, bundle.bundleId), /no longer available/);
    entry.kind = "report"; entry.privacyReview.reviewerConfirmed = false;
    await assert.rejects(readSavedReportDocument(context, forged, bundle.bundleId), /disclosure approval cannot be verified/);
    await writeFile(bundle.files["product-report.html"], bytes + "\nchanged");
    await assert.rejects(readSavedReportDocument(context, state, bundle.bundleId), /HTML changed/);
    await writeFile(bundle.files["product-report.html"], bytes);
    const linkedState = structuredClone(state), linkedEntry = linkedState.exports.find(item => item.bundleId === bundle.bundleId);
    const linkedDir = path.join(context.dataDir, "reader-junction"), targetDir = path.join(context.dataDir, "reader-target");
    await mkdir(targetDir); await symlink(targetDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    linkedEntry.bundleDir = linkedDir; linkedEntry.files["product-report.html"] = path.join(linkedDir, "product-report.html");
    await assert.rejects(readSavedReportDocument(context, linkedState, bundle.bundleId), /outside its registered bundle/);
    assert.deepEqual(await readFile(bundle.files["product-report.html"]), bytes);
});

test("saved HTML open is capability-gated, inert, draft-preserving and fences closed or replaced reads", { timeout: 45000 }, async t => {
    const { context } = await privateFixture(t, [fixture("reader")]), exports = createExportController(context);
    const first = await save(exports, context), second = await save(exports, context), missing = await save(exports, context, ["json"]);
    const firstHtml = await readFile(first.files["product-report.html"], "utf8");
    const malicious = firstHtml.replace("</body>", '<h2>Historical Cost</h2><p>FROZEN_LEGACY_VALUE</p><img src="https://outside.invalid/image"><a href="https://outside.invalid/leave">External link</a><meta http-equiv="refresh" content="0;url=https://outside.invalid/refresh"><script>parent.readerExecuted=true</script></body>');
    await writeFile(first.files["product-report.html"], malicious);
    const manifestPath = first.files["coverage-and-redaction-manifest.json"], manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files["product-report.html"] = { sha256: reportHash(malicious), bytes: Buffer.byteLength(malicious) };
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(manifestPath, manifestBytes);
    await updateBoardState(context, state => { state.exports.find(entry => entry.bundleId === first.bundleId).manifestHash = reportHash(manifestBytes); });
    const frozen = await Promise.all(Object.values(first.files).map(file => readFile(file)));
    const runtime = await startServer(context, exports, { port: 0, collector: { timers: false } }), browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const origin = runtime.url.slice(0, -1);
    const rejected = await fetch(origin + "/api/report/open", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ bundleId: first.bundleId }) });
    assert.equal(rejected.status, 403);
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, colorScheme: "dark" }), external = [], writes = [], frameDocuments = [];
    page.setDefaultTimeout(10000);
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort();
    });
    page.on("request", request => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
    page.on("request", request => { if (request.isNavigationRequest() && request.frame() !== page.mainFrame()) frameDocuments.push(request.url()); });
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await chooseReportScope(page, "all"); await reportContents(page); await page.locator("[name=promptMode][value=none]").check();
    const draft = await scanReport(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    await openReportLibrary(page);
    const rowFor = id => page.locator(`[data-bundle-id="${id}"]`);
    const firstRow = rowFor(first.bundleId), secondRow = rowFor(second.bundleId);
    const open = firstRow.getByRole("button", { name: "Open saved report", exact: true });
    await open.click();
    const dialog = page.locator("#savedReportReader");
    assert.equal(await page.locator("#pageTitle").textContent(), first.title);
    await page.waitForFunction(() => document.querySelector("#savedReportReader iframe,#savedReportReader .error"));
    assert.equal(await dialog.locator("iframe").count(), 1, await dialog.innerText());
    await dialog.locator("iframe").waitFor();
    const frame = dialog.frameLocator("iframe");
    await frame.getByText("FROZEN_LEGACY_VALUE", { exact: true }).waitFor();
    assert.doesNotMatch(await dialog.innerText(), /Report ID:/, "Full identifiers remain in library details rather than competing with the saved document");
    assert.equal(await dialog.locator("iframe").getAttribute("sandbox"), "");
    assert.equal(await frame.locator('a[href]:not([href^="about:srcdoc#"])').count(), 0);
    assert.equal(await frame.locator("html").getAttribute("data-evidence-theme"), "light", "The frozen theme survives an OS-dark reader.");
    assert.equal(await frame.locator("html").getAttribute("lang"), "en");
    assert.equal(await frame.locator("script,base,iframe,meta[http-equiv=refresh]").count(), 0);
    await frame.getByText("External link", { exact: true }).click();
    assert.equal(new URL(page.url()).hash.split("?")[0], "#reports");
    const coverage = frame.getByRole("link", { name: "Coverage", exact: true });
    await coverage.click();
    await frame.locator("#coverage").waitFor({ state: "visible" });
    assert.match(await frame.locator("body").innerText(), /FROZEN_LEGACY_VALUE/);
    assert.ok(await frame.locator("#coverage").evaluate(node => Math.abs(node.getBoundingClientRect().top) < innerHeight));
    assert.deepEqual(frameDocuments, [], "Section links stay in the frozen document, never loading the app shell.");
    assert.equal(await page.evaluate(() => window.readerExecuted), undefined);
    assert.deepEqual(external, []);
    if (process.env.WIRE_QUALITY_PROOFS) await page.screenshot({ path: path.join(process.env.WIRE_QUALITY_PROOFS, "saved-report-reader-light.png") });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.evaluate(() => document.fonts.ready);
    const headerLayout = await dialog.locator(".saved-reader-heading").evaluate(header => {
        const title = document.getElementById("pageTitle"), close = header.querySelector("button");
        const bounds = node => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        const range = document.createRange();
        range.selectNodeContents(title);
        return {
            header: bounds(header), title: bounds(title), close: bounds(close),
            titleLines: range.getClientRects().length,
            wordLines: [...title.textContent.matchAll(/\S+/g)].map(match => {
                const word = document.createRange();
                word.setStart(title.firstChild, match.index); word.setEnd(title.firstChild, match.index + match[0].length);
                return word.getClientRects().length;
            }),
            overflow: header.scrollWidth > header.clientWidth + 1,
        };
    });
    if (process.env.WIRE_READER_HEADER_PROOFS) {
        await mkdir(process.env.WIRE_READER_HEADER_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_READER_HEADER_PROOFS, "reader-header-375-200.png") });
        await writeFile(path.join(process.env.WIRE_READER_HEADER_PROOFS, "reader-header-layout.json"), JSON.stringify(headerLayout, null, 2));
    }
    assert.ok(headerLayout.wordLines.every(lines => lines === 1), `Saved report must wrap by words, not characters: ${JSON.stringify(headerLayout)}`);
    assert.ok(headerLayout.header.height <= 240, "The reader header must leave useful space for the frozen document.");
    assert.ok(headerLayout.title.width >= 100 && headerLayout.close.width >= 44);
    assert.equal(headerLayout.overflow, false);
    assert.ok(headerLayout.close.height >= 44 && headerLayout.close.x >= 0 && headerLayout.close.right <= 375);
    assert.ok(headerLayout.close.y >= 0 && headerLayout.close.bottom <= 1000);
    const keyboardClose = dialog.getByRole("button", { name: "Back to report library", exact: true });
    await keyboardClose.focus();
    assert.equal(await keyboardClose.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await open.evaluate(node => document.activeElement === node), true);
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await open.click();
    await dialog.locator("iframe").waitFor();
    await dialog.getByRole("button", { name: "Back to report library", exact: true }).click();
    assert.equal(await open.evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed");
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), true);
    assert.equal(writes.filter(route => route === "/api/preview").length, 1);
    assert.equal(writes.includes("/api/export"), false);
    const read = Promise.withResolvers(), release = Promise.withResolvers();
    await page.route("**/api/report/open", async route => {
        if (route.request().postDataJSON().bundleId !== first.bundleId) return route.continue();
        const response = await route.fetch(); read.resolve(); await release.promise; await route.fulfill({ response });
    });
    await open.click(); await read.promise;
    await dialog.getByRole("button", { name: "Back to report library", exact: true }).click();
    await secondRow.getByRole("button", { name: "Open saved report", exact: true }).click();
    await dialog.locator("iframe").waitFor(); release.resolve();
    await page.waitForTimeout(50);
    assert.match(await dialog.frameLocator("iframe").locator("body").textContent(), new RegExp(second.bundleId));
    assert.equal(await dialog.frameLocator("iframe").getByText("FROZEN_LEGACY_VALUE", { exact: true }).count(), 0);
    await dialog.getByRole("button", { name: "Back to report library", exact: true }).click();
    const missingRow = rowFor(missing.bundleId); await missingRow.locator(".saved-report-summary").click();
    assert.equal(await missingRow.getByRole("button", { name: "Open saved report", exact: true }).count(), 1);
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
    await dialog.locator("pre").waitFor();
    assert.equal(await dialog.locator("pre").textContent(), await readFile(missing.files["product-report.json"], "utf8"));
    assert.deepEqual(await Promise.all(Object.values(first.files).map(file => readFile(file))), frozen);
    assert.equal((await loadBoardState(context)).exports.length, 3);
    assert.ok(draft.previewId);
});
