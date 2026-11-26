// Port of the mcp-diagnostic-bundle skill's collect_bundle.py as a library.
// Filters one server, normalizes one frame per call, separates host and
// effective outcomes, redacts structured diagnostics, clusters effective
// failures and produces the exact schema-2 artifact set. It never performs a
// live reproduction or writes to a tracker.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
    CLUSTER_ENGINE_VERSION, D, S, cluster, cmpStr, cpLen, cpSlice, decodeUtf8, diagnosticAnalysis,
    frameDiagnostic, fullmatch, isBool, isDict, isFloat, isInt, isList, isNum, isStr, JsonDecodeError, normalise,
    num, pyDumps, pyEq, pyInt, pyLoads, pyLstrip, pyRepr, pyRound, pySplitlines, pyStr, pyStrip, pyTruthy, sanity,
    sha256Hex, sortStrings, toPlain, typeName,
} from "./cluster.mjs";
import { Redactor, verify } from "./redact.mjs";
import { createZip } from "./zip.mjs";

export const COLLECTOR_VERSION = "2.1.0";
export const SCHEMA_VERSION = 2;
export const LIVE_WINDOW_DAYS = 14;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const CAPTURE_SCOPES = ["complete", "failures-only", "sample"];

const OUTCOMES = ["ok", "fail", "unknown"];
const VERDICTS = new Set([
    "unclassified", "test-probe", "caller-error", "product-bug", "contract-gap", "by-design", "client-side",
    "infra-transient", "fixed-since", "not-reproduced-now",
]);
const RW_CLASSES = new Set(["read", "write", "unknown-treat-as-write"]);
const REPRO_DISPOSITIONS = new Set([
    "not-attempted", "not-attempted-unsafe", "not-attempted-no-input", "inconclusive", "not-reproduced-now",
]);
const ALIASES = {
    ts: ["ts", "timestamp", "time", "started_at", "created_at"],
    session_id: ["session_id", "session", "sessionid", "conversation_id"],
    call_id: ["call_id", "tool_call_id", "tool_complete_call_id", "id"],
    tool: ["tool", "name", "tool_name", "tool_start_name"],
    args: ["args", "arguments_json", "arguments", "input", "params"],
    error: ["error", "err", "tool_complete_error_message", "error_message"],
    result: ["result", "tool_complete_result_content", "output", "content", "body"],
    success: ["success", "tool_complete_success", "ok", "is_success"],
    duration_ms: ["duration_ms", "duration", "elapsed_ms", "latency_ms"],
};

const SAFE_FRAME_IDENTIFIER = "[A-Za-z0-9._:/+=-]{1,1024}";
const SAFE_ALIAS = `<[A-Za-z0-9_-]+-${D}+:[0-9a-f]{4,64}>`;
const SAFE_SLUG = "[a-z0-9][a-z0-9-]{0,47}";
const ISO_DAY = new RegExp(`^(${D}{4}-${D}{2}-${D}{2})`, "u");
const SAFE_PREDICATE = "[A-Za-z][A-Za-z0-9_.:-]*(?:=[A-Za-z0-9_.:-]+)?";
const SAFE_TOOL = "[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}";
const SAFE_SERVER = "[A-Za-z0-9][A-Za-z0-9._:-]{0,199}";
const SAFE_ADAPTER = "[A-Za-z0-9][A-Za-z0-9._:-]{0,63}";
const SAFE_CODE = "[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}";
const SAFE_OPERATION_PATH = `\\$(?:(?:\\.(?:[A-Za-z0-9_-]{1,80}|\\*))|(?:\\[${D}{1,9}\\])){0,32}`;
const matches = (pattern, value) => isStr(value) && Boolean(fullmatch(pattern, value));
const safeIdentifier = (value) => matches(SAFE_FRAME_IDENTIFIER, value) || matches(SAFE_ALIAS, value);

/** Input is malformed or violates a bundle safety contract (CLI exit 2, or 1 for no usable input). */
export class InputError extends Error {
    constructor(message, { exitCode = 2, details = [] } = {}) {
        super(message);
        this.name = "InputError";
        this.exitCode = exitCode;
        this.details = details;
    }
}

/** The final redaction gate found residue; nothing may be written (CLI exit 3). */
export class RedactionGateError extends Error {
    constructor(verification) {
        super(`REDACTION VERIFICATION FAILED — ${verification.finding_count} finding(s). Bundle NOT written.`);
        this.name = "RedactionGateError";
        this.exitCode = 3;
        this.verification = verification;
    }
}

const isContainer = (value) => isDict(value) || isList(value);
const get = (object, key, fallback = null) => (Object.hasOwn(object, key) ? object[key] : fallback);
const casefold = (value) => value.toUpperCase().toLowerCase();
const isBlank = (value) => value === null || value === undefined || value === "";
const unique = (values) => [...new Set(values.filter(Boolean))];
const sum = (values) => values.reduce((total, value) => total + value, 0);
const counter = () => new Map();
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const sortedEntries = (map) => Object.fromEntries(sortStrings(map.keys()).map((key) => [key, map.get(key)]));
const mostCommon = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

const loadsOptions = {
    duplicates: "error",
    constants: "error",
    duplicateError: (key) => new InputError(`duplicate JSON key ${pyRepr(key)}`),
    constantError: (name) => new InputError(`non-finite JSON number ${name}`),
};
const jsonLoads = (text) => pyLoads(text, loadsOptions);
const sortedJson = (value) => pyDumps(value, { sortKeys: true, ensureAscii: false, separators: [",", ":"], allowNan: false });

function stringify(value) {
    if (value === null || value === undefined || value === false) return "";
    if (isContainer(value)) {
        try {
            return pyDumps(value, { ensureAscii: false, separators: [",", ":"], allowNan: false });
        } catch {
            throw new InputError("value is not strict JSON");
        }
    }
    return pyStr(value);
}

function errorPresent(value) {
    if (value === null || value === undefined || value === false) return false;
    if (isStr(value)) return Boolean(pyStrip(value));
    return isContainer(value) || isNum(value) ? pyTruthy(value) : true;
}

function normaliseAliasValue(field, value) {
    if (field === "error" && !errorPresent(value)) return ["empty", null];
    if (field !== "error" && isBlank(value)) return ["empty", null];
    if (field === "success") {
        if (isBool(value)) return ["success", value];
        if (isStr(value) && ["true", "false"].includes(pyStrip(value).toLowerCase())) {
            return ["success", pyStrip(value).toLowerCase() === "true"];
        }
        if (isNum(value) && (pyEq(value, 0) || pyEq(value, 1))) return ["success", num(value) !== 0];
        return ["invalid", typeName(value), cpSlice(pyRepr(value), 0, 80)];
    }
    if (["args", "error", "result"].includes(field)) {
        if (isContainer(value)) {
            try {
                return ["json", sortedJson(value)];
            } catch {
                throw new InputError(`${field} contains a non-JSON value`);
            }
        }
        if (isStr(value)) {
            const stripped = pyStrip(value);
            if ("[{".includes(stripped.slice(0, 1))) {
                try {
                    return ["json", sortedJson(jsonLoads(stripped))];
                } catch {
                    // not JSON; compare as text
                }
            }
            return ["text", stripped];
        }
        return ["scalar", typeName(value), value];
    }
    if (["session_id", "call_id", "tool"].includes(field)) return ["text", pyStr(value)];
    if (field === "duration_ms") return ["number", value];
    return [typeName(value), value];
}

function pick(row, field) {
    const aliases = new Map(ALIASES[field].map((alias, index) => [casefold(alias), index]));
    const found = Object.entries(row)
        .filter(([key]) => aliases.has(casefold(key)))
        .map(([key, value]) => [aliases.get(casefold(key)), key, value])
        .sort((a, b) => a[0] - b[0]);
    if (!found.length) return null;
    const normalized = found.map(([, name, value]) => [normaliseAliasValue(field, value), name, value]);
    if (normalized.slice(1).some(([canonical]) => !pyEq(canonical, normalized[0][0]))) {
        throw new InputError(`conflicting aliases for ${field}: ${normalized.map(([, name]) => name).join(", ")}`);
    }
    const chosen = normalized.find(([canonical]) => canonical[0] !== "empty");
    return chosen ? chosen[2] : normalized[0][2];
}

function present(row, ...names) {
    const wanted = new Set(names.map(casefold));
    const found = Object.entries(row).filter(([key]) => wanted.has(casefold(key)));
    if (!found.length) return [false, null];
    const canonical = found.map(([, value]) => {
        try {
            return sortedJson(value);
        } catch {
            throw new InputError(`${names.join("/")} contains a non-JSON value`);
        }
    });
    if (canonical.slice(1).some((value) => value !== canonical[0])) {
        throw new InputError(`conflicting aliases for ${names.join("/")}`);
    }
    return [true, found[0][1]];
}

// --- timestamps (Python 3.9 datetime semantics) ----------------------------

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysIn = (year, month) =>
    MONTH_DAYS[month - 1] + (month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 1 : 0);

function validDateTime(parts) {
    const { year, month, day, hour = 0, minute = 0, second = 0 } = parts;
    return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month)
        && hour <= 23 && minute <= 59 && second <= 59;
}

// Emulates CPython 3.9 parse_hh_mm_ss_ff over text[start, end).
function parseHms(text, start, end) {
    const values = [0, 0, 0];
    let position = start;
    let micro = 0;
    for (let index = 0; index < 3; index += 1) {
        const digits = text.slice(position, position + 2);
        if (!/^[0-9]{2}$/.test(digits)) return null;
        values[index] = Number(digits);
        position += 2;
        const char = position < text.length ? text[position] : "\0";
        position += 1;
        if (position >= end) return { values, micro, more: char !== "\0" };
        if (char === ":") continue;
        if (char === ".") break;
        return null;
    }
    const remains = end - position;
    if (remains !== 3 && remains !== 6) return null;
    const digits = text.slice(position, end);
    if (!/^[0-9]+$/.test(digits)) return null;
    micro = Number(digits) * (remains === 3 ? 1000 : 1);
    return { values, micro, more: end < text.length };
}

