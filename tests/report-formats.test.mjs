import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle, createExportController, writeBundle } from "../lib/export.mjs";
import { assertProjectedBundle } from "../lib/privacy.mjs";
import { normalizeReportOptions, projectPrompts } from "../lib/prompt-projection.mjs";
import { loadBoardState, moveCard, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { fontDataUrl, uiFontStack } from "../lib/typeface.mjs";
import { readSavedReportFile, readSavedArtifactFile } from "../lib/report-artifacts.mjs";

export function reportFixture() {
    const source = fixture();
    source.userPrompt.text = "PROMPT_CANARY Ask Leila Navarro\nleila@example.invalid at +1 (206) 555-0199\nhttps://tenant.example.invalid/private\npassword='tiny!'\n-----BEGIN PRIVATE KEY-----\nSECRET_KEY_CANARY\n-----END PRIVATE KEY-----\nUnicode: Montréal, Αθήνα.\n<script>globalThis.promptExecuted=true</script>\n" +
        "Long retained wording with useful context. ".repeat(550) + "\nPROMPT_FINAL_CANARY";
    source.followUpPrompts = [{ status: "full", text: "FOLLOWUP_CANARY\nAsk Leila Navarro to reply.", provenance: "human-authored" }];
    source.title = "PRIVATE_SIDE_TITLE " + source.userPrompt.text;
    source.notes = "PRIVATE_SIDE_NOTE password=ANOTHER_SECRET";
    source.toolCalls.push({
        tool: "workiq-ask", toolCallId: "ask-synthetic", requestArgs: { question: "QUESTION_CANARY\nleila@example.invalid and password=TOKEN_CANARY" },
        reportedOutcome: "unknown", apiResults: [],
    }, {
        tool: "workiq-retrieve", toolCallId: "retrieve-synthetic", requestArgs: { query: ["QUERY_ONE_CANARY Leila Navarro", "QUERY_TWO_CANARY\nMontréal"] },
        reportedOutcome: "succeeded", toolSucceeded: true, apiResults: [],
    });
    return source;
}

export async function pdfText(bytes) {
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
    const doc = await task.promise;
    try {
        const pages = [];
        for (let number = 1; number <= doc.numPages; number++) {
            const page = await doc.getPage(number), viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            for (const item of content.items.filter((item) => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, `PDF page ${number} text must not clip horizontally`);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, `PDF page ${number} text must be on-page`);
            }
            pages.push(content.items.map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join(""));
        }
        return { pages, pageCount: doc.numPages, text: pages.join("\n") };
    } finally { await task.destroy(); }
}

test("a report title is one reviewed identity across preview, four files and saved metadata", async t => {
    const { context } = await privateFixture(t, [fixture("titled-report")]);
    const controller = createExportController(context), state = await loadBoardState(context);
    const title = "Release exercise - Calendar requests";
    const preview = await controller.preview("title-flow", undefined, {
        title, promptMode: "none", formats: ["html", "pdf", "json", "markdown"],
    }, { kind: "all", revision: state.revision });
    assert.equal(preview.title, title);
    assert.equal(preview.snapshot.title, title);
    assert.equal(JSON.parse(preview.files["product-report.json"]).title, title);
    assert.equal(JSON.parse(preview.files["coverage-and-redaction-manifest.json"]).title, title);
    assert.ok(preview.previewHtml.includes(`<title>WIRE - ${title}</title>`));
    assert.ok(preview.previewHtml.includes(title + "</h1>"));
    assert.ok(preview.files["product-report.md"].startsWith("# " + title + "\n"));
    assert.ok((await pdfText(Buffer.from(preview.files["product-report.pdf"].data, "base64"))).text.includes(title));
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await controller.review("title-flow", preview.previewId, true);
    const saved = (await controller.confirm("title-flow", preview.previewId, true)).bundle;
    assert.equal(saved.title, title);
    const after = await loadBoardState(context);
    assert.equal(after.exports[0].title, title);
    const file = await readSavedReportFile(context, after, saved.bundleId, "html");
    assert.equal(file.artifact.title, title);
    assert.equal(file.canonicalTitle, title);
    for (const format of ["html", "pdf", "json", "markdown"]) {
        assert.equal((await readSavedReportFile(context, after, saved.bundleId, format)).canonicalTitle, title);
        assert.equal((await readSavedArtifactFile(context, after, saved.bundleId, "report", format)).canonicalTitle, title);
    }
    assert.equal(file.bytes.toString("utf8"), preview.previewHtml);
});

