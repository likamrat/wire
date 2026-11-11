import test from "node:test";
import assert from "node:assert/strict";
import { projectOversizedCompletion, COMPLETION_PROJECTION_LIMITS } from "../lib/completion-projection.mjs";

const limits = { maxInputBytes: 4 * 1024 ** 2, maxOutputBytes: 1024 ** 2 };
const entry = data => Buffer.from(JSON.stringify({
    id: "completion-event", type: "tool.execution_complete", timestamp: "2026-10-23T12:00:00.000Z",
    agentId: "recorded-agent", data,
}) + "\n");

test("projects a fully validated completion without packing or retaining its large result", () => {
    const source = entry({ toolCallId: "recorded-call", success: true, model: "recorded-model",
        result: { content: "PRIVATE_RESPONSE_" + "x".repeat(2 * 1024 ** 2) } });
    const result = projectOversizedCompletion(source, limits);
    assert.equal(result.kind, "projected");
    assert.deepEqual(result.event, {
        id: "completion-event", type: "tool.execution_complete", timestamp: "2026-10-23T12:00:00.000Z",
        agentId: "recorded-agent", data: { toolCallId: "recorded-call", success: true, model: "recorded-model" },
    });
    assert.ok(result.work.largestInputSlice <= 4096);
    assert.ok(result.work.largestBatch <= COMPLETION_PROJECTION_LIMITS.batchTokens);
    assert.equal(JSON.stringify(result).includes("PRIVATE_RESPONSE_"), false);
});

test("never publishes a valid-looking prefix before full UTF-8, JSON and EOF validation", () => {
    const source = entry({ toolCallId: "recorded-call", success: true, result: { content: "PRIVATE_DATA" } });
    const malformedUtf8 = Buffer.from(source);
    malformedUtf8[malformedUtf8.indexOf("PRIVATE_DATA")] = 0xff;
    const cases = [
        [malformedUtf8, "invalid-utf8"],
        [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source]), "invalid-json"],
        [Buffer.concat([source.subarray(0, -1), Buffer.from(" garbage\n")]), "invalid-json"],
        [Buffer.concat([source.subarray(0, -1), Buffer.from(" {}\n")]), "invalid-json"],
        [Buffer.concat([source.subarray(0, -2), Buffer.from("\n")]), "invalid-json"],
        [source.subarray(0, -1), "unfinished-entry"],
        [Buffer.concat([source, Buffer.from("{}\n")]), "not-jsonl-entry"],
    ];
    for (const [bytes, reason] of cases) {
        const result = projectOversizedCompletion(bytes, limits);
        assert.equal(result.kind, "unavailable");
        assert.equal(result.reason, reason);
        assert.equal(Object.hasOwn(result, "event"), false);
        assert.equal(JSON.stringify(result).includes("PRIVATE_DATA"), false);
    }
    assert.equal(projectOversizedCompletion(entry({ toolCallId: "recorded-call", success: true,
        result: { content: "\ufffd" } }), limits).kind, "projected", "A legal replacement character is not malformed UTF-8");
});

test("leaves failures and unqualified outcomes as gaps rather than inventing source-absence evidence", () => {
    for (const success of [false, undefined, null, "true", 1]) {
        const result = projectOversizedCompletion(entry({ toolCallId: "recorded-call", success,
            error: { code: "actual-code", message: "PRIVATE_FAILURE_REASON" },
            result: { content: "PRIVATE_FAILURE_BODY" } }), limits);
        assert.equal(result.kind, "unavailable");
        assert.equal(result.reason, "outcome-not-projected");
        assert.equal(Object.hasOwn(result, "event"), false);
        assert.doesNotMatch(JSON.stringify(result), /no-structured-error|not-supplied|PRIVATE_/);
    }
    const forged = projectOversizedCompletion(entry({ toolCallId: "recorded-call", success: true,
        wireFailureEvidence: { reason: "no-structured-error", messageStatus: "not-supplied" } }), limits);
    assert.equal(forged.kind, "unavailable");
    assert.equal(forged.reason, "unsupported-fields");
});