/** Python 3.9 datetime.fromisoformat() grammar; returns parts or null. */
export function fromIsoformat(text) {
    const codePoints = Array.from(text);
    const date = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(codePoints.slice(0, 10).join(""));
    if (!date) return null;
    const parts = { year: +date[1], month: +date[2], day: +date[3], offset: null, offsetMicro: 0, micro: 0 };
    if (codePoints.length > 10) {
        const rest = codePoints.slice(11).join("");
        const signAt = rest.search(/[+-]/);
        const end = signAt < 0 ? rest.length : signAt;
        const time = parseHms(rest, 0, end);
        if (!time || (signAt < 0 && time.more)) return null;
        [parts.hour, parts.minute, parts.second] = time.values;
        parts.micro = time.micro;
        if (signAt >= 0) {
            if (![6, 9, 16].includes(rest.length - signAt)) return null;
            const zone = parseHms(rest, signAt + 1, rest.length);
            if (!zone || zone.more) return null;
            const sign = rest[signAt] === "-" ? -1 : 1;
            parts.offset = sign * (zone.values[0] * 3600 + zone.values[1] * 60 + zone.values[2]);
            parts.offsetMicro = sign * zone.micro;
            if (Math.abs(parts.offset + parts.offsetMicro / 1e6) >= 86400) return null;
        }
    }
    return validDateTime(parts) ? parts : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const STRPTIME_DIRECTIVES = {
    Y: `(${D}${D}${D}${D})`,
    m: `(1[0-2]|0[1-9]|[1-9])`,
    d: `(3[01]|[12]${D}|0[1-9]|[1-9]| [1-9])`,
    H: `(2[0-3]|[0-1]${D}|${D})`,
    M: `([0-5]${D}|${D})`,
    S: `(6[0-1]|[0-5]${D}|${D})`,
    f: "([0-9]{1,6})",
    b: `((?i:${MONTHS.join("|")}))`,
    z: `([+-]${D}${D}:?[0-5]${D}(?::?[0-5]${D}(?:\\.${D}{1,6})?)?|Z)`,
};
const STRPTIME_FORMATS = [
    "%d/%b/%Y:%H:%M:%S %z", "%Y-%m-%d %H:%M:%S.%f%z", "%Y-%m-%d %H:%M:%S%z", "%Y-%m-%d %H:%M:%S %z",
    "%Y/%m/%d %H:%M:%S.%f%z", "%Y/%m/%d %H:%M:%S%z", "%Y/%m/%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M:%S.%f", "%Y/%m/%d %H:%M:%S",
].map((format) => {
    const names = [];
    const source = format.replace(/%(.)|(\s+)|([.^$*+?(){}[\]|\\/])/g, (_, directive, space, literal) => {
        if (directive) {
            names.push(directive);
            return STRPTIME_DIRECTIVES[directive];
        }
        return space ? `${S}+` : `\\${literal}`;
    });
    return { names, pattern: new RegExp(`^${source}`, "u") };
});

function strptime(text) {
    for (const { names, pattern } of STRPTIME_FORMATS) {
        const match = pattern.exec(text);
        if (!match || match[0].length !== text.length) continue;
        const parts = { hour: 0, minute: 0, second: 0, micro: 0, offset: null, offsetMicro: 0 };
        let valid = true;
        names.forEach((name, index) => {
            const value = match[index + 1];
            if (name === "Y") parts.year = pyInt(value);
            else if (name === "m") parts.month = pyInt(value);
            else if (name === "d") parts.day = pyInt(pyStrip(value));
            else if (name === "b") parts.month = MONTHS.indexOf(value.toLowerCase()) + 1;
            else if (name === "H") parts.hour = pyInt(value);
            else if (name === "M") parts.minute = pyInt(value);
            else if (name === "S") parts.second = pyInt(value);
            else if (name === "f") parts.micro = Number(value.padEnd(6, "0"));
            else if (name === "z") {
                if (value === "Z") {
                    parts.offset = 0;
                    return;
                }
                let zone = value;
                if (zone[3] === ":") {
                    zone = zone.slice(0, 3) + zone.slice(4);
                    if (cpLen(zone) > 5) {
                        if (zone[5] !== ":") valid = false;
                        zone = zone.slice(0, 5) + zone.slice(6);
                    }
                }
                const sign = zone[0] === "-" ? -1 : 1;
                const seconds = pyInt(cpSlice(zone, 1, 3)) * 3600 + pyInt(cpSlice(zone, 3, 5)) * 60
                    + (cpSlice(zone, 5, 7) ? pyInt(cpSlice(zone, 5, 7)) : 0);
                const remainder = cpSlice(zone, 8);
                parts.offset = sign * seconds;
                parts.offsetMicro = sign * (remainder ? pyInt(remainder.padEnd(6, "0")) : 0);
                if (Math.abs(parts.offset + parts.offsetMicro / 1e6) >= 86400) valid = false;
            }
        });
        if (valid && validDateTime(parts)) return parts;
    }
    return null;
}

function parseAssumedOffset(value) {
    if (value === null || value === undefined) return null;
    const raw = pyStrip(String(value));
    if (raw.toUpperCase() === "Z") return 0;
    const match = fullmatch(`([+-])(${D}{2}):?(${D}{2})`, raw);
    if (!match) throw new InputError("--assume-offset must be Z or ±HH:MM");
    const [hours, minutes] = [pyInt(match[2]), pyInt(match[3])];
    if (hours > 23 || minutes > 59) throw new InputError("--assume-offset is outside the valid UTC offset range");
    return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes) * 60;
}

const pad = (value, width = 2) => String(value).padStart(width, "0");

