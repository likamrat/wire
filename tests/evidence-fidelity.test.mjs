import test from "node:test";
import assert from "node:assert/strict";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { fidelityEvents as events, collectFidelity as collect, legacyFidelityRecord, imageReminder, imageReferences } from "./evidence-fidelity-fixture.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { privateFixture } from "./helpers.mjs";
import { loadBoardState, mergeEvidenceWithState } from "../lib/store.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { promptInstallation } from "./prompt-authorship-fixture.mjs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { replaceEvidence } from "../lib/store.mjs";
import { qualifyRetainedPromptEvents } from "../lib/prompt-qualification.mjs";
import { discoverSources } from "../lib/source-discovery.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

test("status-only Work IQ failure survives the original-event to card/reader reason seam", () => {
    const record = collect(events()), call = record.toolCalls[0];
    assert.equal(call.toolSucceeded, false);
    assert.equal(call.resultEvidence.statusCode, 503);
    assert.deepEqual(call.apiResults, []);
    assert.equal(call.failureEvidence.diagnostic.status, "recorded");
    assert.equal(call.failureEvidence.diagnostic.statusCode, 503);
    assert.equal(createRecordedResults().failureReason(call),
        "Work IQ reported HTTP 503 (Service unavailable). No further error details are retained.");
});

