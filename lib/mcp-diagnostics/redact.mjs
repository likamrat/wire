// Port of the mcp-diagnostic-bundle skill's redact.py: fail-closed redaction.
// Gate success means the configured finite scanners found no known residue; it
// is not certification that arbitrary text is non-private.
import { createHmac, randomBytes } from "node:crypto";
import {
    B, D, S, W, WS, cmpStr, cpLen, cpSlice, fullmatch, isBool, isDict, isInt, isList, isNum, isStr, num,
    pyDumps, pyLoads, pyLstrip, pyStr, pyStrip, pyInt, pyTruthy, JsonDecodeError,
} from "./cluster.mjs";

export const PROFILES = ["internal", "external"];

export const PLACEHOLDER_CONTENT = "<redacted-content>";
export const PLACEHOLDER_UNKNOWN = "<omitted-unknown-field>";
export const PLACEHOLDER_NARRATIVE = "<omitted-unreviewed-narrative>";
export const PLACEHOLDER_PROSE = "<omitted-unreviewed-error-prose>";
export const PLACEHOLDER_PAYLOAD = "<omitted-nondiagnostic-payload>";
export const PLACEHOLDER_LITERAL = "<redacted-literal>";

// [name, pattern, replacement]; secret values are stripped in every profile.
export const SECRET_RULES = [
    ["capability-url-shares", new RegExp("/shares/u![A-Za-z0-9_\\-=]+", "giu"), "/shares/<redacted-capability>"],
    ["upload-session", new RegExp(`https?://[^${WS}"'<>]*upload(?:Session|Url)[^${WS}"'<>]*`, "giu"),
        "<redacted-upload-session-url>"],
    ["sas-token", new RegExp(`([?&])(?:sig|sv|se|st|sp|skoid|sktid|srt|spr)=[^&${WS}"'<>]+`, "giu"),
        "$1<redacted-sas>"],
    ["query-token", new RegExp("([?&])(?:access_token|token|code|id_token|refresh_token|secret|"
        + `password|passwd|apikey|api_key|client_secret)=[^&${WS}"'<>]+`, "giu"), "$1<redacted-token>"],
    ["bearer", new RegExp(`${B}Bearer${S}+[^${WS},;"']+`, "giu"), "<redacted-bearer>"],
    ["basic", new RegExp(`${B}Basic${S}+[A-Za-z0-9+/=_\\-]{4,}`, "giu"), "<redacted-basic>"],
    ["credential-assignment", new RegExp(`${B}(?:password|passwd|client[_-]?secret|api[_-]?key|authorization|`
        + `proxy-authorization)${S}*[:=]${S}*[^${WS},;"'}]+`, "giu"), "<redacted-credential>"],
    ["cookie", new RegExp(`${B}(?:set-cookie|cookie)${S}*:${S}*[^\\r\\n]+`, "giu"), "<redacted-cookie>"],
    ["jwt", new RegExp(`${B}eyJ[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}`, "gu"), "<redacted-jwt>"],
    ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/gsu, "<redacted-private-key>"],
    ["github-token", new RegExp(`${B}gh[pousr]_[A-Za-z0-9]{16,}`, "gu"), "<redacted-token>"],
    ["aws-key", new RegExp(`${B}(?:AKIA|ASIA)[0-9A-Z]{16}${B}`, "gu"), "<redacted-aws-key>"],
];

const EMAIL_SOURCE = `${B}[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}${B}`;
const GUID_SOURCE = `${B}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${B}`;
const OPAQUE_SOURCE = `${B}(?:AAMk|AQMk|AQAB)[A-Za-z0-9_\\-=]{12,}${B}`;
const EMAIL = new RegExp(EMAIL_SOURCE, "gu");
const GUID = new RegExp(GUID_SOURCE, "giu");
const OPAQUE_ID = new RegExp(OPAQUE_SOURCE, "gu");
const TENANT_HOST = new RegExp(`${B}([A-Za-z0-9-]+)\\.(?:sharepoint\\.com|onmicrosoft\\.com)${B}`, "giu");
const SAFE_TOKEN = "[A-Za-z][A-Za-z0-9_.:\\-/]{0,127}";
const SAFE_VERSION = "[A-Za-z0-9][A-Za-z0-9_.+\\-]{0,63}";
const ISO_TIME = `${D}{4}-${D}{2}-${D}{2}T${D}{2}:${D}{2}:${D}{2}(?:\\.${D}+)?(?:Z|[+-]${D}{2}:${D}{2})`;
const ALIAS = `<[A-Za-z0-9_-]+-${D}+:[0-9a-f]{4,64}>`;
const OFFSET = `(?:Z|[+-]${D}{2}:?${D}{2})`;
const QUOTED = "'(?:''|[^'])*'|\"(?:\\\\[^\\n]|[^\"])*\"";

const safeToken = (value) => isStr(value) && Boolean(fullmatch(SAFE_TOKEN, value));
const safeVersion = (value) => isStr(value) && Boolean(fullmatch(SAFE_VERSION, value));

