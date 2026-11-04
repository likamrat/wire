import { createHmac } from "node:crypto";
import { BoardError } from "./store.mjs";
import { scanTree } from "./privacy.mjs";
import { normalizeReportOptions, projectReportCopy } from "./prompt-projection.mjs";
import { reportContextRef } from "./report-context.mjs";
import { nativeValueHasCredentials } from "./native-read-model.mjs";
import { validateNativeReportCopies, nativeCopyCoverage as copyCoverage } from "./native-report-copy-shape.mjs";
export { validateNativeReportCopies } from "./native-report-copy-shape.mjs";

const availability = new Set(["recorded", "recorded-empty", "explicit-null", "absent-in-response",
    "excluded-by-policy", "credential-excluded", "unsupported", "unqualified", "conflicting"]);
const recorded = value => ["recorded", "recorded-empty"].includes(value);
const fail = () => { throw new BoardError("Native report text has unsupported or conflicting source fields. Nothing was prepared.", 422); };

// Pure disclosure projection; only the committed-source producer can authorize a report.
export function projectNativeReportCopies(records, key, input = {}) {
    if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(records) || !records.length) fail();
    if (nativeValueHasCredentials(records)) {
        throw new BoardError("Native report source failed mandatory credential screening. Nothing was prepared.", 422);
    }
    const options = normalizeReportOptions(input), sourceScan = scanTree(records);
    const copies = [], review = [], unavailableFacts = [], copyKeys = new Set(), scenarioIds = new Set(), selectableKeys = new Set();
    function append(record, identity, { kind = "native-message", author, representation, availability: sourceAvailability, original, sourceRef }) {
        const purpose = author === "user" ? "prompt" : "context";
        const selected = purpose === "prompt" || options.recordedContext;
        const copyKey = reportContextRef(key, "native-copy", JSON.stringify([record.scenarioId, identity]));
        if (copyKeys.has(copyKey) || !availability.has(sourceAvailability)
            || recorded(sourceAvailability) && typeof original !== "string"
            || !recorded(sourceAvailability) && original !== null) fail();
        copyKeys.add(copyKey);
        if (selected) selectableKeys.add(copyKey);
        const projected = projectReportCopy({
            key: copyKey, scenarioRef: reportContextRef(key, "scenario", record.scenarioId), sourceRef,
            kind, purpose, author, representationKind: representation,
            availability: sourceAvailability, original: selected ? original : null,
        }, selected ? options : { ...options, promptMode: "none", overrides: [] });
        copies.push({
            key: projected.key, scenarioRef: projected.scenarioRef, sourceRef: projected.sourceRef, kind: projected.kind,
            purpose: projected.purpose, author: projected.author, representationKind: projected.representationKind,
            availability: projected.availability, omitted: projected.omitted, text: projected.text,
            changes: projected.changes, representation: projected.representation,
            exclusion: selected ? null : "context-not-selected",
        });
        if (selected && options.promptMode !== "none") review.push(projected);
    }
    function appendField(record, fact, path, field) {
        if (!field) fail();
        append(record, JSON.stringify([fact.key, path]), { kind: fact.kind, author: "unknown", representation: "source-field",
            availability: field.availability, original: recorded(field.availability) ? field.value : null,
            sourceRef: reportContextRef(key, "native-fact", fact.key) });
    }
    function appendQuestions(record, fact) {
        const field = fact.fields.questions;
        if (!field || !recorded(field.availability)) {
            appendField(record, fact, "questions", field);
            return;
        }
        if (!Array.isArray(field.value)) fail();
        const text = (path, value) => appendField(record, fact, path, { availability: field.availability, value });
        for (const [index, question] of field.value.entries()) {
            const path = `questions/${index}`;
            if (typeof question === "string") text(path, question);
            else {
                if (!question || !Array.isArray(question.options)) fail();
                text(`${path}/question`, question.question);
                for (const [optionIndex, option] of question.options.entries()) {
                    for (const name of ["label", "submitResponse", "description"]) {
                        if (name !== "description" || option.description !== undefined) {
                            text(`${path}/options/${optionIndex}/${name}`, option[name]);
                        }
                    }
                }
            }
        }
    }
    for (const record of records) {
        if (record?.recordKind !== "native-conversation" || typeof record.scenarioId !== "string" || !record.scenarioId
            || scenarioIds.has(record.scenarioId) || !Array.isArray(record.nativeConversation?.messages)) fail();
        scenarioIds.add(record.scenarioId);
        for (const message of record.nativeConversation.messages) {
            if (!message || typeof message.observationKey !== "string" || !message.observationKey
                || !availability.has(message.availability)) fail();
            const value = message.value;
            if (recorded(message.availability) && (!value || !["user", "assistant", "tool", "unknown"].includes(value.author)
                || !["plain-text", "card-text", "reply-fragment", "follow-up"].includes(value.representation)
                || typeof value.text !== "string")) fail();
            append(record, message.observationKey, {
                sourceRef: reportContextRef(key, "native-observation", message.parentObservationKey ?? message.observationKey),
                author: recorded(message.availability) ? value.author : "unknown",
                representation: recorded(message.availability) ? value.representation : null,
                availability: message.availability, original: recorded(message.availability) ? value.text : null,
            });
        }
        const groups = record.nativeConversation.sourceObservations ?? [];
        if (!Array.isArray(groups)) fail();
        for (const group of groups) {
            if (group.unit !== "chat-source-observation-set" || group.status !== "source-facts-only" || !Array.isArray(group.facts)) fail();
            for (const fact of group.facts) {
                if (typeof fact.key !== "string" || !fact.key || !fact.fields) fail();
                const name = fact.kind === "provider-progress" ? "text" : fact.kind === "native-invocation" ? "toolName" : null;
                if (name) appendField(record, fact, name, fact.fields[name]);
                else if (["task", "task_step", "task_steps", "task_reasoning"].includes(fact.kind)) {
                    for (const name of ["name", "stepTitle", "statusLiteral"]) {
                        if (fact.fields[name]) appendField(record, fact, name, fact.fields[name]);
                    }
                    for (const name of ["steps", "reasoningItems"]) {
                        const children = fact.fields[name];
                        if (!Array.isArray(children)) continue;
                        for (const [index, child] of children.entries()) {
                            if (child.kind === "unsupported-task-child") continue;
                            for (const field of ["stepTitle", "statusLiteral"]) {
                                if (child.fields?.[field]) appendField(record, fact, `${name}/${index}/${field}`, child.fields[field]);
                            }
                        }
                    }
                } else if (fact.kind === "clarification") {
                    appendField(record, fact, "actionId", fact.fields.actionId);
                    appendQuestions(record, fact);
                    if (!Array.isArray(fact.invocations)) fail();
                    for (const [index, invocation] of fact.invocations.entries()) {
                        if (invocation.fields?.functionName) {
                            appendField(record, fact, `invocations/${index}/functionName`, invocation.fields.functionName);
                        }
                    }
                } else if (fact.kind === "confirmation") {
                    appendField(record, fact, "actionId", fact.fields.actionId);
                    if (!Array.isArray(fact.submitActions)) fail();
                    for (const [index, action] of fact.submitActions.entries()) {
                        appendField(record, fact, `submitActions/${index}/actionId`, action.fields?.actionId);
                    }
                } else if (["trigger-plugin", "unsupported-task", "unsupported-trigger-extension", "unsupported-native-invocation"].includes(fact.kind)) {
                    unavailableFacts.push({ ref: reportContextRef(key, "native-fact", fact.key),
                        scenarioRef: reportContextRef(key, "scenario", record.scenarioId), kind: fact.kind,
                        availability: fact.kind === "trigger-plugin" ? "unqualified" : "unsupported" });
                    for (const name of ["actionId", "toolName", "functionName"]) {
                        if (fact.fields[name]) appendField(record, fact, name, fact.fields[name]);
                    }
                    if (fact.invocations !== undefined && !Array.isArray(fact.invocations)) fail();
                    for (const [index, invocation] of (fact.invocations ?? []).entries()) {
                        if (invocation.fields?.functionName) {
                            appendField(record, fact, `invocations/${index}/functionName`, invocation.fields.functionName);
                        }
                    }
                } else fail();
            }
        }
    }
    if (options.overrides.some(edit => !selectableKeys.has(edit.key))) {
        throw new BoardError("A native report edit does not belong to the selected text. Prepare a fresh review.", 409);
    }
    const publicCopies = validateNativeReportCopies({ copies, unavailableFacts, coverage: copyCoverage(copies) },
        [...scenarioIds].map(id => reportContextRef(key, "scenario", id)), options);
    return {
        ...publicCopies, review, sourceScan,
        inputFingerprint: createHmac("sha256", key).update(JSON.stringify(records)).digest("hex"),
    };
}