test("host image-reference suffix does not erase direct input provenance during retention", () => {
    const record = collect(events());
    assert.deepEqual(record.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    assert.equal(record.userPrompt.text, events()[0].data.content);
});

test("rejected host layouts retain closed causes without relaxing original boundaries or sender guards", () => {
    for (const [layout, basis, issue] of [
        [content => "Different invented host body.", "invalid-source", "body-boundary-v1"],
        [content => content + "\nInvented trailing text.", "invalid-source", "body-boundary-v1"],
        [content => "<invented_context>UNTRUSTED_DIAGNOSTIC_MARKER</invented_context>\n\n" + content,
            "unsupported-source", "host-wrapper-v1"],
        [content => "<invented_context>UNTRUSTED_DIAGNOSTIC_MARKER</invented_context>\n\n" + content + imageReminder,
            "unsupported-source", "host-wrapper-v1"],
    ]) {
        const source = events(), event = source[0], original = event.data.content;
        event.data.transformedContent = `<current_datetime>${event.timestamp}</current_datetime>\n\n` + layout(original);
        const record = collect(source);
        assert.deepEqual(record.userPrompt.authorship, { actor: "unknown", basis, issue });
        assert.deepEqual(collect(source, { retained: false }).userPrompt.authorship, record.userPrompt.authorship);
        assert.equal(record.userPrompt.text, original);
        assert.equal(record.toolCalls[0].reportedOutcome, "failed");
        assert.doesNotMatch(JSON.stringify(record), /UNTRUSTED_DIAGNOSTIC_MARKER/);
        assert.deepEqual(promptAuthorship.correlateKickoff(record.userPrompt), record.userPrompt.authorship);
        event.data.source = "user";
        assert.deepEqual(collect(source).userPrompt.authorship, { actor: "user", basis: "source-user" },
            "A separate explicit supported source is not inferred from the rejected envelope.");
    }
    for (const authorship of [
        { actor: "user", basis: "source-user", issue: "body-boundary-v1" },
        { actor: "unknown", basis: "invalid-source", issue: "host-wrapper-v1" },
        { actor: "unknown", basis: "unsupported-source", issue: "UNTRUSTED_DIAGNOSTIC_MARKER" },
    ]) assert.deepEqual(promptAuthorship.read({ authorship }), { actor: "unknown", basis: "invalid-source" });
    const qualified = { authorshipVersion: promptAuthorship.version,
        authorship: { actor: "unknown", basis: "invalid-source", issue: "body-boundary-v1" } };
    assert.deepEqual(promptAuthorship.merge(qualified, {
        authorshipVersion: 6, authorship: { actor: "unknown", basis: "invalid-source" },
    }), qualified.authorship, "An older compact checkpoint cannot discard the retained qualification cause.");
});

test("ordinary collection preserves exact origin gaps through restart, normalized reading and generated reports", async t => {
    const app = await promptInstallation(t), file = app.sourceFiles[1];
    const source = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const human = app.cases.find(row => row.name === "human");
    const original = source.find(event => event.id === human.promptId);
    original.data.transformedContent = `<current_datetime>${original.timestamp}</current_datetime>\n\nInvented unmatched host body.`;
    await writeFile(file, source.map(event => JSON.stringify(event) + "\n").join(""));
    const sourceBytes = await readFile(file);
    await app.runtime().collector.collectNow();
    const before = await loadBoardState(app.context);
    const record = before.evidence.find(row => row.scenarioId === human.scenarioId);
    const expected = { actor: "unknown", basis: "invalid-source", issue: "body-boundary-v1" };
    assert.deepEqual(record.userPrompt.authorship, expected);
    const model = buildAssessmentModel(before);
    const detail = model.details.get(model.catalog.find(row => row.scenarioId === human.scenarioId).interactionRef);
    assert.deepEqual(detail.interaction.message.authorship, expected);
    const bundle = await buildSanitizedBundle([record], before.pseudonymKey, {
        promptMode: "original", formats: ["html", "markdown", "json", "pdf"],
    });
    assert.deepEqual(bundle.snapshot.records[0].prompts.find(prompt => prompt.kind === "origin").authorship, expected);
    for (const format of ["html", "md"]) assert.match(bundle.files[`product-report.${format}`],
        /could not match the original prompt to a supported host message layout/);
    const loading = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    try {
        const document = await loading.promise, pages = [];
        for (let index = 1; index <= document.numPages; index++) {
            const page = await document.getPage(index), content = await page.getTextContent();
            pages.push(content.items.map(item => item.str ?? "").join(" "));
        }
        assert.match(pages.join(" ").replace(/\s+/g, " "),
            /could not match the original prompt to a supported host message layout/);
    } finally { await loading.destroy(); }
    await app.restart();
    await app.runtime().collector.collectNow();
    const after = await loadBoardState(app.context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.exports, before.exports);
    assert.deepEqual(await readFile(file), sourceBytes);
});

test("direct extraction and retention agree without manufacturing returned entries, causes or bodies", () => {
    for (const status of [200, 403, 429, 500, 503, 504]) {
        const source = events();
        source.at(-1).data.error.message = "MCP server 'workiq': " + JSON.stringify({
            statusCode: status, data: { nested: { error: "EXCLUDED_BODY_ERROR" } }, requestId: "EXCLUDED_REQUEST_ID",
        });
        const retained = collect(source), direct = collect(source, { retained: false }), call = retained.toolCalls[0];
        for (const field of ["failureEvidence", "resultEvidence", "apiResults", "reportedOutcome", "toolSucceeded"]) {
            assert.deepEqual(call[field], direct.toolCalls[0][field]);
        }
        assert.equal(call.failureEvidence.diagnostic.statusCode, status);
        assert.equal(call.failureEvidence.diagnostic.message, undefined);
        assert.equal(call.reportedOutcome, "failed");
        assert.deepEqual(call.apiResults, []);
        assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_|sha256:|screen\.png/);
        assert.match(createRecordedResults().failureReason(call), new RegExp(`HTTP ${status}`));
    }
    const minimal = events();
    minimal[0].data = { content: "Invented request." };
    minimal.at(-1).data.error.message = 'MCP server \'workiq\': {"statusCode":503}';
    assert.equal(collect(minimal).toolCalls[0].failureEvidence.diagnostic.statusCode, 503);
});

