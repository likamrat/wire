import test from "node:test";
import assert from "node:assert/strict";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { createTextAccess } from "../web/text-access.mjs";
import { projectPrompts } from "../lib/prompt-projection.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCorpusSources } from "../lib/search-corpus-sources.mjs";
import { inventedSource } from "./search-corpus-fixture.mjs";
import { indexSearchText, rankTextSearch } from "../lib/search-text.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";

const automatic = {
    text: "", status: "full", authorship: { actor: "unknown", basis: "conflicting-source" },
    capture: { version: 1, kind: "automatic-continuation", original: "empty", hostContext: "not-collected", reason: null },
};

test("automatic activity is not a recording failure or a claim of verified agent authorship", () => {
    const access = createTextAccess({}, {}, promptAuthorship, {});
    const before = structuredClone(automatic);
    assert.equal(access.describePrompt(automatic).label, "Author unverified (automatic continuation)");
    assert.equal(access.describePrompt(automatic).notice, "Work continued without a new message.");
    assert.equal(promptAuthorship.read(automatic).actor, "unknown");
    assert.deepEqual(automatic, before);
});

test("new report copies distinguish automatic activity from missing original text without inventing content", () => {
    const projected = projectPrompts({ userPrompt: automatic, followUpPrompts: [], toolCalls: [] }, "synthetic",
        { promptMode: "original" });
    assert.equal(projected.prompts[0].text, null);
    assert.equal(projected.prompts[0].activityState, "automatic");
    assert.equal(projected.prompts[0].availabilityNote, "No new message was sent.");
    assert.equal(projected.coverage.unavailable, 0);
    assert.equal(projected.coverage.noNewMessage, 1);
});

test("unknown, excluded, conflicting and deleted originals never become normal automatic activity", () => {
    for (const value of [
        { ...automatic, status: "unavailable", text: null },
        { ...automatic, capture: { ...automatic.capture, conflict: true } },
        { ...automatic, capture: { ...automatic.capture, original: "recorded" } },
        { ...automatic, capture: { ...automatic.capture, version: 99 } },
        { ...automatic, capture: undefined },
    ]) {
        assert.notEqual(promptAuthorship.availability(value).state, "automatic");
        assert.notEqual(createTextAccess({}, {}, promptAuthorship, {}).describePrompt(value).notice, "No new message was sent.");
    }
    const legacy = { text: "", status: "full", authorship: { actor: "agent", basis: "autopilot" } };
    assert.equal(promptAuthorship.availability(legacy).state, "automatic");
    assert.equal(promptAuthorship.capture(legacy), null);
    assert.equal(promptAuthorship.availability({ text: "", status: "full" }).state, "unavailable");
    assert.equal(promptAuthorship.availability({ ...automatic, status: "partial" }).state, "unavailable");
});

test("real Search and all report formats agree on normal automatic activity without rewriting retained bytes", async t => {
    const records = ["first", "second"].map(id => ({ ...fixture(id), followUpPrompts: [],
        userPrompt: { ...automatic, ...(id === "first" ? { authorship: { actor: "agent", basis: "autopilot" } } : {}),
            sourceEventId: `prompt-${id}`, sourceTimestamp: "2026-09-30T12:00:00.000Z" } }));
    const { context } = await privateFixture(t, records);
    const state = await loadBoardState(context), retainedFile = path.join(context.dataDir, "private-evidence", state.evidenceFile);
    const bytes = await readFile(retainedFile);
    const preview = await createExportController(context).preview("capture-proof", undefined, {
        promptMode: "original", formats: ["html", "json", "markdown", "pdf"], recordedContext: true,
    }, { kind: "selected", revision: state.revision, scenarioIds: records.map(record => record.scenarioId),
        promptAuthors: ["user", "agent", "unknown"] });
    assert.equal(preview.snapshot.promptCoverage.unavailable, 0);
    assert.equal(preview.snapshot.promptCoverage.noNewMessage, 2);
    assert.equal(preview.snapshot.recordedContext.coverage.noNewMessage, 2);
    for (const name of ["product-report.html", "product-report.md"]) {
        assert.match(preview.files[name], /Agent prompt \(automatic continuation\)/);
        assert.match(preview.files[name], /Author unverified \(automatic continuation\)/);
        assert.match(preview.files[name], /Work continued without a new message/);
        assert.doesNotMatch(preview.files[name], /Automatic continuation: Source text unavailable|Originating prompt omitted or unavailable/);
    }
    for (const record of preview.records) assert.equal(record.prompts.find(prompt => prompt.kind === "origin").activityState, "automatic");
    const json = await extractReportFile({ format: "json", snapshot: preview.snapshot,
        manifest: JSON.parse(preview.files["coverage-and-redaction-manifest.json"]) });
    const pdf = await extractReportFile({ format: "pdf", bytes: Buffer.from(preview.files["product-report.pdf"].data, "base64") });
    for (const copy of [json, pdf]) assert.match(copy.content, /Agent prompt \(automatic continuation\)/);
    assert.match(json.content, /No\s+new\s+message\s+was\s+sent/);
    assert.match(pdf.content, /Work continued without a new message/);
    const frame = await createCorpusSources(context, { source: inventedSource }).scan();
    const interactions = frame.entries.filter(entry => entry.type === "interaction");
    assert.equal(interactions.length, 2);
    assert.ok(interactions.every(entry => /^(Agent prompt|Author unverified) \(automatic continuation\)$/.test(entry.title) && entry.content === ""
        && entry.coverage.activityState === "automatic" && entry.coverage.availabilityNote === "No new message was sent."));
    assert.equal(frame.issues.filter(issue => issue.types.includes("interaction") && issue.code === "text-unavailable").length, 0);
    const matches = await rankTextSearch(interactions.map(indexSearchText), "Automatic continuation", ["interaction"], new AbortController().signal);
    assert.equal(matches.length, 2);
    const agents = await rankTextSearch(interactions.map(indexSearchText), "Agent prompt", ["interaction"], new AbortController().signal);
    assert.equal(agents.length, 1);
    assert.deepEqual(await readFile(retainedFile), bytes);
    assert.deepEqual((await loadBoardState(context)).evidence, state.evidence);
});
