import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeEndpoint } from "../lib/analytics.mjs";
import { classifyWorkload } from "../lib/graph-history.mjs";
import { routeShape, isSharedDriveItemPath } from "../lib/graph.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { serviceCategories, createServiceCategories } from "../lib/service-categories.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { fluentIcon } from "../web/ux-icons.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { adaptEvaluationReport, freezeEvaluationFacts } from "../lib/report-facts.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { AUTOMATIC_SCORE_METHOD, automaticScoreAttemptKey, planAutomaticScore } from "../lib/automatic-score-policy.mjs";
import { evaluationRecordFingerprint } from "../lib/evaluation-fingerprint.mjs";
import { MINIMUM_SESSION_AI_CREDITS } from "../lib/evaluation-budget.mjs";
import { serviceEvidenceFixture } from "./service-evidence-fixtures.mjs";

test("shared driveItem classification preserves only the exact public path and never the opaque token or query value", () => {
    for (const token of ["u!INVENTED-PRIVATE", "messages", "A".repeat(1200), "{id}", "{withheld}"]) {
        const raw = `/shares/${token}/driveItem?$select=PRIVATE-SELECT&secret=PRIVATE-QUERY`;
        const normalized = normalizeEndpoint(raw);
        assert.equal(normalized.path, "/shares/{id}/driveItem");
        assert.equal(classifyWorkload(normalized), "Files");
        assert.equal(classifyWorkload(normalizeEndpoint(routeShape(raw))), "Files");
        assert.equal(routeShape(raw).path, "/shares/{withheld}/driveItem");
        assert.deepEqual(normalized.queryShape, ["$select", "{query-key}"]);
        assert.doesNotMatch(JSON.stringify([normalized, routeShape(raw)]), /PRIVATE/);
    }
    assert.equal(classifyWorkload("https://graph.microsoft.com/v1.0/shares/u!example/driveItem"), "Files");
    assert.equal(classifyWorkload("https://untrusted.invalid/shares/u!example/driveItem"), "Unknown");
    for (const path of ["/shares", "/shares/x", "/shares//driveItem", "/shares/./driveItem", "/shares/../driveItem",
        "/shares/x/driveItems", "/shares/x/driveitem", "/Shares/x/driveItem", "/other/shares/x/driveItem",
        "/shares/x/driveItem/unsupported", "/shares/x/another", "/unrelated/driveItem"]) {
        assert.equal(isSharedDriveItemPath(path), false, path);
        assert.equal(classifyWorkload(path), "Unknown", path);
    }
    assert.equal(classifyWorkload(null, "workiq-ask"), "Unknown");
    assert.equal(classifyWorkload(null, "workiq-retrieve"), "Search");
});

test("service identification changes neither units nor results and leaves nonexecuting discovery separate", () => {
    const record = serviceEvidenceFixture(), before = structuredClone(record);
    const tools = buildActivityAnalytics([record]);
    assert.deepEqual(tools.rows.map(row => row.workload), ["Unknown", "Files", "Files", "Unknown", "Unknown", "Discovery"]);
    assert.deepEqual(tools.rows.map(row => row.toolCallId), record.toolCalls.map(call => call.toolCallId));
    assert.deepEqual([tools.totals.count, tools.totals.success, tools.totals.failure, tools.totals.unknown], [6, 4, 1, 1]);
    const api = buildActivityAnalytics([record], { layer: "reported-api" });
    assert.deepEqual(api.rows.map(row => [row.workload, row.status, row.outcome]), [["Files", 200, "success"], ["Files", 403, "failure"]]);
    assert.equal(buildActivityAnalytics([record], { layer: "http" }).totals.count, 0, "tool results do not create owned HTTP");
    record.toolCalls[1].requestArgs.entityUrls.push("/me/messages");
    assert.equal(buildActivityAnalytics([record]).rows[1].workload, "Multiple workloads");
    record.toolCalls[1].requestArgs.entityUrls.pop();
    assert.deepEqual(record, before);
});