test("uses final keys and whole data replacements without borrowing nested payload fields", () => {
    const bytes = Buffer.from(String.raw`{"id":"old","\u0069d":"completion-event","type":"tool.execution_complete","timestamp":"2026-10-23T12:00:00.000Z","parentId":"previous-event","agentId":"agent-a","data":{"unknownScope":"discarded"},"data":{"toolCallId":"old-call","success":false},"data":{"result":{"toolCallId":"spoofed","success":false,"data":{"agentId":"spoofed"}},"toolCallId":"final-call","success":false,"success":true,"parentToolCallId":"parent-call","turnId":"turn-a","model":"final-model"}}` + "\n");
    const source = JSON.parse(bytes.toString("utf8"));
    const projected = projectOversizedCompletion(bytes, limits);
    assert.equal(projected.kind, "projected");
    assert.deepEqual(projected.event, {
        id: source.id, type: source.type, timestamp: source.timestamp, agentId: source.agentId, parentId: source.parentId,
        data: { toolCallId: source.data.toolCallId, success: true, parentToolCallId: source.data.parentToolCallId,
            turnId: source.data.turnId, model: source.data.model },
    });

    for (const replacement of ["null", "[]", '"not-an-object"']) {
        const changed = Buffer.from(bytes.toString("utf8").trimEnd().slice(0, -1) + `,"data":${replacement}}\n`);
        assert.equal(projectOversizedCompletion(changed, limits).kind, "unavailable");
    }
    const falseLast = Buffer.from(bytes.toString("utf8").replace('"success":false,"success":true', '"success":true,"success":false'));
    assert.equal(projectOversizedCompletion(falseLast, limits).reason, "outcome-not-projected");
});

test("rejects excess depth before tokenizer allocation, including in discarded payloads", () => {
    const nested = count => Buffer.from(`{"id":"e","type":"tool.execution_complete","timestamp":"2026-10-23T12:00:00Z","data":{"toolCallId":"c","success":true,"result":${"[".repeat(count)}0${"]".repeat(count)}}}\n`);
    const accepted = projectOversizedCompletion(nested(62), limits);
    assert.equal(accepted.kind, "projected");
    assert.equal(accepted.work.preflightDepth, 64);
    for (const levels of [63, 4096]) {
        const rejected = projectOversizedCompletion(nested(levels), limits);
        assert.equal(rejected.kind, "unavailable");
        assert.equal(rejected.reason, "depth-limit");
        assert.equal(rejected.work.inputSlices, 0);
        assert.equal(rejected.work.generatedTokens, 0);
        assert.equal(Object.hasOwn(rejected, "event"), false);
    }
    assert.equal(projectOversizedCompletion(entry({ toolCallId: "c", success: true,
        result: { content: '\\"' + "[".repeat(4096) } }), limits).kind, "projected");
});

test("accounts for the malformed-literal carry and a discarded error batch before rejection", () => {
    const prefix = '{"id":"e","type":"tool.execution_complete","timestamp":"2026-10-23T12:00:00Z","data":{"toolCallId":"c","success":true,"result":';
    const badLiteral = "f".repeat(16);
    assert.equal(badLiteral.length, 16);
    const bytes = Buffer.from(prefix + " ".repeat(4096 - prefix.length - badLiteral.length)
        + badLiteral + " ".repeat(2 * 1024 ** 2) + "}}\n");
    const result = projectOversizedCompletion(bytes, limits);
    assert.equal(result.kind, "unavailable");
    assert.equal(result.reason, "invalid-json");
    assert.equal(result.work.inputSlices, 2);
    assert.equal(result.work.unobservedBatchTokenBound, COMPLETION_PROJECTION_LIMITS.batchTokens);
    assert.equal(result.work.generatedTokenUpperBound, result.work.generatedTokens + COMPLETION_PROJECTION_LIMITS.batchTokens);
    assert.ok(result.work.largestDecodedSlice + COMPLETION_PROJECTION_LIMITS.parserCarryChars
        <= COMPLETION_PROJECTION_LIMITS.joinedInputChars);
    assert.equal(Object.hasOwn(result, "event"), false);
});

