import test from "node:test";
import assert from "node:assert/strict";
import { projectNativeReportCopies, validateNativeReportCopies } from "../lib/native-report-copies.mjs";
import { projectRetainedNativeRecords } from "../lib/retained-population.mjs";
import { chatFixture } from "./native-read-model-fixtures.mjs";
import { chatSource, nativeCallsSource } from "./native-chat-source-fixtures.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { retainNativeChatSourceObservations } from "../lib/native-read-model.mjs";
import { reportContextRef } from "../lib/report-context.mjs";

const key = "7".repeat(64);
const records = () => projectRetainedNativeRecords(chatFixture()).records;

test("native prompt copies use existing options without implicitly including assistant context", () => {
    const source = records(), before = JSON.stringify(source);
    const result = projectNativeReportCopies(source, key);
    assert.equal(result.copies.length, 3);
    assert.deepEqual(result.copies.map(copy => copy.author), ["user", "assistant", "assistant"]);
    assert.equal(result.copies[0].text, "An invented question.");
    assert.ok(result.copies.slice(1).every(copy => copy.text === null && copy.omitted && copy.exclusion === "context-not-selected"));
    assert.equal(result.review.length, 1);
    assert.equal(result.coverage.included, 1);
    assert.equal(result.coverage.omitted, 2);
    assert.doesNotMatch(JSON.stringify(result.copies), /invented-(?:tenant|subject|chat-conversation|user|reply)|sourceDocument|original/);
    assert.equal(JSON.stringify(source), before);
});

test("context is explicit and none omits all native text including private review copies", () => {
    const source = records();
    const included = projectNativeReportCopies(source, key, { recordedContext: true, promptMode: "original" });
    assert.equal(included.coverage.included, 3);
    assert.equal(included.review.length, 3);
    const omitted = projectNativeReportCopies(source, key, { recordedContext: true, promptMode: "none" });
    assert.equal(omitted.coverage.included, 0);
    assert.ok(omitted.copies.every(copy => copy.text === null && copy.omitted));
    assert.equal(omitted.review.length, 0);
    assert.doesNotMatch(JSON.stringify(omitted), /An invented|First invented/);
});

test("provider Progress uses reviewed context rather than becoming a prompt or tool outcome", () => {
    const decoded = decodeNativeChatObservation(chatSource({
        messageId: "invented-progress", author: "bot", messageType: "Progress", text: "Checking recorded sources.",
    }));
    const source = projectRetainedNativeRecords(retainNativeChatSourceObservations(decoded)).records;
    const excluded = projectNativeReportCopies(source, key);
    assert.equal(excluded.copies.length, 1);
    assert.equal(excluded.copies[0].text, null);
    assert.equal(excluded.copies[0].exclusion, "context-not-selected");
    const included = projectNativeReportCopies(source, key, { recordedContext: true });
    assert.equal(included.copies[0].kind, "provider-progress");
    assert.equal(included.copies[0].author, "unknown");
    assert.equal(included.copies[0].purpose, "context");
    assert.equal(included.copies[0].text, "Checking recorded sources.");
    assert.equal(included.review.length, 1);
    assert.doesNotMatch(JSON.stringify(included.copies), /sourceDocument|nativeCallId|outcome/);
});

test("native invocation display fields are context copies and never dump call input literals", () => {
    const source = projectRetainedNativeRecords(retainNativeChatSourceObservations(decodeNativeChatObservation(nativeCallsSource()))).records;
    const result = projectNativeReportCopies(source, key, { recordedContext: true });
    assert.ok(result.copies.some(copy => copy.text === "invented_lookup" && copy.purpose === "context"));
    assert.ok(result.copies.some(copy => copy.text === "invented_second" && copy.purpose === "context"));
    assert.doesNotMatch(JSON.stringify(result), /First invented query|RAW_METADATA_NOT_RETAINED|RAW_ERROR_PROSE_NOT_RETAINED/);
    assert.ok(result.copies.every(copy => copy.author === "unknown"));
});

test("task update names and status literals cross context review without exporting excluded narrative", () => {
    const decoded = decodeNativeChatObservation(chatSource({
        messageId: "invented-task-message", messageType: "Task",
        text: JSON.stringify([{ type: "task", taskId: "invented-task", conversationId: "invented-chat-conversation",
            name: "Invented task", status: "Completed", result: "RAW_TASK_RESULT_NOT_RETAINED",
            steps: [{ id: "invented-step", stepTitle: "Invented step", status: "Running",
                description: "RAW_STEP_PROSE_NOT_RETAINED" }] }]),
    }));
    const source = projectRetainedNativeRecords(retainNativeChatSourceObservations(decoded)).records;
    const result = projectNativeReportCopies(source, key, { recordedContext: true });
    for (const text of ["Invented task", "Completed", "Invented step", "Running"]) {
        assert.ok(result.copies.some(copy => copy.text === text && copy.purpose === "context"));
    }
    assert.ok(result.copies.every(copy => copy.author === "unknown"));
    assert.doesNotMatch(JSON.stringify(result), /RAW_TASK_RESULT|RAW_STEP_PROSE|invented-step|invented-task-message/);
});

