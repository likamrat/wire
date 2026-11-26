// Port of the mcp-diagnostic-bundle skill's cluster_failures.py (cluster engine v2).
// Signatures and cluster IDs are byte-identical to the Python reference for the
// same input, so saved verdicts keep resolving across both implementations.
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Python-compatible primitives shared by the mcp-diagnostics modules.
// JSON floats are kept as PyFloat so that `1.0` round-trips as `1.0` and
// int/float type checks behave as they do in the reference implementation.
// ---------------------------------------------------------------------------

export class PyFloat {
    constructor(value) {
        this.value = Number(value);
    }

    valueOf() {
        return this.value;
    }

    toJSON() {
        return this.value;
    }
}

export const isStr = (value) => typeof value === "string";
export const isBool = (value) => typeof value === "boolean";
export const isList = Array.isArray;
export const isDict = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};
export const isInt = (value) =>
    typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value));
export const isFloat = (value) =>
    value instanceof PyFloat || (typeof value === "number" && !Number.isInteger(value));
export const isNum = (value) => isInt(value) || isFloat(value);
export const num = (value) => (value instanceof PyFloat ? value.value : Number(value));
// Null-prototype object: safe for arbitrary keys such as "__proto__".
export const dict = () => Object.create(null);

export function typeName(value) {
    if (value === null || value === undefined) return "NoneType";
    if (isBool(value)) return "bool";
    if (isInt(value)) return "int";
    if (isFloat(value)) return "float";
    if (isStr(value)) return "str";
    if (isList(value)) return "list";
    if (isDict(value)) return "dict";
    return typeof value;
}

export function pyTruthy(value) {
    if (value === null || value === undefined || value === false) return false;
    if (value === true) return true;
    if (typeof value === "bigint") return value !== 0n;
    if (isNum(value)) return num(value) !== 0;
    if (isStr(value) || isList(value)) return value.length > 0;
    if (isDict(value)) return Object.keys(value).length > 0;
    return true;
}

// Python str.isspace() whitespace, used for \s, strip() and splitting.
export const WS = "\\t\\n\\x0B\\f\\r\\x1C-\\x20\\x85\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
export const S = `[${WS}]`;
export const NS = `[^${WS}]`;
// Python Unicode \w and \b.
export const W = "\\p{L}\\p{N}_";
export const B = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
export const D = "\\p{Nd}";

const STRIP_BOTH = new RegExp(`^${S}+|${S}+$`, "gu");
const STRIP_LEFT = new RegExp(`^${S}+`, "u");
export const pyStrip = (value) => value.replace(STRIP_BOTH, "");
export const pyLstrip = (value) => value.replace(STRIP_LEFT, "");

/** Python re.fullmatch for a pattern source (Unicode mode). */
export const fullmatch = (pattern, value, flags = "u") => new RegExp(`^(?:${pattern})$`, flags).exec(value);

const SURROGATE = /[\uD800-\uDFFF]/;
export const cpLen = (value) => (SURROGATE.test(value) ? [...value].length : value.length);
export function cpSlice(value, start, end) {
    if (!SURROGATE.test(value)) return value.slice(start, end);
    return Array.from(value).slice(start, end).join("");
}

// Python compares str by code point; JS sort compares UTF-16 code units.
export function cmpStr(left, right) {
    if (left === right) return 0;
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        let a = left.charCodeAt(index);
        let b = right.charCodeAt(index);
        if (a !== b) {
            if (a >= 0xd800) a = a < 0xe000 ? a + 0x2000 : a - 0x800;
            if (b >= 0xd800) b = b < 0xe000 ? b + 0x2000 : b - 0x800;
            return a < b ? -1 : 1;
        }
    }
    return left.length - right.length;
}
export const sortStrings = (values) => [...values].sort(cmpStr);

export function pySplitlines(text) {
    const parts = text.split(/\r\n|[\n\r\x0B\f\x1C-\x1E\x85\u2028\u2029]/);
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
}

const ND = /^\p{Nd}$/u;
function digitValue(char) {
    if (char >= "0" && char <= "9") return char.charCodeAt(0) - 48;
    // Unicode encodes every decimal digit set as an aligned run of ten.
    const codePoint = char.codePointAt(0);
    let start = codePoint;
    while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start -= 1;
    return (codePoint - start) % 10;
}
export const pyInt = (digits) => Number([...digits].map(digitValue).join(""));

export function floatRepr(value) {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
    const sign = value < 0 ? "-" : "";
    const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
    const digits = mantissa.replace(".", "");
    const exponent = Number(exponentText);
    const point = exponent + 1;
    if (point > -4 && point <= 16) {
        if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
        if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
        return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
    }
    const lead = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const magnitude = Math.abs(exponent);
    return `${sign}${lead}e${exponent < 0 ? "-" : "+"}${magnitude < 10 ? "0" : ""}${magnitude}`;
}

// Python round(x, n): correctly rounded, ties to even on the exact binary value.
export function pyRound(value, places) {
    if (!Number.isFinite(value)) return new PyFloat(value);
    const [whole, fraction] = Math.abs(value).toFixed(100).split(".");
    const tail = fraction.slice(places);
    let scaled = BigInt(whole + fraction.slice(0, places));
    const rest = /[1-9]/.test(tail.slice(1));
    if (tail[0] > "5" || (tail[0] === "5" && (rest || scaled % 2n === 1n))) scaled += 1n;
    const text = scaled.toString().padStart(places + 1, "0");
    const rounded = Number(`${text.slice(0, text.length - places)}.${text.slice(text.length - places)}`);
    return new PyFloat(value < 0 ? -rounded : rounded);
}