test("a saved report cannot present a different indexed title as the reviewed title", async t => {
    const { context } = await privateFixture(t, [fixture("title-integrity")]);
    const controller = createExportController(context), state = await loadBoardState(context);
    const preview = await controller.preview("title-integrity", undefined, {
        title: "Calendar requests", promptMode: "none", formats: ["html", "json"],
    }, { kind: "all", revision: state.revision });
    await controller.review("title-integrity", preview.previewId, true);
    const saved = (await controller.confirm("title-integrity", preview.previewId, true)).bundle;
    const after = await loadBoardState(context), changed = structuredClone(after);
    changed.exports.find(entry => entry.bundleId === saved.bundleId).title = "A different report";
    await assert.rejects(readSavedReportFile(context, changed, saved.bundleId, "html"), /title.*(?:changed|differ)/i);
    assert.equal(JSON.stringify(await loadBoardState(context)), JSON.stringify(after));
});

test("report titles are bounded, always masked metadata and remain inside disclosure integrity", async () => {
    for (const promptMode of ["none", "masked", "original"]) {
        const bundle = await buildSanitizedBundle([fixture("private-title")], "a".repeat(64), {
            title: "Plan for title.person@example.invalid password='TITLE_SECRET' private-project",
            promptMode, formats: ["html", "json", "markdown"], manualTerms: ["private-project"],
        });
        assert.doesNotMatch(bundle.title, /title\.person|TITLE_SECRET|private-project/);
        assert.match(bundle.title, /email identifier removed/);
        assert.match(bundle.title, /credential removed/);
        assert.match(bundle.title, /manual redaction/);
        assert.equal(bundle.privacy.reportTitle.allTitleFieldsScanned, true);
        assert.equal(bundle.privacy.reviewerConfirmed, false);
        for (const text of Object.values(bundle.files)) assert.doesNotMatch(text, /title\.person|TITLE_SECRET|private-project/);
        const changed = structuredClone(bundle);
        changed.title = "Not the reviewed title";
        assert.throws(() => assertProjectedBundle(changed), /title changed/);
    }
    for (const title of [null, 123, "A\nsecond line", "x".repeat(201)]) {
        assert.throws(() => normalizeReportOptions({ title }), /report title.*200 characters/);
    }
});

