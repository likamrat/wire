// Port of the mcp-failure-audit skill's inspect_bundle.py: a read-only
// integrity and accounting preflight for schema-2 MCP diagnostic ZIPs. The
// archive is parsed in memory and never extracted.
import { readFileSync, statSync } from "node:fs";
import {
    JsonDecodeError, cluster, decodeUtf8, frameDiagnostic, isBool, isDict, isInt, isList, isNum, isStr, num, pyEq,
    pyLoads, pyRepr, pyRound, pySplitlines, pyStrip, pyTruthy, sha256Hex, sortStrings, toPlain,
} from "./cluster.mjs";
import { fromIsoformat } from "./collect.mjs";
import { DEFLATED, S_IFDIR, S_IFMT, S_IFREG, STORED, ZipError, listEntries, posixParts, readEntry } from "./zip.mjs";

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = MAX_TOTAL_BYTES + 1024 * 1024;
export const MAX_MEMBERS = 32;
export const REQUIRED = new Set([
    "README.md", "report.md", "summary.json", "manifest.json", "environment.json", "clusters.json", "failures.jsonl",
    "embedded.json", "coverage.json", "redaction-report.json",
]);
export const OPTIONAL = new Set(["probe-results.json", "controls.jsonl"]);
const VERDICTS = new Set([
    "unclassified", "test-probe", "caller-error", "product-bug", "contract-gap", "by-design", "client-side",
    "infra-transient", "fixed-since", "not-reproduced-now",
]);
const OUTCOMES = ["ok", "fail", "unknown"];

/** The bundle failed preflight (the Python reference raises ValueError). */
export class BundleRefusedError extends Error {
    constructor(message) {
        super(message);
        this.name = "BundleRefusedError";
    }
}

function require(condition, message) {
    if (!condition) throw new BundleRefusedError(message);
}

const get = (object, key, fallback = null) => (Object.hasOwn(object, key) ? object[key] : fallback);
const isCount = (value) => isInt(value) && Number(value) >= 0;
const setEquals = (left, right) => left.size === right.size && [...left].every((value) => right.has(value));

function count(value, label) {
    require(isCount(value), `Invalid count: ${label}`);
    return Number(value);
}

const decodeJson = (text) => pyLoads(text, {
    duplicates: "error",
    constants: "error",
    duplicateError: () => new BundleRefusedError("Duplicate JSON key"),
    constantError: () => new BundleRefusedError("Non-finite JSON number"),
});

const isStatus = (status) => status === null || (isInt(status) && status >= 100 && status <= 599);