test("image references are neutral only when they match original attachment metadata", () => {
    for (const [actor, basis] of [["user", "host-direct-input"], ["agent", "host-agent-envelope"], ["unknown", "missing-source"]]) {
        const source = events(actor), record = collect(source);
        assert.deepEqual(record.userPrompt.authorship, { actor, basis });
        assert.deepEqual(record.userPrompt.authorship, collect(source, { retained: false }).userPrompt.authorship);
        const model = buildAssessmentModel({ revision: 1, pseudonymKey: "a".repeat(64), evidence: [record], exports: [] });
        assert.deepEqual([...model.details.values()][0].interaction.message.authorship, { actor, basis });
    }
    const edit = change => {
        const source = events();
        change(source[0].data);
        return collect(source).userPrompt.authorship;
    };
    for (const change of [
        data => { delete data.attachments; },
        data => { data.attachments[0].assetId = "sha256:" + "2".repeat(64); },
        data => { data.attachments[0].mimeType = "text/plain"; },
        data => { data.transformedContent += "\n<cross_session_message>Untrusted sender</cross_session_message>"; },
        data => { data.transformedContent = data.transformedContent.replace('"attachment":1', '"attachment":0'); },
        data => { data.transformedContent = data.transformedContent.replace('"attachment":1', '"attachment":1,"sender":"user"'); },
        data => { data.transformedContent = data.transformedContent.replace(/\]$/, ",null]"); },
        data => { data.transformedContent += "x".repeat(65537); },
    ]) assert.deepEqual(edit(change), { actor: "unknown", basis: "invalid-source" });
    assert.equal(edit(data => {
        data.content += imageReminder + imageReferences + '[{"attachment":1,"image_id":"invented"}]';
        data.transformedContent = "<current_datetime>2026-10-01T12:00:00.000Z</current_datetime>\n\n" + data.content;
    }).actor, "user", "User-typed tags are content, not host provenance");
    const agent = events("agent");
    agent[0].data.source = "user";
    assert.deepEqual(collect(agent).userPrompt.authorship, { actor: "unknown", basis: "conflicting-source" });
    assert.equal(promptAuthorship.fromEvent(events()[0], { agentCreatedFirstMessage: true }).actor, "unknown");
});

test("literal image-reference samples remain content before supported host attachment suffixes", () => {
    const literal = 'Explain this literal sample:' + imageReminder + imageReferences + '[{"attachment":1,"image_id":"invented"}]';
    const canvas = "\n\n<canvas-context>\nA supported attached panel.\n</canvas-context>";
    for (const [actor, basis] of [["user", "host-direct-input"], ["agent", "host-agent-envelope"]]) {
        for (const attachment of ["canvas", "image"]) {
            const source = events(actor), data = source[0].data;
            const offset = data.transformedContent.indexOf(data.content);
            const prefix = data.transformedContent.slice(0, offset), imageSuffix = data.transformedContent.slice(offset + data.content.length);
            data.content = literal;
            data.transformedContent = prefix + literal + (attachment === "canvas" ? canvas : imageSuffix);
            if (attachment === "canvas") delete data.attachments;
            for (const retained of [false, true]) {
                const prompt = collect(source, { retained }).userPrompt;
                assert.deepEqual(prompt.authorship, { actor, basis });
                assert.equal(prompt.text, literal);
            }
            if (actor === "agent") {
                data.source = "user";
                assert.deepEqual(collect(source).userPrompt.authorship, { actor: "unknown", basis: "conflicting-source" });
            }
        }
    }
});