for (const promptMode of ["none", "masked", "original"]) test(`${promptMode}: four real formats share one snapshot and never leak credentials or side fields`, { timeout: 120000 }, async () => {
    const source = reportFixture(), before = structuredClone(source);
    const bundle = await buildSanitizedBundle([source], "a".repeat(64), { promptMode, formats: ["html", "pdf", "json", "markdown"], manualTerms: promptMode === "masked" ? ["Leila Navarro"] : [] });
    const snapshot = JSON.parse(bundle.files["product-report.json"]);
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    const extracted = await pdfText(bundle.files["product-report.pdf"]);
    assert.match(extracted.text, /WIRE - local report/);
    assert.match(extracted.text, /Work IQ Request Explorer/);
    assert.ok(bundle.files["product-report.md"].startsWith(`# ${bundle.title}\n`));
    assert.ok(bundle.files["product-report.html"].includes(`<title>WIRE - ${bundle.title}</title>`));
    assert.match(bundle.files["product-report.html"], /class="brand-logo" aria-hidden="true"/);
    assert.equal(bundle.files["product-report.pdf"].subarray(0, 5).toString(), "%PDF-");
    assert.deepEqual(snapshot.records, bundle.records);
    assert.equal(snapshot.promptMode, promptMode);
    assert.equal(manifest.snapshotHash, createHash("sha256").update(JSON.stringify(bundle.snapshot)).digest("hex"));
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.promptCoverage.total, 5);
    for (const name of ["product-report.html", "product-report.pdf", "product-report.json", "product-report.md"]) assert.equal(manifest.files[name].sha256, createHash("sha256").update(bundle.files[name]).digest("hex"));
    const texts = [bundle.files["product-report.html"], bundle.files["product-report.md"], bundle.files["product-report.json"], extracted.text];
    for (const text of texts) {
        assert.doesNotMatch(text, /SECRET_KEY_CANARY|TOKEN_CANARY|tiny!|PRIVATE_SIDE_NOTE|PRIVATE_SIDE_TITLE|ANOTHER_SECRET/);
        assert.ok(text.includes(bundle.bundleId));
        for (const canary of ["PROMPT_CANARY", "FOLLOWUP_CANARY", "QUESTION_CANARY", "QUERY_ONE_CANARY", "QUERY_TWO_CANARY", "PROMPT_FINAL_CANARY"]) assert.equal(text.includes(canary), promptMode !== "none", canary);
        assert.equal(text.includes("leila@example.invalid"), promptMode === "original");
        assert.equal(text.includes("Leila Navarro"), promptMode === "original");
    }
    if (promptMode !== "none") {
        assert.ok(extracted.pageCount >= 5, "Long prompts must paginate, not clip");
        assert.ok(extracted.text.includes("Montréal"));
        assert.ok(extracted.text.includes("Αθήνα"));
        assert.ok(bundle.files["product-report.html"].includes("&lt;script&gt;"));
        assert.ok(bundle.files["product-report.md"].includes("    <script>"));
        assert.ok(bundle.records[0].prompts[0].text.includes("[private key removed]"));
        assert.ok(manifest.promptCoverage.mandatoryRemovals >= 3);
    }
    const paintIds = new Set([...bundle.files["product-report.html"].matchAll(/<(?:linearGradient|filter|clipPath) id="(dimensional-[a-z0-9-]+)"/g)].map(match => match[1]));
    assert.equal(bundle.files["product-report.html"].includes(fontDataUrl), true, "New readable reports embed the licensed Asta font independently of screen tokens");
    assert.ok(bundle.files["product-report.html"].includes(`--font:${uiFontStack}`));
    const withoutLocalChartPaint = bundle.files["product-report.html"].replace(`url("${fontDataUrl}")`, "").replace(/url\(#wire-(light|dark)-r-emergence\)/g, (_, theme) => {
        assert.ok(bundle.files["product-report.html"].includes(`<clipPath id="wire-${theme}-r-emergence">`));
        return "";
    }).replace(/url\(#(wire-dark-wire-(?:letter|cable)-ink)\)/g, (_, id) => {
        assert.ok(bundle.files["product-report.html"].includes(`<linearGradient id="${id}"`), "Bundled dark wordmark paint must resolve locally");
        return "";
    }).replace(/url\(#(dimensional-(?:\d+-(?:(?:orange|cyan|teal|pink|slate)(?:-side|-cap)?|cap|end|(?:success|failure|unknown|partial|other|transport)-(?:front|side))|plane-\d+(?:-(?:glass|reflection|shadow|surface))?))\)/g, (_, id) => {
        assert.ok(paintIds.has(id), "Every allowed chart paint/filter/clip fragment must name an existing local definition");
        return "";
    });
    assert.doesNotMatch(withoutLocalChartPaint, /<script|<(?:img|iframe|link)\b|@import|url\s*\(/i);
    assert.equal(bundle.privacy.reviewerConfirmed, false);
    assert.deepEqual(source, before);
    if (process.env.WORKIQ_REPORT_PROOFS) {
        const folder = path.join(process.env.WORKIQ_REPORT_PROOFS, promptMode);
        await mkdir(folder, { recursive: true });
        for (const [name, bytes] of Object.entries(bundle.files)) await writeFile(path.join(folder, name), bytes);
        await writeFile(path.join(folder, "pdf-extraction.json"), JSON.stringify(extracted, null, 2));
    }
});

test("manual copy edits and omissions re-mask credentials and cannot restore originals through side fields", async () => {
    const source = reportFixture();
    const first = projectPrompts(source, "safe", { promptMode: "masked" });
    const result = projectPrompts(source, "safe", { promptMode: "masked", overrides: [
        { key: first.prompts[0].key, text: "Edited for Leila.\npassword='new-secret' leila@example.invalid" },
        { key: first.prompts[1].key, omit: true },
    ] });
    assert.equal(result.prompts[0].representation, "edited-copy");
    assert.doesNotMatch(result.prompts[0].text, /new-secret|leila@example/);
    assert.equal(result.prompts[1].text, null);
    assert.equal(source.userPrompt.text.includes("PROMPT_CANARY"), true);
    assert.throws(() => normalizeReportOptions({ formats: [] }), /supported report format/);
    assert.throws(() => normalizeReportOptions({ promptMode: "raw", reviewed: true }), /supported report format/);
    await assert.rejects(buildSanitizedBundle([source], "a".repeat(64), { overrides: [{ key: "stale", text: "x" }] }), /no longer belongs/);
});

test("omitted, unavailable and partial text are disclosed, never reconstructed", async () => {
    const source = fixture();
    source.userPrompt = { status: "unavailable", text: null };
    source.followUpPrompts = [{ status: "partial", text: "Only retained fragment" }];
    const bundle = await buildSanitizedBundle([source], "a".repeat(64), { promptMode: "original", formats: ["json", "markdown"] });
    assert.equal(bundle.records[0].prompts[0].text, null);
    assert.equal(bundle.records[0].prompts[1].status, "partial");
    assert.equal(bundle.snapshot.promptCoverage.unavailable, 1);
    assert.equal(bundle.snapshot.promptCoverage.partial, 1);
    assert.match(bundle.files["product-report.md"], /unavailable; not reconstructed/);
});

