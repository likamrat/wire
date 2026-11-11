import { isUtf8 } from "node:buffer";
import { jsonParser } from "stream-json/parser.js";
import { none, isMany, getManyValues } from "stream-chain/core";
import { time } from "./time.mjs";

export const COMPLETION_PROJECTION_LIMITS = Object.freeze({
    inputBytes: 4 * 1024 ** 2,
    outputBytes: 16 * 1024,
    inputSliceBytes: 4096,
    decodedSliceChars: 4098,
    parserCarryChars: 16,
    joinedInputChars: 4114,
    valueChunkChars: 4104,
    batchTokens: 16448,
    tokens: 100000,
    depth: 64,
    keyChars: 64,
    scalarChars: 512,
    identityBytes: 512,
    timestampBytes: 128,
    modelBytes: 512,
    selectedNodes: 1024,
});

const rootIdentities = ["id", "agentId", "parentId"];
const dataIdentities = ["toolCallId", "parentToolCallId", "turnId"];
const rootKeys = new Set([...rootIdentities, "type", "timestamp", "data"]);
const completionKeys = [...dataIdentities, "success", "model", "result", "error", "interactionId", "rte", "toolTelemetry"];
const hookKeys = ["hookInvocationId", "hookType", "input"];
const dataKeys = new Set([...completionKeys, ...hookKeys]);
const inputKeys = new Set(["sessionId", "timestamp", "cwd", "toolCallId", "serverName", "toolName",
    "arguments", "toolArgs", "toolCalls", "toolResult"]);
const ignored = new Set(["result", "error"]);
const unsupported = Symbol("unsupported value");
const tooLarge = Symbol("field limit");
const identity = value => typeof value === "string" && /^[A-Za-z0-9_.:-]+$/.test(value)
    && Buffer.byteLength(value) <= COMPLETION_PROJECTION_LIMITS.identityBytes;
const selection = (kind, array = false) => ({ kind, array, values: new Map(), unsupported: false });
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const materialize = target => {
    if (!target || typeof target !== "object" || !(target.values instanceof Map)) return target;
    if (target.unsupported) return unsupported;
    const entries = [...target.values].map(([key, value]) => [key, materialize(value)]);
    if (entries.some(([, value]) => value === unsupported || value === tooLarge)) return unsupported;
    return target.array ? entries.map(([, value]) => value) : Object.fromEntries(entries);
};