test("bounds all token work with an explicit one-batch overshoot and stops further feeding", () => {
    const empty = entry({ toolCallId: "c", success: true, result: [] });
    const base = projectOversizedCompletion(empty, limits).work.generatedTokens;
    const forTokens = total => {
        const extra = total - base;
        const values = [...Array(Math.floor(extra / 3)).fill("0"), ...Array(extra % 3).fill("true")].join(",");
        return Buffer.from(empty.toString("utf8").replace('"result":[]', `"result":[${values}]`));
    };
    for (const total of [COMPLETION_PROJECTION_LIMITS.tokens - 1, COMPLETION_PROJECTION_LIMITS.tokens]) {
        const result = projectOversizedCompletion(forTokens(total), limits);
        assert.equal(result.kind, "projected");
        assert.equal(result.work.generatedTokens, total);
        assert.equal(result.work.consumedTokens, total);
    }
    for (const total of [COMPLETION_PROJECTION_LIMITS.tokens + 1, 150000]) {
        const bytes = forTokens(total), result = projectOversizedCompletion(bytes, limits);
        assert.equal(result.kind, "unavailable");
        assert.equal(result.reason, "token-limit");
        assert.equal(Object.hasOwn(result, "event"), false);
        assert.ok(result.work.consumedTokens <= COMPLETION_PROJECTION_LIMITS.tokens);
        assert.ok(result.work.generatedTokenUpperBound <= COMPLETION_PROJECTION_LIMITS.tokens + COMPLETION_PROJECTION_LIMITS.batchTokens);
        assert.ok(result.work.largestBatch <= COMPLETION_PROJECTION_LIMITS.batchTokens);
        if (total === 150000) assert.ok(result.work.inputSlices * COMPLETION_PROJECTION_LIMITS.inputSliceBytes < bytes.length);
    }
});

test("validates escape-heavy discarded strings without allocating their discarded tokens", () => {
    const bytes = entry({ toolCallId: "c", success: true, result: { content: '"value":'.repeat(100000) } });
    const result = projectOversizedCompletion(bytes, limits);
    assert.equal(result.kind, "projected");
    assert.ok(result.work.omittedStringChars > 900000);
    assert.ok(result.work.generatedTokens < 2000, "The tokenizer must not allocate a token per discarded escape");
    assert.equal(result.work.generatedTokens, result.work.consumedTokens);
    assert.equal(result.work.stringScanChars, bytes.toString("utf8").length);
    assert.ok(result.work.stringCarryChars <= 5);
    assert.ok(result.work.largestStringFilterSlice <= COMPLETION_PROJECTION_LIMITS.decodedSliceChars + 5);
    assert.ok(result.work.largestParserSlice + COMPLETION_PROJECTION_LIMITS.parserCarryChars <= COMPLETION_PROJECTION_LIMITS.joinedInputChars);
    assert.ok(result.work.largestBatch <= COMPLETION_PROJECTION_LIMITS.batchTokens);
    assert.ok(result.work.largestValueChunk <= COMPLETION_PROJECTION_LIMITS.valueChunkChars);
    assert.deepEqual(result.event.data, { toolCallId: "c", success: true });
    const text = bytes.toString("utf8");
    for (const suffix of [String.raw`\z`, String.raw`\u123Z`, "\u0000", "\\"]) {
        const damaged = Buffer.from(text.slice(0, -5) + suffix + text.slice(-5));
        assert.throws(() => JSON.parse(damaged.toString("utf8")), SyntaxError);
        const rejected = projectOversizedCompletion(damaged, limits);
        assert.equal(rejected.kind, "unavailable");
        assert.equal(rejected.reason, "invalid-json");
        assert.equal(Object.hasOwn(rejected, "event"), false);
    }
    for (const tail of ["garbage", ",", "{}", "]"]) {
        const damaged = Buffer.from(text.trimEnd() + tail + "\n");
        assert.equal(projectOversizedCompletion(damaged, limits).reason, "invalid-json");
    }
});