test("unrecognized native representation metadata cannot bypass text disclosure", () => {
    const source = structuredClone(records());
    source[0].nativeConversation.messages[0].value.representation = "UNREVIEWED_SOURCE_TEXT";
    assert.throws(() => projectNativeReportCopies(source, key), { status: 422 });
});

test("all selected native source fields are screened even when their text is not selected", () => {
    const source = structuredClone(records());
    source[0].nativeConversation.observations[0].fields.input = {
        availability: "recorded", value: { password: "EXAMPLE_ONLY" },
    };
    assert.throws(() => projectNativeReportCopies(source, key, { promptMode: "none" }), { status: 422 });
});

test("clarification questions and choices stay unknown-author reviewed context", () => {
    const actionId = "clarification_ask_user_question";
    const decoded = decodeNativeChatObservation(chatSource({
        messageId: "invented-clarification", messageType: "TriggerExtension", actionId,
        invocation: JSON.stringify([{ callId: "invented-call-correlation", function: {
            name: actionId, arguments: JSON.stringify({ questions: [{ question: "Invented choice",
                options: [{ role: "action", label: "Continue", submitResponse: "invented-continue",
                    description: "Recorded choice description" }] }] }),
        } }]),
    }));
    const source = projectRetainedNativeRecords(retainNativeChatSourceObservations(decoded)).records;
    const result = projectNativeReportCopies(source, key, { recordedContext: true });
    for (const text of ["Invented choice", "Continue", "invented-continue", "Recorded choice description", actionId]) {
        assert.ok(result.copies.some(copy => copy.text === text && copy.kind === "clarification"));
    }
    assert.ok(result.copies.every(copy => copy.author === "unknown" && copy.purpose === "context"));
    assert.doesNotMatch(JSON.stringify(result), /invented-call-correlation|sourceDocument/);
});

test("confirmation actions are reviewed as prospective context and unsupported bodies stay withheld", () => {
    const decoded = decodeNativeChatObservation(chatSource({
        messageId: "invented-confirmation", messageType: "TriggerConfirmation",
        confirmationMetadata: { prose: "RAW_CONFIRMATION_METADATA" },
        adaptiveCards: [{ body: [{ text: "RAW_CARD_PROSE" }], actions: [
            { type: "Action.Submit", data: { message: { actionId: "invented-explicit-action" } } },
        ] }],
    }));
    const source = projectRetainedNativeRecords(retainNativeChatSourceObservations(decoded)).records;
    const result = projectNativeReportCopies(source, key, { recordedContext: true });
    assert.ok(result.copies.some(copy => copy.text === "invented-explicit-action" && copy.kind === "confirmation"));
    assert.ok(result.copies.every(copy => copy.author === "unknown" && copy.purpose === "context"));
    assert.doesNotMatch(JSON.stringify(result), /RAW_CONFIRMATION_METADATA|RAW_CARD_PROSE/);
});

test("known unsupported updates remain explicit without making their bodies into report copies", () => {
    const decoded = decodeNativeChatObservation(chatSource({
        messageId: "invented-plugin", messageType: "TriggerPlugin",
        actionId: "UNQUALIFIED_PLUGIN_OPERATION", result: "RAW_PLUGIN_RESULT",
    }));
    const source = projectRetainedNativeRecords(retainNativeChatSourceObservations(decoded)).records;
    const result = projectNativeReportCopies(source, key, { recordedContext: true });
    assert.equal(result.unavailableFacts.length, 1);
    assert.equal(result.unavailableFacts[0].kind, "trigger-plugin");
    assert.equal(result.unavailableFacts[0].availability, "unqualified");
    assert.ok(result.copies.every(copy => copy.text === null));
    assert.doesNotMatch(JSON.stringify(result), /UNQUALIFIED_PLUGIN_OPERATION|RAW_PLUGIN_RESULT/);
});

test("native copy edits reuse mandatory removal and cannot target unselected context", () => {
    const source = records(), initial = projectNativeReportCopies(source, key);
    const edited = projectNativeReportCopies(source, key, {
        promptMode: "original", overrides: [{ key: initial.copies[0].key, text: '{"password":"EXAMPLE_ONLY"}' }],
    });

    assert.equal(edited.copies[0].representation, "edited-copy");
    assert.ok(edited.copies[0].changes.some(change => change.mandatory));
    assert.doesNotMatch(JSON.stringify(edited), /EXAMPLE_ONLY/);
    assert.throws(() => projectNativeReportCopies(source, key, {
        overrides: [{ key: initial.copies[1].key, text: "Not selected" }],
    }), { status: 409 });
    assert.throws(() => projectNativeReportCopies(source, key, {
        overrides: [{ key: "native-copy-0000000000000000", text: "Not selected" }],
    }), { status: 409 });
});