function frameSchema(frame, expected) {
    require(isDict(frame), "Frame must be an object");
    require(isStr(get(frame, "frame_id")) && /^f-[0-9a-f]{24}$/.test(frame.frame_id), "Invalid frame ID format");
    require(OUTCOMES.includes(get(frame, "outcome")), "Invalid host outcome");
    require(get(frame, "effective_outcome") === expected, "Frame effective outcome mismatch");
    require(isStr(get(frame, "tool")) && Boolean(frame.tool), "Missing frame tool");
    require(isStr(get(frame, "error")) && isStr(get(frame, "args")), "Frame diagnostics and args must be strings");
    for (const key of ["session_id", "call_id", "server", "error_code"]) {
        require(get(frame, key) === null || isStr(frame[key]), `Invalid frame ${key}`);
    }
    for (const key of ["request_ids", "embedded_failure"]) {
        const values = get(frame, key);
        require(isList(values) && values.every((value) => isStr(value) && value)
            && new Set(values).size === values.length, `Invalid frame ${key}`);
    }
    require(isList(get(frame, "operations")) && frame.operations.every(isDict), "Invalid operations");
    for (const operation of frame.operations) {
        require(OUTCOMES.includes(get(operation, "outcome")), "Invalid operation outcome");
        const status = get(operation, "status_code");
        require(isStatus(status), "Invalid operation status");
        if (expected === "ok") {
            require(operation.outcome !== "fail" && !(pyTruthy(status) && status >= 400),
                "Successful control contains a failed operation");
        }
    }
    const status = get(frame, "status_code");
    require(isStatus(status), "Invalid frame status");
    const duration = get(frame, "duration_ms");
    require(duration === null || (isNum(duration) && num(duration) >= 0 && num(duration) <= 2 ** 63 - 1
        && Number.isFinite(num(duration))), "Invalid duration");
    if (expected === "ok") {
        require(frame.outcome !== "fail" && !(pyTruthy(status) && status >= 400),
            "Failed evidence cannot be a successful control");
    }
    const timestamp = get(frame, "ts");
    if (timestamp !== null) {
        require(isStr(timestamp) && timestamp.endsWith("Z"), "Timestamp must be UTC");
        const iso = `${timestamp.slice(0, -1)}+00:00`;
        if (!fromIsoformat(iso)) throw new BundleRefusedError(`Invalid isoformat string: ${pyRepr(iso)}`);
    }
    require(isBool(get(frame, "excluded_from_production")), "Missing exclusion disposition");
    require(pyEq(get(frame, "exclusion_reason"), frame.excluded_from_production ? "test-probe" : null),
        "Exclusion reason conflicts with disposition");
    if (expected === "ok") require(!frame.excluded_from_production, "A control cannot be excluded as a probe");
}

function readMembers(buffer, limits) {
    require(buffer.length <= limits.maxArchiveBytes, "Archive file exceeds size limit");
    const files = new Map();
    const roots = new Set();
    const seen = new Set();
    let total = 0;
    const members = listEntries(buffer);
    require(members.length <= limits.maxMembers, "Too many archive members");
    for (const info of members) {
        require(info.method === STORED || info.method === DEFLATED, "Unsupported archive compression");
        const { name } = info;
        require(!seen.has(name), "Duplicate archive member");
        seen.add(name);
        require(!name.includes("\\") && !name.includes(":") && !name.includes("\0"), "Unsafe archive member name");
        const { parts, absolute } = posixParts(name);
        require(!absolute && !parts.includes(".."), "Unsafe archive path");
        const kind = info.mode & S_IFMT;
        require([0, S_IFREG, S_IFDIR].includes(kind), "Unsupported archive member type");
        if (info.isDir) {
            require(parts.length === 1, "Unexpected archive directory");
            continue;
        }
        require(kind !== S_IFDIR, "File has directory attributes");
        require(parts.length === 2, "Expected one bundle root and a flat file set");
        const [root, leaf] = parts;
        require(REQUIRED.has(leaf) || OPTIONAL.has(leaf), "Unexpected archive file");
        require(!files.has(leaf), "Duplicate logical archive file");
        roots.add(root);
        require(info.size <= limits.maxFileBytes, "Archive file too large");
        total += info.size;
        require(total <= limits.maxTotalBytes, "Archive exceeds uncompressed size limit");
        require(!(info.flags & 1), "Encrypted archives are unsupported");
        const body = readEntry(buffer, info, { maxBytes: limits.maxFileBytes });
        require(body.length === info.size && body.length <= limits.maxFileBytes, "Archive size mismatch");
        files.set(leaf, body);
    }
    require(roots.size === 1, "Archive must have exactly one bundle root");
    require([...REQUIRED].every((name) => files.has(name)), "Missing required bundle files");
    return [[...roots][0], files];
}

