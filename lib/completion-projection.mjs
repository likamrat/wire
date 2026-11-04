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
});

const rootIdentities = ["id", "agentId", "parentId"];
const dataIdentities = ["toolCallId", "parentToolCallId", "turnId"];
const rootKeys = new Set([...rootIdentities, "type", "timestamp", "data"]);
const dataKeys = new Set([...dataIdentities, "success", "model", "result", "error"]);
const ignored = new Set(["result", "error"]);
const unsupported = Symbol("unsupported value");
const tooLarge = Symbol("field limit");
const identity = value => typeof value === "string" && /^[A-Za-z0-9_.:-]+$/.test(value)
    && Buffer.byteLength(value) <= COMPLETION_PROJECTION_LIMITS.identityBytes;
const selection = kind => ({ kind, values: new Map(), unsupported: false });

// This validates one bounded JSONL entry. Returned metadata is still subject to the collector's privacy/deletion gates.
export function projectOversizedCompletion(bytes, { maxInputBytes, maxOutputBytes }) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("Completion projection requires a Buffer.");
    for (const value of [maxInputBytes, maxOutputBytes]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Completion projection requires positive byte budgets.");
    }
    const limit = COMPLETION_PROJECTION_LIMITS;
    const work = { inputBytes: bytes.length, inputSlices: 0, largestInputSlice: 0, largestDecodedSlice: 0, generatedTokens: 0,
        consumedTokens: 0, generatedTokenUpperBound: 0, unobservedBatchTokenBound: 0,
        largestBatch: 0, largestValueChunk: 0, preflightDepth: 0 };
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

    let root, roots = 0, stringKind, stringValue, stringSlot;
    const stack = [];
    function slot() {
        const frame = stack.at(-1);
        if (!frame || frame.kind !== "object") return null;
        const key = frame.key;
        frame.key = null;
        const target = frame.target;
        if (!target) return null;
        if (!(target.kind === "root" ? rootKeys : dataKeys).has(key)) {
            target.unsupported = true;
            return null;
        }
        if (target.kind === "data" && ignored.has(key)) return null;
        target.values.set(key, unsupported);
        return { target, key };
    }
    function valueSlot() {
        if (!stack.length) roots++;
        return slot();
    }
    function consume(token) {
        switch (token.name) {
        case "startObject": {
            const place = valueSlot();
            let target = null;
            if (!stack.length) root = target = selection("root");
            else if (place?.target.kind === "root" && place.key === "data") {
                target = selection("data");
                place.target.values.set(place.key, target);
            }
            stack.push({ kind: "object", target, key: null });
            break;
        }
        case "startArray":
            valueSlot();
            stack.push({ kind: "array", target: null, key: null });
            break;
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
            valueSlot();
            break;
        case "numberChunk":
        case "endNumber":
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
        const problem = feed(text);
        if (problem) return unavailable(problem);
    }
    const finalText = decoder.decode();
    const problem = finalText ? feed(finalText) : null;
    if (problem) return unavailable(problem);
    const finalProblem = feed(none);
    if (finalProblem) return unavailable(finalProblem);
    if (roots !== 1 || stack.length || stringKind || !root) return unavailable("unsupported-event");
    const data = root.values.get("data");
    if (root.unsupported || data?.unsupported) return unavailable("unsupported-fields");
    if (root.values.get("type") !== "tool.execution_complete" || data?.kind !== "data") return unavailable("unsupported-event");
    for (const [target, keys, required] of [[root, rootIdentities, "id"], [data, dataIdentities, "toolCallId"]]) {
        if (!target.values.has(required)) return unavailable("invalid-identity");
        for (const key of keys) if (target.values.has(key) && !identity(target.values.get(key))) return unavailable("invalid-identity");
    }
    const timestamp = root.values.get("timestamp");
    if (typeof timestamp !== "string" || Buffer.byteLength(timestamp) > limit.timestampBytes) return unavailable("invalid-timestamp");
    try { time.instant(timestamp); } catch (error) {
        if (error instanceof RangeError) return unavailable("invalid-timestamp");
        throw error;
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