test("bounds giant discarded keys, strings and numbers without relying on a 256-character chunk assumption", () => {
    const giant = "x".repeat(2 * 1024 ** 2);
    const number = entry({ toolCallId: "c", success: true, result: "NUMBER" }).toString("utf8").replace('"NUMBER"', "1".repeat(2 * 1024 ** 2));
    for (const bytes of [
        entry({ toolCallId: "c", success: true, result: { [giant]: true } }),
        entry({ toolCallId: "c", success: true, result: { content: giant } }),
        Buffer.from(number),
    ]) {
        const result = projectOversizedCompletion(bytes, limits);
        assert.equal(result.kind, "projected");
        assert.ok(result.work.largestInputSlice <= COMPLETION_PROJECTION_LIMITS.inputSliceBytes);
        assert.ok(result.work.largestDecodedSlice <= COMPLETION_PROJECTION_LIMITS.decodedSliceChars);
        assert.ok(result.work.largestValueChunk <= COMPLETION_PROJECTION_LIMITS.valueChunkChars);
        assert.ok(result.work.largestBatch <= COMPLETION_PROJECTION_LIMITS.batchTokens);
        assert.ok(Buffer.byteLength(JSON.stringify(result.event)) < 512);
    }
    const escaped = projectOversizedCompletion(entry({ toolCallId: "c", success: true, result: { content: '\\"x'.repeat(100) } }), limits);
    assert.equal(escaped.kind, "projected");
    assert.ok(escaped.work.largestValueChunk >= 300);
});

test("rejects invalid present identities instead of truncating or dropping their scope", () => {
    const altered = (where, key, value) => {
        const source = JSON.parse(entry({ toolCallId: "c", success: true }));
        (where === "root" ? source : source.data)[key] = value;
        return Buffer.from(JSON.stringify(source) + "\n");
    };
    for (const [where, key] of [["root", "id"], ["root", "agentId"], ["root", "parentId"],
        ["data", "toolCallId"], ["data", "parentToolCallId"], ["data", "turnId"]]) {
        const atLimit = projectOversizedCompletion(altered(where, key, "a".repeat(512)), limits);
        assert.equal(atLimit.kind, "projected");
        assert.equal((where === "root" ? atLimit.event : atLimit.event.data)[key], "a".repeat(512));
        for (const invalid of ["", null, 7, {}, "a".repeat(513), "contains space", "scope/other"]) {
            const result = projectOversizedCompletion(altered(where, key, invalid), limits);
            assert.equal(result.kind, "unavailable");
            assert.equal(result.reason, "invalid-identity");
            assert.equal(Object.hasOwn(result, "event"), false);
        }
    }
    assert.equal(projectOversizedCompletion(altered("root", "tenantId", "other-scope"), limits).reason, "unsupported-fields");
    assert.equal(projectOversizedCompletion(altered("data", "sessionId", "other-scope"), limits).reason, "unsupported-fields");
    for (const invalid of ["2026-02-30T12:00:00Z", "2026-10-23 12:00:00", "", "a".repeat(129), null]) {
        assert.equal(projectOversizedCompletion(altered("root", "timestamp", invalid), limits).reason, "invalid-timestamp");
    }
    const absent = projectOversizedCompletion(altered("data", "toolCallId", undefined), limits);
    assert.equal(absent.kind, "unavailable");
    assert.equal(absent.reason, "invalid-identity");
});

test("enforces raw-entry and final projection byte budgets without changing normal field values", () => {
    const base = entry({ toolCallId: "c", success: true, result: { content: "" } }).length;
    for (const length of [limits.maxInputBytes - 1, limits.maxInputBytes]) {
        const bytes = entry({ toolCallId: "c", success: true, result: { content: "x".repeat(length - base) } });
        assert.equal(bytes.length, length);
        assert.equal(projectOversizedCompletion(bytes, limits).kind, "projected");
    }
    const tooBig = entry({ toolCallId: "c", success: true, result: { content: "x".repeat(limits.maxInputBytes + 1 - base) } });
    const rejected = projectOversizedCompletion(tooBig, limits);
    assert.equal(rejected.reason, "input-limit");
    assert.equal(rejected.work.inputSlices, 0);
    const source = entry({ toolCallId: "c", success: true, model: "recorded-model" });
    const expected = projectOversizedCompletion(source, limits).event;
    const size = Buffer.byteLength(JSON.stringify(expected));
    assert.equal(projectOversizedCompletion(source, { ...limits, maxOutputBytes: size - 1 }).reason, "projection-limit");
    for (const maxOutputBytes of [size, size + 1]) {
        assert.deepEqual(projectOversizedCompletion(source, { ...limits, maxOutputBytes }).event, expected);
    }
    for (const model of [null, {}, "", "   ", "\u001b[31m", "\ud800", "x".repeat(513), "\u00e9".repeat(257)]) {
        const result = projectOversizedCompletion(entry({ toolCallId: "c", success: true, model }), limits);
        assert.equal(result.kind, "projected");
        assert.equal(Object.hasOwn(result.event.data, "model"), false);
    }
    assert.equal(projectOversizedCompletion(entry({ toolCallId: "c", success: true, model: "\u00e9".repeat(256) }), limits).event.data.model, "\u00e9".repeat(256));
});