test("neutral Unknown presentation explains hosted routing, unrecognized paths and missing targets without prose inference", () => {
    const rows = buildActivityAnalytics([serviceEvidenceFixture()]).rows;
    assert.equal(serviceCategories.describe("Unknown").label, "Service not shown");
    assert.equal(serviceCategories.describe("Service not identified").id, "Unknown", "old display aliases remain recognized");
    assert.equal(dimensionalIcons.Unknown, fluentIcon("info"));
    assert.notEqual(dimensionalIcons.Unknown, fluentIcon("question_circle"));
    assert.deepEqual([0, 3, 4].map(index => serviceCategories.serviceEvidence(rows[index]).reason),
        ["hosted-routing", "unrecognized-path", "missing-target"]);
    assert.equal(serviceCategories.serviceEvidence(rows[1]), null);
    assert.equal(serviceCategories.serviceEvidence(rows[0], "reported-api").reason, "missing-target", "API rows never borrow ask routing assumptions");
    assert.equal(serviceCategories.serviceEvidence({ ...rows[0], endpoint: normalizeEndpoint("invalid-target") }).reason, "unsupported-target",
        "explicit unusable target evidence is not hidden routing");
    assert.equal(serviceCategories.serviceEvidence({ ...rows[4], targetCount: 1, endpoint: normalizeEndpoint("not-a-relative-path") }).reason, "unsupported-target");
    const explanation = serviceCategories.explainRows(rows);
    assert.match(explanation, /Its record does not identify a service or API path/);
    assert.doesNotMatch(explanation, /Work IQ does not expose|services.*were used|services.*it used/);
    assert.match(explanation, /path was recorded/);
    assert.match(explanation, /No service target/);
    assert.doesNotMatch(explanation, /Invented question|SHARING-TOKEN/);
    const serialized = Function(`return (${createServiceCategories.toString()})()`)();
    assert.equal(serialized.explainRows(rows), explanation);
    const original = structuredClone(rows), groups = serviceCategories.evidenceGroups(rows);
    assert.deepEqual(groups.map(group => [group.tool, group.purpose, group.evidence.reason, group.count]), [
        ["workiq-ask", "Copilot assistance", "hosted-routing", 1],
        ["workiq-fetch", null, "unrecognized-path", 1],
        ["workiq-fetch", null, "missing-target", 1],
    ]);
    assert.deepEqual(serialized.evidenceGroups(rows), groups);
    assert.deepEqual(rows, original, "Evidence explanations never rewrite canonical rows");
    assert.deepEqual(serviceCategories.evidenceGroups([]), []);
    assert.equal(serviceCategories.evidenceGroups([rows[0]], "reported-api")[0].purpose, null);
    assert.equal(serviceCategories.evidenceGroups([rows[0]], "reported-api")[0].evidence.reason, "missing-target");
    for (const target of ["https://untrusted.invalid/v1.0/me/messages", "https://name:secret@graph.microsoft.com/v1.0/me/messages", "not-a-path"]) {
        const endpoint = normalizeEndpoint(target);
        const evidence = serviceCategories.serviceEvidence({ ...rows[0], targetCount: 1, targets: [endpoint], endpoint });
        assert.equal(evidence.reason, "unsupported-target", "Invalid origins/formats are not presented as a missing target or hidden routing");
        assert.match(evidence.description, /supported relative path or trusted Microsoft Graph URL/);
    }
    assert.equal(serviceCategories.explainRows([]), "");
    assert.doesNotMatch(serviceCategories.explainRows(rows.filter(row => row.tool === "workiq-ask")), /path was recorded|No service target/);
});