test("format/mode/edit changes invalidate prior review; confirmation writes exactly the reviewed bytes", { timeout: 120000 }, async (t) => {
    const { context } = await privateFixture(t, [reportFixture()]);
    await moveCard(context, "test-scenario", "ready_to_export");
    const before = await loadBoardState(context);
    const controller = createExportController(context);
    let prior;
    for (const options of [
        { promptMode: "none" },
        { promptMode: "original", formats: ["json"] },
        { promptMode: "masked", formats: ["html", "pdf", "json", "markdown"], manualTerms: ["Leila Navarro"] },
    ]) {
        const next = await controller.preview("synthetic", ["test-scenario"], options);
        if (prior) await assert.rejects(controller.confirm("synthetic", prior.previewId, true), /not found/);
        prior = await controller.review("synthetic", next.previewId, true);
    }
    assert.deepEqual(await readdir(path.join(context.dataDir, "exports")), []);
    const response = await controller.confirm("synthetic", prior.previewId, true);
    for (const [name, value] of Object.entries(prior.files)) {
        const expected = typeof value === "string" ? Buffer.from(value) : Buffer.from(value.data, "base64");
        assert.deepEqual(await readFile(response.bundle.files[name]), expected);
    }
    assert.equal(response.state.cards["test-scenario"].workflowState, "ready_to_export");
    assert.equal(response.state.evidenceFile, before.evidenceFile);
    assert.equal(response.state.pseudonymKey, before.pseudonymKey);
    assert.deepEqual(response.bundle.formats, ["html", "pdf", "json", "markdown"]);
    const hashes = await Promise.all(Object.values(response.bundle.files).map(async (file) => createHash("sha256").update(await readFile(file)).digest("hex")));
    await moveCard(context, "test-scenario", "ready_to_export");
    const cancelled = await controller.preview("synthetic", ["test-scenario"], { promptMode: "original" });
    await controller.review("synthetic", cancelled.previewId, true);
    controller.cancel("synthetic", cancelled.previewId);
    await assert.rejects(controller.confirm("synthetic", cancelled.previewId, true), /not found/);
    assert.deepEqual(await Promise.all(Object.values(response.bundle.files).map(async (file) => createHash("sha256").update(await readFile(file)).digest("hex"))), hashes);
});

test("renderer failure, cancellation during rendering and tampered output cannot export", async (t) => {
    const { context } = await privateFixture(t);
    await moveCard(context, "test-scenario", "ready_to_export");
    const broken = createExportController(context, writeBundle, async () => { throw new Error("synthetic renderer unavailable"); });
    await assert.rejects(broken.preview("a", undefined, { formats: ["pdf"] }), /renderer unavailable/);
    const state = await loadBoardState(context);
    assert.equal(state.cards["test-scenario"].workflowState, "ready_to_export");
    assert.deepEqual(await readdir(path.join(context.dataDir, "exports")), []);
    let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const delayed = createExportController(context, writeBundle, async () => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const pending = delayed.preview("a", undefined, { formats: ["pdf"] });
    await started;
    delayed.discard("a");
    release(Buffer.from("%PDF-synthetic cancellation fixture"));
    await assert.rejects(pending, /cancelled|replaced/);
    const bundle = await buildSanitizedBundle([fixture()], "a".repeat(64));
    bundle.files["product-report.html"] += "injected";
    assert.throws(() => assertProjectedBundle(bundle), /integrity/);
    await replaceEvidence(context, (records) => ({ records, importCoverage: {} }));
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

test("expired review and missing selected format fail without writes; returned preview cannot mutate the frozen selection", async (t) => {
    const { context } = await privateFixture(t);
    await moveCard(context, "test-scenario", "ready_to_export");
    const controller = createExportController(context);
    const preview = await controller.preview("synthetic", undefined, { promptMode: "original", formats: ["json"] });
    preview.records[0].prompts[0].text = "MUTATED_CLIENT_CANARY";
    const reviewed = await controller.review("synthetic", preview.previewId, true);
    assert.doesNotMatch(reviewed.files["product-report.json"], /MUTATED_CLIENT_CANARY/);
    const now = Date.now;
    try {
        Date.now = () => now() + 11 * 60 * 1000;
        await assert.rejects(controller.confirm("synthetic", preview.previewId, true), /changed|expired/);
    } finally { Date.now = now; }
    assert.deepEqual(await readdir(path.join(context.dataDir, "exports")), []);
    assert.equal((await loadBoardState(context)).cards["test-scenario"].workflowState, "ready_to_export");
    const bundle = await buildSanitizedBundle([fixture()], "a".repeat(64), { formats: ["html", "json"] });
    delete bundle.files["product-report.json"];
    assert.throws(() => assertProjectedBundle(bundle), /selected report format is missing/);
});