const CONTENT_KEYS = new Set([
    "body", "content", "contentbytes", "comment", "comments", "message", "messages",
    "text", "subject", "question", "query", "queries", "search", "prompt", "markdown",
    "htmlbody", "textbody", "bodypreview", "snippet", "summary", "note", "notes",
    "description", "attachment", "attachments", "filecontent", "data", "value",
    "values", "document", "documents", "title", "label", "reason", "justification",
    "jsonbody", "payload", "input",
]);
const CREDENTIAL_KEYS = new Set([
    "authorization", "proxy-authorization", "cookie", "set-cookie", "password",
    "passwd", "secret", "clientsecret", "client_secret", "token", "accesstoken",
    "access_token", "refreshtoken", "refresh_token", "idtoken", "id_token", "apikey",
    "api_key", "x-api-key", "githubtoken", "sasurl", "uploadurl", "headers",
]);
// Every allowed argument key has an explicit value policy. Unknown keys,
// including unknown containers, are omitted before their children are inspected.
const ARG_POLICIES = new Map(Object.entries({
    entityurl: "path", entityurls: "paths", functionurl: "path",
    actionurl: "path", parenturl: "path", path: "path", url: "path",
    urls: "paths", endpoint: "path",
    method: "token", operationtype: "token", format: "token",
    strategy: "token", timezone: "token", scope: "token", source: "token",
    tool: "token", server: "token", consistencylevel: "token",
    top: "number", skip: "number", limit: "number", count: "boolean",
    $top: "number", $skip: "number", $count: "boolean",
    select: "selector", $select: "selector", orderby: "orderby",
    $orderby: "orderby", expand: "expand", $expand: "expand",
    filter: "filter", $filter: "filter", $search: "search",
    agentid: "identifier", conversationid: "identifier",
    requestid: "identifier", clientrequestid: "identifier",
    correlationid: "identifier",
    capabilities: "tokens",
    options: "container", parameters: "container", params: "container",
    request: "container", pagination: "container",
}));
const STRUCTURAL_SEGMENTS = new Set([
    "", "v1.0", "beta", "me", "users", "groups", "messages", "mailfolders",
    "childfolders", "attachments", "events", "calendar", "calendarview", "calendars",
    "drive", "drives", "items", "children", "content", "root", "sites", "lists",
    "columns", "fields", "workbook", "worksheets", "tables", "rows", "teams",
    "channels", "chats", "members", "planner", "tasks", "plans", "buckets",
    "sendmail", "cancel", "delta", "search", "$ref", "$value", "schema",
]);
const REQUEST_ID_KEYS = new Set([
    "requestid", "request_id", "clientrequestid", "client_request_id",
    "correlationid", "correlation_id", "traceid", "trace_id", "activityid",
    "activity_id", "batchid", "batch_id", "request-id", "client-request-id",
    "x-ms-request-id", "x-ms-correlation-request-id",
]);
const STATUS_KEYS = new Set([
    "status", "statuscode", "status_code", "httpstatus", "http_status", "httpstatuscode", "http_status_code",
]);
const CODE_KEYS = new Set(["code", "errorcode", "error_code", "subcode", "type"]);
const TIMING_KEYS = new Set([
    "duration", "durationms", "duration_ms", "elapsed", "elapsedms", "elapsed_ms",
    "retryafter", "retry_after", "retryafterseconds",
]);
const PROTOCOL_KEYS = new Set([
    "iserror", "is_error", "stoppedreason", "stopped_reason", "jsonrpc",
    "protocol", "transport", "outcome", "effectiveoutcome", "effective_outcome",
    "success", "ok", "mimetype", "mime_type",
]);
const PATH_KEYS = new Set(["path", "requestpath", "request_path", "url", "uri", "target"]);
const MESSAGE_KEYS = new Set(["message", "errormessage", "error_message", "detail", "details"]);
const ERROR_CONTAINER_KEYS = new Set(["error", "innererror", "inner_error", "cause"]);
const BATCH_KEYS = new Set(["operations", "responses", "errors", "batch", "batchstatuses", "batch_statuses"]);
const RESULT_BODY_KEYS = new Set([
    "data", "value", "values", "result", "contents", "markdown",
    "body", "subject", "messages", "text", "snippet", "retrievalhits",
    "retrieval_hits", "items", "documents",
]);
const DIAGNOSTIC_ENVELOPE_KEYS = new Set(["results", "content"]);

const KNOWN_ERROR_TEMPLATES = [
    ["access-denied", `${B}(?:access|permission)${S}+denied${B}`],
    ["parse-uri", `${B}(?:failed${S}+to${S}+parse|parse${S}+uri|invalid${S}+uri)${B}`],
    ["not-found", `${B}(?:not${S}+found|no${S}+schema)${B}`],
    ["internal-error", `${B}(?:internal|general)${S}+(?:server${S}+)?error${B}`],
    ["throttled", `${B}(?:too${S}+many${S}+requests|throttl|rate${S}+limit)[${W}]*${B}`],
    ["timeout", `${B}(?:timed?${S}*out|timeout)${B}`],
    ["unauthenticated", `${B}(?:unauthenticated|authentication${S}+failed)${B}`],
    ["no-client", `${B}no${S}+MCP${S}+client${S}+found${B}`],
    ["size-limit", `${B}(?:size${S}+limit|too${S}+large|exceeds?${S}+${D}+${S}*(?:MB|GB))${B}`],
    ["service-unavailable", `${B}(?:service|upstream)${S}+unavailable${B}`],
].map(([name, source]) => [name, new RegExp(source, "iu")]);
const MESSAGE_PATH = new RegExp(`(?<![${W}])/(?:[^${WS}"'|,;}]+)`, "u");

const isContainer = (value) => isDict(value) || isList(value);
const isEmptyish = (value) =>
    value === null || value === undefined || value === "" || (isList(value) && !value.length)
    || (isDict(value) && !Object.keys(value).length);
const intOrStr = (value) => isStr(value) || isInt(value) || isBool(value);
const get = (object, key) => (Object.hasOwn(object, key) ? object[key] : null);
const increment = (map, key, count = 1) => map.set(key, (map.get(key) ?? 0) + count);

function partition(value, separator) {
    const index = value.indexOf(separator);
    return index < 0 ? [value, "", ""] : [value.slice(0, index), separator, value.slice(index + separator.length)];
}

function rpartition(value, separator) {
    const index = value.lastIndexOf(separator);
    return index < 0 ? ["", "", value] : [value.slice(0, index), separator, value.slice(index + separator.length)];
}

// --- urllib.parse ports (Python 3.9 semantics) -----------------------------

const SCHEME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.";