test("rejects invalid caller arguments and honors a smaller input budget before parsing", () => {
    const bytes = entry({ toolCallId: "c", success: true });
    for (const value of [undefined, null, bytes.toString(), new Uint8Array(bytes), {}, 1]) {
        assert.throws(() => projectOversizedCompletion(value, limits), TypeError);
    }
    for (const key of ["maxInputBytes", "maxOutputBytes"]) {
        for (const value of [undefined, null, 0, -1, 1.5, Infinity, NaN, "4096", Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => projectOversizedCompletion(bytes, { ...limits, [key]: value }), RangeError);
        }
    }
    const rejected = projectOversizedCompletion(bytes, { ...limits, maxInputBytes: bytes.length - 1 });
    assert.equal(rejected.reason, "input-limit");
    assert.equal(rejected.work.inputSlices, 0);
    assert.equal(rejected.work.generatedTokens, 0);
    assert.deepEqual(projectOversizedCompletion(bytes, { ...limits, maxInputBytes: bytes.length }).event,
        projectOversizedCompletion(bytes, limits).event);
});

const rawEnvelope = result => '{"id":"e","type":"tool.execution_complete","timestamp":"2026-10-23T12:00:00Z",'
    + '"agentId":"agent","parentId":"previous","data":{"toolCallId":"c","success":true,'
    + '"turnId":"turn","parentToolCallId":"parent","model":"model","result":' + result + '}}\n';
const nativeProjection = bytes => {
    const event = JSON.parse(bytes.toString("utf8"));
    const output = { id: event.id, type: event.type, timestamp: event.timestamp };
    for (const key of ["agentId", "parentId"]) if (Object.hasOwn(event, key)) output[key] = event[key];
    output.data = { toolCallId: event.data.toolCallId, success: event.data.success };
    for (const key of ["parentToolCallId", "turnId", "model"]) if (Object.hasOwn(event.data, key)) output.data[key] = event.data[key];
    return output;
};
const align = (text, marker, offset) => {
    const index = text.indexOf(marker);
    assert.notEqual(index, -1);
    const padding = (offset - Buffer.byteLength(text.slice(0, index)) % 4096 + 4096) % 4096;
    return Buffer.from(" ".repeat(padding) + text);
};

test("matches native JSON semantics across valid discarded grammars and slice alignments", () => {
    const values = [
        "null", "true", "false", "-0", "1e99999", "-1.25E-2", "123456789012345678901234567890",
        '""', String.raw`"\/\\\"\b\f\n\r\t\u0000\ud800\udfff\ud83d\ude00"`,
        '"\u00e9\u20ac\ud83d\ude00"', '[]', '{}',
        '{"__proto__":{"success":false},"constructor":{"toolCallId":"spoof"}}',
        '{"same":false,"same":{"nested":[null,true,-0,1e2,{},[]]}}',
        '{"success":false,"data":{"toolCallId":"spoof","success":true},"result":"PRIVATE_BODY"}',
        `"${"x".repeat(9000)}"`, "1".repeat(9000),
    ];
    let cases = 0;
    for (const value of values) {
        const text = rawEnvelope(value);
        for (const offset of [0, 1, 4080, 4090, 4095]) {
            const bytes = align(text, '"result":', offset);
            const result = projectOversizedCompletion(bytes, limits);
            assert.equal(result.kind, "projected", `value ${values.indexOf(value)}, offset ${offset}`);
            assert.deepEqual(result.event, nativeProjection(bytes));
            assert.equal(result.work.generatedTokens, result.work.consumedTokens);
            assert.equal(result.work.unobservedBatchTokenBound, 0);
            assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|__proto__|spoof/);
            cases++;
        }
    }
    assert.equal(cases, 85);
});