// Selected scalars longer than this are already inadmissible. Validate every
// original string character, but do not ask the tokenizer to allocate its body.
function boundedStrings(maximum, work) {
    let quoted = false, characters = 0, escape = "";
    return text => {
        let output = "";
        const append = (raw, length = 1) => {
            if (characters < maximum) output += raw;
            else work.omittedStringChars += raw.length;
            characters += length;
        };
        for (const character of text) {
            work.stringScanChars += character.length;
            if (!quoted) {
                output += character;
                if (character === '"') { quoted = true; characters = 0; }
            } else if (escape) {
                escape += character;
                if (escape.length === 2 && character === "u") continue;
                if (escape[1] === "u") {
                    if (!/^[0-9a-f]$/i.test(character)) return { problem: "invalid-json" };
                    if (escape.length < 6) continue;
                } else if (!/^["\\/bfnrt]$/.test(character)) return { problem: "invalid-json" };
                append(escape);
                escape = "";
            } else if (character === "\\") escape = character;
            else if (character === '"') { output += character; quoted = false; }
            else {
                if (character.codePointAt(0) < 32) return { problem: "invalid-json" };
                append(character, character.length);
            }
        }
        work.largestStringFilterSlice = Math.max(work.largestStringFilterSlice, output.length);
        work.stringCarryChars = Math.max(work.stringCarryChars, escape.length);
        return { text: output };
    };
}

// This validates one bounded JSONL entry. Returned metadata is still subject to the collector's privacy/deletion gates.
export function projectOversizedCompletion(bytes, { maxInputBytes, maxOutputBytes }) {
    return projectSourceEvent(bytes, { maxInputBytes, maxOutputBytes }, false);
}

export function projectOversizedSourceEvent(bytes, budgets) {
    return projectSourceEvent(bytes, budgets, true);
}

function projectSourceEvent(bytes, { maxInputBytes, maxOutputBytes }, allowHooks) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Completion projection requires a Buffer.");
    for (const value of [maxInputBytes, maxOutputBytes]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Completion projection requires positive byte budgets.");
    }
    const limit = COMPLETION_PROJECTION_LIMITS;
    const work = { inputBytes: bytes.length, inputSlices: 0, largestInputSlice: 0, largestDecodedSlice: 0, generatedTokens: 0,
        consumedTokens: 0, generatedTokenUpperBound: 0, unobservedBatchTokenBound: 0,
        largestBatch: 0, largestValueChunk: 0, preflightDepth: 0,
        stringScanChars: 0, omittedStringChars: 0, largestStringFilterSlice: 0, stringCarryChars: 0,
        selectedNodes: 0, largestParserSlice: 0 };
    const unavailable = reason => ({ kind: "unavailable", reason, work });
    if (bytes.length > Math.min(maxInputBytes, limit.inputBytes)) return unavailable("input-limit");
    if (!bytes.length || bytes.at(-1) !== 10) return unavailable("unfinished-entry");
    if (bytes.indexOf(10) !== bytes.length - 1) return unavailable("not-jsonl-entry");
    if (!isUtf8(bytes)) return unavailable("invalid-utf8");

    // Check structural depth before the tokenizer can allocate a deep stack. This is only a budget scan, not a JSON validator.
    let quoted = false, escaped = false, depth = 0;
    for (const byte of bytes) {
        if (quoted) {
            if (escaped) escaped = false;
            else if (byte === 92) escaped = true;
            else if (byte === 34) quoted = false;
        } else if (byte === 34) quoted = true;
        else if (byte === 123 || byte === 91) {
            depth++;
            work.preflightDepth = Math.max(work.preflightDepth, depth);
            if (depth > limit.depth) return unavailable("depth-limit");
        } else if (byte === 125 || byte === 93) depth--;
    }

    let root, roots = 0, stringKind, stringValue, stringSlot, numberValue, numberSlot, selectionLimit = false;
    const stack = [];
    function slot() {
        const frame = stack.at(-1);
        if (!frame) return null;
        const key = frame.kind === "array" ? frame.index++ : frame.key;
        frame.key = null;
        const target = frame.target;
        if (!target) return null;
        const allowed = target.kind === "root" ? rootKeys : target.kind === "data" ? dataKeys
            : target.kind === "input" ? inputKeys : null;
        if (allowed && !allowed.has(key) || key === tooLarge || key === null) {
            target.unsupported = true;
            return null;
        }
        if (target.kind === "data" && ignored.has(key)) return null;
        if (target.kind === "input" && ["cwd", "timestamp", "toolResult"].includes(key)) return null;
        if (++work.selectedNodes > limit.selectedNodes) { selectionLimit = true; return null; }
        target.values.set(key, unsupported);
        return { target, key };
    }
    function valueSlot() {
        if (!stack.length) roots++;
        return slot();
    }
    function consume(token) {
        switch (token.name) {
        case "startObject":
        case "startArray": {
            const place = valueSlot();
            const array = token.name === "startArray";
            let target = null;
            if (!stack.length && !array) root = target = selection("root");
            else if (!array && place?.target.kind === "root" && place.key === "data") {
                target = selection("data");
                place.target.values.set(place.key, target);
            } else if (!array && place?.target.kind === "data" && place.key === "input") {
                target = selection("input");
                place.target.values.set(place.key, target);
            } else if (place && (place.target.kind === "copy"
                || place.target.kind === "input" && ["arguments", "toolArgs", "toolCalls"].includes(place.key)
                || place.target.kind === "data" && place.key === "toolTelemetry")) {
                target = selection("copy", array);
                place.target.values.set(place.key, target);
            }
            stack.push({ kind: array ? "array" : "object", target, key: null, index: 0 });
            break;
        }
        case "endObject":
        case "endArray":
            if (stack.pop()?.kind !== (token.name === "endObject" ? "object" : "array")) throw new Error("Unexpected JSON parser container sequence.");
            break;
        case "startKey":
            stringKind = "key";
            stringValue = stack.at(-1)?.target ? "" : null;
            break;
        case "startString":
            stringKind = "value";
            stringSlot = valueSlot();
            stringValue = stringSlot && !(stringSlot.target.kind === "root" && stringSlot.key === "data") ? "" : null;
            break;
        case "stringChunk":
            if (stringValue !== null && stringValue !== tooLarge) {
                const maximum = stringKind === "key" ? limit.keyChars : limit.scalarChars;
                stringValue = stringValue.length + token.value.length <= maximum ? stringValue + token.value : tooLarge;
            }
            break;
        case "endKey":
            if (stack.at(-1)?.kind !== "object") throw new Error("Unexpected JSON parser key sequence.");
            stack.at(-1).key = stringValue;
            stringKind = null; stringValue = null;
            break;
        case "endString":
            if (stringSlot && stringValue !== null) stringSlot.target.values.set(stringSlot.key, stringValue);
            stringKind = null; stringValue = null; stringSlot = null;
            break;
        case "startNumber":
            numberSlot = valueSlot();
            numberValue = "";
            break;
        case "numberChunk":
            if (numberSlot && numberValue !== tooLarge) numberValue = numberValue.length + token.value.length <= limit.scalarChars
                ? numberValue + token.value : tooLarge;
            break;
        case "endNumber":
            if (numberSlot && numberValue !== tooLarge && Number.isFinite(Number(numberValue))) {
                numberSlot.target.values.set(numberSlot.key, Number(numberValue));
            }
            numberSlot = null; numberValue = null;
            break;
        case "trueValue":
        case "falseValue":
        case "nullValue": {
            const place = valueSlot();
            if (place) place.target.values.set(place.key, token.value);
            break;
        }
        default:
            throw new Error("Unexpected JSON parser token.");
        }
    }

    const parse = jsonParser({ packValues: false, streamValues: true, jsonStreaming: false });
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const shortenStrings = boundedStrings(limit.scalarChars + 1, work);
    function feed(text) {
        let result;
        try { result = parse(text); }
        catch (error) {
            if (error instanceof Error && /^Parser (?:cannot parse input|has expected)/.test(error.message)) {
                // A throwing call can already have allocated a token prefix that the library does not return.
                work.unobservedBatchTokenBound = limit.batchTokens;
                work.generatedTokenUpperBound = work.generatedTokens + limit.batchTokens;
                return "invalid-json";
            }
            throw error;
        }
        if (result === none) return null;
        if (!isMany(result)) throw new Error("Unexpected JSON parser batch.");
        const tokens = getManyValues(result);
        work.generatedTokens += tokens.length;
        work.generatedTokenUpperBound = work.generatedTokens;
        work.largestBatch = Math.max(work.largestBatch, tokens.length);
        // One bounded batch is allocated before these checks; no next slice is fed on exhaustion.
        if (tokens.length > limit.batchTokens) return "batch-limit";
        if (work.generatedTokens > limit.tokens) return "token-limit";
        for (const token of tokens) {
            if (token.name === "stringChunk" || token.name === "numberChunk") {
                if (typeof token.value !== "string") throw new Error("Unexpected JSON parser value chunk.");
                work.largestValueChunk = Math.max(work.largestValueChunk, token.value.length);
                if (token.value.length > limit.valueChunkChars) return "chunk-limit";
            }
            consume(token);
            work.consumedTokens++;
            if (selectionLimit) return "projection-limit";
        }
        return null;
    }
    function feedFiltered(text) {
        for (let offset = 0; offset < text.length; offset += limit.decodedSliceChars) {
            const slice = text.slice(offset, offset + limit.decodedSliceChars);
            work.largestParserSlice = Math.max(work.largestParserSlice, slice.length);
            const problem = feed(slice);
            if (problem) return problem;
        }
        return null;
    }
    for (let offset = 0; offset < bytes.length; offset += limit.inputSliceBytes) {
        const part = bytes.subarray(offset, offset + limit.inputSliceBytes);
        work.inputSlices++;
        work.largestInputSlice = Math.max(work.largestInputSlice, part.length);
        const text = decoder.decode(part, { stream: true });
        work.largestDecodedSlice = Math.max(work.largestDecodedSlice, text.length);
        if (text.length > limit.decodedSliceChars) return unavailable("decoder-limit");
        const filtered = shortenStrings(text);
        if (filtered.problem) return unavailable(filtered.problem);
        const problem = feedFiltered(filtered.text);
        if (problem) return unavailable(problem);
    }
    const finalText = decoder.decode();
    const filtered = finalText ? shortenStrings(finalText) : { text: "" };
    if (filtered.problem) return unavailable(filtered.problem);
    const problem = filtered.text ? feedFiltered(filtered.text) : null;
    if (problem) return unavailable(problem);
    const finalProblem = feed(none);
    if (finalProblem) return unavailable(finalProblem);
    if (roots !== 1 || stack.length || stringKind || !root) return unavailable("unsupported-event");
    const data = root.values.get("data");
    if (root.unsupported || data?.unsupported) return unavailable("unsupported-fields");
    const type = root.values.get("type"), hook = allowHooks && type === "hook.start";
    if ((!hook && type !== "tool.execution_complete") || data?.kind !== "data") return unavailable("unsupported-event");
    if ([...data.values.keys()].some(key => !(hook ? hookKeys : completionKeys).includes(key))) return unavailable("unsupported-fields");
    for (const [target, keys, required] of [[root, rootIdentities, "id"],
        [data, hook ? ["hookInvocationId"] : [...dataIdentities, "interactionId"], hook ? "hookInvocationId" : "toolCallId"]]) {
        if (!target.values.has(required)) return unavailable("invalid-identity");
        for (const key of keys) if (target.values.has(key) && !identity(target.values.get(key))) return unavailable("invalid-identity");
    }
    const timestamp = root.values.get("timestamp");
    if (typeof timestamp !== "string" || Buffer.byteLength(timestamp) > limit.timestampBytes) return unavailable("invalid-timestamp");
    try { time.instant(timestamp); } catch (error) {
        if (error instanceof RangeError) return unavailable("invalid-timestamp");
        throw error;
    }
    if (hook) {
        const input = materialize(data.values.get("input"));
        const hookType = data.values.get("hookType");
        if (!["preToolUse", "preMcpToolCall", "postToolUse"].includes(hookType) || !plain(input) || input === unsupported) {
            return unavailable("unsupported-hook");
        }
        const event = { id: root.values.get("id"), type, timestamp };
        for (const key of rootIdentities.slice(1)) if (root.values.has(key)) event[key] = root.values.get(key);
        event.data = { hookInvocationId: data.values.get("hookInvocationId"), hookType, input };
        if (Buffer.byteLength(JSON.stringify(event)) > Math.min(maxOutputBytes, limit.outputBytes)) return unavailable("projection-limit");
        return { kind: "projected", event, work };
    }
    if (data.values.has("rte") && typeof data.values.get("rte") !== "boolean") return unavailable("unsupported-fields");
    if (data.values.has("toolTelemetry")) {
        const telemetry = materialize(data.values.get("toolTelemetry"));
        if (!plain(telemetry) || telemetry === unsupported || Object.entries(telemetry).some(([key, values]) =>
            !["properties", "metrics"].includes(key) || !plain(values) || Object.values(values)
                .some(value => key === "properties" ? typeof value !== "string" : typeof value !== "number"))) {
            return unavailable("unsupported-fields");
        }
    }
    // Failure reasons need a separate trusted omission representation; never turn omitted payloads into "not supplied".
    if (data.values.get("success") !== true) return unavailable("outcome-not-projected");
    const event = { id: root.values.get("id"), type: "tool.execution_complete", timestamp };
    for (const key of rootIdentities.slice(1)) if (root.values.has(key)) event[key] = root.values.get(key);
    event.data = { toolCallId: data.values.get("toolCallId"), success: true };
    for (const key of dataIdentities.slice(1)) if (data.values.has(key)) event.data[key] = data.values.get(key);
    const model = data.values.get("model");
    if (typeof model === "string" && model.trim() && model.isWellFormed() && Buffer.byteLength(model) <= limit.modelBytes
        && !/[\u0000-\u001f\u007f]/.test(model)) event.data.model = model;
    if (Buffer.byteLength(JSON.stringify(event)) > Math.min(maxOutputBytes, limit.outputBytes)) return unavailable("projection-limit");
    return { kind: "projected", event, work };
}