function urlsplit(input) {
    let url = input.replace(/[\t\r\n]/g, "");
    let scheme = "";
    let netloc = "";
    let query = "";
    const colon = url.indexOf(":");
    if (colon > 0 && /^[A-Za-z]/.test(url) && [...url.slice(0, colon)].every((char) => SCHEME_CHARS.includes(char))) {
        scheme = url.slice(0, colon).toLowerCase();
        url = url.slice(colon + 1);
    }
    if (url.startsWith("//")) {
        let end = url.length;
        for (const char of "/?#") {
            const found = url.indexOf(char, 2);
            if (found >= 0) end = Math.min(end, found);
        }
        netloc = url.slice(2, end);
        url = url.slice(end);
        if (netloc.includes("[") !== netloc.includes("]")) throw new Error("Invalid IPv6 URL");
    }
    if (url.includes("#")) url = url.slice(0, url.indexOf("#"));
    if (url.includes("?")) [url, , query] = partition(url, "?");
    if (netloc && /[^\x00-\x7f]/.test(netloc)) {
        const plain = netloc.replace(/[@:#?]/g, "");
        const normalized = plain.normalize("NFKC");
        if (plain !== normalized && /[/?#@:]/.test(normalized)) {
            throw new Error(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
        }
    }
    let hostname = null;
    if (netloc) {
        const hostinfo = rpartition(netloc, "@")[2];
        const [, bracket, bracketed] = partition(hostinfo, "[");
        let host = bracket ? partition(bracketed, "]")[0] : partition(hostinfo, ":")[0];
        if (host) {
            const [name, percent, zone] = partition(host, "%");
            host = name.toLowerCase() + percent + zone;
            hostname = host;
        }
    }
    return { scheme, netloc, path: url, query, hostname };
}

const UTF8 = new TextDecoder("utf-8");

function unquote(value) {
    if (!value.includes("%")) return value;
    return value.replace(/[\x00-\x7f]+/g, (run) => {
        const bytes = [];
        for (let index = 0; index < run.length; index += 1) {
            if (run[index] === "%" && /^[0-9A-Fa-f]{2}$/.test(run.slice(index + 1, index + 3))) {
                bytes.push(parseInt(run.slice(index + 1, index + 3), 16));
                index += 2;
            } else bytes.push(run.charCodeAt(index));
        }
        return UTF8.decode(Uint8Array.from(bytes));
    });
}

function parseQsl(query) {
    const pairs = [];
    for (const part of query.split("&")) {
        if (!part) continue;
        const [name, separator, value] = partition(part, "=");
        pairs.push([unquote(name.replaceAll("+", " ")), separator ? unquote(value.replaceAll("+", " ")) : ""]);
    }
    return pairs;
}

const ODATA_PATTERNS = {
    comparison: new RegExp(`(${B}(?:eq|ne|gt|ge|lt|le)${S}+)(?!<redacted-literal>)([^${WS}()]+)`, "giu"),
    inList: new RegExp(`(${B}in${S}*)\\(([^)]*)\\)`, "giu"),
    textFunction: new RegExp(
        `(${B}(?:contains|startswith|endswith)${S}*\\(${S}*[A-Za-z_][A-Za-z0-9_./]*${S}*,${S}*)([^)]*)`, "giu",
    ),
    longToken: new RegExp(`${B}[A-Za-z0-9_\\-=]{24,}${B}`, "gu"),
    quoted: new RegExp(QUOTED, "gu"),
    functionArgument: new RegExp(`([,(]?${S}*[A-Za-z_][A-Za-z0-9_.]*${S}*=${S}*)([^,)]*)`, "gu"),
};

const DIGIT_LIKE = /^[\p{Nd}\u00B2\u00B3\u00B9\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2468\u2474-\u247C\u2488-\u2490\u24F5-\u24FD\u24EA\u24FF\u2776-\u277E\u2780-\u2788\u278A-\u2792\u1369-\u1371\u19DA]+$/u;

/** Stable, one-way, per-instance aliases. */
export class Pseudonymiser {
    constructor(salt = null) {
        this.salt = salt ? Buffer.from(salt) : randomBytes(32);
        this.map = new Map();
        this.counts = new Map();
    }

    alias(kind, value) {
        const key = JSON.stringify([kind, value]);
        if (!this.map.has(key)) {
            increment(this.counts, kind);
            const digest = createHmac("sha256", this.salt).update(value, "utf8").digest("hex").slice(0, 12);
            this.map.set(key, `<${kind}-${this.counts.get(kind)}:${digest}>`);
        }
        return this.map.get(key);
    }

    get distinct() {
        return Object.fromEntries(this.counts);
    }
}

/** Policy object shared by one bundle so aliases remain consistent. */
export class Redactor {
    constructor(profile = "internal", { maxErrorLen = 4000, salt = null } = {}) {
        if (!PROFILES.includes(profile)) throw new Error(`profile must be one of ${PROFILES.join(", ")}`);
        this.profile = profile;
        this.maxErrorLen = maxErrorLen;
        this.fired = new Map();
        this.classes = new Map();
        this.droppedFields = new Map();
        this.unknownDropped = new Map();
        this.pseudo = new Pseudonymiser(salt);
    }

    record(rule, cls, count = 1) {
        increment(this.fired, rule, count);
        this.classes.set(rule, cls);
    }

    drop(category, unknown = false) {
        increment(unknown ? this.unknownDropped : this.droppedFields, category);
        this.record(category, "content");
    }

    /** Keep an explicitly classified identifier internally; alias externally. */
    identifier(value, kind = "id") {
        if (isBool(value) || !(isStr(value) || isInt(value))) {
            this.drop("diagnostic.invalid-identifier");
            return PLACEHOLDER_CONTENT;
        }
        const text = pyStr(value);
        if (!text || cpLen(text) > 1024 || /[\x00-\x1f]/.test(text)) {
            this.drop("diagnostic.invalid-identifier");
            return PLACEHOLDER_CONTENT;
        }
        if (["request", "session_id", "call_id", "arg-id", "path-id"].includes(kind)
            && !(fullmatch("[A-Za-z0-9._:/+=@%!-]+", text) || fullmatch(ALIAS, text))) {
            this.drop("diagnostic.invalid-identifier");
            return PLACEHOLDER_CONTENT;
        }
        if (this.profile === "internal") return text;
        this.record(`identifier:${kind}`, "identifying");
        return this.pseudo.alias(kind, text);
    }

    substitute(text, pattern, replacement, rule, cls) {
        let count = 0;
        const out = text.replace(pattern, (...args) => {
            count += 1;
            return typeof replacement === "function" ? replacement(args[0])
                : replacement.replace("$1", args[1] ?? "");
        });
        if (count) this.record(rule, cls, count);
        return out;
    }

    /** Finite secret/identity scrub only; this is not a content classifier. */
    text(value) {
        if (!value) return value;
        let out = this.scrubSecrets(value);
        if (this.profile === "external") {
            out = this.substitute(out, EMAIL, (match) => this.identifier(match, "user"), "email", "identifying");
            out = this.substitute(out, GUID, (match) => this.identifier(match, "id"), "guid", "identifying");
            out = this.substitute(out, OPAQUE_ID, (match) => this.identifier(match, "opaque"), "opaque-id", "identifying");
            out = this.substitute(out, TENANT_HOST, (match) => this.identifier(match, "tenant-host"), "tenant-host",
                "identifying");
        }
        return out;
    }

    scrubSecrets(value) {
        let out = value;
        for (const [name, pattern, replacement] of SECRET_RULES) out = this.substitute(out, pattern, replacement, name, "secret");
        return out;
    }

    // -- arguments --------------------------------------------------------

    /** Project an argument tree through an explicit key/value allowlist. */
    args(value) {
        if (isDict(value)) {
            const output = Object.create(null);
            for (const [key, rawValue] of Object.entries(value)) {
                const leaf = key.toLowerCase();
                if (CREDENTIAL_KEYS.has(leaf)) {
                    this.drop("argument.credential");
                    continue;
                }
                if (CONTENT_KEYS.has(leaf)) {
                    this.drop("argument.content");
                    output[key] = PLACEHOLDER_CONTENT;
                    continue;
                }
                const policy = ARG_POLICIES.get(leaf);
                if (policy === undefined) {
                    this.drop("argument.unknown-key", true);
                    continue;
                }
                const projected = this.argumentValue(policy, rawValue);
                if (projected !== null) output[key] = projected;
            }
            return output;
        }
        if (isList(value)) return value.map((item) => (isDict(item) ? this.args(item) : PLACEHOLDER_CONTENT));
        this.drop("argument.unstructured-root");
        return PLACEHOLDER_CONTENT;
    }

    argumentValue(policy, value) {
        if (policy === "container") {
            const parsed = parseJsonString(value);
            if (isContainer(parsed)) return this.args(parsed);
            this.drop("argument.invalid-container");
            return PLACEHOLDER_CONTENT;
        }
        if (policy === "path") return this.path(value);
        if (policy === "paths") {
            if (!isList(value)) {
                this.drop("argument.invalid-path-list");
                return [];
            }
            return value.map((item) => this.path(item));
        }
        if (policy === "identifier") {
            if (intOrStr(value)) return this.identifier(value, "arg-id");
            this.drop("argument.invalid-identifier");
            return PLACEHOLDER_CONTENT;
        }
        if (["token", "selector", "orderby", "expand", "filter", "search"].includes(policy)) {
            if (!isStr(value)) {
                this.drop(`argument.invalid-${policy}`);
                return PLACEHOLDER_CONTENT;
            }
            if (policy === "token") return safeToken(value) ? value : PLACEHOLDER_CONTENT;
            if (policy === "selector") return selector(value);
            if (policy === "orderby") return orderby(value);
            if (policy === "expand") return this.expand(value);
            if (policy === "filter") return odataFilter(value);
            this.drop("argument.search-text");
            return PLACEHOLDER_CONTENT;
        }
        if (policy === "tokens") {
            if (isList(value)) return value.filter(safeToken);
            if (safeToken(value)) return value;
            this.drop("argument.invalid-token-list");
            return [];
        }
        if (policy === "number") {
            if (isNum(value)) return value;
            if (isStr(value) && fullmatch(`-?${D}+(?:\\.${D}+)?`, value)) return value;
            this.drop("argument.invalid-number");
            return null;
        }
        if (policy === "boolean") {
            if (isBool(value)) return value;
            if (isStr(value) && ["true", "false"].includes(value.toLowerCase())) return value.toLowerCase();
            this.drop("argument.invalid-boolean");
            return null;
        }
        throw new Error(`unknown argument policy: ${policy}`);
    }

    /** Project JSON arguments. Unparsed input never falls back to raw text. */
    argsString(raw) {
        if (!raw) return raw;
        let parsed;
        try {
            parsed = pyLoads(raw);
        } catch (error) {
            if (!(error instanceof JsonDecodeError)) throw error;
            this.drop("argument.unparsed");
            return pyDumps(PLACEHOLDER_CONTENT);
        }
        // Some hosts serialize arguments twice; decode a small bounded number of wrappers.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (!isStr(parsed) || !["{", "["].includes(pyLstrip(parsed).slice(0, 1))) break;
            try {
                parsed = pyLoads(parsed);
            } catch (error) {
                if (!(error instanceof JsonDecodeError)) throw error;
                this.drop("argument.unparsed");
                return pyDumps(PLACEHOLDER_CONTENT);
            }
        }
        return pyDumps(this.args(parsed), { ensureAscii: false, sortKeys: true });
    }

    expand(value, depth = 0) {
        if (depth >= 4) {
            this.drop("argument.expand-depth");
            return PLACEHOLDER_CONTENT;
        }
        try {
            const result = [];
            for (const part of odataParts(value, ",")) {
                const match = fullmatch("([A-Za-z_][A-Za-z0-9_./]*)(?:\\((.*)\\))?", part, "su");
                if (!match) throw new SyntaxError("unsupported expand expression");
                const [, name, inner] = match;
                if (inner === undefined) {
                    result.push(name);
                    continue;
                }
                const clauses = [];
                for (const clause of odataParts(inner, ";")) {
                    const [rawKey, separator, raw] = partition(clause, "=");
                    const key = pyStrip(rawKey).toLowerCase();
                    if (!separator) throw new SyntaxError("unsupported expand clause");
                    let safe;
                    if (key === "$filter") safe = odataFilter(raw);
                    else if (key === "$select") safe = selector(raw);
                    else if (key === "$orderby") safe = orderby(raw);
                    else if (key === "$expand") safe = this.expand(raw, depth + 1);
                    else if ((key === "$top" || key === "$skip") && fullmatch(`${D}+`, pyStrip(raw))) safe = pyStrip(raw);
                    else if (key === "$search") {
                        this.drop("argument.search-text");
                        safe = PLACEHOLDER_CONTENT;
                    } else throw new SyntaxError("unsupported expand clause");
                    clauses.push(`${key}=${safe}`);
                }
                result.push(`${name}(${clauses.join(";")})`);
            }
            return result.join(",");
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            this.drop("argument.invalid-expand");
            return PLACEHOLDER_CONTENT;
        }
    }

    path(raw) {
        if (!isStr(raw)) {
            this.drop("argument.invalid-path");
            return PLACEHOLDER_CONTENT;
        }
        const value = this.scrubSecrets(raw);
        const parsed = urlsplit(value);
        let prefix = "";
        let path;
        let query;
        if (parsed.scheme || parsed.netloc) {
            const scheme = ["http", "https"].includes(parsed.scheme) ? parsed.scheme : "https";
            // netloc includes credentials; rebuild from hostname and a numeric port.
            let host = parsed.hostname || "<redacted-host>";
            const portMatch = new RegExp(`:(${D}{1,5})$`, "u").exec(rpartition(parsed.netloc, "@")[2]);
            const port = portMatch ? `:${portMatch[1]}` : "";
            if (this.profile === "external" && host) host = this.identifier(host, "host");
            prefix = `${scheme}://${host}${port}`;
            ({ path, query } = parsed);
        } else {
            [path, , query] = partition(value, "?");
        }
        const safePath = path.split("/").map((segment) => this.pathSegment(segment)).join("/");
        const safeQuery = this.odataQuery(query);
        return prefix + safePath + (safeQuery ? `?${safeQuery}` : "");
    }

    pathSegment(raw) {
        let segment = unquote(raw);
        if (!segment) return "";
        segment = segment.replace(ODATA_PATTERNS.quoted, PLACEHOLDER_LITERAL);
        const base = partition(segment, "(")[0].toLowerCase();
        if (STRUCTURAL_SEGMENTS.has(base)) {
            if (segment.includes("(") && segment.endsWith(")")) {
                const [name, , rest] = partition(segment, "(");
                let argumentsText = rest.slice(0, -1);
                if (argumentsText.includes("=")) {
                    argumentsText = argumentsText.replace(ODATA_PATTERNS.functionArgument,
                        (_, lead) => lead + PLACEHOLDER_LITERAL);
                } else if (pyStrip(argumentsText)) argumentsText = PLACEHOLDER_LITERAL;
                return `${name}(${argumentsText})`;
            }
            return segment;
        }
        if (DIGIT_LIKE.test(segment)) return this.profile === "internal" ? segment : this.identifier(segment, "path-id");
        if (fullmatch(EMAIL_SOURCE, segment)) return this.profile === "internal" ? segment : this.identifier(segment, "user");
        const isIdentifier = fullmatch(GUID_SOURCE, segment, "iu") || fullmatch(OPAQUE_SOURCE, segment)
            || fullmatch("[A-Za-z0-9_\\-=]{24,}", segment);
        if (isIdentifier) return this.profile === "internal" ? segment : this.identifier(segment, "path-id");
        this.record("path-name", "content");
        if (this.profile === "external") return this.identifier(segment, "path");
        return "<redacted-path-name>";
    }

    odataQuery(query) {
        if (!query) return "";
        const output = [];
        for (const [key, value] of parseQsl(query)) {
            const lowered = key.toLowerCase();
            if (lowered === "$select") output.push([key, selector(value)]);
            else if (lowered === "$filter") output.push([key, odataFilter(value)]);
            else if (lowered === "$search") {
                this.drop("argument.search-text");
                output.push([key, PLACEHOLDER_CONTENT]);
            } else if (lowered === "$orderby") output.push([key, orderby(value)]);
            else if (lowered === "$expand") output.push([key, this.expand(value)]);
            else if ((lowered === "$top" || lowered === "$skip") && fullmatch(`${D}+`, value)) output.push([key, value]);
            else if (lowered === "$count" && ["true", "false"].includes(value.toLowerCase())) {
                output.push([key, value.toLowerCase()]);
            } else this.drop("argument.query-parameter", true);
        }
        return output.map(([key, value]) => `${key}=${value}`).join("&");
    }

    // -- diagnostic response/error projection ----------------------------

    /** Return only structured or known-template diagnostic evidence. */
    diagnostic(raw) {
        const parsed = parseJsonString(raw);
        if (isContainer(parsed)) {
            const projected = this.projectDiagnostic(parsed);
            if (isEmptyish(projected)) {
                this.drop("diagnostic.nondiagnostic-payload");
                return PLACEHOLDER_PAYLOAD;
            }
            return pyDumps(projected, { ensureAscii: false, sortKeys: true });
        }
        if (raw === null || raw === undefined || raw === "") return "";
        return this.knownMessage(pyStr(raw));
    }

    projectDiagnostic(value) {
        if (isList(value)) {
            return value.map((item) => this.projectDiagnostic(item)).filter((item) => !isEmptyish(item));
        }
        if (!isDict(value)) return null;
        const output = Object.create(null);
        for (const [key, rawValue] of Object.entries(value)) {
            const leaf = key.toLowerCase();
            let safe;
            if (RESULT_BODY_KEYS.has(leaf)) {
                this.drop("diagnostic.result-content");
                continue;
            }
            if (DIAGNOSTIC_ENVELOPE_KEYS.has(leaf)) safe = this.projectEnvelope(rawValue);
            else if (STATUS_KEYS.has(leaf)) safe = projectStatus(rawValue);
            else if (CODE_KEYS.has(leaf)) safe = projectCode(rawValue);
            else if (REQUEST_ID_KEYS.has(leaf)) safe = this.identifier(rawValue, "request");
            else if (TIMING_KEYS.has(leaf)) safe = isNum(rawValue) || isBool(rawValue) ? rawValue : null;
            else if (PROTOCOL_KEYS.has(leaf)) safe = projectProtocol(rawValue);
            else if (PATH_KEYS.has(leaf)) safe = this.path(rawValue);
            else if (MESSAGE_KEYS.has(leaf)) safe = this.knownMessage(pyStr(rawValue));
            else if (ERROR_CONTAINER_KEYS.has(leaf)) {
                const parsed = parseJsonString(rawValue);
                safe = isContainer(parsed) ? this.projectDiagnostic(parsed) : this.knownMessage(pyStr(parsed));
            } else if (BATCH_KEYS.has(leaf)) safe = this.projectDiagnostic(rawValue);
            else if (leaf === "headers") safe = this.diagnosticHeaders(rawValue);
            else {
                this.drop("diagnostic.unknown-field", true);
                continue;
            }
            if (!isEmptyish(safe)) output[key] = safe;
        }
        return output;
    }

    /** Extract diagnostics from WorkIQ results and MCP content wrappers. */
    projectEnvelope(value) {
        const parsed = parseJsonString(value);
        if (isList(parsed)) {
            return parsed.map((item) => this.projectEnvelope(item))
                .filter((item) => !isEmptyish(item) && item !== PLACEHOLDER_PAYLOAD);
        }
        if (isDict(parsed)) {
            const mime = Object.hasOwn(parsed, "mimeType") ? parsed.mimeType
                : Object.hasOwn(parsed, "mime_type") ? parsed.mime_type : get(parsed, "type");
            if (["application/json", "application/problem+json", "text/json", "text"].includes(mime)) {
                for (const payloadKey of ["text", "content", "body", "data", "value"]) {
                    if (!Object.hasOwn(parsed, payloadKey)) continue;
                    const payload = parseJsonString(parsed[payloadKey]);
                    if (isContainer(payload)) return { mime_type: mime, diagnostic: this.projectDiagnostic(payload) };
                    if (mime === "text") return { mime_type: mime, diagnostic: this.knownMessage(pyStr(payload)) };
                    this.drop("diagnostic.unparsed-envelope");
                    return null;
                }
            }
            return this.projectDiagnostic(parsed);
        }
        this.drop("diagnostic.unparsed-envelope");
        return null;
    }

    diagnosticHeaders(value) {
        if (!isDict(value)) {
            this.drop("diagnostic.headers");
            return {};
        }
        const output = Object.create(null);
        for (const [key, rawValue] of Object.entries(value)) {
            const leaf = key.toLowerCase();
            if (["request-id", "client-request-id", "x-ms-request-id", "x-ms-correlation-request-id"].includes(leaf)) {
                output[key] = this.identifier(rawValue, "request");
            } else if (["retry-after", "x-ms-retry-after-ms"].includes(leaf) && DIGIT_LIKE.test(pyStr(rawValue))) {
                output[key] = isInt(rawValue) ? Number(rawValue) : pyInt(pyStr(rawValue));
            } else this.drop("diagnostic.header");
        }
        return output;
    }

    knownMessage(message) {
        // The returned value is a canonical template, never the source prose.
        const scrubbed = this.scrubSecrets(message);
        for (const [name, pattern] of KNOWN_ERROR_TEMPLATES) {
            if (!pattern.test(scrubbed)) continue;
            const pathMatch = MESSAGE_PATH.exec(scrubbed);
            const suffix = pathMatch ? ` path=${this.path(pathMatch[0])}` : "";
            this.record(`diagnostic-template:${name}`, "diagnostic");
            return `<error-template:${name}>${suffix}`;
        }
        this.drop("diagnostic.unreviewed-prose");
        return PLACEHOLDER_PROSE;
    }

    // -- side inputs -------------------------------------------------------

    /** Include operator prose only after an explicit manual-review assertion. */
    narrative(text, reviewed = false) {
        if (!pyTruthy(text)) return "";
        if (!reviewed) {
            this.drop("narrative.unreviewed");
            return PLACEHOLDER_NARRATIVE;
        }
        this.record("narrative.reviewed", "manual-review");
        return this.text(pyStr(text));
    }

    /** Project operator metadata to a known typed environment schema. */
    environment(source) {
        if (!isDict(source)) throw new TypeError("environment must be a dictionary");
        const output = Object.create(null);
        const nullable = new Set([
            "collected_at", "collection_time", "host", "server", "os", "client", "transport", "auth_mode",
            "authmode", "tools", "tool_inventory", "source_offsets_seen", "sourceoffsetsseen", "identity", "tenant",
            "clock_skew_ms", "clockskewms", "local_offset", "localoffset",
        ]);
        for (const [key, value] of Object.entries(source)) {
            const leaf = key.toLowerCase();
            if (value === null && nullable.has(leaf)) {
                if (!["identity", "tenant"].includes(leaf) || this.profile === "internal") output[key] = null;
                else this.drop("environment.external-identity");
                continue;
            }
            if (["collected_at", "collection_time"].includes(leaf) && isStr(value)) {
                if (fullmatch(ISO_TIME, value)) output[key] = value;
                else if (!value) output[key] = null;
            } else if (["host", "server", "os", "client"].includes(leaf)) {
                const projected = this.environmentComponent(leaf, value);
                if (pyTruthy(projected)) output[key] = projected;
            } else if (["transport", "auth_mode", "authmode"].includes(leaf)) {
                if (isStr(value)) output[key] = safeToken(value) ? value : null;
            } else if (["tools", "tool_inventory"].includes(leaf)) {
                output[key] = this.environmentTools(value);
            } else if (["source_offsets_seen", "sourceoffsetsseen"].includes(leaf)) {
                if (isList(value)) {
                    output[key] = value.filter((item) => isStr(item)
                        && (fullmatch(OFFSET, item) || item === "none — timestamps assumed UTC"));
                }
            } else if (["identity", "tenant"].includes(leaf)) {
                if (this.profile === "internal") {
                    const projected = environmentIdentity(this, value);
                    if (!isEmptyish(projected)) output[key] = projected;
                } else this.drop("environment.external-identity");
            } else if (["clock_skew_ms", "clockskewms"].includes(leaf) && (isNum(value) || isBool(value))) {
                output[key] = value;
            } else if (["local_offset", "localoffset"].includes(leaf) && isStr(value)) {
                if (fullmatch(OFFSET, value)) output[key] = value;
            } else this.drop("environment.unknown-key", true);
        }
        return output;
    }

    environmentComponent(kind, value) {
        if (!isDict(value)) return {};
        const output = Object.create(null);
        const nullable = new Set([
            "name", "version", "build", "architecture", "platform", "endpoint", "url", "transport", "auth_mode",
            "authmode", "os",
        ]);
        for (const [key, item] of Object.entries(value)) {
            const leaf = key.toLowerCase();
            if (item === null && nullable.has(leaf)) {
                output[key] = null;
                continue;
            }
            if (leaf === "name" && isStr(item)) {
                if (!item) output[key] = null;
                else if (["host", "server"].includes(kind) && this.profile === "external" && item !== "unknown") {
                    output[key] = fullmatch(ALIAS, item) ? item : this.identifier(item, kind);
                } else if (safeToken(item)) output[key] = item;
            } else if (["version", "build", "architecture", "platform"].includes(leaf)) {
                if (isStr(item)) output[key] = safeVersion(item) ? item : null;
            } else if (["endpoint", "url"].includes(leaf) && isStr(item)) {
                output[key] = this.path(item);
            } else if (["transport", "auth_mode", "authmode"].includes(leaf)) {
                if (isStr(item)) output[key] = safeToken(item) ? item : null;
            } else if (leaf === "os") {
                if (safeToken(item)) output[key] = item;
                else if (isDict(item)) {
                    const safeOs = Object.create(null);
                    for (const osKey of ["name", "version", "architecture"]) {
                        const osValue = get(item, osKey);
                        const valid = osKey === "name" ? safeToken : safeVersion;
                        if (osValue === null) safeOs[osKey] = null;
                        else if (valid(osValue)) safeOs[osKey] = osValue;
                    }
                    output[key] = safeOs;
                }
            } else this.drop("environment.unknown-component-key", true);
        }
        return output;
    }

    environmentTools(value) {
        if (!isList(value)) return [];
        const output = [];
        for (const item of value) {
            if (safeToken(item)) output.push({ name: item });
            else if (isDict(item)) {
                const tool = Object.create(null);
                for (const [key, raw] of Object.entries(item)) {
                    if (!["name", "version", "schema_sha256"].includes(key)) {
                        this.drop("environment.unknown-tool-key", true);
                        continue;
                    }
                    if (raw === null) {
                        tool[key] = null;
                        continue;
                    }
                    if (key === "schema_sha256") {
                        if (isStr(raw) && /^[0-9a-fA-F]{64}$/.test(raw)) tool[key] = raw.toLowerCase();
                        continue;
                    }
                    if (isStr(raw)) tool[key] = (key === "name" ? safeToken : safeVersion)(raw) ? raw : null;
                }
                if (pyTruthy(get(tool, "name"))) output.push(tool);
            }
        }
        return output;
    }

    /** Project a probe record; result bodies never pass through. */
    probe(source) {
        const parsed = parseJsonString(source);
        if (isList(parsed)) return parsed.map((item) => this.probe(item)).filter((item) => !isEmptyish(item));
        if (!isDict(parsed)) return this.diagnostic(parsed);
        const output = Object.create(null);
        for (const [key, value] of Object.entries(parsed)) {
            const leaf = key.toLowerCase();
            if (["timestamp", "ts", "collected_at"].includes(leaf) && isStr(value)) {
                if (fullmatch(ISO_TIME, value)) output[key] = value;
            } else if (["tool", "name", "server", "method"].includes(leaf)) {
                if (safeToken(value)) output[key] = value;
            } else if (PROTOCOL_KEYS.has(leaf)) {
                const safe = projectProtocol(value);
                if (safe !== null) output[key] = safe;
            } else if (STATUS_KEYS.has(leaf) || CODE_KEYS.has(leaf) || REQUEST_ID_KEYS.has(leaf)) {
                const projected = this.projectDiagnostic({ [key]: value });
                Object.assign(output, projected);
            } else if (TIMING_KEYS.has(leaf) && (isNum(value) || isBool(value))) {
                output[key] = value;
            } else if (["error", "err", "diagnostic", "response", "result", "operations", "batch", "batchstatuses",
                "batch_statuses"].includes(leaf)) {
                const diagnostic = this.diagnostic(value);
                if (diagnostic !== "" && diagnostic !== PLACEHOLDER_PAYLOAD) {
                    output[key] = "[{".includes(diagnostic.slice(0, 1)) ? pyLoads(diagnostic) : diagnostic;
                }
            } else if (["read_only", "readonly", "replayed"].includes(leaf) && isBool(value)) {
                output[key] = value;
            } else this.drop("probe.unknown-field", true);
        }
        return output;
    }

    // -- report ------------------------------------------------------------

    report(verification = null) {
        const counted = (counter) => [...counter.keys()].sort(cmpStr).map((name) => `${name} (${counter.get(name)})`);
        return {
            profile: this.profile,
            rules_fired: [...this.fired.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([rule, hits]) => ({ rule, class: this.classes.get(rule) ?? "unknown", hits })),
            fields_dropped: counted(this.droppedFields),
            unknown_fields_dropped: counted(this.unknownDropped),
            pseudonyms: this.profile === "external" ? this.pseudo.distinct : {},
            salt_stored: false,
            semantic_redaction_certified: false,
            limitations: [
                "Finite scanners cannot establish that arbitrary prose is non-private.",
                "Unreviewed narrative and unknown structured fields are omitted fail-closed.",
                "Reviewed narrative records an operator assertion, not machine certification.",
            ],
            verification: verification || {
                ran: false,
                passed: false,
                findings: ["verification not run"],
                scope: "known secret patterns and external identity patterns",
            },
        };
    }
}

function parseJsonString(value) {
    if (!isStr(value)) return value;
    if (!["{", "["].includes(pyLstrip(value).slice(0, 1))) return value;
    try {
        return pyLoads(value);
    } catch (error) {
        if (error instanceof JsonDecodeError) return value;
        throw error;
    }
}

function selector(value) {
    const parts = value.split(",").map(pyStrip);
    const safe = parts.filter((part) => fullmatch("[A-Za-z_][A-Za-z0-9_./]*", part));
    return safe.length && safe.length === parts.length ? safe.join(",") : PLACEHOLDER_CONTENT;
}

function orderby(value) {
    const parts = value.split(",").map(pyStrip);
    const valid = parts.every((part) => fullmatch(`[A-Za-z_][A-Za-z0-9_./]*(?:${S}+(?:asc|desc))?`, part, "iu"));
    return valid ? parts.join(",") : PLACEHOLDER_CONTENT;
}

function odataParts(value, delimiter) {
    const parts = [];
    let start = 0;
    let depth = 0;
    let quote = null;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (quote) {
            if (char === quote) {
                if (value[index + 1] === quote) index += 1;
                else quote = null;
            }
        } else if (char === "'" || char === '"') quote = char;
        else if (char === "(") depth += 1;
        else if (char === ")") {
            depth -= 1;
            if (depth < 0) throw new SyntaxError("unbalanced OData clause");
        } else if (char === delimiter && depth === 0) {
            parts.push(pyStrip(value.slice(start, index)));
            start = index + 1;
        }
    }
    if (depth || quote) throw new SyntaxError("unbalanced OData clause");
    parts.push(pyStrip(value.slice(start)));
    return parts;
}

function odataFilter(value) {
    return value
        .replace(ODATA_PATTERNS.quoted, PLACEHOLDER_LITERAL)
        .replace(GUID, PLACEHOLDER_LITERAL)
        .replace(ODATA_PATTERNS.comparison, (_, lead) => lead + PLACEHOLDER_LITERAL)
        .replace(ODATA_PATTERNS.inList, (_, lead) => `${lead}(${PLACEHOLDER_LITERAL})`)
        .replace(ODATA_PATTERNS.textFunction, (_, lead) => lead + PLACEHOLDER_LITERAL)
        // Long bare tokens outside a recognized comparison are values, not property names.
        .replace(ODATA_PATTERNS.longToken, PLACEHOLDER_LITERAL);
}

function projectStatus(value) {
    if (isBool(value)) return null;
    if (isNum(value)) {
        const number = num(value);
        return number >= 100 && number <= 599 && Number.isFinite(number) && Number.isInteger(number) ? number : null;
    }
    const text = pyStr(value);
    if (fullmatch(`${D}{3}`, text) || ["ok", "fail", "failed", "error", "unknown", "success"].includes(text.toLowerCase())) {
        return text;
    }
    return null;
}

function projectCode(value) {
    if (isBool(value) || !(isStr(value) || isInt(value))) return null;
    const text = pyStr(value);
    return safeToken(text) || fullmatch(`-?${D}{1,10}`, text) ? text : null;
}

function projectProtocol(value) {
    if (isBool(value) || isNum(value)) return value;
    const text = pyStr(value);
    return safeToken(text) ? text : null;
}

function environmentIdentity(redactor, value) {
    if (isStr(value) || isInt(value) || isBool(value)) return value;
    if (!isDict(value)) return null;
    const allowed = new Set(["id", "tenantid", "tenant_id", "upn", "userprincipalname", "name", "object_id", "objectid",
        "region"]);
    const output = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
        if (allowed.has(key.toLowerCase()) && (isStr(item) || isInt(item) || isBool(item) || item === null)) {
            output[key] = item;
        } else redactor.drop("environment.unknown-identity-key", true);
    }
    return output;
}

function* verificationPatterns(profile) {
    for (const [name, pattern] of SECRET_RULES) yield [name, "secret", pattern];
    if (profile === "external") {
        yield ["email", "identifying", EMAIL];
        yield ["guid", "identifying", GUID];
        yield ["opaque-id", "identifying", OPAQUE_ID];
        yield ["tenant-host", "identifying", TENANT_HOST];
    }
}

/** Scan the exact supplied artifact strings for configured residue patterns. */
export function verify(texts, profile) {
    if (!PROFILES.includes(profile)) throw new Error(`profile must be one of ${PROFILES.join(", ")}`);
    const findings = [];
    for (const [filename, body] of Object.entries(texts)) {
        if (!isStr(body)) throw new TypeError("verification bodies must be strings");
        for (const [name, cls, pattern] of verificationPatterns(profile)) {
            for (const match of body.matchAll(pattern)) {
                const at = cpLen(body.slice(0, match.index));
                findings.push({ file: filename, rule: name, class: cls, at, excerpt: excerpt(body, at) });
            }
        }
    }
    return {
        ran: true,
        passed: !findings.length,
        findings,
        finding_count: findings.length,
        scope: "known secret patterns and external identity patterns; not semantic privacy certification",
    };
}

// Show pre-hit context without reproducing the detected value.
const excerpt = (body, at, span = 24) => `${cpSlice(body, Math.max(0, at - span), at)}<<<HIT>>>`;

