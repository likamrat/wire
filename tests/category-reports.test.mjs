import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { assertProjectedBundle } from "../lib/privacy.mjs";
import { renderHtmlReport, renderMarkdownReport } from "../lib/product-report.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { fixture } from "./helpers.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function source() {
    const record = fixture("synthetic-category-report");
    record.toolCalls[0].apiResults = [];
    record.toolCalls.push({
        tool: "workiq-retrieve", toolCallId: "synthetic-retrieval",
        requestArgs: { query: ["SYNTHETIC search request"] },
        toolSucceeded: true, reportedOutcome: "succeeded", apiResults: [],
    });
    return record;
}
async function pdfText(bytes) {
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const doc = await task.promise;
    try {
        const pages = [];
        for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n), viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            for (const item of content.items.filter((item) => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1);
            }
            pages.push(content.items.map((item) => item.str ?? "").join(" "));
        }
        return pages.join(" ").replace(/\s+/g, " ");
    } finally { await task.destroy(); }
}

for (const promptMode of ["none", "masked", "original"]) test(`${promptMode}: used-only category definitions travel in all four frozen formats`, { timeout: 60000 }, async () => {
    const original = source(), before = structuredClone(original);
    const bundle = await buildSanitizedBundle([original], "a".repeat(64), {
        promptMode, formats: ["html", "pdf", "json", "markdown"],
        timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" },
    });
    const snapshot = JSON.parse(bundle.files["product-report.json"]);
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    const definitions = serviceCategories.used(["Calendar", "Search"]);
    assert.deepEqual(snapshot.serviceCategories, definitions);
    assert.deepEqual(bundle.snapshot.serviceCategories, definitions);
    const html = bundle.files["product-report.html"], markdown = bundle.files["product-report.md"], pdf = await pdfText(bundle.files["product-report.pdf"]);
    for (const text of [html, markdown, pdf]) {
        assert.match(text, /Activity categories in this report/);
        for (const definition of definitions) assert.ok(text.includes(definition.description), definition.id);
        for (const definition of serviceCategories.entries.filter((entry) => !["Calendar", "Search"].includes(entry.id))) assert.ok(!text.includes(definition.description), definition.id);
    }
    assert.match(html, /<section[^>]*class="service-glossary"/);
    assert.doesNotMatch(html, /title="Meeting and calendar/);
    assert.equal(manifest.snapshotHash, hash(JSON.stringify(bundle.snapshot)));
    for (const [name, bytes] of Object.entries(bundle.files).filter(([name]) => name !== "coverage-and-redaction-manifest.json")) assert.equal(manifest.files[name].sha256, hash(bytes));
    assert.deepEqual(original, before);
    assert.equal(bundle.privacy.reviewerConfirmed, false);
    assert.doesNotThrow(() => assertProjectedBundle(bundle));
});

test("category glossary does not add unused services, counts, source prose, or synthetic records", async () => {
    await assert.rejects(buildSanitizedBundle([], "a".repeat(64)), /non-empty exact selection/);
    assert.doesNotMatch(renderHtmlReport([]), /Services in this report/);
    assert.doesNotMatch(renderMarkdownReport([]), /Services in this report/);
    const synthetic = source(); synthetic.sample = true;
    const excluded = await buildSanitizedBundle([synthetic], "a".repeat(64), { formats: ["json"] });
    assert.deepEqual(excluded.snapshot.serviceCategories, []);
    const unknown = fixture("unclassified");
    unknown.toolCalls[0].requestedApiPath = "/unclassified";
    unknown.toolCalls[0].requestArgs = { entityUrls: ["/unclassified"] };
    unknown.toolCalls[0].apiResults = [];
    const bundle = await buildSanitizedBundle([unknown], "a".repeat(64), { formats: ["json", "html", "markdown"] });
    assert.deepEqual(bundle.snapshot.serviceCategories, serviceCategories.used(["Unknown"]));
    assert.match(bundle.files["product-report.html"], /does not mean the call failed/);
    assert.equal(bundle.snapshot.serviceCategories.some((entry) => Object.hasOwn(entry, "count")), false);
    assert.equal(bundle.snapshot.serviceCategories.some((entry) => Object.values(entry).some((text) => text.includes("SYNTHETIC_PRIVATE_PROMPT"))), false);
    const records = bundle.records;
    assert.ok(renderHtmlReport(records).includes(serviceCategories.describe("Unknown").description));
    assert.ok(renderMarkdownReport(records).includes(serviceCategories.describe("Unknown").description));
});