test("a qualified tool-authored message retains its role and requires context opt-in", () => {
    const decoded = decodeNativeChatObservation(chatSource({
        messageId: "invented-tool-message", author: "tool", text: "Recorded tool message.",
    }));
    const source = projectRetainedNativeRecords(retainNativeChatSourceObservations(decoded)).records;
    const excluded = projectNativeReportCopies(source, key);
    assert.equal(excluded.copies[0].author, "tool");
    assert.equal(excluded.copies[0].purpose, "context");
    assert.equal(excluded.copies[0].text, null);
    assert.equal(projectNativeReportCopies(source, key, { recordedContext: true }).copies[0].text, "Recorded tool message.");
});

test("frozen native copies accept only their public fields and selected pseudonymous conversations", () => {
    const projected = projectNativeReportCopies(records(), key);
    const value = structuredClone({ copies: projected.copies, unavailableFacts: projected.unavailableFacts, coverage: projected.coverage });
    const refs = [...new Set(value.copies.map(copy => copy.scenarioRef))];
    assert.equal(validateNativeReportCopies(value, refs), value);
    const leaked = structuredClone(value);
    leaked.copies[0].original = "Private source text";
    assert.throws(() => validateNativeReportCopies(leaked, refs), TypeError);
    assert.throws(() => validateNativeReportCopies(value, ["scenario-" + "0".repeat(16)]), TypeError);
});

test("frozen native copies cannot bypass mode, role or context disclosure", () => {
    for (const promptMode of ["none", "masked", "original"]) for (const recordedContext of [false, true]) {
        const options = { promptMode, recordedContext }, projected = projectNativeReportCopies(records(), key, options);
        const value = structuredClone({ copies: projected.copies, unavailableFacts: projected.unavailableFacts, coverage: projected.coverage });
        const refs = [...new Set(value.copies.map(copy => copy.scenarioRef))];
        assert.equal(validateNativeReportCopies(value, refs, options), value);
        const altered = structuredClone(value);
        altered.copies[1].author = "unknown";
        altered.copies[1].purpose = "prompt";
        assert.throws(() => validateNativeReportCopies(altered, refs, options), TypeError);
        if (promptMode === "none" || !recordedContext) {
            const disclosed = structuredClone(value);
            Object.assign(disclosed.copies[1], { text: "Unreviewed context", omitted: false,
                representation: "retained-original", exclusion: null });
            assert.throws(() => validateNativeReportCopies(disclosed, refs, options), TypeError);
        }
    }
});

test("frozen native copy counts, unavailable facts and mandatory removals are independently checked", () => {
    const projected = projectNativeReportCopies(records(), key);
    const value = { copies: projected.copies, unavailableFacts: projected.unavailableFacts, coverage: projected.coverage };
    const refs = [...new Set(value.copies.map(copy => copy.scenarioRef))];
    for (const alter of [
        copy => { copy.coverage.included++; },
        copy => { copy.copies.push(copy.copies[0]); },
        copy => { copy.copies[0].changes = [{ category: "unreviewed source prose", mandatory: false }]; },
        copy => { copy.copies[0].text = '{"password":"EXAMPLE_ONLY"}'; },
        copy => { copy.unavailableFacts.push({ ref: "native-fact-" + "b".repeat(16), scenarioRef: refs[0],
            kind: "unreviewed source prose", availability: "unsupported" }); },
    ]) {
        const invalid = structuredClone(value);
        alter(invalid);
        assert.throws(() => validateNativeReportCopies(invalid, refs), TypeError);
    }
});

test("frozen native copies keep the existing privacy scan text limit", () => {
    const projected = projectNativeReportCopies(records(), key, { promptMode: "original" });
    const value = structuredClone({ copies: projected.copies, unavailableFacts: projected.unavailableFacts, coverage: projected.coverage });
    value.copies[0].text = "x".repeat(4 * 1024 * 1024);
    const refs = [...new Set(value.copies.map(copy => copy.scenarioRef))];
    assert.throws(() => validateNativeReportCopies(value, refs, { promptMode: "original" }),
        error => error.status === 422 && /Privacy scan text limit exceeded/.test(error.message));
});

test("native copies bind to their pseudonymous observation or update without exporting source identities", () => {
    const source = records(), message = source[0].nativeConversation.messages[0];
    const copied = projectNativeReportCopies(source, key);
    assert.equal(copied.copies[0].sourceRef, reportContextRef(key, "native-observation", message.observationKey));
    const decoded = decodeNativeChatObservation(chatSource({
        messageId: "invented-progress-link", author: "bot", messageType: "Progress", text: "Checking recorded sources.",
    }));
    const progress = projectRetainedNativeRecords(retainNativeChatSourceObservations(decoded)).records;
    const fact = progress[0].nativeConversation.sourceObservations[0].facts[0];
    const update = projectNativeReportCopies(progress, key, { recordedContext: true });
    assert.equal(update.copies[0].sourceRef, reportContextRef(key, "native-fact", fact.key));
    assert.doesNotMatch(JSON.stringify(update.copies), /invented-progress-link|sourceDocument|decodedPointer/);
});