function loadArchive(input, limits) {
    if (isStr(input)) {
        require(statSync(input).size <= limits.maxArchiveBytes, "Archive file exceeds size limit");
        return readFileSync(input);
    }
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

/**
 * Read-only preflight of a schema-2 bundle ZIP (path, Buffer or Uint8Array).
 * Returns { manifest, summary, files } or throws BundleRefusedError.
 * options.limits may override maxFileBytes, maxTotalBytes, maxArchiveBytes
 * and maxMembers.
 */
export function inspectBundle(input, { limits = {} } = {}) {
    const bounds = {
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
        maxMembers: MAX_MEMBERS,
        ...limits,
    };
    try {
        return inspect(loadArchive(input, bounds), bounds);
    } catch (error) {
        if (error instanceof BundleRefusedError) throw error;
        if (error instanceof ZipError || error instanceof JsonDecodeError || error.code === "ENOENT"
            || error.code === "EISDIR" || error.code === "EACCES") {
            throw new BundleRefusedError(error.message);
        }
        throw error;
    }
}

function inspect(buffer, limits) {
    const [root, files] = readMembers(buffer, limits);
    const text = new Map();
    for (const [name, body] of files) {
        const [decoded, at] = decodeUtf8(body);
        require(decoded !== null, `'utf-8' codec can't decode ${name} at byte ${at}`);
        text.set(name, decoded);
    }
    const manifest = decodeJson(text.get("manifest.json"));
    require(isDict(manifest), "Manifest must be an object");
    require(isInt(get(manifest, "schema_version")) && Number(manifest.schema_version) === 2,
        "Unsupported schema; regenerate legacy bundles");
    require(get(manifest, "bundle_id") === root, "Manifest/archive root mismatch");
    require(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(root), "Invalid bundle identifier");
    require(["internal", "external"].includes(get(manifest, "profile")), "Invalid profile");
    const hashes = get(manifest, "checksums");
    const emitted = new Set([...files.keys()].filter((name) => name !== "manifest.json"));
    require(isDict(hashes) && setEquals(new Set(Object.keys(hashes)), emitted),
        "Checksum inventory differs from emitted file set");
    for (const [name, expected] of Object.entries(hashes)) {
        require(expected === `sha256:${sha256Hex(files.get(name))}`, `Checksum mismatch: ${name}`);
    }

    const data = new Map();
    for (const [name, body] of text) if (name.endsWith(".json")) data.set(name, decodeJson(body));
    const summary = data.get("summary.json");
    const clusters = data.get("clusters.json");
    const coverage = data.get("coverage.json");
    const environment = data.get("environment.json");
    require(isDict(summary) && pyEq(get(summary, "schema_version"), 2), "Invalid summary schema");
    require(get(summary, "bundle_id") === root, "Summary/manifest identity mismatch");
    require(pyEq(get(summary, "profile"), manifest.profile), "Summary/manifest profile mismatch");
    require(isList(clusters) && clusters.every(isDict), "Clusters must be objects");
    require(isDict(coverage) && isDict(environment), "Invalid coverage/environment");
    require(pyEq(get(summary, "coverage"), coverage), "Summary/coverage mismatch");
    require(pyEq(get(summary, "environment"), environment), "Summary/environment mismatch");
    require(["complete", "failures-only", "sample"].includes(get(summary, "capture_scope")), "Invalid capture scope");
    for (const key of ["capture_scope", "window", "source_integrity", "reconciliation", "clustering"]) {
        require(pyEq(get(manifest, key), get(summary, key)), `Manifest/summary mismatch: ${key}`);
    }
    const clustering = get(summary, "clustering");
    require(isDict(clustering) && isInt(get(clustering, "engine_version")) && Number(clustering.engine_version) === 2
        && isInt(get(clustering, "opaque")) && clustering.opaque >= 1 && clustering.opaque <= 10000,
    "Unsupported clustering policy");
    const reconciliation = get(summary, "reconciliation");
    require(isDict(reconciliation), "Missing reconciliation");
    const reconciled = get(reconciliation, "status");
    require(reconciled === null || isBool(reconciled), "Invalid reconciliation state");
    require(get(manifest, "reconciled") === reconciled, "Reconciled flag mismatch");
    require(get(manifest, "truncated") === null || isBool(manifest.truncated), "Invalid truncation state");
    for (const flag of ["live_reproduction_performed", "permission_to_replay_or_write"]) {
        require(get(manifest, flag) === false && get(summary, flag) === false,
            "Bundle must not authorize actions or claim collection performed a live repro");
    }
    const omissions = get(manifest, "omitted");
    require(isList(omissions) && omissions.every(isDict), "Invalid omissions record");
    const omittedNames = omissions.map((item) => get(item, "file"));
    require(omittedNames.every(isStr) && new Set(omittedNames).size === omittedNames.length,
        "Invalid omitted file names");
    const missingOptional = new Set([...OPTIONAL].filter((name) => !files.has(name)));
    require(setEquals(new Set(omittedNames), missingOptional)
        && omissions.every((item) => isStr(get(item, "reason")) && item.reason), "Omissions differ from actual file set");

    const lines = (name) => pySplitlines(text.get(name) ?? "").filter((line) => pyStrip(line)).map(decodeJson);
    const frames = lines("failures.jsonl");
    for (const frame of frames) frameSchema(frame, "fail");
    const ids = frames.map((frame) => get(frame, "frame_id"));
    require(ids.every((id) => isStr(id) && id) && new Set(ids).size === ids.length, "Missing or duplicate failure frame IDs");
    require(frames.every((frame) => frame.effective_outcome === "fail"), "Failure corpus contains a nonfailure");
    const byId = new Map(ids.map((id, index) => [id, frames[index]]));
    const controls = lines("controls.jsonl");
    for (const frame of controls) frameSchema(frame, "ok");
    const controlIds = controls.map((frame) => frame.frame_id);
    require(new Set(controlIds).size === controlIds.length && !controlIds.some((id) => byId.has(id)),
        "Duplicate or overlapping control IDs");
    const controlById = new Map(controls.map((frame) => [frame.frame_id, frame]));
    const clusterIds = clusters.map((item) => get(item, "id"));
    require(clusterIds.every((id) => isStr(id) && /^c-[0-9a-f]{24}$/.test(id)) && new Set(clusterIds).size === clusterIds.length,
        "Invalid cluster IDs");
    const rows = frames.map((frame) => ({
        frame_id: frame.frame_id,
        tool: frame.tool,
        ts: get(frame, "ts") || "",
        session: get(frame, "session_id") || "",
        args: frame.args,
        err: frameDiagnostic(frame),
    }));
    const computed = new Map(cluster(rows, Number(clustering.opaque)).map((item) => [item.id, item]));
    require(setEquals(new Set(computed.keys()), new Set(clusterIds)), "Content-derived cluster identities differ");

    const assigned = [];
    const referencedControls = new Set();
    for (const item of clusters) {
        require(VERDICTS.has(get(item, "verdict")), "Invalid cluster verdict");
        require(["read", "write", "unknown-treat-as-write"].includes(get(item, "rw_class")), "Invalid read/write classification");
        const n = count(get(item, "count"), "cluster.count");
        const members = get(item, "frame_ids");
        require(isList(members) && members.length === n, "Cluster member count mismatch");
        require(members.every((id) => isStr(id) && byId.has(id)), "Unknown cluster member");
        require(members.every((id) => pyEq(get(byId.get(id), "tool"), get(item, "tool"))), "Cluster tool/member mismatch");
        const days = get(item, "day_counts");
        require(isDict(days), "Missing daily accounting");
        require(Object.values(days).every(isCount), "Invalid daily count");
        const dated = members.filter((id) => pyTruthy(get(byId.get(id), "ts"))).length;
        require(Object.values(days).reduce((total, value) => total + Number(value), 0) === dated,
            "Cluster daily counts do not reconcile");
        const actualDays = {};
        for (const id of members) {
            const ts = get(byId.get(id), "ts");
            if (!pyTruthy(ts)) continue;
            require(isStr(ts), "Invalid member timestamp");
            const day = [...ts].slice(0, 10).join("");
            actualDays[day] = (actualDays[day] ?? 0) + 1;
        }
        require(pyEq(days, actualDays), "Daily counts disagree with members");
        require(pyEq(get(item, "distinct_days"), Object.keys(actualDays).length), "Distinct-day count mismatch");
        const actual = computed.get(item.id);
        for (const key of ["tool", "signature", "count", "day_counts", "distinct_days", "undated_count", "first_seen",
            "last_seen"]) {
            require(pyEq(get(item, key), get(actual, key)), `Recomputed cluster mismatch: ${key}`);
        }
        require(setEquals(new Set(members), new Set(actual.frame_ids)), "Recomputed cluster membership mismatch");
        const excludedMembers = members.filter((id) => pyTruthy(byId.get(id).excluded_from_production));
        require(pyEq(get(item, "excluded_frame_ids"), excludedMembers)
            && pyEq(get(item, "adjusted_count"), n - excludedMembers.length), "Cluster probe-adjusted accounting mismatch");
        if (get(item, "verdict") === "test-probe") {
            require(excludedMembers.length === n, "Test-probe verdict lacks explicit member exclusions");
        }
        const evidence = get(item, "evidence", {});
        require(isDict(evidence), "Invalid evidence object");
        const track = get(item, "evidence_track");
        require([null, "A", "B"].includes(track), "Invalid evidence track");
        require(get(item, "evidence_verified") === false, "Offline evidence must remain unverified");
        if (track === "A") {
            const failingRefs = get(evidence, "failing_frame_ids");
            const controlRefs = get(evidence, "control_frame_ids");
            require(isList(failingRefs) && failingRefs.length > 0
                && failingRefs.every((id) => isStr(id) && members.includes(id)), "Unresolved failing evidence references");
            require(isList(controlRefs) && controlRefs.length > 0
                && controlRefs.every((id) => isStr(id) && controlById.has(id)), "Unresolved successful control references");
            for (const id of controlRefs) referencedControls.add(id);
        }
        assigned.push(...members);
    }
    require(pyEq(sortStrings(assigned), sortStrings(ids)), "Cluster membership does not partition failures");
    require(setEquals(referencedControls, new Set(controlIds)), "Published control set differs from evidence references");

    const embedded = data.get("embedded.json");
    require(isList(embedded) && embedded.every(isDict), "Invalid embedded failure records");
    const embeddedIds = embedded.map((frame) => get(frame, "frame_id"));
    require(embeddedIds.every((id) => isStr(id) && byId.has(id)) && new Set(embeddedIds).size === embeddedIds.length,
        "Invalid embedded overlap");
    require(embedded.every((frame) => pyEq(frame, byId.get(frame.frame_id))), "Embedded and failure records disagree");
    require(setEquals(new Set(embeddedIds), new Set(frames.filter((frame) => frame.outcome !== "fail").map((f) => f.frame_id))),
        "Embedded failure coverage mismatch");
    const summaryClusters = get(summary, "clusters");
    require(isList(summaryClusters), "Missing summary clusters");
    require(pyEq(summaryClusters, clusters), "Summary clusters must exactly mirror clusters.json");
    require(summaryClusters.every((item) => isDict(item) && isStr(get(item, "id"))), "Invalid summary cluster objects");
    require(setEquals(new Set(summaryClusters.map((item) => item.id)), new Set(clusterIds)), "Summary cluster identities differ");
    const sourceClusters = new Map(clusters.map((item) => [item.id, item]));
    for (const item of summaryClusters) {
        require(sourceClusters.has(item.id), "Unknown summary cluster");
        const actual = sourceClusters.get(item.id);
        require(Object.entries(item).every(([key, value]) => pyEq(get(actual, key), value)), "Summary/cluster value mismatch");
    }

    const volume = get(summary, "volume");
    require(isDict(volume), "Missing volume");
    for (const key of ["calls", ...OUTCOMES]) count(get(volume, key), `volume.${key}`);
    require(Number(volume.ok) + Number(volume.fail) + Number(volume.unknown) === Number(volume.calls),
        "Volume outcomes do not reconcile");
    const tools = get(coverage, "tools");
    require(isList(tools) && tools.every(isDict), "Missing per-tool coverage");
    for (const key of ["calls", ...OUTCOMES]) {
        const total = tools.reduce((acc, tool) => acc + count(get(tool, key), `coverage.${key}`), 0);
        require(total === Number(volume[key]), "Coverage/volume mismatch");
    }
    const adjustedFailures = frames.filter((frame) => !frame.excluded_from_production).length;
    require(Number(volume.fail) === adjustedFailures, "Probe-adjusted failure count mismatch");
    const raw = get(summary, "raw_volume");
    require(isDict(raw), "Missing raw volume");
    const rawCalls = count(get(raw, "calls"), "raw_volume.calls");
    for (const label of ["host_outcomes", "effective_outcomes"]) {
        const outcomes = get(raw, label);
        require(isDict(outcomes), "Missing raw outcome counts");
        const total = OUTCOMES.reduce((acc, key) => acc + count(get(outcomes, key), `${label}.${key}`), 0);
        require(total === rawCalls, "Raw outcomes do not reconcile");
    }
    require(Number(raw.effective_outcomes.fail) === frames.length, "Raw failure count mismatch");
    require(count(get(raw, "embedded_failure_calls"), "raw embedded calls") === embedded.length, "Embedded count mismatch");
    require(Number(raw.host_outcomes.fail) <= Number(raw.effective_outcomes.fail),
        "Host failures cannot become effective successes");
    const probeCount = frames.length - adjustedFailures;
    require(rawCalls - probeCount === Number(volume.calls), "Probe-adjusted total call count mismatch");
    require(pyEq(get(volume, "excluded_test_probe_calls"), probeCount), "Probe exclusion count mismatch");
    const counts = get(manifest, "counts");
    require(isDict(counts), "Missing manifest counts");
    require(pyEq(get(counts, "raw"), raw) && pyEq(get(counts, "production_adjusted"), volume)
        && count(get(counts, "clusters"), "manifest clusters") === clusters.length, "Manifest count mismatch");
    const limitations = get(summary, "limitations");
    require(isDict(limitations) && isDict(get(limitations, "excluded")), "Missing exclusion accounting");
    const excludedRows = Object.values(limitations.excluded).reduce((acc, value) => acc + count(value, "excluded"), 0);
    require(pyEq(get(counts, "excluded_rows"), excludedRows), "Manifest exclusion mismatch");
    const sourceIntegrity = get(summary, "source_integrity");
    require(isDict(sourceIntegrity), "Missing source integrity");
    for (const key of ["truncated", "retention_incomplete"]) require(isBool(get(sourceIntegrity, key)), "Invalid source-integrity flag");
    for (const key of ["unmatched_starts", "identical_duplicates", "malformed_rows"]) {
        count(get(sourceIntegrity, key), `source_integrity.${key}`);
    }
    require(pyEq(get(reconciliation, "observed_calls"), rawCalls)
        && pyEq(get(reconciliation, "observed_host_failures"), raw.host_outcomes.fail),
    "Reconciliation observed counts differ from raw volume");
    for (const key of ["expected_calls", "expected_host_failures"]) {
        if (get(reconciliation, key) !== null) count(reconciliation[key], `reconciliation.${key}`);
    }
    require((get(reconciliation, "expected_calls") === null) === (get(reconciliation, "expected_host_failures") === null),
        "Expected reconciliation counts must be supplied together");
    const complete = summary.capture_scope === "complete" && reconciled === true;
    const losses = ["truncated", "retention_incomplete", "unmatched_starts", "malformed_rows"]
        .some((key) => pyTruthy(get(sourceIntegrity, key)));
    if (reconciled === true) {
        require(!losses && pyEq(get(reconciliation, "expected_calls"), rawCalls)
            && pyEq(get(reconciliation, "expected_host_failures"), raw.host_outcomes.fail), "Unsupported reconciled claim");
    }
    const scan = get(summary, "payload_scan");
    require(isDict(scan), "Missing payload scan accounting");
    for (const key of ["scanned_calls", "missing_nonfailed_payloads", "inconclusive_calls"]) {
        count(get(scan, key), `payload_scan.${key}`);
    }
    require(Number(scan.inconclusive_calls) <= Number(scan.scanned_calls) && Number(scan.scanned_calls) <= rawCalls,
        "Scan counts exceed observed population");
    require(isBool(get(volume, "rate_available")), "Rate availability must be boolean");
    if (volume.rate_available) {
        require(complete && !losses && !pyTruthy(scan.missing_nonfailed_payloads) && !pyTruthy(scan.inconclusive_calls),
            "Rate claims unsupported completeness");
        const known = Number(volume.ok) + Number(volume.fail);
        const expectedKnown = known ? pyRound((100 * Number(volume.fail)) / known, 1) : null;
        const expectedAll = Number(volume.calls) ? pyRound((100 * Number(volume.fail)) / Number(volume.calls), 1) : null;
        require(pyEq(get(volume, "fail_pct_of_known"), expectedKnown) && pyEq(get(volume, "fail_pct_of_all"), expectedAll),
            "Rate arithmetic mismatch");
    } else {
        require(get(volume, "fail_pct_of_known") === null && get(volume, "fail_pct_of_all") === null,
            "Unavailable rates must be null");
    }
    const top = get(summary, "top_issues");
    require(isList(top) && top.length <= 5 && top.every(isDict), "Invalid top issues");
    require(new Set(top.map((issue) => get(issue, "cluster_id")).filter(isStr)).size === top.length,
        "Duplicate or invalid top issue IDs");
    for (const issue of top) {
        require(sourceClusters.has(get(issue, "cluster_id")), "Unknown top issue");
        const actual = sourceClusters.get(issue.cluster_id);
        require(pyEq(get(issue, "hits"), actual.count) && pyEq(get(issue, "tool"), actual.tool)
            && pyEq(get(issue, "verdict"), get(actual, "verdict")), "Top issue differs from cluster");
    }
    const expectedPredicates = new Map();
    for (const frame of embedded) {
        for (const predicate of frame.embedded_failure) {
            const key = JSON.stringify([predicate, frame.tool]);
            expectedPredicates.set(key, (expectedPredicates.get(key) ?? 0) + 1);
        }
    }
    const predicateTable = get(summary, "embedded_failures");
    require(isList(predicateTable) && predicateTable.every(isDict), "Invalid embedded predicate table");
    const actualPredicates = new Map();
    for (const row of predicateTable) {
        require(isStr(get(row, "predicate")) && isStr(get(row, "tool")), "Invalid embedded predicate");
        const key = JSON.stringify([row.predicate, row.tool]);
        require(!actualPredicates.has(key), "Duplicate predicate table entry");
        actualPredicates.set(key, count(get(row, "count"), "predicate.count"));
    }
    require(actualPredicates.size === expectedPredicates.size
        && [...expectedPredicates].every(([key, value]) => actualPredicates.get(key) === value),
    "Raw embedded predicate counts differ from frames");
    const redaction = data.get("redaction-report.json");
    require(isDict(redaction), "Invalid redaction report");
    const verification = get(redaction, "verification", {});
    require(isDict(verification), "Invalid verification record");
    require(get(verification, "ran") === true && get(verification, "passed") === true, "Redaction gate did not pass");
    require(!pyTruthy(get(verification, "findings")), "Redaction findings remain");
    return { manifest: toPlain(manifest), summary: toPlain(summary), files: sortStrings(files.keys()) };
}