function formatOffset(seconds) {
    const total = Math.abs(Math.trunc(seconds / 60));
    return `${seconds >= 0 ? "+" : "-"}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// Python strftime("%z") for a fixed offset.
function strftimeZ(seconds, micro) {
    let totalMicro = seconds * 1_000_000 + micro;
    const sign = totalMicro < 0 ? "-" : "+";
    totalMicro = Math.abs(totalMicro);
    const whole = Math.floor(totalMicro / 1_000_000);
    const rest = totalMicro % 1_000_000;
    let out = `${sign}${pad(Math.floor(whole / 3600))}${pad(Math.floor(whole / 60) % 60)}`;
    if (whole % 60 || rest) out += pad(whole % 60);
    if (rest) out += `.${pad(rest, 6)}`;
    return out;
}

function utcFields(parts) {
    const base = new Date(0);
    base.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    base.setUTCHours(parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, 0);
    let micro = (parts.micro ?? 0) - (parts.offsetMicro ?? 0);
    let seconds = base.getTime() / 1000 - (parts.offset ?? 0) + Math.floor(micro / 1_000_000);
    micro = ((micro % 1_000_000) + 1_000_000) % 1_000_000;
    const date = new Date(seconds * 1000);
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;
    return { date, micro };
}

const stamp = (date) =>
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

/**
 * Return [strict UTC timestamp, source offset]. Missing timestamps are
 * [null, null]; invalid and naive timestamps without an explicit offset throw.
 */
export function toUtc(raw, assumeOffset = null) {
    if (raw === null || raw === undefined || (isStr(raw) && !pyStrip(raw))) return [null, null];
    if (!(isStr(raw) || isNum(raw) || isBool(raw))) throw new InputError("timestamp must be a string, number, or null");
    const source = pyStrip(pyStr(raw));
    let iso = /[Zz]$/.test(source) ? `${source.slice(0, -1)}+00:00` : source;
    const compact = fullmatch(
        `(${D}{4}-${D}{2}-${D}{2}[T ]${D}{2}:${D}{2}(?::${D}{2}(?:\\.${D}+)?)?)([+-]${D}{2})(${D}{2})?`, iso,
    );
    if (compact) iso = `${compact[1]}${compact[2]}:${compact[3] ?? "00"}`;
    const parsed = fromIsoformat(iso) ?? strptime(source);
    if (!parsed) throw new InputError(`invalid timestamp ${pyRepr(source)}`);
    let originalOffset;
    if (parsed.offset === null) {
        const assumed = parseAssumedOffset(assumeOffset);
        if (assumed === null) throw new InputError(`naive timestamp ${pyRepr(source)} requires --assume-offset`);
        parsed.offset = assumed;
        originalOffset = formatOffset(assumed);
    } else {
        const sourceOffset = new RegExp(`([+-]${D}{2})(?::?(${D}{2}))?$`, "u").exec(source);
        originalOffset = sourceOffset ? `${sourceOffset[1]}:${sourceOffset[2] ?? "00"}`
            : strftimeZ(parsed.offset, parsed.offsetMicro);
        if (originalOffset && !originalOffset.includes(":")) {
            originalOffset = `${cpSlice(originalOffset, 0, 3)}:${cpSlice(originalOffset, 3)}`;
        }
    }
    const utc = utcFields(parsed);
    if (!utc) throw new InputError(`invalid timestamp ${pyRepr(source)}`);
    return [`${stamp(utc.date)}.${pad(Math.floor(utc.micro / 1000), 3)}Z`, originalOffset];
}

function parseUtcStamp(value) {
    if (!isStr(value)) return null;
    const parts = fromIsoformat(value.replaceAll("Z", "+00:00"));
    if (!parts) return null;
    const utc = utcFields(parts);
    return utc ? utc.date.getTime() + utc.micro / 1000 : null;
}

// --- row normalization ------------------------------------------------------

function canonicalOutcome(row, errorValue) {
    const [hasOutcome, supplied] = present(row, "outcome");
    const success = pick(row, "success");
    let successOutcome = null;
    if (isBool(success)) successOutcome = success ? "ok" : "fail";
    else if (isStr(success) && ["true", "false"].includes(pyStrip(success).toLowerCase())) {
        successOutcome = pyStrip(success).toLowerCase() === "true" ? "ok" : "fail";
    } else if (isNum(success)) {
        if (!Number.isFinite(num(success)) || !(pyEq(success, 0) || pyEq(success, 1))) {
            throw new InputError("numeric success values must be finite 0 or 1");
        }
        successOutcome = num(success) ? "ok" : "fail";
    } else if (success !== null && success !== undefined) {
        throw new InputError("success must be boolean, 0/1, true/false, or null");
    }
    if (hasOutcome) {
        if (!isStr(supplied) || !OUTCOMES.includes(supplied.toLowerCase())) {
            throw new InputError("outcome must be ok, fail, or unknown");
        }
        const outcome = supplied.toLowerCase();
        if (successOutcome !== null && outcome !== successOutcome) throw new InputError("outcome conflicts with success");
        return outcome;
    }
    if (successOutcome !== null) return successOutcome;
    return errorPresent(errorValue) ? "fail" : "unknown";
}

function strictStatus(value, label) {
    if (isBlank(value)) return null;
    let status;
    if (isBool(value) || isFloat(value)) throw new InputError(`${label} must be a three-digit integer or null`);
    if (isInt(value)) status = Number(value);
    else if (isStr(value) && fullmatch(`${D}{3}`, pyStrip(value))) status = pyInt(pyStrip(value));
    else throw new InputError(`${label} must be a three-digit integer or null`);
    if (status < 100 || status > 599) throw new InputError(`${label} must be between 100 and 599`);
    return status;
}

function typedStatus(row) {
    const values = [];
    const names = [];
    for (const [name, value] of Object.entries(row)) {
        if (["status_code", "statuscode"].includes(casefold(name)) && !isBlank(value)) {
            values.push(strictStatus(value, name));
            names.push(name);
        }
    }
    if (new Set(values).size > 1) throw new InputError(`conflicting status aliases: ${names.join(", ")}`);
    return values.length ? values[0] : null;
}

function typedString(row, name) {
    const [found, value] = present(row, name);
    if (!found || isBlank(value)) return null;
    if (!isStr(value)) throw new InputError(`${name} must be a string or null`);
    return value;
}

function typedIdentifier(value, name) {
    if (isBlank(value)) return null;
    if (isBool(value) || !(isStr(value) || isInt(value))) throw new InputError(`${name} must be a string, integer, or null`);
    const text = pyStr(value);
    if (!safeIdentifier(text)) throw new InputError(`${name} is invalid or too long`);
    return text;
}

function typedStringList(row, name) {
    const [found, value] = present(row, name);
    if (!found) return null;
    if (value === null) return [];
    if (!isList(value) || value.some((item) => !isStr(item) || !item || cpLen(item) > 1024)) {
        throw new InputError(`${name} must be an array of strings`);
    }
    return [...value];
}

function adaptOperation(item, index) {
    if (!isDict(item)) throw new InputError("operation diagnostics must be objects");
    const path = get(item, "path", `$.operations[${index}]`);
    if (!matches(SAFE_OPERATION_PATH, path)) throw new InputError("operation path must be a bounded string");
    const outcome = get(item, "outcome", "unknown");
    if (!isStr(outcome) || !OUTCOMES.includes(outcome.toLowerCase())) {
        throw new InputError("operation outcome must be ok, fail, or unknown");
    }
    const status = strictStatus(get(item, "status_code"), "operation.status_code");
    let errorCode = get(item, "error_code");
    if (isBlank(errorCode)) errorCode = null;
    else if (!matches(SAFE_CODE, errorCode)) throw new InputError("operation.error_code must be a bounded diagnostic token");
    const requestIds = get(item, "request_ids", []);
    if (!isList(requestIds) || requestIds.some((value) => !safeIdentifier(value))) {
        throw new InputError("operation.request_ids must be an array of identifiers");
    }
    return {
        path,
        outcome: outcome.toLowerCase(),
        status_code: status,
        error_code: errorCode,
        request_ids: [...requestIds],
        _diagnostic_raw: get(item, "diagnostic", ""),
    };
}

function scanPayloads(errorValue, resultValue) {
    const predicates = [];
    const operations = [];
    const metadata = new Map();
    const modes = counter();
    const limits = [];
    let inconclusive = false;
    let bodyAvailable = false;
    for (const [source, value] of [["error", errorValue], ["result", resultValue]]) {
        const body = stringify(value);
        if (!body) continue;
        const analysis = diagnosticAnalysis(body, source);
        bodyAvailable = bodyAvailable || analysis.body_available;
        predicates.push(...analysis.predicates);
        inconclusive = inconclusive || analysis.inconclusive;
        bump(modes, analysis.scan_mode);
        limits.push(analysis.limits);
        for (const [key, values] of Object.entries(analysis.metadata)) {
            if (!metadata.has(key)) metadata.set(key, []);
            metadata.get(key).push(...values);
        }
        const base = operations.length;
        analysis.operations.forEach((operation, index) => operations.push(adaptOperation(operation, base + index)));
    }
    return {
        predicates: unique(predicates),
        operations,
        metadata: new Map([...metadata].map(([key, values]) => [key, unique(values)])),
        inconclusive,
        scanModes: sortedEntries(modes),
        limits,
        bodyAvailable,
    };
}

function inferServer(tool) {
    if (!tool) return null;
    if (tool.toLowerCase().startsWith("mcp__")) {
        const parts = tool.split("__");
        if (parts.length >= 3 && parts[1]) return parts[1];
    }
    return tool.split(/[-_.:/]+/)[0] || null;
}

const hashId = (material) => `f-${sha256Hex(Buffer.from(material, "utf8")).slice(0, 24)}`;

function frameIdOf(frame) {
    const identity = frame.session_id && frame.call_id
        ? { server: frame.server, session_id: frame.session_id, call_id: frame.call_id }
        : Object.fromEntries([
            "server", "tool", "ts", "outcome", "effective_outcome", "status_code", "error_code", "request_ids",
            "embedded_failure", "args", "_diagnostic_raw",
        ].map((key) => [key, get(frame, key)]));
    return hashId(pyDumps(identity, { sortKeys: true, ensureAscii: false, separators: [",", ":"] }));
}

function normaliseRow(row, adapter, assumeOffset) {
    const errorValue = pick(row, "error");
    const resultValue = pick(row, "result");
    const errorText = stringify(errorValue);
    const resultText = stringify(resultValue);
    const [ts, sourceOffset] = toUtc(pick(row, "ts"), assumeOffset);
    const tool = pyStrip(stringify(pick(row, "tool")));
    if (!tool || !matches(SAFE_TOOL, tool)) {
        throw new InputError("tool name is required and must be a bounded namespace token");
    }
    const outcome = canonicalOutcome(row, errorValue);
    const suppliedEmbedded = typedStringList(row, "embedded_failure");
    if (suppliedEmbedded && suppliedEmbedded.some((value) => !matches(SAFE_PREDICATE, value))) {
        throw new InputError("embedded_failure contains an invalid predicate");
    }
    const analysis = scanPayloads(errorValue, resultValue);
    const scanned = [...analysis.predicates];
    let scanInconclusive = analysis.inconclusive;
    let statusCode = typedStatus(row);
    if (statusCode !== null && statusCode >= 400) scanned.push(`statusCode=${statusCode}`);
    if (outcome !== "fail" && errorPresent(errorValue) && !scanned.includes("error-field")) scanned.push("error-field");

    const [operationsPresent, suppliedOperationsValue] = present(row, "operations");
    let operations;
    if (operationsPresent) {
        const supplied = suppliedOperationsValue ?? [];
        if (!isList(supplied) || supplied.some((item) => !isDict(item))) {
            throw new InputError("operations must be an array of objects");
        }
        operations = supplied.map((item, index) => adaptOperation(item, index));
    } else operations = analysis.operations;
    const failedOperationStatuses = [...new Set(operations
        .filter((operation) => operation.outcome === "fail" && operation.status_code !== null)
        .map((operation) => operation.status_code))].sort((a, b) => a - b);
    if (operations.some((operation) => operation.outcome === "fail"
        || (operation.status_code !== null && operation.status_code >= 400))) {
        scanned.push("operationFailure", ...failedOperationStatuses.map((status) => `statusCode=${status}`));
    }

    const metadata = analysis.metadata;
    const structuredStatuses = [];
    for (const rawStatus of metadata.get("status_codes") ?? []) {
        try {
            structuredStatuses.push(strictStatus(rawStatus, "diagnostic status"));
        } catch (error) {
            if (!(error instanceof InputError)) throw error;
            scanInconclusive = true;
        }
    }
    const failingStatuses = [...new Set(structuredStatuses.filter((value) => value >= 400))].sort((a, b) => a - b);
    if (statusCode === null) {
        if (failingStatuses.length === 1) statusCode = failingStatuses[0];
        else if (outcome !== "fail" && !scanInconclusive) {
            const allStatuses = [...new Set(structuredStatuses)];
            if (allStatuses.length === 1) statusCode = allStatuses[0];
        }
    }
    const errorCodes = [];
    for (const value of metadata.get("error_codes") ?? []) {
        if (matches(SAFE_CODE, value)) errorCodes.push(value);
        else scanInconclusive = true;
    }
    let errorCode = typedString(row, "error_code");
    if (errorCode === null) {
        const failingCodes = sortStrings(new Set(operations
            .filter((operation) => operation.outcome === "fail" && operation.error_code)
            .map((operation) => operation.error_code)));
        if (failingCodes.length === 1) errorCode = failingCodes[0];
        else if (new Set(errorCodes).size === 1) errorCode = errorCodes[0];
    }
    if (errorCode && !matches(SAFE_CODE, errorCode)) throw new InputError("error_code is invalid or too long");
    const suppliedIds = typedStringList(row, "request_ids") || [];
    if (suppliedIds.some((value) => !safeIdentifier(value))) {
        throw new InputError("request_ids contains an invalid identifier");
    }
    const extractedIds = [];
    for (const key of ["request_ids", "client_request_ids", "x_ms_request_ids", "correlation_ids"]) {
        for (const value of metadata.get(key) ?? []) {
            if (safeIdentifier(value)) extractedIds.push(value);
            else scanInconclusive = true;
        }
    }
    const requestIds = unique([...suppliedIds, ...extractedIds]);

    const embedded = unique([...(suppliedEmbedded || []), ...scanned]);
    const [hasEffective, suppliedEffective] = present(row, "effective_outcome");
    let effective;
    if (hasEffective) {
        if (!isStr(suppliedEffective) || !OUTCOMES.includes(suppliedEffective.toLowerCase())) {
            throw new InputError("effective_outcome must be ok, fail, or unknown");
        }
        effective = suppliedEffective.toLowerCase();
        if ((outcome === "fail" || embedded.length) && effective !== "fail") {
            throw new InputError("effective_outcome conflicts with failure evidence");
        }
    } else effective = outcome === "fail" || embedded.length ? "fail" : outcome;

    let server = typedString(row, "server");
    if (server === null) server = inferServer(tool);
    if (server && !matches(SAFE_SERVER, server)) throw new InputError("server must be a bounded namespace token");
    let duration = pick(row, "duration_ms");
    if (!isBlank(duration)) {
        if (isBool(duration) || !isNum(duration) || !Number.isFinite(num(duration)) || num(duration) < 0) {
            throw new InputError("duration_ms must be a finite non-negative number or null");
        }
    } else duration = null;

    const frame = {
        ts,
        _offset: sourceOffset,
        session_id: typedIdentifier(pick(row, "session_id"), "session_id"),
        call_id: typedIdentifier(pick(row, "call_id"), "call_id"),
        server,
        tool,
        outcome,
        effective_outcome: effective,
        embedded_failure: embedded,
        operations,
        duration_ms: duration,
        args: stringify(pick(row, "args")),
        _diagnostic_raw: errorText || (effective === "fail" ? resultText : ""),
        _payload_available: analysis.bodyAvailable,
        _payload_scan_inconclusive: scanInconclusive,
        _payload_scan_modes: analysis.scanModes,
        _payload_scan_limits: analysis.limits,
        status_code: statusCode,
        error_code: errorCode,
        request_ids: requestIds,
        adapter: typedString(row, "adapter") || adapter,
    };
    if (!matches(SAFE_ADAPTER, frame.adapter)) throw new InputError("adapter must be a bounded token");
    const suppliedFrameId = typedString(row, "frame_id");
    if (suppliedFrameId) {
        if (!/^f-[0-9a-f]{24}$/.test(suppliedFrameId)) throw new InputError("frame_id must match f-<24 lowercase hex>");
        frame.frame_id = suppliedFrameId;
        frame._frame_id_source = "supplied";
    } else {
        frame.frame_id = frameIdOf(frame);
        frame._frame_id_source = frame.session_id && frame.call_id ? "host-call" : "anonymous";
        if (frame._frame_id_source === "anonymous") frame._anonymous_id_base = frame.frame_id;
    }
    return frame;
}

function assignAnonymousFrameIds(frames) {
    const occurrences = counter();
    for (const frame of frames) {
        if (frame._frame_id_source !== "anonymous") continue;
        const base = frame._anonymous_id_base ?? frame.frame_id;
        bump(occurrences, base);
        frame.frame_id = hashId(pyDumps([base, occurrences.get(base)], { ensureAscii: false, separators: [",", ":"] }));
    }
}

function sourceText(data, name, bad) {
    if (isStr(data)) return data.replace(/\r\n?/g, "\n");
    const [text, at] = decodeUtf8(data);
    if (text === null) {
        bad.push(`${name}: cannot read UTF-8 input ('utf-8' codec can't decode byte 0x${data[at].toString(16)} `
            + `in position ${at})`);
        return null;
    }
    return text.replace(/\r\n?/g, "\n");
}

function sourceRows(name, data, bad) {
    if (isList(data)) return data.map((row, index) => [`${name}[${index}]`, row]);
    const text = sourceText(data, name, bad);
    if (text === null) return [];
    if (pyLstrip(text).startsWith("[")) {
        let parsed;
        try {
            parsed = jsonLoads(text);
        } catch (error) {
            if (!(error instanceof JsonDecodeError || error instanceof InputError)) throw error;
            bad.push(`${name}: not valid JSON (${error.message})`);
            return [];
        }
        if (!isList(parsed)) {
            bad.push(`${name}: JSON root must be an array`);
            return [];
        }
        return parsed.map((row, index) => [`${name}[${index}]`, row]);
    }
    const rows = [];
    pySplitlines(text).forEach((line, index) => {
        if (!pyStrip(line)) return;
        try {
            rows.push([`${name}:${index + 1}`, jsonLoads(line)]);
        } catch (error) {
            if (!(error instanceof JsonDecodeError || error instanceof InputError)) throw error;
            bad.push(`${name}:${index + 1}: not valid JSON (${error instanceof JsonDecodeError ? error.msg : error.message})`);
        }
    });
    return rows;
}

function normaliseSources(input) {
    if (isStr(input) || Buffer.isBuffer(input)) return [["input", input]];
    if (isList(input) && input.length && input.every((item) => isStr(item) || Buffer.isBuffer(item))) {
        return input.map((item, index) => [`input${index + 1}`, item]);
    }
    if (isList(input)) return [["records", input]];
    if (isDict(input) && isList(input.sources)) return input.sources.map(({ name, data }) => [name, data]);
    throw new TypeError("records must be an array of rows, JSON/JSONL text, a Buffer, or { sources }");
}