test("image-reference-looking canvas content cannot intercept the host suffix boundary", () => {
    const source = events(), data = source[0].data;
    const prefix = data.transformedContent.slice(0, data.transformedContent.indexOf(data.content));
    data.transformedContent = prefix + data.content + "\n\n<canvas-context>\n" + data.content
        + imageReminder + imageReferences + '[{"attachment":1,"image_id":"invented"}]\n</canvas-context>';
    delete data.attachments;
    assert.deepEqual(collect(source).userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
});

test("retained status is readable without rewriting legacy evidence or promoting unknown authors", async t => {
    const legacy = legacyFidelityRecord(), before = structuredClone(legacy);
    const { context } = await privateFixture(t, [legacy]);
    const state = await loadBoardState(context), records = mergeEvidenceWithState(state);
    const call = records[0].toolCalls[0];
    assert.equal(createRecordedResults().failureReason(call),
        "The tool reported HTTP 503 (Service unavailable). No further error details are retained.");
    assert.equal(promptAuthorship.read(records[0].userPrompt).actor, "unknown");
    assert.deepEqual(records[0].userPrompt, before.userPrompt);
    assert.deepEqual(call, before.toolCalls[0]);
    assert.deepEqual(await loadBoardState(context), state);
});

test("status-only display preserves exclusion and conflict limits rather than claiming the source omitted text", () => {
    const results = createRecordedResults(), original = collect(events()).toolCalls[0];
    assert.doesNotMatch(results.failureReason(original), /were supplied|timed out|retry/i);
    for (const [status, expected] of [["sensitive-excluded", "excluded for privacy"], ["size-excluded", "exceeded the saving limit"]]) {
        const call = legacyFidelityRecord().toolCalls[0];
        call.failureEvidence.diagnostic.status = status;
        assert.match(results.failureReason(call), new RegExp(`HTTP 503.*${expected}`));
    }
    const conflict = legacyFidelityRecord().toolCalls[0];
    conflict.resultEvidence.statusCode = null;
    conflict.resultEvidence.statusConflict = { structured: 503, text: 200 };
    assert.doesNotMatch(results.failureReason(conflict), /HTTP 503|HTTP 200/);
    const source = events();
    source.at(-1).data.success = true;
    const call = collect(source).toolCalls[0];
    assert.equal(call.reportedOutcome, "succeeded");
    assert.equal(call.failureEvidence, undefined);
    assert.equal(call.resultEvidence.statusCode, null, "A successful tool's error-field prose is not proof of a returned HTTP response");
});

test("new author and error facts reach exact filters and report artifacts without changing outcomes", async () => {
    const records = ["user", "agent", "unknown"].map(actor => collect(events(actor), { sessionId: `invented-${actor}` }));
    for (const actor of ["user", "agent", "unknown"]) {
        const rows = buildActivityAnalytics(records, { layer: "tool", filters: { scope: "all", includeMetadata: true, promptAuthors: [actor] } }).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, "failure");
        assert.equal(rows[0].workload, "Unknown", "The routing target does not establish a named downstream service");
        assert.equal(rows[0].sourceSessionId, `invented-${actor}`);
    }
    const bundle = await buildSanitizedBundle(records, "a".repeat(64), { promptMode: "masked", resultText: true,
        formats: ["json", "html", "markdown"] });
    for (const call of bundle.snapshot.resultFacts.calls) {
        assert.equal(call.completion, "failed");
        assert.equal(call.observations[0].statusCode, 503);
        assert.equal(call.observations[0].errorStatusCode, 503);
        assert.equal(call.observations[0].diagnosticStatus, "recorded");
        assert.equal(call.observations[0].errorTextAvailable, false);
        assert.deepEqual(call.observations[0].returnedEntries, []);
    }
    for (const [name, bytes] of Object.entries(bundle.files)) {
        assert.doesNotMatch(bytes, /EXCLUDED_REQUEST_ID|sha256:1{64}|C:\\\\invented/);
        if (/\.(html|md)$/.test(name)) assert.match(bytes, /503/);
    }
});

