import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import { execFile, fork } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import path from "node:path";
import { fixture, privateFixture } from "./helpers.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedReportFile, readSavedReportDocument, reportHash, createSavedArtifactDescriptor, SAVED_REPORT_MAX_BYTES } from "../lib/report-artifacts.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { pdfDocumentText, pdfParserEnvironment } from "../lib/search-corpus-pdf.mjs";
import { createSearchCorpus } from "../lib/search-corpus.mjs";
import { createCorpusSources } from "../lib/search-corpus-sources.mjs";
import { createDeletionController } from "../lib/deletion.mjs";

async function save(context, exports, promptMode, formats, { recordedContext = false, scenarioId } = {}) {
    const state = await loadBoardState(context);
    const preview = await exports.preview("format-fixture", undefined, { promptMode, formats, recordedContext },
        scenarioId ? { kind: "selected", revision: state.revision, scenarioIds: [scenarioId] } : { kind: "all", revision: state.revision });
    await exports.review("format-fixture", preview.previewId, true);
    return (await exports.confirm("format-fixture", preview.previewId, true)).bundle;
}
async function corpusItems(corpus) {
    let items, receipt;
    const status = await corpus.index(entries => entries, (value, token) => { items = value; receipt = token; });
    assert.ok(items, JSON.stringify(status));
    return { items, receipt, status };
}
async function isolatedRuntime(root, bytes) {
    const directory = path.join(root, "omit-dev");
    await mkdir(directory);
    for (const name of ["package.json", "package-lock.json"]) await copyFile(new URL(`../${name}`, import.meta.url), path.join(directory, name));
    const worker = path.join(directory, "parser.mjs");
    await copyFile(new URL("../lib/search-corpus-pdf-worker.mjs", import.meta.url), worker);
    const npmArgs = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
    const run = promisify(execFile);
    if (process.platform === "win32") await run(process.env.ComSpec, ["/d", "/s", "/c", `npm ${npmArgs.join(" ")}`], { cwd: directory });
    else await run("npm", npmArgs, { cwd: directory });
    const installed = JSON.parse(await readFile(path.join(directory, "node_modules", "pdfjs-dist", "package.json")));
    assert.equal(installed.version, "6.3.289");
    await assert.rejects(readFile(path.join(directory, "node_modules", "@playwright", "test", "package.json")), { code: "ENOENT" });
    return new Promise((resolve, reject) => {
        const child = fork(worker, [], { cwd: directory, execPath: process.execPath, execArgv: ["--disallow-code-generation-from-strings"],
            serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], env: pdfParserEnvironment() });
        let result;
        child.once("message", value => { result = value; });
        child.once("error", reject);
        child.once("close", code => {
            if (code !== 0 || result?.ok !== true) reject(new Error(`Isolated production parser failed (${result?.code ?? "process"}).`));
            else resolve(result);
        });
        child.send({ bytes, maxBytes: 32 * 1024 * 1024 });
    });
}

async function corpusParserCancellation(t, context) {
    for (const action of ["invalidate", "close", "supersede"]) {
        const started = Promise.withResolvers(), originalFork = childProcess.fork;
        const mocked = t.mock.method(childProcess, "fork", (modulePath, args, options) => {
            assert.equal(path.basename(String(modulePath)), "search-corpus-pdf-worker.mjs");
            assert.equal(options.execPath, process.execPath);
            assert.deepEqual(options.execArgv, ["--disallow-code-generation-from-strings"]);
            assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
            const child = originalFork(modulePath, args, options);
            started.resolve(child);
            return child;
        });
        syncBuiltinESMExports();
        const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
        let child;
        try {
            const pending = corpus.rebuild();
            child = await Promise.race([started.promise, pending.then(() => { throw new Error("The fixture did not start a PDF parser."); })]);
            let replacement;
            if (action === "supersede") { replacement = corpus.rebuild(); corpus.close(); }
            else corpus[action]();
            assert.ok(["superseded", "closed"].includes((await pending).state));
            if (replacement) await replacement;
            assert.equal(child.killed, true, `${action} must cancel the actual active PDF parser`);
        } finally {
            corpus.close();
            if (child?.exitCode === null && child.signalCode === null) child.kill();
            mocked.mock.restore();
            syncBuiltinESMExports();
        }
    }
}