/**
 * Read rows and return { frames, bad }. `input` is an array of row objects,
 * JSON/JSONL text or Buffer, an array of texts/Buffers, or
 * { sources: [{ name, data }] }. Malformed rows are counted in `bad`.
 */
export function ingest(input, { adapter = "jsonl", assumeOffset = null } = {}) {
    parseAssumedOffset(assumeOffset);
    const frames = [];
    const bad = [];
    for (const [name, data] of normaliseSources(input)) {
        for (const [location, row] of sourceRows(name, data, bad)) {
            if (!isDict(row)) {
                bad.push(`${location}: row must be an object`);
                continue;
            }
            try {
                frames.push(normaliseRow(row, adapter, assumeOffset));
            } catch (error) {
                if (!(error instanceof InputError)) throw error;
                bad.push(`${location}: ${error.message}`);
            }
        }
    }
    assignAnonymousFrameIds(frames);
    return { frames, bad };
}

/** Filter by exact preserved/inferred source namespace, never substring. */
export function filterServer(frames, server) {
    if (!server) return [...frames];
    const wanted = casefold(server);
    return frames.filter((frame) => isStr(frame.server) && casefold(frame.server) === wanted);
}

/** Deduplicate exact call identities and refuse conflicting duplicates. */
export function deduplicateFrames(frames) {
    const output = [];
    const byIdentity = new Map();
    const suppliedIds = new Set();
    let duplicateCount = 0;
    for (const frame of frames) {
        if (frame._frame_id_source === "supplied") {
            if (suppliedIds.has(frame.frame_id)) throw new InputError(`duplicate supplied frame_id ${pyRepr(frame.frame_id)}`);
            suppliedIds.add(frame.frame_id);
        }
        const { session_id: sessionId, call_id: callId } = frame;
        if (!sessionId || !callId) {
            output.push(frame);
            continue;
        }
        const identity = JSON.stringify([sessionId, callId]);
        const comparable = Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "_source"));
        if (!byIdentity.has(identity)) {
            byIdentity.set(identity, comparable);
            output.push(frame);
        } else if (pyEq(byIdentity.get(identity), comparable)) duplicateCount += 1;
        else {
            throw new InputError(
                `conflicting duplicate call identity (session_id=${pyRepr(sessionId)}, call_id=${pyRepr(callId)})`,
            );
        }
    }
    const seen = new Set();
    for (const frame of output) {
        if (seen.has(frame.frame_id)) {
            throw new InputError(
                `duplicate frame_id ${pyRepr(frame.frame_id)}; supply unique call identity or a unique canonical frame_id`,
            );
        }
        seen.add(frame.frame_id);
    }
    return { frames: output, duplicateCount };
}

function windowOf(frames) {
    const stamps = sortStrings(frames.filter((frame) => frame.ts).map((frame) => frame.ts));
    const sessions = new Set(frames.filter((frame) => frame.session_id).map((frame) => frame.session_id)).size;
    if (!stamps.length) return { from: null, to: null, days: null, sessions };
    const day = (value) => Math.floor(parseUtcStamp(value) / 86_400_000);
    return { from: stamps[0], to: stamps[stamps.length - 1], days: day(stamps[stamps.length - 1]) - day(stamps[0]) + 1, sessions };
}

/** Whether an observation is recent (0..14 days) relative to collection time. */
export function isLive(lastSeen, ref = new Date()) {
    if (!lastSeen) return false;
    const observed = parseUtcStamp(lastSeen);
    const collected = ref instanceof Date ? ref.getTime() : parseUtcStamp(ref);
    if (observed === null || collected === null || Number.isNaN(collected)) return false;
    const delta = collected - observed;
    return delta >= 0 && delta <= LIVE_WINDOW_DAYS * 86_400_000;
}

function buildClusters(failedFrames, opaque, collectedAt) {
    const rows = failedFrames.map((frame) => ({
        frame_id: frame.frame_id,
        ts: frame.ts || "",
        session: frame.session_id || "",
        tool: frame.tool,
        args: frame.args,
        err: frameDiagnostic(frame),
    }));
    const clusters = cluster(rows, opaque);
    const warnings = sanity(clusters, rows, opaque);
    const members = new Map();
    for (const row of rows) {
        const key = JSON.stringify([row.tool, normalise(row.err, opaque)]);
        if (!members.has(key)) members.set(key, []);
        members.get(key).push(row);
    }
    for (const item of clusters) {
        if (!/^c-[0-9a-f]{24}$/.test(item.id)) throw new InputError("cluster engine returned an invalid stable cluster ID");
        const owning = members.get(JSON.stringify([item.tool, item.signature])) ?? [];
        const expected = owning.map((row) => row.frame_id);
        const emitted = item.frame_ids;
        if (!isList(emitted) || emitted.some((value) => !isStr(value)) || new Set(emitted).size !== emitted.length
            || !pyEq(emitted, expected)) {
            throw new InputError(`cluster ${item.id} membership does not match its input rows`);
        }
        if (!pyEq(item.member_ids, emitted)) throw new InputError(`cluster ${item.id} member_ids alias is inconsistent`);
        const dates = counter();
        let unknownDates = 0;
        for (const row of owning) {
            const match = ISO_DAY.exec(row.ts || "");
            if (match) bump(dates, match[1]);
            else unknownDates += 1;
        }
        const expectedDays = sortedEntries(dates);
        if (!pyEq(item.day_counts, expectedDays)) throw new InputError(`cluster ${item.id} day_counts do not match its members`);
        if (item.distinct_days !== Object.keys(expectedDays).length) {
            throw new InputError(`cluster ${item.id} distinct_days is inconsistent`);
        }
        if ((item.undated_count ?? unknownDates) !== unknownDates) {
            throw new InputError(`cluster ${item.id} undated_count is inconsistent`);
        }
        item.unknown_date_count = unknownDates;
        if (sum(Object.values(item.day_counts)) + unknownDates !== item.count) {
            throw new InputError(`cluster ${item.id} failed day-count conservation`);
        }
        item.recent = isLive(item.last_seen, collectedAt);
    }
    const allMembers = clusters.flatMap((item) => item.frame_ids);
    const expectedMembers = failedFrames.map((frame) => frame.frame_id);
    if (allMembers.length !== new Set(allMembers).size) throw new InputError("cluster membership contains duplicate frame IDs");
    const expectedSet = new Set(expectedMembers);
    if (allMembers.length !== expectedMembers.length || allMembers.some((id) => !expectedSet.has(id))
        || new Set(allMembers).size !== expectedSet.size) {
        throw new InputError("cluster membership does not cover the effective failure set exactly");
    }
    return { clusters, warnings };
}

const operationsOf = (frame) => frame.operations ?? [];
const failedOperations = (frames) => sum(frames.map((frame) => operationsOf(frame).filter((op) => op.outcome === "fail").length));
const embeddedCalls = (frames) => frames.filter((frame) => frame.outcome !== "fail" && frame.effective_outcome === "fail").length;

function volumeOf(frames, ratesAvailable, excludedProbes = 0) {
    const counts = counter();
    for (const frame of frames) bump(counts, frame.effective_outcome);
    const [ok, fail, unknown] = OUTCOMES.map((name) => counts.get(name) ?? 0);
    const known = ok + fail;
    return {
        calls: frames.length,
        ok,
        fail,
        unknown,
        embedded_failure_calls: embeddedCalls(frames),
        operation_diagnostics: sum(frames.map((frame) => operationsOf(frame).length)),
        failed_operations: failedOperations(frames),
        excluded_test_probe_calls: excludedProbes,
        fail_pct_of_known: ratesAvailable && known ? pyRound((100 * fail) / known, 1) : null,
        fail_pct_of_all: ratesAvailable && frames.length ? pyRound((100 * fail) / frames.length, 1) : null,
        denominator: "calls",
        rate_available: ratesAvailable,
    };
}

function rawVolumeOf(frames) {
    const host = counter();
    const effective = counter();
    for (const frame of frames) {
        bump(host, frame.outcome);
        bump(effective, frame.effective_outcome);
    }
    return {
        calls: frames.length,
        host_outcomes: Object.fromEntries(OUTCOMES.map((name) => [name, host.get(name) ?? 0])),
        effective_outcomes: Object.fromEntries(OUTCOMES.map((name) => [name, effective.get(name) ?? 0])),
        embedded_failure_calls: embeddedCalls(frames),
        operation_diagnostics: sum(frames.map((frame) => operationsOf(frame).length)),
        failed_operations: failedOperations(frames),
    };
}

function coverageOf(frames, advertised, { ratesAvailable = false, inventoryCaptured = false, windowDays = null } = {}) {
    const per = new Map();
    for (const frame of frames) {
        if (!per.has(frame.tool)) {
            per.set(frame.tool, {
                calls: 0, ok: 0, fail: 0, unknown: 0, sessions: new Set(), first_seen: null, last_seen: null,
                operation_diagnostics: 0,
            });
        }
        const data = per.get(frame.tool);
        data.calls += 1;
        data[frame.effective_outcome] += 1;
        data.operation_diagnostics += operationsOf(frame).length;
        if (frame.session_id) data.sessions.add(frame.session_id);
        if (frame.ts) {
            const first = data.first_seen || frame.ts;
            const last = data.last_seen || frame.ts;
            data.first_seen = cmpStr(first, frame.ts) <= 0 ? first : frame.ts;
            data.last_seen = cmpStr(last, frame.ts) >= 0 ? last : frame.ts;
        }
    }
    const tools = [...per.entries()]
        .sort((a, b) => b[1].fail - a[1].fail || cmpStr(a[0], b[0]))
        .map(([name, data]) => {
            const known = data.ok + data.fail;
            return {
                tool: name,
                calls: data.calls,
                ok: data.ok,
                fail: data.fail,
                unknown: data.unknown,
                fail_pct_of_known: ratesAvailable && known ? pyRound((100 * data.fail) / known, 1) : null,
                sessions: data.sessions.size,
                first_seen: data.first_seen,
                last_seen: data.last_seen,
                operation_diagnostics: data.operation_diagnostics,
            };
        });
    const called = new Set(tools.map((entry) => entry.tool));
    return {
        window_days: windowDays,
        tools,
        inventory_captured: inventoryCaptured,
        advertised_never_called: inventoryCaptured ? sortStrings(advertised.filter((name) => !called.has(name))) : null,
    };
}

function jsonValue(value, label, { object = false } = {}) {
    let parsed = value;
    if (isStr(value) || Buffer.isBuffer(value)) {
        try {
            const text = isStr(value) ? value : decodeUtf8(value)[0];
            if (text === null) throw new Error("invalid UTF-8");
            parsed = jsonLoads(text);
        } catch (error) {
            throw new InputError(`${label} is not valid UTF-8 JSON: ${error.message}`);
        }
    }
    if (object && !isDict(parsed)) throw new InputError(`${label} root must be an object`);
    return parsed;
}

function stringList(value, label) {
    if (!isList(value) || value.some((item) => !isStr(item) || !item || cpLen(item) > 1024)) {
        throw new InputError(`${label} must be an array of strings`);
    }
    return value;
}

function validateFrameRefs(values, label, knownFrames, predicate = null) {
    const refs = stringList(values, label);
    const unknown = sortStrings(new Set(refs.filter((ref) => !knownFrames.has(ref))));
    if (unknown.length) throw new InputError(`${label} references unknown frame IDs: ${unknown.join(", ")}`);
    if (predicate && refs.some((ref) => !predicate(knownFrames.get(ref)))) {
        throw new InputError(`${label} contains a frame with the wrong outcome`);
    }
    return refs;
}

