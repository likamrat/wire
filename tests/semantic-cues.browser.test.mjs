import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { buildSanitizedBundle, buildSanitizedRecord } from "../lib/export.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { renderHtmlReport } from "../lib/product-report.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { fixture } from "./helpers.mjs";

const proofs = process.env.WORKIQ_CUE_PROOFS;
if (proofs) await mkdir(proofs, { recursive: true });
const charts = createDimensionalCharts(), results = createRecordedResults();
const records = [
    ["/me/messages"], ["/me/events"], ["/me/drive"], ["/teams"], ["/me/people"], ["/planner/tasks"],
    ["/me/onenote/pages"], ["/groups"], ["/search/query"], ["/me/events", "/unclassified"], ["/$batch"], ["/unclassified"], ["/me/messages"],
].map((targets, index) => {
    const record = fixture(`semantic-cue-${index}`);
    record.sourceSessionName = "Synthetic cue examples";
    record.toolCalls[0] = {
        ...record.toolCalls[0], requestedApiPath: targets.length === 1 ? targets[0] : null,
        tool: index === 12 ? "workiq-get_schema" : record.toolCalls[0].tool,
        requestArgs: index === 12 ? { path: "/me/messages", operationType: "fetch" } : { entityUrls: targets }, startedAt: "2026-09-30T12:00:00Z",
        toolSucceeded: [true, false, null, null][index % 4],
        reportedOutcome: ["succeeded", "failed", "unknown", "partial"][index % 4], apiResults: [],
    };
    return record;
});
const iconName = markup => /data-lucide-icon="([^"]+)"/.exec(markup)[1];
const expectedServices = serviceCategories.entries.map(entry => ({
    ...serviceCategories.display(entry.id), tone: charts.tone(entry.id), icon: iconName(dimensionalIcons[entry.id]),
}));

test("all outcome and classifier cues keep the canonical semantic palette and glyphs", () => {
    assert.deepEqual(charts.outcomeTones, { success: "teal", failure: "pink", partial: "orange", unknown: "slate", other: "violet", transport: "cyan" });
    assert.deepEqual(Object.fromEntries(expectedServices.map(entry => [entry.id, entry.tone])), {
        Mail: "service-mail", Calendar: "service-calendar", Files: "service-files", Teams: "service-teams", People: "service-people", Tasks: "service-tasks",
        Notes: "service-notes", Directory: "service-directory", Search: "service-search", Discovery: "service-discovery", "Multiple workloads": "service-multiple", "Platform metadata": "service-diagnostics", Unknown: "service-unknown",
    });
    const serialized = Function(`return (${createRecordedResults.toString()})()`)();
    for (const [key, icon] of Object.entries({ success: "check", failure: "result-failure", unknown: "unobserved", partial: "result-partial", other: "result-other", transport: "result-transport" })) {
        assert.equal(results.icon(key), icon); assert.equal(serialized.icon(key), icon);
        assert.equal(results.entries("tool", results.summarize([{ id: "one", outcome: key }]))[0].icon, icon);
    }
    assert.throws(() => results.icon("unrecorded-value"), /recorded outcome/);
    assert.equal(charts.tone("group:other"), "service-other");
});