test("nine real single-format bundles retain reviewed mode/content and parse in an isolated omit-dev runtime", { timeout: 180000 }, async t => {
    const records = retainedContextFixture().records.slice(0, 2), record = records[0];
    record.userPrompt.text = "FORMAT_ORIGIN_CANARY Ask format-person@example.invalid.\n<script>literal example</script>\npassword='FORMAT_SECRET'";
    record.userPrompt.status = "partial";
    records[1].userPrompt.text = "FORMAT_FOLLOWUP_CANARY remains sufficient.";
    record.followUpPrompts[0].text = records[1].userPrompt.text;
    record.followUpPrompts.push({ status: "unavailable", text: null });
    records[1].followUpPrompts = [];
    for (const item of records) for (const call of item.toolCalls) call.requestArgs = { entityUrls: ["/me/drive/root/children"] };
    record.notes = "FORMAT_HIDDEN_SIDE_FIELD";
    const { context, root } = await privateFixture(t, records), exports = createExportController(context);
    await seedRetainedReply(context, inventedSource(), "FORMAT_CONTEXT_REPLY_CANARY Contact reply-context@example.invalid.");
    const saved = [], hashes = new Map();
    let productionPdf;
    for (const mode of ["original", "masked", "none"]) for (const format of ["json", "markdown", "pdf"]) {
        const artifact = await save(context, exports, mode, [format], { recordedContext: true, scenarioId: record.scenarioId });
        saved.push({ mode, format, artifact });
        for (const file of Object.values(artifact.files)) hashes.set(file, reportHash(await readFile(file)));
        const file = await readSavedReportFile(context, await loadBoardState(context), artifact.bundleId);
        assert.equal(file.format, format);
        const result = await extractReportFile(file);
        assert.equal(result.content.includes("FORMAT_ORIGIN_CANARY"), mode !== "none", `${format}/${mode} originating text`);
        assert.equal(result.content.includes("FORMAT_FOLLOWUP_CANARY"), mode !== "none", `${format}/${mode} follow-up text`);
        assert.equal(result.content.includes("format-person@example.invalid"), mode === "original", `${format}/${mode} masking`);
        assert.equal(result.content.includes("FORMAT_CONTEXT_REPLY_CANARY"), mode !== "none", `${format}/${mode} frozen reply`);
        assert.equal(result.content.includes("reply-context@example.invalid"), mode === "original", `${format}/${mode} reply masking`);
        assert.doesNotMatch(result.content, /FORMAT_SECRET|FORMAT_HIDDEN_SIDE_FIELD/);
        if (format === "json") {
            assert.equal(file.snapshot.records.length, 1, "Context does not enlarge analytical membership");
            assert.equal(Boolean(file.snapshot.recordedContext), mode !== "none");
            if (mode !== "none") {
                assert.ok(result.coverage.contextPartial > 0);
                assert.ok(result.coverage.contextUnavailable > 0);
                assert.match(result.content, /unverified/);
                for (const entry of file.snapshot.recordedContext.entries) assert.equal(result.content.includes(entry.key), false);
                const tampered = structuredClone(file);
                tampered.manifest.recordedContextHash = "0".repeat(64);
                await assert.rejects(extractReportFile(tampered), { code: "report-context-integrity" });
                const oneSided = structuredClone(file);
                delete oneSided.manifest.recordedContext;
                await assert.rejects(extractReportFile(oneSided), { code: "report-context-integrity" });
                const badShape = structuredClone(file);
                badShape.snapshot.recordedContext.extra = "HIDDEN_EXTRA";
                badShape.manifest.recordedContext = structuredClone(badShape.snapshot.recordedContext);
                badShape.manifest.recordedContextHash = reportHash(JSON.stringify(badShape.snapshot.recordedContext));
                await assert.rejects(extractReportFile(badShape), { code: "report-context-invalid" });
                const privateCopy = structuredClone(file), frozen = privateCopy.snapshot.recordedContext;
                frozen.entries.find(entry => entry.kind === "response" && entry.text !== null).text =
                    mode === "masked" ? "UNMASKED_CONTEXT private@example.invalid" : "password='UNREMOVED_CONTEXT_SECRET'";
                frozen.coverage.projectedBytes = frozen.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text ?? ""), 0);
                privateCopy.manifest.recordedContext = structuredClone(frozen);
                privateCopy.manifest.recordedContextHash = reportHash(JSON.stringify(frozen));
                await assert.rejects(extractReportFile(privateCopy), { code: "report-context-private-pattern" });
            }
        }
        if (format === "pdf") {
            assert.ok(result.coverage.pages >= 1);
            assert.equal(result.coverage.representation, "pdf-text-layer");
            if (mode === "original") productionPdf = file.bytes;
        }
    }
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    const { items, status } = await corpusItems(corpus), reports = items.filter(item => item.type === "report");
    assert.equal(reports.length, 9, JSON.stringify(status));
    for (const { mode, format, artifact } of saved) {
        const item = reports.find(item => item.target.bundleId === artifact.bundleId);
        assert.equal(item.target.kind, "open-saved-report-file");
        assert.equal(item.target.format, format);
        assert.equal(item.coverage.textMode, mode);
        const file = await readSavedReportFile(context, await loadBoardState(context), item.target.bundleId, item.target.format);
        assert.equal(file.sha256, item.target.documentHash);
        assert.equal(file.manifestHash, item.target.manifestHash);
    }
    for (const [file, hash] of hashes) assert.equal(reportHash(await readFile(file)), hash, "Reading never rewrites frozen bytes");
    await corpusParserCancellation(t, context);
    const production = await isolatedRuntime(root, productionPdf);
    assert.match(production.text, /FORMAT_ORIGIN_CANARY/);
    assert.match(production.text, /FORMAT_CONTEXT_REPLY_CANARY/);
    t.diagnostic("9 single-format artifacts with accepted recordedContext; 3 real PDF renders; omit-dev PDF.js 6.3.289 text extraction succeeded with development test dependency absent.");
});