function strRepr(value) {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = quote;
    for (const char of value) {
        const codePoint = char.codePointAt(0);
        if (char === quote || char === "\\") out += `\\${char}`;
        else if (char === "\t") out += "\\t";
        else if (char === "\n") out += "\\n";
        else if (char === "\r") out += "\\r";
        else if (codePoint < 0x20 || codePoint === 0x7f) out += `\\x${codePoint.toString(16).padStart(2, "0")}`;
        else if (codePoint < 0x7f) out += char;
        else if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u.test(char)) {
            const hex = codePoint.toString(16);
            out += codePoint <= 0xff ? `\\x${hex.padStart(2, "0")}`
                : codePoint <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\U${hex.padStart(8, "0")}`;
        } else out += char;
    }
    return out + quote;
}

export function pyRepr(value) {
    if (isStr(value)) return strRepr(value);
    if (isList(value)) return `[${value.map(pyRepr).join(", ")}]`;
    if (isDict(value)) {
        return `{${Object.entries(value).map(([key, item]) => `${strRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
    }
    return pyStr(value);
}

export function pyStr(value) {
    if (value === null || value === undefined) return "None";
    if (value === true) return "True";
    if (value === false) return "False";
    if (isStr(value)) return value;
    if (isInt(value)) return String(value);
    if (isFloat(value)) return floatRepr(num(value));
    return pyRepr(value);
}

export function pyEq(left, right) {
    if (left === right) return true;
    const numeric = (value) => isBool(value) || isNum(value);
    if (numeric(left) && numeric(right)) {
        if (typeof left === "bigint" && typeof right === "bigint") return left === right;
        return num(left) === num(right);
    }
    if (isList(left) && isList(right)) {
        return left.length === right.length && left.every((item, index) => pyEq(item, right[index]));
    }
    if (isDict(left) && isDict(right)) {
        const keys = Object.keys(left);
        return keys.length === Object.keys(right).length
            && keys.every((key) => Object.hasOwn(right, key) && pyEq(left[key], right[key]));
    }
    return false;
}

/** Convert PyFloat/BigInt/null-prototype values into plain JS values. */
export function toPlain(value) {
    if (value instanceof PyFloat) return value.value;
    if (typeof value === "bigint") return Number(value);
    if (isList(value)) return value.map(toPlain);
    if (isDict(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            Object.defineProperty(out, key, { value: toPlain(item), enumerable: true, writable: true, configurable: true });
        }
        return out;
    }
    return value;
}

export class JsonDecodeError extends Error {
    constructor(msg, doc, pos) {
        const lineno = doc.slice(0, pos).split("\n").length;
        const colno = pos - (pos === 0 ? -1 : doc.lastIndexOf("\n", pos - 1));
        super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
        this.name = "JSONDecodeError";
        this.msg = msg;
        this.pos = pos;
    }
}

const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;

function skipWs(text, index) {
    while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
        index += 1;
    }
    return index;
}

function scanString(text, end) {
    const begin = end - 1;
    let out = "";
    for (;;) {
        let index = end;
        while (index < text.length) {
            const code = text.charCodeAt(index);
            if (code === 34 || code === 92 || code < 32) break;
            index += 1;
        }
        if (index >= text.length) throw new JsonDecodeError("Unterminated string starting at", text, begin);
        out += text.slice(end, index);
        const code = text.charCodeAt(index);
        if (code === 34) return [out, index + 1];
        if (code !== 92) throw new JsonDecodeError("Invalid control character at", text, index);
        index += 1;
        if (index >= text.length) throw new JsonDecodeError("Unterminated string starting at", text, begin);
        const escape = text[index];
        if (escape !== "u") {
            if (!Object.hasOwn(ESCAPES, escape)) throw new JsonDecodeError("Invalid \\escape", text, index - 1);
            out += ESCAPES[escape];
            end = index + 1;
            continue;
        }
        const hex = text.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JsonDecodeError("Invalid \\uXXXX escape", text, index - 1);
        out += String.fromCharCode(parseInt(hex, 16));
        end = index + 5;
    }
}

function constant(name, options) {
    if (options.constants === "allow") {
        return new PyFloat(name === "NaN" ? NaN : name === "Infinity" ? Infinity : -Infinity);
    }
    throw options.constantError(name);
}

function scanOnce(text, index, options) {
    if (index >= text.length) throw new JsonDecodeError("Expecting value", text, index);
    const char = text[index];
    if (char === '"') return scanString(text, index + 1);
    if (char === "{") return scanObject(text, index, options);
    if (char === "[") return scanArray(text, index, options);
    if (char === "n" && text.startsWith("null", index)) return [null, index + 4];
    if (char === "t" && text.startsWith("true", index)) return [true, index + 4];
    if (char === "f" && text.startsWith("false", index)) return [false, index + 5];
    if (char === "N" && text.startsWith("NaN", index)) return [constant("NaN", options), index + 3];
    if (char === "I" && text.startsWith("Infinity", index)) return [constant("Infinity", options), index + 8];
    if (char === "-" && text.startsWith("-Infinity", index)) return [constant("-Infinity", options), index + 9];
    NUMBER.lastIndex = index;
    const match = NUMBER.exec(text);
    if (!match) throw new JsonDecodeError("Expecting value", text, index);
    const lexeme = match[0];
    if (match[1] !== undefined || match[2] !== undefined) return [new PyFloat(Number(lexeme)), NUMBER.lastIndex];
    const value = Number(lexeme);
    return [Number.isSafeInteger(value) ? (value === 0 ? 0 : value) : BigInt(lexeme), NUMBER.lastIndex];
}

function scanObject(text, start, options) {
    const out = dict();
    let duplicate;
    let index = skipWs(text, start + 1);
    if (text[index] === "}") return [out, index + 1];
    for (;;) {
        if (text[index] !== '"') {
            throw new JsonDecodeError("Expecting property name enclosed in double quotes", text, index);
        }
        const [key, keyEnd] = scanString(text, index + 1);
        index = skipWs(text, keyEnd);
        if (text[index] !== ":") throw new JsonDecodeError("Expecting ':' delimiter", text, index);
        const [value, valueEnd] = scanOnce(text, skipWs(text, index + 1), options);
        if (duplicate === undefined && Object.hasOwn(out, key)) duplicate = key;
        out[key] = value;
        index = skipWs(text, valueEnd);
        if (text[index] === "}") {
            index += 1;
            break;
        }
        if (text[index] !== ",") throw new JsonDecodeError("Expecting ',' delimiter", text, index);
        index = skipWs(text, index + 1);
    }
    if (duplicate !== undefined && options.duplicates === "error") throw options.duplicateError(duplicate);
    return [out, index];
}

function scanArray(text, start, options) {
    const out = [];
    let index = skipWs(text, start + 1);
    if (text[index] === "]") return [out, index + 1];
    for (;;) {
        const [value, end] = scanOnce(text, index, options);
        out.push(value);
        index = skipWs(text, end);
        if (text[index] === "]") return [out, index + 1];
        if (text[index] !== ",") throw new JsonDecodeError("Expecting ',' delimiter", text, index);
        index = skipWs(text, index + 1);
    }
}

export class DuplicateKeyError extends Error {}

const STRICT = {
    duplicates: "error",
    constants: "error",
    duplicateError: (key) => new DuplicateKeyError(`duplicate key ${pyRepr(key)}`),
    constantError: (name) => new Error(`non-finite JSON number ${name}`),
};

/**
 * Python json.loads(). Options: duplicates "error"|"last", constants
 * "error"|"allow", duplicateError(key), constantError(name). Defaults mirror
 * plain json.loads (last duplicate wins, NaN/Infinity allowed).
 */
export function pyLoads(text, options = {}) {
    const settings = { duplicates: "last", constants: "allow", ...options };
    if (text.startsWith("\ufeff")) {
        throw new JsonDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", text, 0);
    }
    const [value, end] = scanOnce(text, skipWs(text, 0), settings);
    const tail = skipWs(text, end);
    if (tail !== text.length) throw new JsonDecodeError("Extra data", text, tail);
    return value;
}

export function pyRawDecode(text, index, options = {}) {
    return scanOnce(text, index, { duplicates: "last", constants: "allow", ...options });
}

/** json.loads with duplicate keys and NaN/Infinity refused. */
export const strictLoads = (text, options = {}) => pyLoads(text, { ...STRICT, ...options });

function encodeAscii(value) {
    let out = '"';
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        const code = value.charCodeAt(index);
        if (char === '"' || char === "\\") out += `\\${char}`;
        else if (char === "\n") out += "\\n";
        else if (char === "\r") out += "\\r";
        else if (char === "\t") out += "\\t";
        else if (char === "\b") out += "\\b";
        else if (char === "\f") out += "\\f";
        else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, "0")}`;
        else out += char;
    }
    return `${out}"`;
}

/**
 * Python json.dumps(). Options: sortKeys, indent, separators [item, key],
 * ensureAscii (default true), allowNan (default true), default(value).
 */
export function pyDumps(value, options = {}) {
    const { sortKeys = false, indent = null, ensureAscii = true, allowNan = true } = options;
    const [itemSep, keySep] = options.separators ?? (indent === null ? [", ", ": "] : [",", ": "]);
    const encodeString = ensureAscii ? encodeAscii : (text) => JSON.stringify(text);
    const encode = (item, level) => {
        if (item === null) return "null";
        if (item === true) return "true";
        if (item === false) return "false";
        if (isStr(item)) return encodeString(item);
        if (isInt(item)) return String(item);
        if (isFloat(item)) {
            const number = num(item);
            if (Number.isFinite(number)) return floatRepr(number);
            if (!allowNan) throw new RangeError("Out of range float values are not JSON compliant");
            return Number.isNaN(number) ? "NaN" : number > 0 ? "Infinity" : "-Infinity";
        }
        let parts;
        let brackets;
        if (isList(item)) {
            if (!item.length) return "[]";
            parts = item.map((child) => encode(child, level + 1));
            brackets = "[]";
        } else if (isDict(item)) {
            const keys = Object.keys(item);
            if (!keys.length) return "{}";
            if (sortKeys) keys.sort(cmpStr);
            parts = keys.map((key) => encodeString(key) + keySep + encode(item[key], level + 1));
            brackets = "{}";
        } else if (options.default) {
            return encode(options.default(item), level);
        } else {
            throw new TypeError(`Object of type ${typeName(item)} is not JSON serializable`);
        }
        if (indent === null) return brackets[0] + parts.join(itemSep) + brackets[1];
        const inner = `\n${" ".repeat(indent * (level + 1))}`;
        return brackets[0] + inner + parts.join(itemSep + inner) + `\n${" ".repeat(indent * level)}` + brackets[1];
    };
    return encode(value, 0);
}

export const compactSorted = (value) =>
    pyDumps(value, { sortKeys: true, ensureAscii: false, separators: [",", ":"], allowNan: false });

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

// First invalid UTF-8 byte offset (like UnicodeDecodeError.start), or -1.
export function invalidUtf8At(bytes) {
    let index = 0;
    while (index < bytes.length) {
        const byte = bytes[index];
        let need;
        let min;
        if (byte < 0x80) {
            index += 1;
            continue;
        }
        if (byte >= 0xc2 && byte <= 0xdf) [need, min] = [1, 0x80];
        else if (byte >= 0xe0 && byte <= 0xef) [need, min] = [2, 0x800];
        else if (byte >= 0xf0 && byte <= 0xf4) [need, min] = [3, 0x10000];
        else return index;
        let codePoint = byte & (0x3f >> need);
        for (let offset = 1; offset <= need; offset += 1) {
            const next = bytes[index + offset];
            if (next === undefined || (next & 0xc0) !== 0x80) return index;
            codePoint = (codePoint << 6) | (next & 0x3f);
        }
        if (codePoint < min || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return index;
        index += need + 1;
    }
    return -1;
}

export function decodeUtf8(bytes) {
    const at = invalidUtf8At(bytes);
    return at >= 0 ? [null, at] : [Buffer.from(bytes).toString("utf8"), -1];
}

// ---------------------------------------------------------------------------
// Cluster engine
// ---------------------------------------------------------------------------

const TOKEN = /[0-9A-Za-z_=+.\-]+/gu;
const GUID = new RegExp(`${B}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${B}`, "giu");
const TIMESTAMP = new RegExp(
    `${B}${D}{4}-${D}{2}-${D}{2}[T ][0-9:.]+(?:Z|[+-]${D}{2}:?${D}{2})?${B}`, "giu",
);
const ISO_DAY = new RegExp(`^(${D}{4}-${D}{2}-${D}{2})`, "u");
const PSEUDO = new RegExp(
    "<(user|id|sess|session|call|frame|req|request|path|path-id|path-name|"
    + `opaque|host|tenant-host|arg-id|org|collector)-${D}+:[0-9a-f]{4,}>`, "giu",
);
const STATUS = new RegExp(
    "[\"']?(?:status|statusCode|status_code|httpStatus|http_status|httpStatusCode|http_status_code)"
    + `["']?${S}*[:=]${S}*["']?(-?(?:${D}+(?:\\.${D}+)?|NaN|Infinity|-Infinity))["']?(?![0-9.])`, "giu",
);
const CODE = new RegExp(`["']?(?:code|errorCode|error_code)["']?${S}*[:=]${S}*["']([^"']{1,160})["']`, "giu");
const REQID = new RegExp(
    "[\"']?(requestId|request_id|clientRequestId|client_request_id|x-ms-request-id|x_ms_request_id|"
    + `xMsRequestId|correlationId|correlation_id)["']?${S}*[:=]${S}*["']([^"']{1,300})["']`, "giu",
);
const FALLBACK_ISERROR = new RegExp(`["']?isError["']?${S}*[:=]${S}*true${B}`, "iu");
const FALLBACK_STOPPED = new RegExp(`["']?stoppedReason["']?${S}*[:=]${S}*["']error["']`, "iu");
const FALLBACK_ERROR = new RegExp(
    `(?<![A-Za-z0-9_])["']?error["']?${S}*[:=]${S}*(?:`
    + `["'](?!${S}*(?:null|false)${S}*["'])[^"']*${NS}[^"']*["']`
    + `|\\{${S}*[^${WS}}]|\\[${S}*[^${WS}\\]]|true${B}|-?(?:[1-9]${D}*)(?:\\.${D}+)?)`, "iu",
);
const COLLAPSE_WS = new RegExp(`${S}+`, "gu");
const STATUS_TEXT = new RegExp(`^${S}*(${D}{3})${S}*$`, "u");

export const BODY_ALIASES = [
    "err", "error", "tool_complete_error_message", "result", "tool_complete_result_content", "body", "content",
];
export const DEFAULT_OPAQUE_LEN = 20;
export const CLUSTER_ENGINE_VERSION = 2;
export const DISPLAY_SIGNATURE_LIMIT = 220;
export const DISPLAY_SAMPLE_ERROR_LIMIT = 320;
export const DISPLAY_SAMPLE_ARGS_LIMIT = 220;
export const MAX_PROTOCOL_DEPTH = 5;
export const MAX_PROTOCOL_NODES = 10_000;
export const MAX_PROTOCOL_ARRAY = 1_000;
export const MAX_PROTOCOL_TEXT = 100_000;

const STATUS_KEYS = new Set(["status", "statuscode", "httpstatus", "httpstatuscode"]);
const ERROR_KEYS = new Set(["error", "errors"]);
const DIRECT_PROTOCOL_KEYS = new Set(["iserror", ...STATUS_KEYS, "stoppedreason", ...ERROR_KEYS, "content"]);
const SIGNAL_KEYS = new Set([...DIRECT_PROTOCOL_KEYS, "outcome", "success"]);
const OPERATION_KEYS = new Set([
    ...DIRECT_PROTOCOL_KEYS, "code", "errorcode", "subcode", "message", "detail", "details", "diagnostic",
    "outcome", "success", "id", "operationid", "index", "path", "requestpath", "resourcepath", "endpoint",
    "uri", "url", "target", "requestid", "requestids", "clientrequestid", "clientrequestids", "xmsrequestid",
    "xmsrequestids", "correlationid", "correlationids",
]);
const PAYLOAD_KEYS = new Set(["data", "body", "headers"]);
const OPERATION_PAYLOAD_KEYS = new Set([...OPERATION_KEYS, ...PAYLOAD_KEYS]);
const STOPPED_ENVELOPE_KEYS = new Set([...OPERATION_KEYS, "markdown", "resultcount", "retrievalhits"]);
const REQUEST_ID_KINDS = {
    requestid: "request_id", requestids: "request_id",
    clientrequestid: "client_request_id", clientrequestids: "client_request_id",
    xmsrequestid: "x_ms_request_id", xmsrequestids: "x_ms_request_id",
    correlationid: "correlation_id", correlationids: "correlation_id",
};
const PATH_KEYS = new Set(["path", "requestpath", "resourcepath", "endpoint", "uri", "url", "target"]);
const METADATA_KEYS = [
    "status_codes", "error_codes", "request_ids", "client_request_ids", "x_ms_request_ids", "correlation_ids", "paths",
];

const keyOf = (value) => pyStr(value).toLowerCase().replace(/[^a-z0-9]/g, "");
const isContainer = (value) => isDict(value) || isList(value);
const subset = (set, allowed) => [...set].every((key) => allowed.has(key));
const intersects = (set, values) => values.some((key) => set.has(key));
const get = (object, key) => (Object.hasOwn(object, key) ? object[key] : null);

function loadsOrNull(text) {
    const stripped = pyStrip(text);
    if (!stripped) return null;
    try {
        return strictLoads(stripped);
    } catch {
        return null;
    }
}

/** Return whether an unlabelled token looks like a generated identifier. */
export function isOpaque(token, minLen) {
    if (token.length < minLen) return false;
    if (/^[0-9]+$/.test(token)) return false;
    return /[0-9]/.test(token) && /[A-Za-z]/.test(token);
}

function normaliseText(value, minLen, preserveTokens = false) {
    value = value
        .replace(PSEUDO, (_, kind) => `<${kind.toLowerCase()}>`)
        .replace(GUID, "<guid>")
        .replace(TIMESTAMP, "<ts>");
    if (!preserveTokens) value = value.replace(TOKEN, (token) => (isOpaque(token, minLen) ? "<x>" : token));
    return pyStrip(value.replace(COLLAPSE_WS, " "));
}

function isCodeKey(key) {
    const normalized = keyOf(key);
    return !STATUS_KEYS.has(normalized)
        && (normalized === "code" || normalized.endsWith("errorcode") || normalized === "subcode");
}

function normaliseStructured(node, minLen, field = "") {
    const identifier = REQUEST_ID_KINDS[keyOf(field)];
    if (identifier && truthyError(node)) return `<${identifier}>`;
    if (isDict(node)) {
        const out = dict();
        for (const key of Object.keys(node).sort(cmpStr)) out[key] = normaliseStructured(node[key], minLen, key);
        return out;
    }
    if (isList(node)) return node.map((value) => normaliseStructured(value, minLen, field));
    if (isStr(node)) return normaliseText(node, minLen, isCodeKey(field) || PATH_KEYS.has(keyOf(field)));
    return node;
}

/** Return the complete, deterministic grouping signature for an error. */
export function normalise(err, minLen = DEFAULT_OPAQUE_LEN) {
    if (!pyTruthy(err) || !pyStrip(pyStr(err))) return "(no error text - check the body column)";
    const text = pyStrip(pyStr(err));
    let parsed;
    try {
        parsed = strictLoads(text);
    } catch {
        return normaliseText(text, minLen);
    }
    return compactSorted(normaliseStructured(parsed, minLen));
}

function truthyError(value) {
    if (value === null || value === undefined || value === false) return false;
    if (isStr(value)) {
        const stripped = pyStrip(value);
        return Boolean(stripped) && !["null", "false"].includes(stripped.toLowerCase());
    }
    if (isContainer(value)) return pyTruthy(value);
    if (isNum(value) || value === true) return num(value) !== 0;
    return true;
}

function statusOf(value) {
    let code;
    if (isBool(value)) return null;
    if (isInt(value)) code = Number(value);
    else if (isFloat(value)) {
        const number = num(value);
        if (!Number.isFinite(number) || !Number.isInteger(number)) return null;
        code = number;
    } else if (isStr(value)) {
        const match = STATUS_TEXT.exec(value);
        if (!match) return null;
        code = pyInt(match[1]);
    } else return null;
    return code >= 100 && code <= 599 ? code : null;
}

const emptyMetadata = () => Object.fromEntries(METADATA_KEYS.map((key) => [key, new Set()]));
const isWorkiqMime = (key) => pyStrip(key).toLowerCase().startsWith("application/vnd.ms-workiq.");

function normalizedItems(node) {
    const items = new Map();
    for (const [key, value] of Object.entries(node)) items.set(keyOf(key), [key, value]);
    return items;
}

const directSignalKeys = (node) => [...normalizedItems(node).keys()].filter((key) => SIGNAL_KEYS.has(key));

function operationShape(node, allowPayload = false) {
    if (!isDict(node) || !Object.keys(node).length) return false;
    const keys = new Set(normalizedItems(node).keys());
    if (!subset(keys, allowPayload ? OPERATION_PAYLOAD_KEYS : OPERATION_KEYS)) return false;
    const hasStatus = intersects(keys, [...STATUS_KEYS]);
    const hasIdentity = intersects(keys, ["id", "operationid", "index", "path", "requestpath", "resourcepath"]);
    const hasOutcome = intersects(keys, ["iserror", "stoppedreason", "error", "outcome", "success"]);
    return hasStatus || (hasIdentity && hasOutcome);
}

const operationArray = (node, allowPayload = false) =>
    isList(node) && node.length > 0 && node.every((item) => operationShape(item, allowPayload));

function explicitEnvelope(node, source) {
    if (!isDict(node)) return false;
    const normalized = normalizedItems(node);
    const keys = new Set(normalized.keys());
    if (normalized.has("iserror") && isBool(normalized.get("iserror")[1])) return true;
    if (normalized.has("stoppedreason") && subset(keys, STOPPED_ENVELOPE_KEYS)) return true;
    if ([...normalized.values()].some(([original]) => isWorkiqMime(original))) return true;
    if (intersects(keys, ["content", "result", "results", "responses", "operations"])) return true;
    if (keys.has("jsonrpc") && keys.has("error")) return true;
    const signals = directSignalKeys(node).length > 0;
    if (source === "error" && (signals || Object.keys(node).some(isCodeKey))) return true;
    return signals && subset(keys, OPERATION_KEYS);
}

function decodePayload(text) {
    const stripped = pyStrip(text);
    if (!stripped) return [null, "absent", false];
    try {
        return [strictLoads(stripped), "structural", false];
    } catch {
        // fall through to bounded extraction
    }
    const starts = [...text.matchAll(/[[{]/g)].map((match) => match.index);
    const candidatesIncomplete = starts.length > 64;
    for (const start of starts.slice(0, 1)) {
        let value;
        let end;
        try {
            [value, end] = pyRawDecode(text, start, STRICT);
        } catch {
            continue;
        }
        const prefix = pyStrip(text.slice(0, start));
        const suffix = pyStrip(text.slice(end));
        let mode = prefix && !suffix ? "prefixed-json" : "extracted-json";
        if (!prefix && suffix) mode = "json-with-trailing";
        return [value, mode, Boolean(suffix) || candidatesIncomplete];
    }
    return [null, "regex-fallback", starts.length > 0];
}

function analyseFallback(body) {
    const hits = new Set();
    const metadata = emptyMetadata();
    if (FALLBACK_ISERROR.test(body)) hits.add("isError");
    for (const match of body.matchAll(STATUS)) {
        const code = statusOf(match[1]);
        if (code !== null && code >= 400) {
            metadata.status_codes.add(String(code));
            hits.add(`statusCode=${code}`);
        }
    }
    if (FALLBACK_STOPPED.test(body)) hits.add("stoppedReason=error");
    if (FALLBACK_ERROR.test(body)) hits.add("error");
    for (const match of body.matchAll(CODE)) {
        const code = pyStrip(match[1]);
        if (code) metadata.error_codes.add(code);
    }
    for (const match of body.matchAll(REQID)) {
        const kind = REQUEST_ID_KINDS[keyOf(match[1])];
        const value = pyStrip(match[2]);
        if (kind && value) {
            metadata[`${kind}s`].add(value);
            metadata.request_ids.add(value);
        }
    }
    return [hits, metadata];
}

function directDiagnostic(node, hits, metadata, state = null) {
    const localHits = new Set();
    const statuses = [];
    let errorCode = null;
    let message = "";
    const requestIds = new Set();
    let explicitOutcome = "";
    const scalar = (value) => !isContainer(value) && !isBool(value);

    for (const [key, [original, value]] of normalizedItems(node)) {
        if (key === "iserror" && value === true) localHits.add("isError");
        else if (STATUS_KEYS.has(key)) {
            const code = statusOf(value);
            if (code !== null) {
                statuses.push(code);
                metadata.status_codes.add(String(code));
                if (code >= 400) localHits.add(`statusCode=${code}`);
            }
        } else if (key === "stoppedreason" && pyStrip(pyStr(value)).toLowerCase() === "error") {
            localHits.add("stoppedReason=error");
        } else if (ERROR_KEYS.has(key) && truthyError(value)) localHits.add("error");
        else if (isCodeKey(original) && scalar(value)) {
            const candidate = pyStrip(pyStr(value));
            if (candidate) {
                errorCode = errorCode || candidate;
                metadata.error_codes.add(candidate);
            }
        } else if (Object.hasOwn(REQUEST_ID_KINDS, key)) {
            let candidates;
            if (isList(value)) {
                if (value.length > MAX_PROTOCOL_ARRAY && state) state.inconclusive = true;
                candidates = value.slice(0, MAX_PROTOCOL_ARRAY);
            } else if (value === null || isDict(value) || isBool(value)) {
                if (isDict(value) && state) state.inconclusive = true;
                continue;
            } else candidates = [value];
            for (const candidateValue of candidates) {
                if (candidateValue === null || isContainer(candidateValue) || isBool(candidateValue)) {
                    if (state) state.inconclusive = true;
                    continue;
                }
                const candidate = pyStrip(pyStr(candidateValue));
                if (candidate) {
                    metadata[`${REQUEST_ID_KINDS[key]}s`].add(candidate);
                    metadata.request_ids.add(candidate);
                    requestIds.add(candidate);
                }
            }
        } else if (PATH_KEYS.has(key) && scalar(value)) {
            const candidate = pyStrip(pyStr(value));
            if (candidate) metadata.paths.add(candidate);
        } else if ((key === "message" || key === "detail") && isStr(value)) {
            message = message || pyStrip(value);
        } else if (key === "outcome" && isStr(value)) {
            explicitOutcome = pyStrip(value).toLowerCase();
        } else if (key === "success" && isBool(value)) {
            explicitOutcome = value ? "ok" : "fail";
        }
    }

    let outcome;
    if (["fail", "failed", "error"].includes(explicitOutcome)) {
        localHits.add("outcome=fail");
        outcome = "fail";
    } else if (localHits.size) outcome = "fail";
    else if (["ok", "success", "succeeded"].includes(explicitOutcome)) outcome = "ok";
    else if (statuses.length) outcome = statuses.some((code) => code >= 400) ? "fail" : "ok";
    else outcome = "unknown";
    for (const hit of localHits) hits.add(hit);
    let statusCode = statuses.find((code) => code >= 400) ?? null;
    if (statusCode === null && new Set(statuses).size === 1) statusCode = statuses[0];
    return [outcome, statusCode, errorCode, sortStrings(requestIds), message];
}

function operationRecord(node, path, hits, metadata, state) {
    if (cpLen(path) > 240) {
        state.inconclusive = true;
        path = cpSlice(path, 0, 240);
    }
    const [outcome, statusCode, errorCode, requestIds, message] = directDiagnostic(node, hits, metadata, state);
    const diagnostic = { outcome };
    if (statusCode !== null) diagnostic.status_code = statusCode;
    if (errorCode) diagnostic.error_code = errorCode;
    if (message) diagnostic.message = message;
    if (outcome === "fail") hits.add("operationFailure");
    return {
        path,
        outcome,
        status_code: statusCode,
        error_code: errorCode,
        request_ids: requestIds,
        diagnostic: compactSorted(diagnostic),
    };
}

function analyseJson(value, source = "result") {
    const hits = new Set();
    const metadata = emptyMetadata();
    const operations = [];
    const state = { nodes: 0, inconclusive: false };

    const consumeArray = (node, path, depth, allowPayload = false) => {
        if (node.length > MAX_PROTOCOL_ARRAY) state.inconclusive = true;
        const limited = node.slice(0, MAX_PROTOCOL_ARRAY);
        if (!operationArray(limited, allowPayload)) {
            if (limited.some((item) => isDict(item) && directSignalKeys(item).length)) state.inconclusive = true;
            return;
        }
        for (const [index, item] of limited.entries()) {
            if (state.nodes >= MAX_PROTOCOL_NODES) {
                state.inconclusive = true;
                return;
            }
            state.nodes += 1;
            operations.push(operationRecord(item, `${path}[${index}]`, hits, metadata, state));
            const wrappers = dict();
            for (const [key, child] of Object.entries(item)) if (!PAYLOAD_KEYS.has(keyOf(key))) wrappers[key] = child;
            inspectWrappers(wrappers, `${path}[${index}]`, depth + 1);
        }
    };

    const consumeText = (text, path, depth) => {
        if (cpLen(text) > MAX_PROTOCOL_TEXT) {
            state.inconclusive = true;
            text = cpSlice(text, 0, MAX_PROTOCOL_TEXT);
        }
        const [parsed, mode, incomplete] = decodePayload(text);
        state.inconclusive = state.inconclusive || incomplete;
        if (parsed === null) {
            const [fallbackHits, fallbackMetadata] = analyseFallback(text);
            for (const hit of fallbackHits) hits.add(hit);
            for (const [key, values] of Object.entries(fallbackMetadata)) for (const item of values) metadata[key].add(item);
            if (pyStrip(text)) state.inconclusive = true;
            return;
        }
        if (isList(parsed)) consumeArray(parsed, path, depth + 1);
        else if (explicitEnvelope(parsed, "result")) walk(parsed, path, depth + 1, "envelope");
        else if (mode !== "structural") state.inconclusive = true;
    };

    const inspectWrappers = (node, path, depth) => {
        for (const [key, [original, child]] of normalizedItems(node)) {
            const childPath = `${path}.${original}`;
            if (key === "content" && isList(child)) {
                if (child.length > MAX_PROTOCOL_ARRAY) state.inconclusive = true;
                for (const [index, item] of child.slice(0, MAX_PROTOCOL_ARRAY).entries()) {
                    if (!isDict(item)) continue;
                    const itemKeys = new Map(Object.entries(item).map(([itemKey, itemValue]) => [keyOf(itemKey), itemValue]));
                    const text = itemKeys.get("text");
                    const itemType = pyStrip(pyStr(itemKeys.has("type") ? itemKeys.get("type") : "")).toLowerCase();
                    if (isStr(text) && (itemType === "" || itemType === "text")) {
                        consumeText(text, `${childPath}[${index}].text`, depth + 1);
                    }
                }
            } else if (isWorkiqMime(original) && isContainer(child)) {
                walk(child, childPath, depth + 1, "envelope");
            } else if (["results", "responses", "operations"].includes(key)) {
                if (isList(child)) consumeArray(child, childPath, depth + 1, true);
                else if (isDict(child) && explicitEnvelope(child, "result")) walk(child, childPath, depth + 1, "envelope");
            } else if (["result", "response", "body"].includes(key)) {
                if (isList(child)) consumeArray(child, childPath, depth + 1);
                else if (isDict(child) && explicitEnvelope(child, "result")) walk(child, childPath, depth + 1, "envelope");
            } else if (ERROR_KEYS.has(key) && isContainer(child)) {
                walk(child, childPath, depth + 1, "error");
            }
        }
    };

    const walk = (node, path, depth, context) => {
        if (depth > MAX_PROTOCOL_DEPTH || state.nodes >= MAX_PROTOCOL_NODES) {
            state.inconclusive = true;
            return;
        }
        state.nodes += 1;
        if (isList(node)) {
            consumeArray(node, path, depth);
            return;
        }
        if (!isDict(node)) return;
        const recognized = context === "error" || context === "envelope" || explicitEnvelope(node, source);
        if (!recognized) {
            if (directSignalKeys(node).length) state.inconclusive = true;
            return;
        }
        directDiagnostic(node, hits, metadata, state);
        inspectWrappers(node, path, depth);
    };

    walk(value, "$", 0, source);
    return { hits, metadata, operations, inconclusive: state.inconclusive };
}

const sortedMetadata = (metadata) =>
    Object.fromEntries(sortStrings(METADATA_KEYS).map((key) => [key, sortStrings(metadata[key])]));

/** Return one bounded structural scan for predicates and operations. */
export function diagnosticAnalysis(body, source = "result") {
    const available = pyTruthy(body) && Boolean(pyStrip(pyStr(body)));
    const base = {
        predicates: [],
        metadata: sortedMetadata(emptyMetadata()),
        operations: [],
        inconclusive: false,
        body_available: available,
        scan_mode: "absent",
        predicate_confidence: "none",
        limits: {
            max_depth: MAX_PROTOCOL_DEPTH,
            max_nodes: MAX_PROTOCOL_NODES,
            max_array_items: MAX_PROTOCOL_ARRAY,
            max_text_chars: MAX_PROTOCOL_TEXT,
        },
    };
    if (!available) return base;
    const text = pyStrip(pyStr(body));
    const [parsed, scanMode, parseInconclusive] = decodePayload(text);
    base.scan_mode = scanMode;
    if (parsed === null) {
        const [hits, metadata] = analyseFallback(text);
        base.predicates = sortStrings(hits);
        base.metadata = sortedMetadata(metadata);
        base.inconclusive = true;
        base.predicate_confidence = "suspect";
        return base;
    }
    const analysed = analyseJson(parsed, source);
    base.predicates = sortStrings(analysed.hits);
    base.metadata = sortedMetadata(analysed.metadata);
    base.operations = analysed.operations;
    base.inconclusive = Boolean(parseInconclusive || analysed.inconclusive);
    base.predicate_confidence = base.inconclusive ? "suspect" : "confirmed";
    return base;
}

/** Return failure predicates from bounded MCP diagnostic protocol shapes. */
export const embeddedFailure = (body) => diagnosticAnalysis(body).predicates;

function scalarText(value) {
    if (value === null || value === undefined || isContainer(value) || isBool(value)) return "";
    return pyStrip(pyStr(value));
}

/** Build the canonical, correlation-independent diagnostic used for grouping. */
export function frameDiagnostic(frame) {
    const error = stringify(Object.hasOwn(frame, "error") ? frame.error : get(frame, "err"));
    const parsedError = loadsOrNull(error);
    if (
        isDict(parsedError)
        && pyEq(get(parsedError, "cluster_engine_version"), CLUSTER_ENGINE_VERSION)
        && !["status_code", "error_code", "embedded_failure", "predicates", "operations"]
            .some((key) => pyTruthy(get(frame, key)))
    ) {
        return compactSorted(parsedError);
    }

    const payload = { cluster_engine_version: CLUSTER_ENGINE_VERSION };
    if (pyStrip(error)) payload.error = parsedError !== null ? parsedError : error;
    const statusCode = statusOf(get(frame, "status_code"));
    if (statusCode !== null) payload.status_code = statusCode;
    const errorCode = scalarText(get(frame, "error_code"));
    if (errorCode) payload.error_code = errorCode;

    let predicates = get(frame, "embedded_failure");
    if (!pyTruthy(predicates)) predicates = get(frame, "predicates");
    if (!pyTruthy(predicates)) predicates = [];
    if (isStr(predicates)) predicates = [predicates];
    if (isList(predicates)) {
        const clean = sortStrings(new Set(predicates.map((value) => pyStrip(pyStr(value))).filter(Boolean)));
        if (clean.length) payload.predicates = clean;
    }

    let operations = get(frame, "operations");
    if (!isList(operations)) operations = error ? diagnosticAnalysis(error, "error").operations : [];
    const grouping = new Map();
    for (const operation of operations) {
        if (!isDict(operation)) continue;
        const item = {};
        const rawOutcome = get(operation, "outcome");
        const outcome = pyStrip(pyStr(pyTruthy(rawOutcome) ? rawOutcome : "")).toLowerCase();
        if (["ok", "fail", "unknown"].includes(outcome)) item.outcome = outcome;
        const operationStatus = statusOf(get(operation, "status_code"));
        if (operationStatus !== null) item.status_code = operationStatus;
        const operationCode = scalarText(get(operation, "error_code"));
        if (operationCode) item.error_code = operationCode;
        const diagnostic = get(operation, "diagnostic");
        if (isStr(diagnostic) && pyStrip(diagnostic)) {
            const decoded = loadsOrNull(diagnostic);
            item.diagnostic = decoded !== null ? decoded : diagnostic;
        } else if (isContainer(diagnostic) && pyTruthy(diagnostic)) {
            item.diagnostic = diagnostic;
        }
        if (!Object.keys(item).length) continue;
        grouping.set(compactSorted(item), item);
    }
    if (grouping.size) payload.operations = sortStrings(grouping.keys()).map((key) => grouping.get(key));
    return compactSorted(payload);
}

function stringify(value) {
    if (value === null || value === undefined) return "";
    if (isContainer(value)) return compactSorted(value);
    return pyStr(value);
}

/** Parse a pipe table without guessing ownership of malformed cells. */
export function parseMarkdown(text) {
    const numbered = pySplitlines(text)
        .map((line, index) => [index + 1, line])
        .filter(([, line]) => pyStrip(line).startsWith("|"));
    if (!numbered.length) return [[], []];
    const cellsOf = (line) => pyStrip(line).replace(/^\|+|\|+$/g, "").split("|").map(pyStrip);
    const header = cellsOf(numbered[0][1]).map((cell) => cell.toLowerCase());
    if (new Set(header).size !== header.length) return [[], ["line 1: duplicate markdown header names"]];
    const rows = [];
    const bad = [];
    for (const [lineNumber, line] of numbered.slice(1)) {
        const cells = cellsOf(line);
        if (cells.every((cell) => /^[- :]*$/.test(cell))) continue;
        if (cells.length !== header.length) {
            bad.push(
                `line ${lineNumber}: ${cells.length} cells, header has ${header.length} `
                + "(unescaped '|' in the data - re-export as JSONL)",
            );
            continue;
        }
        const row = dict();
        header.forEach((name, index) => {
            row[name] = cells[index];
        });
        rows.push(row);
    }
    return [rows, bad];
}

const ASCII_WS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);
function bytesLstrip(bytes) {
    let index = 0;
    while (index < bytes.length && ASCII_WS.has(bytes[index])) index += 1;
    return bytes.subarray(index);
}

function bytesSplitlines(bytes) {
    const lines = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] === 0x0a || bytes[index] === 0x0d) {
            lines.push(bytes.subarray(start, index));
            if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) index += 1;
            start = index + 1;
        }
    }
    if (start < bytes.length) lines.push(bytes.subarray(start));
    return lines;
}

function parseJsonBytes(data) {
    const rows = [];
    const bad = [];
    const stripped = bytesLstrip(data);
    if (!stripped.length) return [rows, bad];
    if (stripped[0] === 0x5b) {
        const [text, at] = decodeUtf8(data);
        if (text === null) return [[], [`byte ${at}: invalid UTF-8`]];
        let value;
        try {
            value = strictLoads(text);
        } catch (error) {
            return [[], [`JSON document: ${error.message}`]];
        }
        if (!isList(value)) return [[], ["JSON document: expected an array"]];
        for (const [index, item] of value.entries()) {
            if (isDict(item)) rows.push(item);
            else bad.push(`array item ${index}: expected object, got ${typeName(item)}`);
        }
        return [rows, bad];
    }
    const [whole] = decodeUtf8(data);
    if (whole !== null) {
        try {
            const value = strictLoads(whole);
            if (isDict(value)) return [[value], []];
        } catch {
            // not a single document; read as JSONL
        }
    }
    for (const [index, rawLine] of bytesSplitlines(data).entries()) {
        const lineNumber = index + 1;
        if (!bytesLstrip(rawLine).length) continue;
        const [line, at] = decodeUtf8(rawLine);
        if (line === null) {
            bad.push(`line ${lineNumber}: invalid UTF-8 at byte ${at}`);
            continue;
        }
        let item;
        try {
            item = strictLoads(line);
        } catch (error) {
            bad.push(`line ${lineNumber}: not valid JSON (${error.message})`);
            continue;
        }
        if (!isDict(item)) {
            bad.push(`line ${lineNumber}: expected object, got ${typeName(item)}`);
            continue;
        }
        rows.push(item);
    }
    return [rows, bad];
}

/** Compatibility helper that throws if any JSON/JSONL record is malformed. */
export function parseJson(text) {
    const [rows, bad] = parseJsonBytes(Buffer.from(text, "utf8"));
    if (bad.length) throw new Error(bad.join("; "));
    return rows;
}

/**
 * Port of load(): parse a JSON, JSONL or markdown-table dump (Buffer or
 * string) into cluster rows. Returns { rows, bad, seenKeys }.
 */
export function loadRows(data, bodyColumn = null) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    const first = bytesLstrip(bytes)[0];
    let raw;
    let bad;
    if (first === undefined || first === 0x5b || first === 0x7b) [raw, bad] = parseJsonBytes(bytes);
    else {
        const [text, at] = decodeUtf8(bytes);
        if (text === null) return { rows: [], bad: [`byte ${at}: invalid UTF-8`], seenKeys: new Set() };
        [raw, bad] = parseMarkdown(text);
    }
    const seenKeys = new Set();
    const rows = [];
    for (const row of raw) {
        const low = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
        for (const key of low.keys()) seenKeys.add(key);
        const pick = (key) => (low.has(key) ? low.get(key) : null);
        const either = (...keys) => keys.map(pick).find(pyTruthy) ?? pick(keys[keys.length - 1]);
        let body = "";
        if (bodyColumn) body = stringify(pick(bodyColumn.toLowerCase()));
        else {
            const alias = BODY_ALIASES.find((name) => truthyError(pick(name)));
            if (alias) body = stringify(pick(alias));
        }
        rows.push({
            ts: stringify(either("timestamp", "ts")),
            session: stringify(either("session_id", "session")),
            tool: stringify(either("name", "tool", "tool_start_name")),
            args: stringify(either("args", "arguments_json")),
            err: body,
            frame_id: stringify(pick("frame_id")),
            status_code: pick("status_code"),
            error_code: pick("error_code"),
            request_ids: pyTruthy(pick("request_ids")) ? pick("request_ids") : [],
            embedded_failure: pyTruthy(pick("embedded_failure")) ? pick("embedded_failure") : [],
            operations: pyTruthy(pick("operations")) ? pick("operations") : [],
        });
    }
    return { rows, bad, seenKeys };
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validDay(timestamp) {
    const match = ISO_DAY.exec(timestamp || "");
    if (!match) return "";
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(match[1]);
    if (!parts) return "";
    const [year, month, date] = parts.slice(1).map(Number);
    if (year < 1 || month < 1 || month > 12 || date < 1) return "";
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return date > MONTH_DAYS[month - 1] + (month === 2 && leap ? 1 : 0) ? "" : match[1];
}

function fallbackMemberId(row, occurrence) {
    const encoded = pyDumps(row, {
        sortKeys: true, ensureAscii: false, separators: [",", ":"], default: (value) => pyStr(value),
    });
    return `row-${sha256Hex(encoded).slice(0, 20)}-${occurrence}`;
}

/** Stable cluster ID: c- + sha256(json([tool, signature]))[:24]. */
export function clusterId(tool, signature) {
    const encoded = pyDumps([tool, signature], { ensureAscii: false, separators: [",", ":"] });
    return `c-${sha256Hex(encoded).slice(0, 24)}`;
}

const asList = (value) => (isList(value) ? value : pyTruthy(value) ? [value] : []);

export function cluster(rows, minLen = DEFAULT_OPAQUE_LEN) {
    const buckets = new Map();
    for (const [index, row] of rows.entries()) {
        const tool = stringify(get(row, "tool"));
        const signature = normalise(frameDiagnostic(row), minLen);
        const key = JSON.stringify([tool, signature]);
        if (!buckets.has(key)) buckets.set(key, { tool, signature, members: [] });
        buckets.get(key).members.push([index, row]);
    }

    const clusters = [];
    for (const { tool, signature, members } of buckets.values()) {
        const items = members.map(([, row]) => row);
        const timestamps = sortStrings(items.filter((row) => pyTruthy(get(row, "ts"))).map((row) => stringify(row.ts)));
        const dayCounts = new Map();
        for (const row of items) {
            const day = validDay(stringify(get(row, "ts")));
            if (day) dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
        }
        const memberIds = [];
        const sets = emptyMetadata();
        let scanInconclusive = false;
        for (const [index, row] of members) {
            memberIds.push(pyStrip(stringify(get(row, "frame_id"))) || fallbackMemberId(row, index));
            const analysis = diagnosticAnalysis(stringify(get(row, "err")), "error");
            scanInconclusive = scanInconclusive || analysis.inconclusive;
            for (const [key, values] of Object.entries(analysis.metadata)) for (const value of values) sets[key].add(value);
            const typedStatus = statusOf(get(row, "status_code"));
            if (typedStatus !== null) sets.status_codes.add(String(typedStatus));
            const typedCode = scalarText(get(row, "error_code"));
            if (typedCode) sets.error_codes.add(typedCode);
            for (const value of asList(get(row, "request_ids"))) {
                const candidate = scalarText(value);
                if (candidate) sets.request_ids.add(candidate);
            }
            const rowOperations = get(row, "operations");
            if (!isList(rowOperations)) continue;
            for (const operation of rowOperations) {
                if (!isDict(operation)) continue;
                const operationStatus = statusOf(get(operation, "status_code"));
                if (operationStatus !== null) sets.status_codes.add(String(operationStatus));
                const operationCode = scalarText(get(operation, "error_code"));
                if (operationCode) sets.error_codes.add(operationCode);
                for (const value of asList(get(operation, "request_ids"))) {
                    const candidate = scalarText(value);
                    if (candidate) sets.request_ids.add(candidate);
                }
            }
        }
        const first = items[0] ?? {};
        const sampleArgs = stringify(get(first, "args"));
        const sampleError = stringify(get(first, "err"));
        const count = items.length;
        const dated = [...dayCounts.values()].reduce((total, value) => total + value, 0);
        const days = sortStrings(dayCounts.keys());
        const display = cpSlice(signature, 0, DISPLAY_SIGNATURE_LIMIT);
        clusters.push({
            id: clusterId(tool, signature),
            tool,
            signature,
            signature_display: display,
            signature_display_truncated: cpLen(signature) > cpLen(display),
            count,
            sessions: new Set(items.map((row) => stringify(get(row, "session"))).filter(Boolean)).size,
            first_seen: timestamps[0] ?? "",
            last_seen: timestamps[timestamps.length - 1] ?? "",
            distinct_days: dayCounts.size,
            days,
            day_counts: Object.fromEntries(days.map((day) => [day, dayCounts.get(day)])),
            undated_count: count - dated,
            frame_ids: memberIds,
            member_ids: [...memberIds],
            status_codes: sortStrings(sets.status_codes),
            error_codes: sortStrings(sets.error_codes),
            request_ids: sortStrings(sets.request_ids),
            client_request_ids: sortStrings(sets.client_request_ids),
            x_ms_request_ids: sortStrings(sets.x_ms_request_ids),
            correlation_ids: sortStrings(sets.correlation_ids),
            paths: sortStrings(sets.paths),
            diagnostic_scan_inconclusive: scanInconclusive,
            sample_args: cpSlice(sampleArgs, 0, DISPLAY_SAMPLE_ARGS_LIMIT),
            sample_args_truncated: cpLen(sampleArgs) > DISPLAY_SAMPLE_ARGS_LIMIT,
            sample_error: cpSlice(sampleError, 0, DISPLAY_SAMPLE_ERROR_LIMIT),
            sample_error_truncated: cpLen(sampleError) > DISPLAY_SAMPLE_ERROR_LIMIT,
        });
    }
    clusters.sort((a, b) => b.count - a.count || cmpStr(a.tool, b.tool) || cmpStr(a.id, b.id));
    if (clusters.reduce((total, item) => total + item.count, 0) !== rows.length) {
        throw new Error("cluster counts do not conserve input rows");
    }
    return clusters;
}

/** Return warnings for incomplete or suspicious clustering evidence. */
export function sanity(clusters, rows, minLen = DEFAULT_OPAQUE_LEN) {
    const warnings = [];
    const total = rows.length;
    const sum = (values) => values.reduce((acc, value) => acc + value, 0);
    if (sum(clusters.map((item) => item.count)) !== total) warnings.push("Cluster counts do not sum to parsed rows.");
    for (const item of clusters) {
        if (sum(Object.values(item.day_counts ?? {})) !== item.count - (item.undated_count ?? 0)) {
            warnings.push(`${item.id} daily counts do not reconcile with dated members.`);
        }
    }
    if (total >= 50 && clusters.length < 5) {
        warnings.push(
            `Only ${clusters.length} clusters for ${total} rows - the normaliser may be `
            + `erasing useful text. Raise --opaque above ${minLen} and compare.`,
        );
    }
    if (total >= 20 && clusters.length > 0.7 * total) {
        warnings.push(
            `${clusters.length} clusters for ${total} rows - almost nothing grouped. `
            + `Lower --opaque below ${minLen} and compare.`,
        );
    }
    const blank = sum(clusters.filter((item) => item.signature.startsWith("(no error text")).map((item) => item.count));
    if (blank) {
        warnings.push(
            `${blank} rows have no body text. This is inconclusive, not evidence of `
            + "no embedded failures; specify the diagnostic body column.",
        );
    }
    if (total && !rows.some((row) => pyTruthy(get(row, "session")))) {
        warnings.push("No session_id on any row; session counts are unavailable and must not be reported.");
    }
    if (total && !rows.some((row) => pyTruthy(get(row, "ts")))) {
        warnings.push("No timestamps parsed; temporal classification is unavailable.");
    }
    const undated = sum(clusters.map((item) => item.undated_count ?? 0));
    if (undated) {
        warnings.push(`${undated} row(s) lack a valid YYYY-MM-DD date; daily tables cover only dated members.`);
    }
    const duplicates = sum(clusters.map((item) => item.frame_ids.length - new Set(item.frame_ids).size));
    if (duplicates) warnings.push(`${duplicates} duplicate frame membership ID(s) detected.`);
    const mixed = clusters
        .filter((item) => item.status_codes.length > 1 || item.error_codes.length > 1)
        .map((item) => item.id);
    if (mixed.length) {
        warnings.push(
            `${mixed.length} cluster(s) contain multiple diagnostic status/error codes: ${mixed.slice(0, 8).join(", ")}`,
        );
    }
    const limited = clusters.filter((item) => item.diagnostic_scan_inconclusive).length;
    if (limited) {
        warnings.push(
            `${limited} cluster(s) reached the bounded protocol scan limit; `
            + "embedded-failure coverage is inconclusive for those members.",
        );
    }
    const erased = clusters.filter((item) => item.signature.includes("<x>")).length;
    if (erased) {
        warnings.push(
            `${erased} signature(s) collapse unlabelled opaque tokens. Structured `
            + "code, path, status, and correlation fields remain preserved separately.",
        );
    }
    return warnings;
}