test("catalog-selected reports preserve frozen service facts in HTML, JSON and bounded PDF text", { timeout: 60000 }, async () => {
    const original = structuredClone(records);
    const catalog = buildExportCatalog(records);
    assert.deepEqual(catalog.records.map(record => record.scenarioId), records.filter((_, index) => index !== 10).map(record => record.scenarioId));
    assert.equal(catalog.excluded.requestGroupsWithoutEligibleEvidence, 1);
    assert.equal(catalog.excluded.platformDiagnosticEvidenceRecords, 1);
    assert.equal(catalog.excluded.excludedOrDuplicateEvidenceRecords, 1);
    await assert.rejects(buildSanitizedBundle([records[10]], "a".repeat(64), { promptMode: "none", formats: ["json"] }), /Invalid frozen result facts/);
    const bundle = await buildSanitizedBundle(catalog.records, "a".repeat(64), { promptMode: "none", formats: ["html", "pdf", "json"] });
    assert.deepEqual(records, original);
    assert.equal(bundle.privacy.reviewerConfirmed, false);
    const snapshot = JSON.parse(bundle.files["product-report.json"]);
    for (const entry of snapshot.serviceCategories) assert.deepEqual(Object.keys(entry), ["id", "label", "description"]);
    const services = snapshot.evaluationFacts.serviceInvolvement;
    assert.equal(services.denominator, 12);
    assert.ok(services.groups.length > 0);
    const html = bundle.files["product-report.html"], network = [], reportMeasurements = [];
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ javaScriptEnabled: false });
        await page.route("**/*", route => { network.push(route.request().url()); return route.abort(); });
        await page.setContent(html);
        for (const media of ["screen", "print"]) for (const width of media === "screen" ? [375, 820, 1200] : [820]) {
            await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ media });
            const section = page.locator("#breakdowns>section").filter({ has: page.getByRole("heading", { name: "Services", exact: true }) });
            const measured = await section.evaluate(node => ({
                labels: [...node.querySelectorAll(".native-bar-heading>span")].map(row => row.textContent),
                values: [...node.querySelectorAll(".native-bar")].map(row => ({ count: Number(row.dataset.count), denominator: Number(row.dataset.denominator) })),
                overflow: document.documentElement.scrollWidth - innerWidth,
                clipped: [...node.querySelectorAll(".native-bar-heading")].filter(row => row.scrollWidth > row.clientWidth + 1).map(row => row.textContent),
            }));
            assert.ok(measured.overflow <= 1);
            assert.deepEqual(measured.clipped, []);
            assert.deepEqual(measured.labels, services.groups.map(group => serviceCategories.describe(group.service).label));
            assert.deepEqual(measured.values, services.groups.map(group => ({ count: group.count, denominator: services.denominator })));
            assert.match(await section.textContent(), /Each call counts once per service; services overlap/);
            assert.match(await page.locator("#coverage").textContent(), new RegExp(`Service definition: ${services.definition.id} v${services.definition.version}`));
            reportMeasurements.push({ media, width, ...measured });
            if (proofs && width === 820) await section.screenshot({ path: path.join(proofs, `synthetic-report-${media}.png`) });
        }
        assert.deepEqual(network, []);
    } finally { await browser.close(); }
    const loading = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    const document = await loading.promise, pages = [];
    try {
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, item.str);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, item.str);
            }
            const text = content.items.map(item => item.str ?? "").join(" "); pages.push(text);
            if (proofs && text.includes("Services in this report")) {
                const view = page.getViewport({ scale: 1.5 }), canvas = document.canvasFactory.create(Math.ceil(view.width), Math.ceil(view.height));
                await page.render({ canvasContext: canvas.context, viewport: view }).promise;
                await writeFile(path.join(proofs, `synthetic-pdf-page-${number}.png`), canvas.canvas.toBuffer("image/png"));
                document.canvasFactory.destroy(canvas);
            }
        }
    } finally { await loading.destroy(); }
    const text = pages.join(" ").replace(/\s+/g, " ");
    for (const group of services.groups) assert.ok(text.includes(serviceCategories.describe(group.service).label), group.service);
    assert.match(text, /Each call counts once per service; services overlap/);
    assert.ok(text.includes(`Service definition: ${services.definition.id} v${services.definition.version}`));
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_PRIVATE_FOLLOWUP/);
    if (proofs) {
        await writeFile(path.join(proofs, "synthetic-report.html"), html);
        await writeFile(path.join(proofs, "synthetic-report.pdf"), bundle.files["product-report.pdf"]);
        await writeFile(path.join(proofs, "synthetic-report-proof.json"), JSON.stringify({ pages: pages.length, services: snapshot.serviceCategories, network, sourceUnchanged: true, reviewerConfirmed: false, measurements: reportMeasurements }, null, 2));
    }
});

test("script-free human report rendering covers even categories withheld by the current privacy path projection", { timeout: 30000 }, async () => {
    // These invented structural paths exercise the renderer, not disclosure approval.
    // The genuine bundle test above keeps the existing projection completely intact.
    const projectedFixture = records.map((source, index) => {
        const record = buildSanitizedRecord(source, "a".repeat(64));
        delete record.userPrompt;
        delete record.followUpPrompts;
        return {
        ...record, projectionVersion: 3, promptMode: "none", prompts: [], toolCalls: record.toolCalls.map(call => ({
            ...call,
            requestedApiPath: records[index].toolCalls[0].requestedApiPath,
            requestArgs: structuredClone(records[index].toolCalls[0].requestArgs),
        })),
    }; });
    const html = renderHtmlReport(projectedFixture);
    const browser = await chromium.launch(), measurements = [];
    try {
        const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 820, height: 1000 } });
        await page.route("**/*", route => { throw new Error(`No network in synthetic report: ${route.request().url()}`); });
        await page.setContent(html);
        for (const media of ["screen", "print"]) {
            await page.emulateMedia({ media });
            const measured = await page.locator(".service-glossary").evaluate(node => ({
                labels: [...node.querySelectorAll("dt")].map(row => row.textContent),
                overflow: document.documentElement.scrollWidth - innerWidth,
            }));
            assert.ok(measured.overflow <= 1);
            assert.deepEqual(measured.labels, serviceCategories.entries.map(entry => entry.label));
            measurements.push({ media, ...measured });
            if (proofs) await page.locator(".service-glossary").screenshot({ path: path.join(proofs, `all-service-report-${media}.png`) });
        }
    } finally { await browser.close(); }
    const bytes = await renderPdf(html);
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const pdf = await loading.promise, text = [];
    try {
        for (let number = 1; number <= pdf.numPages; number++) {
            const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, item.str);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, item.str);
            }
            text.push(content.items.map(item => item.str ?? "").join(" "));
        }
    } finally { await loading.destroy(); }
    for (const entry of serviceCategories.entries) assert.ok(text.join(" ").replace(/\s+/g, " ").includes(entry.label), entry.id);
    assert.doesNotMatch(text.join(" "), /SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_PRIVATE_FOLLOWUP/);
    if (proofs) {
        await writeFile(path.join(proofs, "all-service-renderer-report.html"), html);
        await writeFile(path.join(proofs, "all-service-renderer-report.pdf"), bytes);
        await writeFile(path.join(proofs, "all-service-renderer-report-proof.json"), JSON.stringify({ syntheticRendererFixture: true, disclosureApproved: false, measurements }, null, 2));
    }
});