test("format preference distinguishes genuine absence from corruption and keeps HTML legacy reader behavior", async t => {
    const { context } = await privateFixture(t), exports = createExportController(context);
    const html = await save(context, exports, "none", ["html", "json"]), json = await save(context, exports, "none", ["json", "markdown"]);
    let state = await loadBoardState(context);
    assert.equal((await readSavedReportFile(context, state, html.bundleId)).format, "html");
    assert.equal((await readSavedReportFile(context, state, json.bundleId)).format, "json");
    const htmlDocument = await readSavedReportDocument(context, state, html.bundleId);
    assert.equal(htmlDocument.html, await readFile(html.files["product-report.html"], "utf8"));
    const legacy = structuredClone(state), legacyEntry = legacy.exports.find(entry => entry.bundleId === html.bundleId);
    delete legacyEntry.formats;
    assert.equal((await readSavedReportDocument(context, legacy, html.bundleId)).sha256, htmlDocument.sha256);
    await writeFile(html.files["product-report.html"], "BROKEN_PREFERRED_HTML");
    await assert.rejects(readSavedReportFile(context, state, html.bundleId), { status: 409 });
    await unlink(json.files["product-report.json"]);
    await assert.rejects(readSavedReportFile(context, state, json.bundleId), { status: 404 });
    await assert.rejects(readSavedReportFile(context, state, html.bundleId, "../outside"), { status: 422 });
    await updateBoardState(context, value => { value.exports.find(entry => entry.bundleId === html.bundleId).files["product-report.html"] = path.join(context.dataDir, "outside.html"); });
    state = await loadBoardState(context);
    await assert.rejects(readSavedReportFile(context, state, html.bundleId), { status: 422 });
});

