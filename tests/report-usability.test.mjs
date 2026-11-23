import test from "node:test";
import assert from "node:assert/strict";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

test("known empty retained prompts export as explicitly unavailable without altering source", async t => {
    const source = fixture();
    source.userPrompt = { status: "full", text: "" };
    source.followUpPrompts = [{ status: "full", text: "   " }];
    const { context } = await privateFixture(t, [source]);
    const before = await loadBoardState(context);
    const controller = createExportController(context);
    const preview = await controller.preview("synthetic", undefined, { promptMode: "masked", formats: ["json", "markdown"] }, { kind: "all", revision: before.revision });
    assert.equal(preview.snapshot.promptCoverage.unavailable, 2);
    assert.equal(preview.snapshot.promptCoverage.included, 0);
    for (const p of preview.records[0].prompts) {
        assert.equal(p.status, "unavailable");
        assert.equal(p.sourceStatus, "full");
        assert.equal(p.text, null);
        assert.match(p.availabilityNote, /empty/i);
    }
    assert.match(preview.files["product-report.md"], /source marked full/i);
    assert.deepEqual(await loadBoardState(context), before);
    controller.discard("synthetic");
    source.userPrompt = { status: "made-up", text: "" };
    await assert.rejects(buildSanitizedBundle([source], "a".repeat(64)), /coverage is unsupported/);
    source.userPrompt = { status: "full", text: null };
    await assert.rejects(buildSanitizedBundle([source], "a".repeat(64)), /coverage is unsupported/);
});

test("bounded examples retain the highlighted late failure and disclose excluded calls", async () => {
    const source = fixture();
    source.toolCalls = Array.from({ length: 18 }, (_, i) => ({
        ...structuredClone(source.toolCalls[0]), toolCallId: `ordered-${i}`, order: i + 1,
        startEventId: `start-${i}`, completionEventId: `complete-${i}`,
        reportedOutcome: i === 14 ? "failed" : "succeeded", toolSucceeded: i !== 14,
    }));
    const bundle = await buildSanitizedBundle([source], "a".repeat(64), { promptMode: "none", formats: ["html", "markdown"] });
    assert.match(bundle.previewHtml, /11 earlier and 0 later calls are outside this bounded example/);
    assert.match(bundle.files["product-report.md"], /\| 15 \| workiq-fetch \| .*? \| failed \|/);
    assert.match(bundle.files["product-report.md"], /11 earlier and 0 later calls are outside this bounded example/);
});