const extraKeys = (object, allowed) => sortStrings(Object.keys(object).filter((key) => !allowed.includes(key)));
const inSet = (set, value) => isStr(value) && set.has(value);

/** Validate stable references and sanitize optional operator narrative. */
function loadVerdicts(source, clusters, frames, redactor, reviewedNarrative) {
    const empty = { headline: "", top_issue_ids: [], asks: [], our_actions: [], clusters: {}, probe_frame_ids: [] };
    if (source === null || source === undefined) return { verdicts: empty, discarded: [] };
    const raw = jsonValue(source, "verdicts", { object: true });
    const unknownRoot = extraKeys(raw, ["schema_version", "headline", "top_issues", "asks", "our_actions", "clusters",
        "probe_frame_ids"]);
    if (unknownRoot.length) throw new InputError(`verdicts has unknown fields: ${unknownRoot.join(", ")}`);
    if (!pyEq(get(raw, "schema_version", SCHEMA_VERSION), SCHEMA_VERSION)) {
        throw new InputError("verdicts schema_version must be 2");
    }
    const knownClusters = new Map(clusters.map((item) => [item.id, item]));
    const knownFrames = new Map(frames.map((frame) => [frame.frame_id, frame]));
    const probeFrameIds = validateFrameRefs(get(raw, "probe_frame_ids", []), "verdicts.probe_frame_ids", knownFrames,
        (frame) => frame.effective_outcome === "fail");
    if (probeFrameIds.length !== new Set(probeFrameIds).size) throw new InputError("verdicts.probe_frame_ids must be unique");
    const suppliedClusters = get(raw, "clusters", {});
    if (!isDict(suppliedClusters)) throw new InputError("verdicts.clusters must be an object");
    const stale = sortStrings(Object.keys(suppliedClusters).filter((id) => !knownClusters.has(id)));
    if (stale.length) throw new InputError(`verdicts references unknown cluster IDs: ${stale.join(", ")}`);

    const discarded = [];
    const narrative = (value, label) => {
        if (isBlank(value)) return "";
        if (!isStr(value)) throw new InputError(`${label} must be a string`);
        const sanitized = redactor.narrative(value, reviewedNarrative);
        if (!reviewedNarrative) {
            discarded.push(label);
            return "";
        }
        return sanitized;
    };

    const outputClusters = {};
    for (const [clusterId, value] of Object.entries(suppliedClusters)) {
        if (!isDict(value)) throw new InputError(`verdicts.clusters.${clusterId} must be an object`);
        const extras = extraKeys(value, ["verdict", "rw_class", "evidence_track", "evidence", "mechanism",
            "reproduction_disposition"]);
        if (extras.length) throw new InputError(`verdicts.clusters.${clusterId} has unknown fields: ${extras.join(", ")}`);
        const verdict = get(value, "verdict", "unclassified");
        if (!inSet(VERDICTS, verdict)) throw new InputError(`invalid verdict for ${clusterId}: ${pyRepr(verdict)}`);
        const rwClass = get(value, "rw_class", "unknown-treat-as-write");
        if (!inSet(RW_CLASSES, rwClass)) throw new InputError(`invalid rw_class for ${clusterId}: ${pyRepr(rwClass)}`);
        let track = get(value, "evidence_track");
        if (["", "none", "—"].includes(track)) track = null;
        if (track !== null && !["A", "B"].includes(track)) {
            throw new InputError(`invalid evidence_track for ${clusterId}: ${pyRepr(track)}`);
        }
        let evidence = get(value, "evidence", {});
        if (!isDict(evidence)) throw new InputError(`evidence for ${clusterId} must be an object`);
        const disposition = get(value, "reproduction_disposition", get(evidence, "reproduction_disposition", "not-attempted"));
        if (!inSet(REPRO_DISPOSITIONS, disposition)) {
            throw new InputError(`invalid reproduction_disposition for ${clusterId}: ${pyRepr(disposition)}`);
        }
        if (track === "A") {
            const trackExtras = extraKeys(evidence, ["failing_frame_ids", "control_frame_ids", "correlation_ids",
                "reproduction_disposition"]);
            if (trackExtras.length) {
                throw new InputError(`track A evidence for ${clusterId} has unknown fields: ${trackExtras.join(", ")}`);
            }
            const failingRefs = validateFrameRefs(get(evidence, "failing_frame_ids", []),
                `${clusterId}.evidence.failing_frame_ids`, knownFrames, (frame) => frame.effective_outcome === "fail");
            const controlRefs = validateFrameRefs(get(evidence, "control_frame_ids", []),
                `${clusterId}.evidence.control_frame_ids`, knownFrames, (frame) => frame.effective_outcome === "ok");
            const correlationIds = stringList(get(evidence, "correlation_ids", []), `${clusterId}.evidence.correlation_ids`);
            if (correlationIds.some((id) => !safeIdentifier(id))) {
                throw new InputError(`${clusterId}.evidence.correlation_ids contains an invalid identifier`);
            }
            if (!failingRefs.length || !controlRefs.length || !correlationIds.length) {
                throw new InputError(
                    `evidence track A for ${clusterId} requires failing_frame_ids, control_frame_ids, and correlation_ids`,
                );
            }
            const members = new Set(knownClusters.get(clusterId).frame_ids ?? []);
            if (failingRefs.some((ref) => !members.has(ref))) {
                throw new InputError(`track A failing_frame_ids for ${clusterId} must belong to that cluster`);
            }
            const projected = correlationIds.map((id) => redactor.identifier(id, "request"));
            const cited = new Set([...failingRefs, ...controlRefs].flatMap((id) => knownFrames.get(id).request_ids ?? []));
            if (projected.some((id) => !cited.has(id))) {
                throw new InputError(`track A correlation_ids for ${clusterId} must occur on a referenced frame`);
            }
            const rebuilt = { failing_frame_ids: failingRefs, control_frame_ids: controlRefs, correlation_ids: projected };
            if (Object.hasOwn(evidence, "reproduction_disposition")) {
                rebuilt.reproduction_disposition = evidence.reproduction_disposition;
            }
            evidence = rebuilt;
        } else if (track === "B") {
            const trackExtras = extraKeys(evidence, ["reproduction_disposition"]);
            if (trackExtras.length) {
                throw new InputError(`track B evidence for ${clusterId} has unknown fields: ${trackExtras.join(", ")}`);
            }
            if ((knownClusters.get(clusterId).distinct_days ?? 0) < 3) {
                throw new InputError(`evidence track B for ${clusterId} requires at least 3 observed days`);
            }
            if (!Object.hasOwn(value, "reproduction_disposition") && !Object.hasOwn(evidence, "reproduction_disposition")) {
                throw new InputError(`evidence track B for ${clusterId} requires reproduction_disposition`);
            }
        } else if (pyTruthy(evidence)) {
            throw new InputError(`structured evidence for ${clusterId} requires evidence_track A or B`);
        }
        outputClusters[clusterId] = {
            verdict,
            rw_class: rwClass,
            evidence_track: track,
            evidence,
            reproduction_disposition: disposition,
            mechanism: narrative(get(value, "mechanism", ""), `clusters.${clusterId}.mechanism`),
        };
        const probes = new Set(probeFrameIds);
        if (verdict === "test-probe" && knownClusters.get(clusterId).frame_ids.some((id) => !probes.has(id))) {
            throw new InputError(`test-probe verdict for ${clusterId} requires every member in root probe_frame_ids`);
        }
    }

    const topIssueIds = stringList(get(raw, "top_issues", []), "verdicts.top_issues");
    if (topIssueIds.length > 5 || new Set(topIssueIds).size !== topIssueIds.length) {
        throw new InputError("verdicts.top_issues must contain at most 5 unique cluster IDs");
    }
    const unknownTop = sortStrings(new Set(topIssueIds.filter((id) => !knownClusters.has(id))));
    if (unknownTop.length) {
        throw new InputError(`verdicts.top_issues references unknown cluster IDs: ${unknownTop.join(", ")}`);
    }

    const sections = [
        ["asks", ["cluster_id", "ask", "impact", "severity"]],
        ["our_actions", ["cluster_id", "kind", "owner", "action"]],
    ];
    const cleaned = {};
    for (const [section] of sections) {
        const items = get(raw, section, []);
        if (!isList(items) || items.some((item) => !isDict(item))) {
            throw new InputError(`verdicts.${section} must be an array of objects`);
        }
    }
    for (const [section, fields] of sections) {
        cleaned[section] = [];
        for (const [index, item] of get(raw, section, []).entries()) {
            if (extraKeys(item, fields).length) throw new InputError(`verdicts.${section}[${index}] has unknown fields`);
            const clusterId = get(item, "cluster_id");
            if (!isStr(clusterId) || !knownClusters.has(clusterId)) {
                throw new InputError(`verdicts.${section}[${index}] references an unknown cluster`);
            }
            if (reviewedNarrative) {
                const clean = { cluster_id: clusterId };
                for (const field of fields.slice(1)) {
                    clean[field] = narrative(get(item, field, ""), `${section}[${index}].${field}`);
                }
                cleaned[section].push(clean);
            } else {
                for (const field of fields.slice(1)) {
                    if (pyTruthy(get(item, field))) narrative(item[field], `${section}[${index}].${field}`);
                }
            }
        }
    }

    return {
        verdicts: {
            headline: narrative(get(raw, "headline", ""), "headline"),
            top_issue_ids: topIssueIds,
            asks: cleaned.asks,
            our_actions: cleaned.our_actions,
            clusters: outputClusters,
            probe_frame_ids: probeFrameIds,
        },
        discarded: sortStrings(new Set(discarded)),
    };
}

function applyVerdicts(clusters, verdicts) {
    for (const item of clusters) {
        const value = verdicts.clusters[item.id] ?? {};
        item.verdict = value.verdict ?? "unclassified";
        item.rw_class = value.rw_class ?? "unknown-treat-as-write";
        item.evidence_track = value.evidence_track ?? null;
        item.evidence_track_asserted = value.evidence_track ?? null;
        item.evidence_verified = false;
        item.evidence = value.evidence ?? {};
        item.reproduction_disposition = value.reproduction_disposition ?? "not-attempted";
        if (value.mechanism) item.mechanism = value.mechanism;
    }
}

function annotateProbeAdjustments(clusters, frames, probeFrameIds) {
    const byId = new Map(frames.map((frame) => [frame.frame_id, frame]));
    for (const item of clusters) {
        const excluded = item.frame_ids.filter((id) => probeFrameIds.has(id));
        const days = counter();
        let undated = 0;
        for (const id of item.frame_ids) {
            if (probeFrameIds.has(id)) continue;
            const match = ISO_DAY.exec(byId.get(id).ts || "");
            if (match) bump(days, match[1]);
            else undated += 1;
        }
        item.excluded_frame_ids = excluded;
        item.adjusted_count = item.count - excluded.length;
        item.adjusted_day_counts = sortedEntries(days);
        item.adjusted_undated_count = undated;
        if (item.adjusted_count !== sum(Object.values(item.adjusted_day_counts)) + undated) {
            throw new InputError(`cluster ${item.id} adjusted counts do not reconcile`);
        }
    }
}

function topIssues(clusters, selected) {
    const byId = new Map(clusters.map((item) => [item.id, item]));
    const chosen = selected.length ? selected.map((id) => byId.get(id)) : clusters.slice(0, 5);
    return chosen.map((item) => ({
        cluster_id: item.id,
        tool: item.tool,
        diagnostic: item.mechanism || item.signature,
        hits: item.count,
        adjusted_hits: item.adjusted_count,
        last_seen: item.last_seen || null,
        recent: Boolean(item.recent),
        verdict: item.verdict ?? "unclassified",
    }));
}