test("rejects malformed discarded JSON at every relevant tokenizer boundary", () => {
    const values = [
        "", "+1", "01", ".1", "1.", "1e", "1e+", "--1", "NaN", "Infinity",
        "tru", "truex", "falsefalse", "nul", "undefined", "True",
        "[1,]", "[,1]", "[1 2]", '{"a":1,}', '{"a" 1}', "{a:1}", '{"a":}',
        String.raw`"\x20"`, String.raw`"\u123"`, String.raw`"\uQQQQ"`, '"raw\tcontrol"',
        '"unfinished', '"unfinished\\', "[}", "{]", "true false", "/*x*/true",
        "\u00a0true", "true\u00a0", "\ufefftrue",
    ];
    for (const value of values) {
        for (const offset of [0, 4080, 4090, 4095]) {
            const bytes = align(rawEnvelope(value), '"result":', offset);
            assert.throws(() => JSON.parse(bytes.toString("utf8")), SyntaxError);
            const result = projectOversizedCompletion(bytes, limits);
            assert.equal(result.kind, "unavailable", `value ${JSON.stringify(value)}, offset ${offset}`);
            assert.equal(result.reason, "invalid-json");
            assert.equal(Object.hasOwn(result, "event"), false);
            assert.ok(result.work.generatedTokenUpperBound <= COMPLETION_PROJECTION_LIMITS.tokens + COMPLETION_PROJECTION_LIMITS.batchTokens);
        }
    }
});

test("preserves UTF-8 and escaped Unicode across slices without publishing invalid scalar identities", () => {
    for (const value of ["\u00e9", "\u20ac", "\ud83d\ude00"]) {
        for (let split = 1; split < Buffer.byteLength(value); split++) {
            const text = rawEnvelope(JSON.stringify(value + "x".repeat(4200)));
            const bytes = align(text, value, 4096 - split);
            const result = projectOversizedCompletion(bytes, limits);
            assert.equal(result.kind, "projected");
            assert.deepEqual(result.event, nativeProjection(bytes));
            assert.ok(result.work.largestDecodedSlice <= COMPLETION_PROJECTION_LIMITS.decodedSliceChars);
        }
    }
    for (const model of [String.raw`"\u00e9"`, String.raw`"\ud83d\ude00"`, String.raw`"\ud800"`, String.raw`"\udfff"`]) {
        const text = rawEnvelope("null").replace('"model":"model"', `"model":${model}`);
        for (let tail = 1; tail <= model.length; tail++) {
            const result = projectOversizedCompletion(align(text, model, 4096 - tail), limits);
            assert.equal(result.kind, "projected");
            const decoded = JSON.parse(model);
            assert.equal(result.event.data.model, decoded.isWellFormed() ? decoded : undefined);
        }
    }
    for (const key of ["id", "agentId", "parentId", "toolCallId", "turnId", "parentToolCallId"]) {
        for (const value of [String.raw`"\ud800"`, String.raw`"scope\u000a"`, String.raw`"scope\u0000"`]) {
            const text = rawEnvelope("null").replace(new RegExp(`"${key}":"[^"]*"`), `"${key}":${value}`);
            assert.equal(projectOversizedCompletion(align(text, value, 4093), limits).reason, "invalid-identity");
        }
    }
    const invalidUtf8 = [
        [0xc0, 0xaf], [0xe0, 0x80, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80],
        [0x80], [0xf5, 0x80, 0x80, 0x80], [0xe2, 0x28, 0xa1], [0xf0, 0x9f, 0x98],
    ];
    for (const octets of invalidUtf8) {
        const source = align(rawEnvelope('"MARKER"'), "MARKER", 4095);
        const index = source.indexOf("MARKER");
        const result = projectOversizedCompletion(Buffer.concat([source.subarray(0, index), Buffer.from(octets),
            source.subarray(index + 6)]), limits);
        assert.equal(result.reason, "invalid-utf8");
        assert.equal(result.work.inputSlices, 0);
        assert.equal(Object.hasOwn(result, "event"), false);
    }
});