test("normal collection qualifies new envelopes but restart and ordinary append preserve faithful v5 author caches", async t => {
    const app = await promptInstallation(t), human = app.cases.find(row => row.name === "human");
    const file = app.sourceFiles[1], source = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const original = source.find(event => event.id === human.promptId);
    original.data = events("user", Date.parse(original.timestamp))[0].data;
    await writeFile(file, source.map(event => JSON.stringify(event) + "\n").join(""));
    await app.runtime().collector.collectNow();
    let state = await loadBoardState(app.context);
    const record = state.evidence.find(row => row.scenarioId === human.scenarioId);
    assert.deepEqual(record.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    assert.equal(record.userPrompt.authorshipVersion, promptAuthorship.version);
    const v5Prompt = prompt => ({ ...prompt, authorshipVersion: 5,
        ...(prompt.sourceEventId === human.promptId ? { authorship: { actor: "unknown", basis: "invalid-source" } } : {}) });
    await replaceEvidence(app.context, () => ({ records: state.evidence.map(row => row.sourceSessionId === app.child ? {
        ...row, userPrompt: v5Prompt(row.userPrompt), followUpPrompts: row.followUpPrompts.map(v5Prompt),
    } : row), importCoverage: state.importCoverage }));
    const indexFile = path.join(app.context.dataDir, "collector", "index.json");
    let checkpointFile;
    await app.restart(async () => {
        const index = JSON.parse(await readFile(indexFile, "utf8"));
        checkpointFile = path.join(app.context.dataDir, "collector", index.fingerprint, `${app.child}.json`);
        const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
        assert.ok(checkpoint.events.some(event => event.id === human.promptId));
        for (const event of checkpoint.events.filter(event => event.type === "user.message")) {
            assert.equal(Object.hasOwn(event.data, "transformedContent"), false);
            assert.equal(Object.hasOwn(event.data, "attachments"), false);
            event.data.wirePromptAuthorshipVersion = 5;
            if (event.id === human.promptId) event.data.wirePromptAuthorship = { actor: "unknown", basis: "invalid-source" };
        }
        if (index.sources[app.child].promptEventQualification) index.sources[app.child].promptEventQualification.classifierVersion = 5;
        await writeFile(checkpointFile, JSON.stringify(checkpoint));
        await writeFile(indexFile, JSON.stringify(index));
    });
    await app.runtime().collector.collectNow();
    state = await loadBoardState(app.context);
    const legacy = state.evidence.find(row => row.scenarioId === human.scenarioId);
    assert.deepEqual(legacy.userPrompt.authorship, { actor: "unknown", basis: "invalid-source" });
    assert.equal(legacy.userPrompt.authorshipVersion, 5);
    const beforeAppend = JSON.parse(await readFile(indexFile, "utf8"));
    const cachedBefore = JSON.parse(await readFile(checkpointFile, "utf8")).events.find(event => event.id === human.promptId);
    assert.deepEqual(cachedBefore.data.wirePromptAuthorship, legacy.userPrompt.authorship);
    assert.equal(cachedBefore.data.wirePromptAuthorshipVersion, 5);
    const added = events("user", Date.now() - 35000);
    for (const event of added) {
        event.id = randomUUID();
        if (event.type === "user.message") event.data.messageId = randomUUID();
        else event.data.toolCallId = "invented-appended-call";
    }
    const appended = added.map(event => JSON.stringify(event) + "\n").join("");
    await appendFile(file, appended);
    await app.runtime().collector.collectNow();
    const afterAppend = await loadBoardState(app.context), afterIndex = JSON.parse(await readFile(indexFile, "utf8"));
    const old = afterAppend.evidence.find(row => row.scenarioId === human.scenarioId);
    assert.deepEqual(old.userPrompt, legacy.userPrompt);
    assert.deepEqual(old.toolCalls, legacy.toolCalls);
    assert.equal(afterAppend.evidence.length, state.evidence.length + 1);
    const fresh = afterAppend.evidence.find(row => row.userPrompt.sourceEventId === added[0].id);
    assert.deepEqual(fresh.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    assert.equal(fresh.userPrompt.authorshipVersion, promptAuthorship.version);
    assert.ok(afterIndex.sources[app.child].cursor.offset > beforeAppend.sources[app.child].cursor.offset);
    assert.deepEqual(afterIndex.sources[app.child].promptEventQualification, beforeAppend.sources[app.child].promptEventQualification);
    assert.deepEqual(JSON.parse(await readFile(checkpointFile, "utf8")).events.find(event => event.id === human.promptId), cachedBefore);
    state = afterAppend;
    const discovery = await discoverSources(app.config);
    const mapped = discovery.roster.find(row => row.sessionId === app.child);
    const preview = await qualifyRetainedPromptEvents(app.config, mapped, [legacy], undefined, 32 * 1024 * 1024);
    assert.deepEqual(preview.updates, [{ eventId: human.promptId, authorship: { actor: "user", basis: "host-direct-input" } }]);
    assert.deepEqual(await loadBoardState(app.context), state, "Read-only qualification does not publish an author correction");
    assert.equal(await readFile(file, "utf8"), source.map(event => JSON.stringify(event) + "\n").join("") + appended);
});
