import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { diagnosticRecords } from "./diagnostic-bundles-fixture.mjs";
import { executeAction } from "../lib/server.mjs";
import { resolveDataDir, loadBoardState } from "../lib/store.mjs";
import { editNamedDrafts, namedDraftCatalog } from "../lib/named-report-drafts.mjs";
import { buildDiagnosticCalls } from "../lib/analytics.mjs";
import { diagnosticBundleRequest, prepareDiagnosticBundle, saveDiagnosticBundle } from "../lib/diagnostic-bundles.mjs";

const scope = { from: "2026-11-16", to: "2026-11-19", timeContext: { timeZone: "UTC", locale: "en-US" } };
const run = (context, action, input) => executeAction(context, {}, "owner", action, input, {});

test("diagnostic bundle preview reads the Analyze scope and writes nothing", async t => {
    const { context } = await privateFixture(t, diagnosticRecords());
    const preview = await run(context, "get_diagnostic_bundle_preview", scope);
    assert.deepEqual(preview.totals, { calls: 23, failures: 9, completed: 12, unknown: 2 });
    assert.equal(preview.captureScope, "complete");
    assert.equal(preview.completeEligible, true);
    assert.equal(preview.rate.available, false);
    assert.match(preview.rate.explanation, /replies of successful calls/);
    assert.match(preview.headline, /^9 of 23 Work IQ tool calls failed, in 5 failure groups\. 2 more calls have no recorded result\.$/);
    const denied = preview.clusters.find(cluster => cluster.errorCodes.includes("ErrorAccessDenied"));
    assert.deepEqual([denied.tool, denied.count, denied.share, denied.statusCodes], ["workiq-fetch", 3, "33.3%", ["403"]]);
    assert.deepEqual(denied.reasons, ["Access is denied. Check credentials and try again."]);
    assert.ok(preview.clusters.some(cluster => cluster.errorCodes.includes("-32001") && cluster.reasons[0].includes("timed out")));
    assert.ok(preview.limitations.some(line => /no recorded result/.test(line)));
    assert.match(preview.report, /^# MCP diagnostic/);
    const narrowed = await run(context, "get_diagnostic_bundle_preview", { ...scope, from: "2026-11-18", tools: ["workiq-fetch"] });
    assert.deepEqual(narrowed.totals, { calls: 3, failures: 1, completed: 1, unknown: 1 });
    assert.deepEqual(await readdir(resolveDataDir(context)).then(names => names.includes("diagnostics")), false);
    await assert.rejects(run(context, "get_diagnostic_bundle_preview", { ...scope, extra: true }), { status: 422 });
});

test("diagnostic bundles save, list, open, annotate and delete without touching reports or drafts", async t => {
    const { context } = await privateFixture(t, diagnosticRecords());
    const expected = namedDraftCatalog(await loadBoardState(context), "test-source").version;
    await editNamedDrafts(context, "test-source", { name: "Kept draft", scenarioId: "diag-0", included: true, expected });
    const before = await loadBoardState(context);
    await assert.rejects(run(context, "save_diagnostic_bundle", { ...scope, expected: { calls: 22, failures: 9 } }), { status: 409 });
    const saved = await run(context, "save_diagnostic_bundle", { ...scope, expected: { calls: 23, failures: 9 } });
    assert.equal(saved.saved, true);
    const root = path.join(resolveDataDir(context), "diagnostics");
    assert.equal(path.dirname(saved.files.archive), root);
    const names = (await readdir(root)).sort();
    assert.deepEqual(names, [`${saved.bundle.bundleId}.md`, `${saved.bundle.bundleId}.zip`, "index.json"].sort());
    const { bundles } = await run(context, "get_diagnostic_bundles", {});
    assert.equal(bundles.length, 1);
    assert.deepEqual([bundles[0].available, bundles[0].clusterCount, bundles[0].reviewed, bundles[0].totals.failures], [true, 5, 0, 9]);
    assert.equal(Object.hasOwn(bundles[0], "hashes"), false);

    const opened = await run(context, "get_diagnostic_bundle", { bundleId: saved.bundle.bundleId });
    assert.match(opened.report, /^# MCP diagnostic/);
    const cluster = opened.clusters.find(item => item.errorCodes.includes("TooManyRequests"));
    assert.deepEqual(cluster.reasons, ["Application is over its MailboxConcurrency limit."]);

    await assert.rejects(run(context, "record_diagnostic_audit_result", { bundleId: saved.bundle.bundleId, clusterId: cluster.id,
        verdict: "infra-transient", workItemUrl: "http://example.invalid/1" }), { status: 422 });
    await assert.rejects(run(context, "record_diagnostic_audit_result", { bundleId: saved.bundle.bundleId, clusterId: cluster.id, verdict: "flaky" }), { status: 422 });
    await assert.rejects(run(context, "record_diagnostic_audit_result", { bundleId: saved.bundle.bundleId, clusterId: "c-000000000000000000000000",
        verdict: "by-design" }), { status: 404 });
    const zipBefore = await readFile(saved.files.archive);
    await run(context, "record_diagnostic_audit_result", { bundleId: saved.bundle.bundleId, clusterId: cluster.id,
        verdict: "infra-transient", workItemUrl: "https://dev.azure.example/items/42", note: "Throttled during a mailbox sync." });
    assert.deepEqual(await readFile(saved.files.archive), zipBefore, "Annotations never modify the frozen zip");
    const annotated = await run(context, "get_diagnostic_bundle", { bundleId: saved.bundle.bundleId });
    assert.deepEqual(annotated.clusters.find(item => item.id === cluster.id).audit.workItemUrl, "https://dev.azure.example/items/42");
    assert.equal(annotated.bundle.reviewed, 1);

    await run(context, "delete_diagnostic_bundle", { bundleId: saved.bundle.bundleId });
    assert.deepEqual(await readdir(root), ["index.json"]);
    assert.deepEqual((await run(context, "get_diagnostic_bundles", {})).bundles, []);
    await assert.rejects(run(context, "get_diagnostic_bundle", { bundleId: saved.bundle.bundleId }), { status: 404 });
    await assert.rejects(run(context, "delete_diagnostic_bundle", { bundleId: saved.bundle.bundleId }), { status: 404 });
    const after = await loadBoardState(context);
    assert.deepEqual(after.exports, before.exports);
    assert.deepEqual(after.namedReportDrafts, before.namedReportDrafts);
    assert.equal(after.evidence.length, before.evidence.length);
    assert.deepEqual(namedDraftCatalog(after, "test-source").drafts.map(item => item.name), ["Kept draft"]);
});

test("verified Open refuses altered or missing bundle files and Save never overwrites", async t => {
    const { context } = await privateFixture(t, diagnosticRecords());
    const first = await run(context, "save_diagnostic_bundle", scope);
    await appendFile(first.files.report, "\nAdded later.\n");
    await assert.rejects(run(context, "get_diagnostic_bundle", { bundleId: first.bundle.bundleId }), error =>
        error.status === 422 && error.code === "bundle-altered" && /report\.md was modified/.test(error.message));

    const second = await run(context, "save_diagnostic_bundle", scope);
    const bytes = await readFile(second.files.archive);
    bytes[bytes.length - 30] ^= 1;
    await writeFile(second.files.archive, bytes);
    await assert.rejects(run(context, "get_diagnostic_bundle", { bundleId: second.bundle.bundleId }), { status: 422, code: "bundle-altered" });
    await rm(second.files.report);
    assert.equal((await run(context, "get_diagnostic_bundles", {})).bundles.find(item => item.bundleId === second.bundle.bundleId).available, false);
    await assert.rejects(run(context, "get_diagnostic_bundle", { bundleId: second.bundle.bundleId }), /report\.md is missing/);

    const calls = buildDiagnosticCalls(diagnosticRecords(), scope);
    const request = diagnosticBundleRequest(scope);
    const fixed = { now: new Date("2026-11-20T12:00:00Z"), nonce: "0badc0de" };
    const third = await saveDiagnosticBundle(context, calls, request, fixed);
    const kept = await readFile(third.files.archive);
    await assert.rejects(saveDiagnosticBundle(context, calls, request, fixed), { status: 409 });
    await run(context, "delete_diagnostic_bundle", { bundleId: third.bundle.bundleId });
    await assert.rejects(saveDiagnosticBundle(context, calls, request, fixed), { status: 409 }, "A deleted identity is never reused");
    // A stray file with the next identity's name is not overwritten.
    const stray = { now: fixed.now, nonce: "feedf00d" };
    const strayPath = path.join(path.dirname(third.files.archive), "mcp-diag-internal-20261120T120000Z-feedf00d.md");
    await writeFile(strayPath, "not WIRE's");
    await assert.rejects(saveDiagnosticBundle(context, calls, request, stray), { status: 409 });
    assert.equal(await readFile(strayPath, "utf8"), "not WIRE's");
    assert.equal((await readdir(path.dirname(strayPath))).some(name => name.startsWith("mcp-diag-internal-20261120T120000Z-feedf00d.zip")), false);
    assert.ok(kept.length > 0);
});

test("complete scope is refused when WIRE can't include every call", async () => {
    const calls = buildDiagnosticCalls(diagnosticRecords(), scope);
    calls.coverage = { ...calls.coverage, complete: false, truncated: true };
    const request = diagnosticBundleRequest(scope);
    const sample = prepareDiagnosticBundle(calls, request).preview;
    assert.equal(sample.captureScope, "sample");
    assert.equal(sample.completeEligible, false);
    assert.match(sample.rate.explanation, /sample/);
    assert.ok(sample.limitations[0].includes("5,000"));
    assert.throws(() => prepareDiagnosticBundle(calls, diagnosticBundleRequest({ ...scope, captureScope: "complete" })), { code: "incomplete-capture" });
});