function defaultEnvironment(supplied, serverLabel, collectedAt, offsets, assumeOffset) {
    const env = {
        collected_at: collectedAt,
        host: { name: "unknown", version: "unknown" },
        server: { name: serverLabel, version: "unknown", endpoint: "unknown" },
        transport: "unknown",
        auth_mode: "unknown",
        clock_skew_ms: null,
        local_offset: null,
        source_offsets_seen: offsets,
        assumed_offset: assumeOffset,
        tools: [],
        tool_inventory_captured: false,
    };
    const assign = (target, key, value) =>
        Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    for (const [key, value] of Object.entries(supplied)) {
        if ((key === "host" || key === "server") && isDict(value)) {
            for (const [nestedKey, nested] of Object.entries(value)) assign(env[key], nestedKey, nested);
        } else assign(env, key, value);
    }
    env.collected_at = collectedAt;
    env.source_offsets_seen = offsets;
    env.assumed_offset = assumeOffset;
    if (pyTruthy(env.tools)) env.tool_inventory_captured = true;
    return env;
}

function redactFrames(frames, redactor) {
    for (const frame of frames) {
        frame.args = redactor.argsString(frame.args);
        frame.error = redactor.diagnostic(frame._diagnostic_raw);
        delete frame._diagnostic_raw;
        for (const operation of frame.operations) {
            operation.diagnostic = redactor.diagnostic(operation._diagnostic_raw);
            delete operation._diagnostic_raw;
        }
        for (const key of ["session_id", "call_id"]) if (frame[key]) frame[key] = redactor.identifier(frame[key], key);
        frame.request_ids = frame.request_ids.map((value) => redactor.identifier(value, "request"));
        if (frame.server) frame.server = redactor.identifier(frame.server, "server");
        for (const operation of frame.operations) {
            operation.request_ids = operation.request_ids.map((value) => redactor.identifier(value, "request"));
        }
    }
}

const serializableFrame = (frame) => Object.fromEntries(Object.entries(frame).filter(([key]) => !key.startsWith("_")));

function safeSlug(value, fallback) {
    const slug = cpSlice(pyStrip(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), 0, 48)
        .replace(/-+$/, "") || fallback;
    if (!fullmatch(SAFE_SLUG, slug)) throw new InputError(`unsafe output label ${pyRepr(value)}`);
    return slug;
}

const jsonArtifact = (value) => pyDumps(value, { indent: 2, ensureAscii: false, sortKeys: true, allowNan: false });
const jsonLine = (value) => pyDumps(value, { ensureAscii: false, sortKeys: true, allowNan: false });
const sha = (text) => `sha256:${sha256Hex(Buffer.from(text, "utf8"))}`;
const htmlEscape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const display = (value) => pyStr(value === null || value === undefined ? "—" : value);
const COLLAPSE = new RegExp(`${S}+`, "gu");

const plainData = (value) =>
    pyStrip(htmlEscape(display(value)).replace(COLLAPSE, " ")).replace(/([\\`*_[\]{}()#+.!|>~-])/g, "\\$1");

const cell = (value) =>
    htmlEscape(display(value)).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");

function table(headers, rows) {
    if (!rows.length) return "_None._";
    return [
        `| ${headers.map(cell).join(" | ")} |`,
        `|${headers.map(() => "---").join("|")}|`,
        ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    ].join("\n");
}

function short(value, length = 100) {
    const text = pyStrip((value || "").replaceAll("\r", " ").replaceAll("\n", " "));
    return cpLen(text) <= length ? text : `${cpSlice(text, 0, length - 1)}…`;
}

const day10 = (value) => cpSlice(value || "unknown", 0, 10);

function mechanicalHeadline(summary) {
    const { volume, capture_scope: scope } = summary;
    if (volume.fail === 0) {
        return `No effective failures were observed in the supplied ${scope} capture. `
            + "This does not establish a zero production failure rate.";
    }
    if (!volume.rate_available) {
        return `${volume.fail} effective failed call(s) were observed in the supplied ${scope} capture. `
            + `Production failure rate is withheld: ${summary.rate_reason}.`;
    }
    return `${volume.fail} of ${volume.calls} production-adjusted calls failed (${pyStr(volume.fail_pct_of_all)}%).`;
}

/** Render report.md from values already present in summary.json. */
export function buildReport(meta, summary) {
    const { clusters, coverage: cov, environment: env, limitations: limits, warnings, raw_volume: raw, volume, window } = summary;
    const lines = [
        `# MCP diagnostic — ${cell(summary.server)} — ${meta.date}`,
        "",
        `**Bundle** \`${cell(summary.bundle_id)}\` · schema ${SCHEMA_VERSION} · profile ${cell(summary.profile)} · `
        + `capture scope **${cell(summary.capture_scope)}**  `,
        `**Collected** ${cell(summary.generated_at)} · observed window ${cell(window.from)} → ${cell(window.to)}  `,
        `**Raw host outcomes** ${raw.calls} calls: ${raw.host_outcomes.ok} ok, ${raw.host_outcomes.fail} fail, `
        + `${raw.host_outcomes.unknown} unknown  `,
        `**Production-adjusted effective outcomes** ${volume.calls} calls: ${volume.ok} ok, ${volume.fail} fail, `
        + `${volume.unknown} unknown  `,
        volume.rate_available
            ? `**Failure rate** ${pyStr(volume.fail_pct_of_all)}% of calls`
            : `**Failure rate withheld** — ${cell(summary.rate_reason)}`,
        "",
        "## Headline",
        "",
        summary.headline ? plainData(summary.headline) : mechanicalHeadline(summary),
        "",
        "## Top 5 issues",
        "",
        table(
            ["Cluster", "Tool", "Diagnostic", "Raw calls", "Adjusted calls", "Last observed", "Recent?", "Verdict"],
            summary.top_issues.map((item) => [
                item.cluster_id, item.tool, short(item.diagnostic, 90), item.hits, item.adjusted_hits,
                day10(item.last_seen), item.recent ? "yes" : "no", item.verdict,
            ]),
        ),
        "",
        "## Owner actions",
        "",
        summary.asks.length
            ? table(["Cluster", "Ask", "Impact", "Severity"],
                summary.asks.map((item) => [item.cluster_id, item.ask, item.impact, item.severity]))
            : "_No reviewed owner-action narrative was supplied._",
        "",
        "## Caller actions",
        "",
        summary.our_actions.length
            ? table(["Cluster", "Kind", "Owner", "Action"],
                summary.our_actions.map((item) => [item.cluster_id, item.kind, item.owner, item.action]))
            : "_No reviewed caller-action narrative was supplied._",
        "",
        "## Failure clusters",
        "",
        table(
            ["ID", "Tool", "Diagnostic signature", "Raw calls", "Adjusted calls", "Days", "First → last", "Recent?",
                "Verdict", "R/W", "Asserted evidence", "Reproduction assertion"],
            clusters.map((item) => [
                item.id, item.tool, short(item.signature, 90), item.count, item.adjusted_count, item.distinct_days,
                `${day10(item.first_seen)} → ${day10(item.last_seen)}`, item.recent ? "yes" : "no", item.verdict,
                item.rw_class, item.evidence_track_asserted ? `${item.evidence_track_asserted} (unverified)` : "none",
                item.reproduction_disposition,
            ]),
        ),
        "",
        "## Failures hiding in successes",
        "",
    ];
    if (summary.embedded_failures.length) {
        const population = summary.embedded_failure_population;
        lines.push(
            `Raw evidence: ${population.raw_affected_calls} call(s) with a non-failed host outcome carried `
            + `${population.predicate_hits} structured predicate hit(s). Production-adjusted remaining affected calls: `
            + `${population.adjusted_remaining_calls}. Predicate hits are diagnostics, not additional calls.`,
            "",
            table(["Predicate", "Tool", "Calls"], summary.embedded_failures.map((item) => [item.predicate, item.tool, item.count])),
        );
    } else if (summary.payload_scan.missing_nonfailed_payloads) {
        lines.push("_No hidden failure was established, but payload coverage is incomplete; this is not negative evidence._");
    } else lines.push("_No structured embedded failure predicate was detected._");
    let advertised;
    if (cov.advertised_never_called?.length) {
        advertised = `**Advertised but never called:** ${cov.advertised_never_called.map((name) => `\`${cell(name)}\``).join(", ")}`;
    } else if (cov.inventory_captured) advertised = "**Advertised but never called:** _none._";
    else advertised = "**Advertised but never called:** _unknown — inventory not captured._";
    lines.push(
        "",
        "## Coverage",
        "",
        table(
            ["Tool", "Calls", "OK", "Fail", "Unknown", "Fail %", "Sessions", "Last observed", "Operations"],
            cov.tools.map((item) => [
                item.tool, item.calls, item.ok, item.fail, item.unknown,
                item.fail_pct_of_known !== null ? item.fail_pct_of_known : "withheld",
                item.sessions, day10(item.last_seen), item.operation_diagnostics,
            ]),
        ),
        "",
        advertised,
        "",
        "## Environment",
        "",
    );
    const envRows = [];
    for (const [section, value] of Object.entries(env)) {
        if (isDict(value)) {
            for (const [key, nested] of Object.entries(value)) envRows.push([`${section}.${key}`, short(stringify(nested), 100) || "unknown"]);
        } else envRows.push([section, short(stringify(value), 100) || "unknown"]);
    }
    lines.push(
        table(["Field", "Value"], envRows),
        "",
        "## Limitations",
        "",
        `- Capture scope: \`${summary.capture_scope}\`.`,
        `- Reconciliation: \`${pyStr(summary.reconciliation.status)}\`. ${cell(summary.reconciliation.note)}`,
        `- Payload scan: ${summary.payload_scan.scanned_calls} call(s) had payload material; `
        + `${summary.payload_scan.missing_nonfailed_payloads} nonfailed/unknown call(s) lacked a payload; `
        + `${summary.payload_scan.inconclusive_calls} scan(s) were inconclusive.`,
        `- Reviewed narrative included: \`${pyStr(limits.narrative.reviewed)}\`; `
        + `discarded fields: ${limits.narrative.discarded_fields.length}.`,
        `- Successful controls published: ${summary.controls.count}; evidence-track `
        + "labels are operator assertions and remain unverified.",
        "- The collector performed no live reproduction and assumes no permission to replay or write.",
        ...limits.not_visible.map((value) => `- Not visible: ${cell(value)}`),
        ...Object.entries(limits.excluded).map(([reason, count]) => `- Excluded: ${cell(reason)} — ${count} row(s).`),
        ...limits.redaction_losses.map((value) => `- Redaction loss: ${cell(value)}`),
        "",
        "## Appendix",
        "",
        "### Per-cluster daily evidence",
        "",
    );
    const chronic = clusters.filter((item) => item.distinct_days >= 3);
    if (chronic.length) {
        for (const item of chronic) {
            const days = sortStrings(new Set([...Object.keys(item.day_counts), ...Object.keys(item.adjusted_day_counts)]));
            const rows = days.map((day) => [day, item.day_counts[day] ?? 0, item.adjusted_day_counts[day] ?? 0]);
            if (item.unknown_date_count || item.adjusted_undated_count) {
                rows.push(["unknown", item.unknown_date_count, item.adjusted_undated_count]);
            }
            lines.push(`**\`${cell(item.id)}\` · ${cell(item.tool)}**`, "", table(["Day", "Raw calls", "Adjusted calls"], rows), "");
        }
    } else lines.push("_None._", "");
    lines.push(
        "### Collector warnings",
        "",
        warnings.map((value) => `- ${cell(value)}`).join("\n") || "_None._",
        "",
        "### Integrity",
        "",
        "The complete final-byte checksum inventory is in `manifest.json`. The manifest "
        + "is excluded from hashing itself and is included in the final redaction gate.",
        "",
    );
    return lines.join("\n");
}