test("new reports freeze Files recognition and v3 patterns; v2 comparisons withhold pattern deltas but retain compatible speed", { timeout: 30000 }, async () => {
    const record = serviceEvidenceFixture();
    await assert.rejects(buildSanitizedBundle([record], "d".repeat(64), { promptMode: "none", formats: ["json"] }), /required tool prompt\/argument field is missing/);
    record.toolCalls.splice(4, 1);
    const before = structuredClone(record);
    const bundle = await buildSanitizedBundle([record], "d".repeat(64), { promptMode: "none", formats: ["json", "html", "markdown", "pdf"] });
    const facts = bundle.snapshot.evaluationFacts;
    assert.equal(bundle.snapshot.categoryDefinition.version, 3);
    assert.equal(facts.patterns.every(entry => entry.pattern.version === 3), true);
    assert.equal(facts.patterns.filter(entry => entry.pattern.display.workload === "Files").reduce((sum, entry) => sum + entry.memberRefs.length, 0), 4);
    for (const content of [bundle.files["product-report.html"], bundle.files["product-report.md"], bundle.files["product-report.json"]]) {
        assert.doesNotMatch(content, /INVENTED-PRIVATE|ANOTHER-INVENTED|INVENTED-SCHEMA/);
        assert.match(content, /Service not shown/);
        assert.match(content, /shares/);
    }
    for (const content of [bundle.files["product-report.html"], bundle.files["product-report.md"]]) {
        assert.match(content, /Its record does not identify a service or API path/);
        assert.match(content, /regrouping, not a change in recorded outcomes/);
    }
    const pdf = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    const document = await pdf.promise;
    let pdfText = "";
    try {
        for (let index = 1; index <= document.numPages; index++) {
            const page = await document.getPage(index), viewport = page.getViewport({ scale: 1 });
            for (const item of (await page.getTextContent()).items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1);
                pdfText += item.str + " ";
            }
        }
    } finally { await pdf.destroy(); }
    assert.match(pdfText, /\/shares\/\{id\}\/driveItem/);
    assert.match(pdfText, /Service not shown/);
    assert.doesNotMatch(pdfText, /INVENTED-PRIVATE|ANOTHER-INVENTED|INVENTED-SCHEMA/);
    const olderFacts = structuredClone(facts);
    for (const entry of olderFacts.patterns) {
        const pattern = entry.pattern;
        for (const endpoint of pattern.display.endpoints) if (endpoint.pathTemplate === "/shares/{id}/driveItem") {
            endpoint.pathTemplate = "/{id}/{id}/{id}";
            if (pattern.display.workload === "Files") pattern.display.workload = "Unknown";
        }
        pattern.version = 2; pattern.normalizer = "wire-safe-technical-pattern-v2";
        const { version, normalizer, key, ...structural } = pattern;
        pattern.key = createHash("sha256").update(JSON.stringify(structural)).digest("hex");
    }
    const metadata = (name, char) => ({ bundleId: `export-${name}`, snapshotHash: char.repeat(64), disclosureReviewed: true });
    const older = adaptEvaluationReport(freezeEvaluationFacts(olderFacts), metadata("older", "a"));
    const newer = adaptEvaluationReport(facts, metadata("newer", "b"));
    const oldBytes = JSON.stringify(older), newBytes = JSON.stringify(newer);
    assert.deepEqual([older.patternVersion, newer.patternVersion], [3, 4]);
    const comparison = compareFrozenReportFacts(older, newer);
    assert.equal(comparison.reason, "pattern-definition-changed");
    assert.equal(comparison.toolComparison, null);
    const speed = comparison.metrics.find(metric => metric.metric === "speed" && metric.boundary === "tool-start-to-completion");
    assert.equal(speed.status, "comparable");
    assert.deepEqual(speed.delta, { value: 0, unit: "ms", direction: "unchanged" });
    assert.equal(JSON.stringify(older), oldBytes); assert.equal(JSON.stringify(newer), newBytes);
    assert.deepEqual(older.toolRows.map(row => [row.id, row.outcome]), newer.toolRows.map(row => [row.id, row.outcome]));
    assert.deepEqual(record, before);
    if (process.env.WIRE_SERVICE_EVIDENCE_PROOFS) {
        await mkdir(process.env.WIRE_SERVICE_EVIDENCE_PROOFS, { recursive: true });
        for (const extension of ["html", "pdf", "json", "md"]) await writeFile(path.join(process.env.WIRE_SERVICE_EVIDENCE_PROOFS,
            `invented-service-report.${extension}`), bundle.files[`product-report.${extension}`]);
    }
});

test("derived service regrouping leaves completed automatic assessment identity current and cannot schedule another spend", () => {
    const record = serviceEvidenceFixture();
    record.responseTiming = { status: "measured", promptEventId: "invented-prompt", finalEventId: "invented-final", completionEventId: "invented-turn-end" };
    const ref = (kind, char) => kind + "-" + char.repeat(32);
    const approval = { schemaVersion: 1, approvalRef: ref("approval", "a"), revision: 1, state: "enabled",
        sourceConfigRef: ref("source", "b"), sourceConfigRevision: 1, windowDays: 30, chatRefs: [ref("chat", "c")],
        method: { ...AUTOMATIC_SCORE_METHOD }, evidenceCategories: ["answer", "intent", "prompt", "references"],
        maxCalls: 2, maxAiCredits: MINIMUM_SESSION_AI_CREDITS * 2, approvedAt: "2026-10-01T12:00:00.000Z", origin: "explicit-automatic-score-approval" };
    const interactionRef = ref("interaction", "d");
    const fingerprint = evaluationRecordFingerprint(record), attemptKey = automaticScoreAttemptKey(approval, interactionRef, record);
    const original = structuredClone(record);
    for (const layer of ["tool", "reported-api", "http"]) buildActivityAnalytics([record], { layer });
    serviceCategories.explainRows(buildActivityAnalytics([record]).rows);
    assert.deepEqual(record, original);
    assert.equal(evaluationRecordFingerprint(record), fingerprint);
    assert.equal(automaticScoreAttemptKey(approval, interactionRef, record), attemptKey);
    const decision = planAutomaticScore({ approval, source: { available: true, collectionEnabled: true,
        sourceConfigRef: approval.sourceConfigRef, sourceConfigRevision: 1, windowDays: 30 },
        candidates: [{ interactionRef, chatRef: approval.chatRefs[0], record }], attempts: [{ attemptKey, phase: "complete" }],
        usage: { callsReserved: 1, spentAiCredits: 0.1, costUnknown: false, active: false, cleanupPending: false },
        now: "2026-10-07T12:00:00.000Z" });
    assert.equal(decision.next, null);
    assert.deepEqual([decision.state, decision.reason], ["ready", "processed"]);
});
