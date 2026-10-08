import test from "node:test";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { routeShape } from "../lib/graph.mjs";
import { normalizeEndpoint } from "../lib/analytics.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { freezeEvaluationFacts } from "../lib/report-facts.mjs";
import { serviceEvidenceFixture } from "./service-evidence-fixtures.mjs";

const secret = "u!INVENTED-OPAQUE-SHARING-TOKEN";
const query = "?$select=id,name&$filter=INVENTED-PRIVATE-QUERY";
const route = `/shares/${secret}/driveItem`;
const forms = [
    ["relative", route, null],
    ["versioned-relative", "/v1.0" + route, "v1.0"],
    ["trusted-absolute", "https://graph.microsoft.com/v1.0" + route, "v1.0"],
];
function recordFor(target) {
    const record = serviceEvidenceFixture();
    record.toolCalls = record.toolCalls.slice(1, 3).map(call => ({
        ...call, requestArgs: { entityUrls: [target] }, requestedApiPath: target,
    }));
    return record;
}
const identities = rows => rows.map(row => [row.id, row.toolCallId, row.parentCallId, row.outcome, row.status, row.startedAt, row.durationMs]);
async function pdfText(bytes) {
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const doc = await task.promise;
    let text = "";
    try {
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
            const page = await doc.getPage(pageNumber), viewport = page.getViewport({ scale: 1 });
            for (const item of (await page.getTextContent()).items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1);
                text += item.str + " ";
            }
        }
        return text;
    } finally { await task.destroy(); }
}

test("all report formats and frozen facts agree on supported shared-driveItem target forms", { timeout: 60000 }, async t => {
    let originalIdentities, projectedIdentities, frozenOutcomeBytes, earlierSaved, earlierSavedBytes;
    for (const [name, input, version] of forms) await t.test(name, async () => {
        const record = recordFor(input + query), before = structuredClone(record);
        const calls = buildActivityAnalytics([record]);
        assert.deepEqual(calls.rows.map(row => row.workload), ["Files", "Files"]);
        assert.deepEqual(calls.rows.map(row => row.endpoint.apiVersion), [version, version]);
        originalIdentities ??= identities(calls.rows);
        assert.deepEqual(identities(calls.rows), originalIdentities);
        const bundle = await buildSanitizedBundle([record], "f".repeat(64), {
            promptMode: "none", formats: ["html", "pdf", "json", "markdown"],
        });
        assert.deepEqual(record, before);
        assert.deepEqual(bundle.snapshot.summary.services, ["Files"], "readable/JSON summary must agree with frozen facts");
        assert.deepEqual(bundle.snapshot.serviceCategories.map(category => category.id), ["Files"]);
        const facts = freezeEvaluationFacts(bundle.snapshot.evaluationFacts);
        assert.ok(facts.patterns.every(entry => entry.pattern.display.workload === "Files"));
        assert.ok(facts.patterns.every(entry => entry.pattern.display.endpoints.every(endpoint =>
            endpoint.pathTemplate === "/shares/{id}/driveItem" && endpoint.apiVersion === version)));
        const projected = buildActivityAnalytics(bundle.records, { filters: { scope: "all" } });
        assert.deepEqual(projected.rows.map(row => row.workload), ["Files", "Files"]);
        assert.deepEqual(projected.rows.map(row => row.endpoint.apiVersion), [version, version]);
        projectedIdentities ??= identities(projected.rows);
        assert.deepEqual(identities(projected.rows), projectedIdentities, "report pseudonym IDs, outcomes and withheld times are stable across equivalent forms");
        frozenOutcomeBytes ??= JSON.stringify(facts.recordedOutcomes);
        assert.equal(JSON.stringify(facts.recordedOutcomes), frozenOutcomeBytes);
        assert.equal(calls.totals.count, 2);
        assert.deepEqual([calls.totals.success, calls.totals.failure], [1, 1]);
        assert.deepEqual([projected.totals.success, projected.totals.failure], [1, 1]);
        const texts = [bundle.files["product-report.html"], bundle.files["product-report.md"],
            bundle.files["product-report.json"], await pdfText(bundle.files["product-report.pdf"])];
        for (const content of texts) {
            assert.match(content, /Files/);
            assert.match(content.replaceAll("\\{", "{").replaceAll("\\}", "}"), /\/shares\/\{id\}\/driveItem|\/shares\/\{withheld\}\/driveItem/);
            assert.doesNotMatch(content, /Service not shown|INVENTED-OPAQUE-SHARING-TOKEN|INVENTED-PRIVATE-QUERY/);
        }
        const shape = routeShape(input + query);
        assert.equal(normalizeEndpoint(shape).apiVersion, version);
        assert.equal(normalizeEndpoint(shape).path, "/shares/{id}/driveItem");
        assert.doesNotMatch(JSON.stringify(shape), /INVENTED/);
        if (earlierSaved) assert.equal(JSON.stringify(earlierSaved), earlierSavedBytes, "earlier saved in-memory bytes remain unchanged");
        else {
            earlierSaved = bundle.files;
            earlierSavedBytes = JSON.stringify(bundle.files);
        }
    });
});

test("hostile/lookalike origins and unsupported shared paths never receive shared-file report attribution", async t => {
    const denied = [
        "https://graph.microsoft.com.evil.invalid/v1.0" + route,
        "https://graph.microsoft.com@evil.invalid/v1.0" + route,
        "https://name:secret@graph.microsoft.com/v1.0" + route,
        "https://graph.microsoft.com:444/v1.0" + route,
        "http://graph.microsoft.com/v1.0" + route,
        "//graph.microsoft.com/v1.0" + route,
    ];
    for (const [index, target] of denied.entries()) await t.test(`untrusted-origin-${index + 1}`, async () => {
        const record = recordFor(target);
        assert.deepEqual(buildActivityAnalytics([record]).rows.map(row => row.workload), ["Unknown", "Unknown"], target);
        const bundle = await buildSanitizedBundle([record], "f".repeat(64), { promptMode: "none", formats: ["json", "html", "markdown"] });
        assert.deepEqual(bundle.snapshot.serviceCategories.map(category => category.id), ["Unknown"], target);
        assert.ok(bundle.snapshot.evaluationFacts.patterns.every(entry => entry.pattern.display.workload === "Unknown"), target);
        assert.notEqual(normalizeEndpoint(routeShape(target)).path, "/shares/{id}/driveItem", target);
        assert.doesNotMatch(JSON.stringify(bundle.snapshot.records), /INVENTED-OPAQUE|evil\.invalid|name:secret/);
    });
    for (const target of ["/v1.0/shares/id/driveItems", "https://graph.microsoft.com/v1.0/shares/id/driveitem", "/v2.0" + route, "/me" + route]) {
        assert.ok(buildActivityAnalytics([recordFor(target)]).rows.every(row => row.workload !== "Files"), target);
        assert.notEqual(normalizeEndpoint(routeShape(target)).path, "/shares/{id}/driveItem", target);
    }
});