const README = ({ bundleId, profile, generated }) => `# MCP diagnostic bundle

\`${bundleId}\` · schema ${SCHEMA_VERSION} · profile **${profile}** · generated ${generated} by
\`collect_bundle.py ${COLLECTOR_VERSION}\`.

Read \`report.md\` first. \`manifest.json\` declares the exact file set and final-byte
checksums for every other artifact. \`failures.jsonl\` contains one sanitized frame per
effective failed call; operation diagnostics remain nested and are never added to the
call denominator. When Track A cites successful controls, their sanitized frames are
published in optional \`controls.jsonl\`.

The redaction gate checks finite structural and pattern rules. A passing gate is not
semantic certification of arbitrary prose or permission to distribute, replay calls,
or write to a tracker. No live reproduction was performed by this collector.
`;

export function artifactLimits(files, { maxFileBytes = MAX_FILE_BYTES, maxBundleBytes = MAX_BUNDLE_BYTES } = {}) {
    let total = 0;
    for (const [name, body] of Object.entries(files)) {
        const size = Buffer.byteLength(body, "utf8");
        if (size > maxFileBytes) throw new InputError(`artifact ${name} exceeds ${maxFileBytes} bytes`);
        total += size;
    }
    if (total > maxBundleBytes) throw new InputError(`bundle exceeds ${maxBundleBytes} uncompressed bytes`);
}

/** The empty schema-2 verdicts document (port of --verdicts-template). */
export function verdictsTemplate() {
    return {
        schema_version: SCHEMA_VERSION,
        headline: "",
        top_issues: [],
        probe_frame_ids: [],
        asks: [],
        our_actions: [],
        clusters: {},
    };
}

const utcStamp = (date) => stamp(date);
const compactStamp = (date) => utcStamp(date).replace(/[-:]/g, "");

function validateOptions(options) {
    const { expectedCalls = null, expectedFailures = null, unmatchedStarts = 0 } = options;
    const count = (value, label) => {
        if (value === null) return;
        if (!Number.isInteger(value)) throw new InputError(`${label} must be an integer`);
        if (value < 0) throw new InputError(`${label} cannot be negative`);
    };
    count(expectedCalls, "--expected-calls");
    count(expectedFailures, "--expected-failures");
    count(unmatchedStarts, "--unmatched-starts");
    if ((expectedCalls === null) !== (expectedFailures === null)) {
        throw new InputError("--expected-calls and --expected-failures must be supplied together");
    }
    if (options.server && !matches(SAFE_SERVER, options.server)) throw new InputError("--server must be a bounded namespace token");
    if (!matches(SAFE_ADAPTER, options.adapter)) throw new InputError("--adapter must be a bounded token");
    for (const [label, value] of [["--org", options.org], ["--collector", options.collector]]) {
        if (!isStr(value) || cpLen(value) > 200 || /[\r\n\0]/.test(value)) throw new InputError(`${label} is invalid or too long`);
    }
    if (!PROFILE_NAMES.includes(options.profile)) throw new InputError("--profile must be internal or external");
    if (!CAPTURE_SCOPES.includes(options.captureScope)) throw new InputError("--capture-scope must be complete, failures-only, or sample");
    if (!Number.isInteger(options.opaque) || options.opaque < 1) throw new InputError("--opaque must be a positive integer");
}

const PROFILE_NAMES = ["internal", "external"];

/**
 * Build a schema-2 MCP diagnostic bundle in memory.
 *
 * records: rows array, JSON/JSONL text or Buffer, array of texts/Buffers, or
 * { sources: [{ name, data }] }.
 * options: server, org ("unknown"), profile ("internal"|"external"), adapter
 * ("jsonl"), captureScope ("sample"|"failures-only"|"complete"),
 * expectedCalls, expectedFailures, assumeOffset (alias assumeUtcOffset), allowPartial,
 * sourceTruncated, retentionIncomplete, unmatchedStarts (0), environment,
 * verdicts, probe, reviewedNarrative, notVisible ([]), collector, opaque (20),
 * now (Date), nonce (8 hex chars), salt (external alias key), verify
 * (final-gate override for tests).
 *
 * Returns { files, summary, report, manifest, archiveName, bundleId,
 * generatedAt, warnings, discardedNarrative, verification }. Throws
 * InputError (exitCode 1 or 2) or RedactionGateError (exitCode 3).
 */
