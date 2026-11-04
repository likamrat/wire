import { jsonParser } from "stream-json/parser.js";
import { none, isMany, getManyValues } from "stream-chain/core";
import { textFindings } from "./privacy.mjs";

export const WORKIQ_ERROR_INSPECTION_BYTES = 256000;
const rootKeys = new Set(["results", "note", "requestId", "statusCode", "data", "error"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const entry = value => object(value) && (Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599
    || object(value.error) || typeof value.error === "string");
const syntaxError = error => error instanceof Error && /^Parser (?:cannot parse input|has expected)/.test(error.message);

// Only a syntactically complete prefix of a recognized results array is evidence.
// Never repair the suffix, finish an entry, or search prose for an embedded error.
function completedPrefix(json) {
    const parse = jsonParser({ packValues: true, streamValues: false });
    const stack = [], results = [], keys = new Set();
    let rootComplete = false, roots = 0, tokens = 0, invalid = false, stopped = false, endedEntries = false;
    function slot() {
        const parent = stack.at(-1);
        const key = parent?.array ? parent.index++ : parent?.key;
        return { parent, key, path: parent ? [...parent.path, key] : [] };
    }
    function attach(place, value) {
        if (place.parent?.path.length === 0 && ["note", "requestId"].includes(place.key)
            && value != null && typeof value !== "string") invalid = true;
        if (place.parent) place.parent.value[place.key] = value;
    }
    function consume(token) {
        if (++tokens > 100000) { invalid = true; return; }
        if (token.name === "keyValue") {
            const frame = stack.at(-1);
            frame.key = token.value;
            const evidenceObject = frame.path.length === 0 || /^results\.\d+(?:\.error(?:\.error)?(?:\.details\.\d+)?)?$/.test(frame.path.join("."));
            if (evidenceObject && frame.keys.has(token.value)) invalid = true;
            if (evidenceObject) frame.keys.add(token.value);
            if (stack.length === 1) {
                if (!rootKeys.has(token.value) || keys.has(token.value)) invalid = true;
                keys.add(token.value);
            }
        } else if (token.name === "startObject" || token.name === "startArray") {
            const place = slot(), array = token.name === "startArray";
            if (!stack.length && (++roots !== 1 || array)) invalid = true;
            if (stack.length >= 64 || place.path.length === 1 && place.key === "results" && !array) invalid = true;
            stack.push({ ...place, slot: place, array, key: null, keys: new Set(), index: 0, value: array ? [] : Object.create(null) });
        } else if (token.name === "endObject" || token.name === "endArray") {
            const frame = stack.pop();
            if (frame.path.length === 2 && frame.path[0] === "results") {
                if (!entry(frame.value)) endedEntries = true;
                if (!endedEntries && results.length < 100) results.push(frame.value);
            }
            attach(frame.slot, frame.value);
            if (!stack.length) rootComplete = true;
        } else if (["stringValue", "numberValue", "nullValue", "trueValue", "falseValue"].includes(token.name)) {
            const place = slot();
            if (place.path.length === 2 && place.path[0] === "results") endedEntries = true;
            if (!place.parent || place.path.length === 1 && place.key === "results") invalid = true;
            attach(place, token.name === "numberValue" ? Number(token.value) : token.value);
        }
    }
    function feed(part) {
        let batch;
        try { batch = parse(part); } catch (error) {
            if (!syntaxError(error)) throw error;
            stopped = true; return;
        }
        if (batch !== none) for (const token of isMany(batch) ? getManyValues(batch) : [batch]) consume(token);
    }
    // One character per feed preserves every completed entry before the parser's throwing token.
    // Input bytes, token count and nesting are independently bounded.
    for (const character of json) {
        feed(character);
        if (stopped || invalid) break;
    }
    if (!stopped && !invalid) feed(none);
    return stopped && !invalid && !rootComplete && results.length ? { results } : null;
}

export function workIqErrorEnvelope(message) {
    if (typeof message !== "string" || Buffer.byteLength(message) > WORKIQ_ERROR_INSPECTION_BYTES
        || textFindings(message).some(finding => finding.mandatory || finding.category === "sensitivity_markings")) return null;
    const match = /^MCP server ['"]workiq['"]:\s*(\{[\s\S]*)$/.exec(message.trim());
    if (!match) return null;
    let value;
    try { value = JSON.parse(match[1]); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const prefix = completedPrefix(match[1]);
        return prefix ? { value: prefix, partial: true } : null;
    }
    return object(value) && !Object.keys(value).some(key => !rootKeys.has(key)) ? { value, partial: false } : null;
}