test("validates only final decoded envelope fields while charging all overwritten content", () => {
    const text = rawEnvelope("null");
    for (const key of ["id", "agentId", "parentId", "toolCallId", "turnId", "parentToolCallId", "type", "timestamp", "model"]) {
        const pair = new RegExp(`"${key}":("[^"]*")`);
        const escapedKey = "\\u" + key.charCodeAt(0).toString(16).padStart(4, "0") + key.slice(1);
        for (const old of ["null", "123", "{}", "[]", '"invalid value"', `"${"x".repeat(9000)}"`]) {
            const changed = text.replace(pair, (_, value) => `"${key}":${old},"${escapedKey}":${value}`);
            const bytes = align(changed, `"${escapedKey}"`, 4093);
            const result = projectOversizedCompletion(bytes, limits);
            assert.equal(result.kind, "projected");
            assert.deepEqual(result.event, nativeProjection(bytes));
        }
    }
    const replacedData = text.replace('"data":', `"data":{"unknown":"PRIVATE_OLD","result":[${"0,".repeat(34000)}0]},"data":`);
    const exhausted = projectOversizedCompletion(Buffer.from(replacedData), limits);
    assert.equal(exhausted.reason, "token-limit", "A valid final data object must not reset prior token work");
    assert.equal(Object.hasOwn(exhausted, "event"), false);
    assert.doesNotMatch(JSON.stringify(exhausted), /PRIVATE_OLD/);
    const tooDeep = text.replace('"data":', `"data":{"result":${"[".repeat(63)}0${"]".repeat(63)}},"data":`);
    assert.equal(projectOversizedCompletion(Buffer.from(tooDeep), limits).reason, "depth-limit");
});

test("accounts for late malformed literals and observes whole-lexeme chunks near the feed size", () => {
    const densePrefix = '"result":[' + "0,".repeat(2500);
    const initial = rawEnvelope("null").replace('"result":null', densePrefix + "BAD]");
    for (const initialLetter of ["t", "f", "n"]) {
        const literal = initialLetter.repeat(16);
        const text = initial.replace("BAD", literal);
        const bytes = align(text, literal, 4080);
        const result = projectOversizedCompletion(bytes, limits);
        assert.equal(result.reason, "invalid-json");
        assert.ok(result.work.generatedTokens > 0);
        assert.equal(result.work.unobservedBatchTokenBound, COMPLETION_PROJECTION_LIMITS.batchTokens);
        assert.equal(result.work.generatedTokenUpperBound, result.work.generatedTokens + COMPLETION_PROJECTION_LIMITS.batchTokens);
        assert.ok(result.work.generatedTokenUpperBound <= COMPLETION_PROJECTION_LIMITS.tokens + COMPLETION_PROJECTION_LIMITS.batchTokens);
    }
    for (const value of [`"${"x".repeat(4094)}"`, "1".repeat(4095)]) {
        const bytes = align(rawEnvelope(value), value, 0);
        const result = projectOversizedCompletion(bytes, limits);
        assert.equal(result.kind, "projected");
        if (value.startsWith('"')) {
            assert.ok(result.work.omittedStringChars > 3000);
            assert.ok(result.work.largestValueChunk <= COMPLETION_PROJECTION_LIMITS.scalarChars + 1);
        } else assert.ok(result.work.largestValueChunk >= 4094);
        assert.ok(result.work.largestValueChunk <= COMPLETION_PROJECTION_LIMITS.valueChunkChars);
    }
});

test("buffered string escapes never enlarge a parser feed or its carry allocation bound", () => {
    for (const offset of [4091, 4092, 4093, 4094, 4095]) {
        const value = String.raw`{"text":"short\u0041","items":[` + "0,".repeat(3500) + "0]}";
        const bytes = align(rawEnvelope(value), String.raw`\u0041`, offset);
        const result = projectOversizedCompletion(bytes, limits);
        assert.equal(result.kind, "projected");
        assert.deepEqual(result.event, nativeProjection(bytes));
        assert.equal(result.work.generatedTokens, result.work.consumedTokens);
        assert.ok(result.work.largestParserSlice <= COMPLETION_PROJECTION_LIMITS.decodedSliceChars);
        assert.ok(result.work.largestParserSlice + COMPLETION_PROJECTION_LIMITS.parserCarryChars
            <= COMPLETION_PROJECTION_LIMITS.joinedInputChars);
        assert.ok(result.work.largestBatch <= COMPLETION_PROJECTION_LIMITS.batchTokens);
    }
});