export function buildBundle(records, options = {}) {
    const settings = {
        server: null, org: "unknown", profile: "internal", adapter: "jsonl", captureScope: "sample",
        expectedCalls: null, expectedFailures: null, assumeOffset: null, allowPartial: false, sourceTruncated: false,
        retentionIncomplete: false, unmatchedStarts: 0, environment: null, verdicts: null, probe: null,
        reviewedNarrative: false, notVisible: [], collector: process.env.USER ?? "unknown", opaque: 20,
        now: new Date(), nonce: null, salt: null, verify,
        ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
    };
    if (options.assumeOffset === undefined && options.assumeUtcOffset !== undefined) {
        settings.assumeOffset = options.assumeUtcOffset;
    }
    validateOptions(settings);
    const collected = settings.now;
    const collectedAt = `${utcStamp(collected)}Z`;
    const nonce = settings.nonce ?? randomBytes(4).toString("hex");
    if (!/^[0-9a-f]{8}$/.test(nonce)) throw new InputError("nonce must be 8 lowercase hex characters");

    let { frames, bad } = ingest(records, { adapter: settings.adapter, assumeOffset: settings.assumeOffset });
    if (bad.length && !settings.allowPartial) {
        throw new InputError(`${bad.length} malformed row(s) refused; use allowPartial to exclude them`,
            { details: bad.slice(0, 20) });
    }
    if (!frames.length) {
        if (bad.length) throw new InputError("no usable rows after validation", { details: bad.slice(0, 20) });
        throw new InputError("No usable rows. Check the adapter and field names.", { exitCode: 1 });
    }
    const ingestedCount = frames.length;
    frames = filterServer(frames, settings.server);
    const foreignCount = ingestedCount - frames.length;
    if (!frames.length) throw new InputError(`No rows matched server ${pyRepr(settings.server)}.`, { exitCode: 1 });
    assignAnonymousFrameIds(frames);
    const deduplicated = deduplicateFrames(frames);
    frames = deduplicated.frames;
    const { duplicateCount } = deduplicated;

    const redactor = new Redactor(settings.profile, { salt: settings.salt });
    redactFrames(frames, redactor);

    const offsets = sortStrings(new Set(frames.map((frame) => frame._offset).filter(Boolean)));
    const missingTimestamps = frames.filter((frame) => frame.ts === null).length;
    const missingNonfailedPayloads = frames.filter((frame) => frame.outcome !== "fail" && !frame._payload_available).length;
    const inconclusivePayloadScans = frames.filter((frame) => frame._payload_scan_inconclusive).length;
    const payloadScanModes = counter();
    const payloadScanLimits = [];
    for (const frame of frames) {
        for (const [mode, count] of Object.entries(frame._payload_scan_modes)) bump(payloadScanModes, mode, count);
        for (const limit of frame._payload_scan_limits) {
            if (!payloadScanLimits.some((existing) => pyEq(existing, limit))) payloadScanLimits.push(limit);
        }
    }

    const effectiveFailures = frames.filter((frame) => frame.effective_outcome === "fail");
    const { clusters, warnings } = buildClusters(effectiveFailures, settings.opaque, collected);
    const { verdicts, discarded: discardedNarrative } = loadVerdicts(
        settings.verdicts, clusters, frames, redactor, settings.reviewedNarrative,
    );
    applyVerdicts(clusters, verdicts);

    const probeFrameIds = new Set(verdicts.probe_frame_ids);
    annotateProbeAdjustments(clusters, frames, probeFrameIds);
    for (const frame of frames) {
        frame.excluded_from_production = probeFrameIds.has(frame.frame_id);
        frame.exclusion_reason = frame.excluded_from_production ? "test-probe" : null;
    }
    const productionFrames = frames.filter((frame) => !frame.excluded_from_production);
    const controlFrameIds = new Set(Object.values(verdicts.clusters).flatMap((value) => value.evidence?.control_frame_ids ?? []));
    const controlFrames = frames.filter((frame) => controlFrameIds.has(frame.frame_id));

    const observedHostFailures = frames.filter((frame) => frame.outcome === "fail").length;
    let reconciliationStatus = null;
    let reconcileNote = "Host totals were not supplied.";
    const sourceLosses = Boolean(bad.length || settings.sourceTruncated || settings.retentionIncomplete
        || settings.unmatchedStarts);
    if (settings.expectedCalls !== null) {
        const countsMatch = settings.expectedCalls === frames.length && settings.expectedFailures === observedHostFailures;
        reconciliationStatus = countsMatch && !sourceLosses;
        if (reconciliationStatus) reconcileNote = "Observed calls and host failures match the supplied host totals.";
        else {
            reconcileNote = `Expected ${settings.expectedCalls} calls and ${settings.expectedFailures} host failures; `
                + `observed ${frames.length} calls and ${observedHostFailures} host failures.`;
            if (bad.length) reconcileNote += ` ${bad.length} malformed row(s) were excluded.`;
            if (settings.sourceTruncated) reconcileNote += " The source export was declared truncated.";
            if (settings.retentionIncomplete) reconcileNote += " Source retention was declared incomplete.";
            if (settings.unmatchedStarts) reconcileNote += ` ${settings.unmatchedStarts} unmatched call start(s) were reported.`;
        }
    }

    const rateAvailable = settings.captureScope === "complete" && reconciliationStatus === true
        && missingNonfailedPayloads === 0 && inconclusivePayloadScans === 0;
    let rateReason;
    if (settings.captureScope !== "complete") rateReason = `capture scope is ${settings.captureScope}, not complete`;
    else if (reconciliationStatus === null) rateReason = "complete scope lacks expected call and host-failure totals";
    else if (reconciliationStatus === false) rateReason = "host call/failure totals did not reconcile";
    else if (missingNonfailedPayloads) rateReason = "payload scan coverage is incomplete";
    else if (inconclusivePayloadScans) rateReason = "one or more payload scans were inconclusive";
    else rateReason = "available";

    const rawVolume = rawVolumeOf(frames);
    const volume = volumeOf(productionFrames, rateAvailable, probeFrameIds.size);
    const observedWindow = windowOf(frames);

    const suppliedEnvironment = settings.environment === null ? {}
        : jsonValue(settings.environment, "environment", { object: true });
    const outputServer = redactor.identifier(settings.server || "unknown", "server");
    const outputOrg = redactor.identifier(settings.org, "org");
    const outputCollector = redactor.identifier(settings.collector, "collector");
    let environment = defaultEnvironment(suppliedEnvironment, outputServer, collectedAt, offsets, settings.assumeOffset);
    environment = redactor.environment(environment);
    const setDefault = (object, key, value) => {
        if (!Object.hasOwn(object, key)) object[key] = value;
        return object[key];
    };
    setDefault(environment, "collected_at", collectedAt);
    const hostEnvironment = setDefault(environment, "host", Object.create(null));
    setDefault(hostEnvironment, "name", "unknown");
    setDefault(hostEnvironment, "version", "unknown");
    const serverEnvironment = setDefault(environment, "server", Object.create(null));
    setDefault(serverEnvironment, "name", outputServer);
    setDefault(serverEnvironment, "version", "unknown");
    setDefault(serverEnvironment, "endpoint", "unknown");
    setDefault(environment, "transport", "unknown");
    setDefault(environment, "auth_mode", "unknown");
    setDefault(environment, "clock_skew_ms", null);
    setDefault(environment, "local_offset", null);
    setDefault(environment, "source_offsets_seen", offsets);
    environment.assumed_offset = settings.assumeOffset;
    setDefault(environment, "tools", []);
    environment.tool_inventory_captured = pyTruthy(environment.tools);

    let probeProjection = null;
    if (settings.probe !== null) {
        const probe = jsonValue(settings.probe, "probe");
        if (!isContainer(probe)) throw new InputError("probe root must be an object or array");
        probeProjection = redactor.probe(probe);
    }
    const advertised = (isList(environment.tools) ? environment.tools : [])
        .filter((item) => isDict(item) && isStr(item.name)).map((item) => item.name);
    const cov = coverageOf(productionFrames, advertised, {
        ratesAvailable: rateAvailable,
        inventoryCaptured: pyTruthy(environment.tool_inventory_captured),
        windowDays: observedWindow.days,
    });

    const hiddenFrames = frames.filter((frame) => frame.outcome !== "fail" && frame.effective_outcome === "fail");
    const adjustedHidden = hiddenFrames.filter((frame) => !probeFrameIds.has(frame.frame_id));
    const predicateCounts = counter();
    for (const frame of hiddenFrames) {
        for (const predicate of frame.embedded_failure) bump(predicateCounts, JSON.stringify([predicate, frame.tool]));
    }
    const embeddedSummary = mostCommon(predicateCounts).map(([key, count]) => {
        const [predicate, tool] = JSON.parse(key);
        return { predicate, tool, count };
    });
    const embeddedHostOutcomes = counter();
    for (const frame of hiddenFrames) bump(embeddedHostOutcomes, frame.outcome);
    const embeddedPopulation = {
        raw_affected_calls: hiddenFrames.length,
        adjusted_remaining_calls: adjustedHidden.length,
        predicate_hits: sum([...predicateCounts.values()]),
        raw_host_outcomes: Object.fromEntries(OUTCOMES.map((name) => [name, embeddedHostOutcomes.get(name) ?? 0])),
    };

    const excluded = {};
    if (bad.length) excluded["malformed or invalid rows"] = bad.length;
    if (foreignCount) excluded["other servers"] = foreignCount;
    if (duplicateCount) excluded["identical duplicate call identities"] = duplicateCount;
    if (probeFrameIds.size) excluded["confirmed test-probe calls from production metrics"] = probeFrameIds.size;
    if (settings.unmatchedStarts) excluded["unmatched call starts"] = settings.unmatchedStarts;

    const notVisible = [];
    settings.notVisible.forEach((value, index) => {
        const sanitized = redactor.narrative(value, settings.reviewedNarrative);
        if (settings.reviewedNarrative) notVisible.push(sanitized);
        else discardedNarrative.push(`not_visible[${index}]`);
    });
    if (missingTimestamps) notVisible.push(`${missingTimestamps} call(s) have no timestamp; temporal fields are null`);
    if (missingNonfailedPayloads) {
        notVisible.push(`${missingNonfailedPayloads} nonfailed/unknown call(s) lack payloads; `
            + "embedded-failure coverage is incomplete");
    }
    if (inconclusivePayloadScans) {
        notVisible.push(`${inconclusivePayloadScans} call payload scan(s) hit parser bounds or `
            + "unsupported containers and are inconclusive");
    }
    if (!frames.some((frame) => frame.duration_ms !== null)) notVisible.push("call duration was not recorded");
    if (!frames.some((frame) => frame.request_ids.length)) notVisible.push("request IDs were not present");
    if (settings.environment === null) {
        notVisible.push("environment inventory/version/transport/auth/clock-skew metadata was not supplied");
    }
    if (settings.sourceTruncated) notVisible.push("the source export was declared truncated");
    if (settings.retentionIncomplete) notVisible.push("source retention was declared incomplete");

    const redactionNow = redactor.report();
    const redactionLosses = redactionNow.rules_fired
        .filter((item) => ["content", "size"].includes(item.class))
        .map((item) => `${item.rule} — ${item.hits} occurrence(s)`);
    if (redactionNow.unknown_fields_dropped.length) {
        redactionLosses.push(`unknown structured fields were dropped: ${redactionNow.unknown_fields_dropped.slice(0, 12).join(", ")}`);
    }
    const limits = {
        not_visible: notVisible,
        excluded,
        redaction_losses: redactionLosses,
        narrative: {
            reviewed: Boolean(settings.reviewedNarrative),
            discarded_fields: discardedNarrative,
            scanner_scope: settings.reviewedNarrative
                ? "Manual review assertion plus finite secret/identity scanning."
                : "Operator narrative omitted; no semantic content review claimed.",
        },
    };

    const bundleId = `mcp-diag-${safeSlug(settings.profile, "bundle")}-${compactStamp(collected)}Z-${nonce}`;
    const meta = {
        server: outputServer, org: outputOrg, collector: outputCollector, date: utcStamp(collected).slice(0, 10),
        bundle_id: bundleId, profile: settings.profile, adapter: settings.adapter,
    };
    const sourceIntegrity = {
        truncated: Boolean(settings.sourceTruncated),
        retention_incomplete: Boolean(settings.retentionIncomplete),
        unmatched_starts: settings.unmatchedStarts,
        identical_duplicates: duplicateCount,
        malformed_rows: bad.length,
    };
    const summary = {
        schema_version: SCHEMA_VERSION,
        bundle_id: bundleId,
        generated_at: collectedAt,
        server: outputServer,
        org: outputOrg,
        profile: settings.profile,
        adapter: settings.adapter,
        capture_scope: settings.captureScope,
        clustering: { engine_version: CLUSTER_ENGINE_VERSION, opaque: settings.opaque },
        window: observedWindow,
        raw_volume: rawVolume,
        volume,
        rate_reason: rateReason,
        reconciliation: {
            status: reconciliationStatus,
            expected_calls: settings.expectedCalls,
            observed_calls: frames.length,
            expected_host_failures: settings.expectedFailures,
            observed_host_failures: observedHostFailures,
            note: reconcileNote,
        },
        payload_scan: {
            scanned_calls: frames.filter((frame) => frame._payload_available).length,
            missing_nonfailed_payloads: missingNonfailedPayloads,
            inconclusive_calls: inconclusivePayloadScans,
            scan_modes: sortedEntries(payloadScanModes),
            limits: payloadScanLimits,
        },
        headline: verdicts.headline,
        probe_frame_ids: frames.filter((frame) => probeFrameIds.has(frame.frame_id)).map((frame) => frame.frame_id),
        top_issues: topIssues(clusters, verdicts.top_issue_ids),
        asks: verdicts.asks,
        our_actions: verdicts.our_actions,
        controls: { count: controlFrames.length, frame_ids: controlFrames.map((frame) => frame.frame_id) },
        clusters,
        embedded_failures: embeddedSummary,
        embedded_failure_population: embeddedPopulation,
        coverage: cov,
        environment,
        limitations: limits,
        warnings,
        live_reproduction_performed: false,
        permission_to_replay_or_write: false,
        source_integrity: sourceIntegrity,
    };

    const serialControls = controlFrames.map(serializableFrame);
    const files = {
        "summary.json": jsonArtifact(summary),
        "clusters.json": jsonArtifact(clusters),
        "coverage.json": jsonArtifact(cov),
        "environment.json": jsonArtifact(environment),
        "embedded.json": jsonArtifact(hiddenFrames.map(serializableFrame)),
        "failures.jsonl": effectiveFailures.map((frame) => jsonLine(serializableFrame(frame))).join("\n"),
    };
    if (probeProjection !== null) files["probe-results.json"] = jsonArtifact(probeProjection);
    if (serialControls.length) files["controls.jsonl"] = serialControls.map(jsonLine).join("\n");
    files["report.md"] = buildReport(meta, summary);
    files["README.md"] = README({ bundleId, profile: settings.profile, generated: collectedAt });
    files["redaction-report.json"] = jsonArtifact(redactor.report({
        ran: true,
        passed: true,
        findings: [],
        finding_count: 0,
        scope: "exact final artifact set including manifest and redaction report",
    }));

    const checksums = Object.fromEntries(sortStrings(Object.keys(files)).map((name) => [name, sha(files[name])]));
    const omitted = [];
    if (probeProjection === null) omitted.push({ file: "probe-results.json", reason: "offline probe not supplied" });
    if (!serialControls.length) omitted.push({ file: "controls.jsonl", reason: "no successful control frame was referenced" });
    const manifest = {
        schema_version: SCHEMA_VERSION,
        bundle_id: bundleId,
        generated_at: collectedAt,
        generated_by: `collect_bundle.py ${COLLECTOR_VERSION}`,
        profile: settings.profile,
        server: outputServer,
        adapter: settings.adapter,
        capture_scope: settings.captureScope,
        clustering: summary.clustering,
        collector: outputCollector,
        window: observedWindow,
        counts: {
            raw: rawVolume,
            production_adjusted: volume,
            clusters: clusters.length,
            controls: serialControls.length,
            excluded_rows: sum(Object.values(excluded)),
        },
        reconciliation: summary.reconciliation,
        reconciled: reconciliationStatus,
        truncated: sourceLosses ? true
            : settings.captureScope !== "complete" || reconciliationStatus === null ? null : !reconciliationStatus,
        omitted,
        checksums,
        checksum_scope: "every emitted file except manifest.json",
        live_reproduction_performed: false,
        permission_to_replay_or_write: false,
        source_integrity: sourceIntegrity,
    };
    files["manifest.json"] = jsonArtifact(manifest);
    artifactLimits(files);

    const verification = settings.verify(files, settings.profile);
    if (!verification.passed) throw new RedactionGateError(verification);

    return {
        files,
        summary: toPlain(summary),
        manifest: toPlain(manifest),
        report: files["report.md"],
        archiveName: `${bundleId}.zip`,
        bundleId,
        generatedAt: collected,
        warnings,
        discardedNarrative,
        verification,
    };
}

const ARCHIVE_NAME = /^mcp-diag-[a-z0-9][a-z0-9-]{0,47}-\d{8}T\d{6}Z-[0-9a-f]{8}\.zip$/;

/** Encode a built bundle as the ZIP bytes: one `<bundleId>/` root, flat, sorted members. */
export function bundleZip(result) {
    const names = sortStrings(Object.keys(result.files));
    return createZip(
        names.map((name) => ({ name: `${result.bundleId}/${name}`, data: result.files[name] })),
        { date: result.generatedAt },
    );
}

/**
 * Write the bundle ZIP into `directory` (created 0700 when missing) as
 * `<bundleId>.zip` (0600). Never overwrites: refuses an existing path and
 * publishes with an exclusive link from a private staging file.
 */
export function writeBundle(result, directory) {
    if (!ARCHIVE_NAME.test(result.archiveName) || result.archiveName !== `${result.bundleId}.zip`) {
        throw new InputError("unsafe archive name");
    }
    const existed = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existed) chmodSync(directory, 0o700);
    const target = join(directory, result.archiveName);
    if (existsSync(target) || existsSync(join(directory, result.bundleId))) {
        throw new InputError("refusing to reuse an existing bundle path");
    }
    const bytes = bundleZip(result);
    const staging = join(directory, `.${result.bundleId}.zip.staging-${randomBytes(4).toString("hex")}`);
    const writeExclusive = (path) => {
        const handle = openSync(path, "wx", 0o600);
        try {
            writeSync(handle, bytes);
        } finally {
            closeSync(handle);
        }
        chmodSync(path, 0o600);
    };
    writeExclusive(staging);
    try {
        linkSync(staging, target);
    } catch (error) {
        if (error.code === "EEXIST") throw new InputError("refusing to reuse an existing bundle path");
        writeExclusive(target);
    } finally {
        unlinkSync(staging);
    }
    return target;
}