test("non-HTML artifact deletion and replacement fence cached and late results", async t => {
    const { context } = await privateFixture(t), exports = createExportController(context);
    const artifact = await save(context, exports, "original", ["markdown"]);
    const corpus = createSearchCorpus(context, { source: inventedSource, onInvalidate: () => {} });
    const { items, receipt } = await corpusItems(corpus), item = items.find(item => item.target.bundleId === artifact.bundleId);
    const sources = createCorpusSources(context, { source: inventedSource }), frame = await sources.scan();
    const original = await readFile(artifact.files["product-report.md"]);
    await writeFile(artifact.files["product-report.md"], "REPLACED_SOURCE");
    await assert.rejects(sources.current(frame, () => { assert.fail("No late file disclosure"); }), { status: 409 });
    let disclosed = false;
    await corpus.deliver({ ...receipt, hits: [{ id: item.id, revision: item.revision }] }, () => { disclosed = true; });
    assert.equal(disclosed, false);
    await writeFile(artifact.files["product-report.md"], original);
    const deletion = createDeletionController(context, { describeSavedArtifact: createSavedArtifactDescriptor(context), onSeal: () => corpus.invalidate() });
    const preview = await deletion.previewArtifact("format-fixture", { artifactKind: "report", artifactId: artifact.bundleId });
    await deletion.confirmArtifact("format-fixture", { operationId: preview.operationId, confirmed: true });
    assert.equal((await corpusItems(corpus)).items.some(item => item.target.bundleId === artifact.bundleId), false);
});

test("PDF parser errors and active cancellation settle without returning text", async () => {
    await assert.rejects(pdfDocumentText(Buffer.from("NOT_A_PDF")), { code: "pdf-invalid" });
    await assert.rejects(pdfDocumentText(unembeddedFontPdf("q 0 0 m 1 1 l S Q")), { code: "pdf-no-text" });
    const brokenIndex = unembeddedFontPdf("q 0 0 m 1 1 l S Q").toString().replace(/startxref\n\d+/, "startxref\n0");
    await assert.rejects(pdfDocumentText(Buffer.from(brokenIndex)), { code: "pdf-invalid" });
    await assert.rejects(pdfDocumentText(Buffer.alloc(SAVED_REPORT_MAX_BYTES + 1)), { code: "pdf-byte-limit" });
    const controller = new AbortController(), pending = pdfDocumentText(Buffer.from("NOT_A_PDF"), { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { code: "pdf-cancelled" });
});

function unembeddedFontPdf(stream = "BT /F1 12 Tf 40 700 Td (INVENTED_PDF_TEXT) Tj ET") {
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let bytes = "%PDF-1.7\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(bytes));
        bytes += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(bytes);
    bytes += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) bytes += `${String(offset).padStart(10, "0")} 00000 n \n`;
    bytes += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(bytes);
}

test("nonembedded PDF resources are denied and parent disconnection leaves no parser helper", { timeout: 10000 }, async t => {
    assert.ok(Object.keys(pdfParserEnvironment()).every(key => ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].includes(key)));
    await assert.rejects(pdfDocumentText(unembeddedFontPdf(), { signal: t.signal }), { code: "pdf-external-resource" });
    await new Promise((resolve, reject) => {
        const child = fork(new URL("../lib/search-corpus-pdf-worker.mjs", import.meta.url), [], {
            execPath: process.execPath, execArgv: ["--disallow-code-generation-from-strings"],
            serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], env: pdfParserEnvironment(),
        });
        t.after(() => { if (child.exitCode === null) child.kill(); });
        child.once("error", reject);
        child.once("exit", () => resolve());
        child.send({ bytes: unembeddedFontPdf(), maxBytes: 32 * 1024 * 1024 }, () => child.disconnect());
    });
});
