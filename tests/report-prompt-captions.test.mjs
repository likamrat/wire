import test from "node:test";
import assert from "node:assert/strict";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { fixture } from "./helpers.mjs";

for (const provenance of ["human-authored", "coordinator-message", "recorded-user-message-origin-unverified"]) {
    test(`new report prompt captions stay neutral for ${provenance}`, async () => {
        const source = fixture(`captions-${provenance}`);
        source.userPrompt = { text: "SYNTHETIC_PROMPT_CAPTION", status: "full", provenance };
        source.followUpPrompts = [];
        source.toolCalls.push({
            tool: "workiq-search_paths", toolCallId: "caption-query", startEventId: "caption-query-start",
            requestArgs: { query: "/me/messages", filter: "SYNTHETIC_API_FILTER" },
            reportedOutcome: "succeeded", toolSucceeded: true, apiResults: [],
        }, {
            tool: "workiq-ask", toolCallId: "caption-question", startEventId: "caption-question-start",
            requestArgs: { question: "SYNTHETIC_TOOL_QUESTION" }, reportedOutcome: "unknown", toolSucceeded: null, apiResults: [],
        });
        const before = structuredClone(source);
        const bundle = await buildSanitizedBundle([source], "a".repeat(64), { promptMode: "masked", formats: ["html", "json", "markdown"] });
        assert.match(bundle.previewHtml, /<h4>Prompt<\/h4>/);
        assert.match(bundle.previewHtml, /Reviewed prompt excerpt:/);
        assert.match(bundle.previewHtml, /<h4>Recorded tool argument · Tool 2: query<\/h4>/);
        assert.match(bundle.previewHtml, /<h4>Recorded tool argument · Tool 2: filter<\/h4>/);
        assert.match(bundle.previewHtml, /<h4>Recorded tool argument · Tool 3: question<\/h4>/);
        assert.match(bundle.files["product-report.md"], /\*\*Prompt\*\*/);
        assert.match(bundle.files["product-report.md"], /\*\*Recorded tool argument/);
        assert.doesNotMatch(bundle.previewHtml, /Human prompt|Agent-to-tool prompt|Reviewed request excerpt/);
        assert.equal(bundle.records[0].prompts.find(prompt => prompt.kind === "origin").label, "Original request", "Stored projection label is not renamed");
        assert.equal(JSON.parse(bundle.files["product-report.json"]).records[0].prompts.find(prompt => prompt.kind === "origin").label, "Original request");
        assert.deepEqual(source, before);
    });
}
