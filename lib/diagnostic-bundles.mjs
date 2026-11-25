import { lstat, mkdir, open, readFile, rename, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BoardError, resolveDataDir } from "./store.mjs";
import { buildBundle, bundleZip, InputError, RedactionGateError } from "./mcp-diagnostics/collect.mjs";
import { inspectBundle, BundleRefusedError } from "./mcp-diagnostics/inspect.mjs";

// WIRE owns saved MCP diagnostic bundles. They live in the private data folder under
// diagnostics/, beside an index that records what was saved. The zip and report.md are
// frozen at Save; audit results are a separate, mutable record per bundle.

export const AUDIT_VERDICTS = Object.freeze(["unclassified", "test-probe", "caller-error", "product-bug", "contract-gap",
    "by-design", "client-side", "infra-transient", "fixed-since", "not-reproduced-now"]);
const SCOPES = ["complete", "sample", "failures-only"];
const PROFILES = ["internal", "external"];
const BUNDLE_ID = /^mcp-diag-[a-z0-9][a-z0-9-]{0,47}-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const CLUSTER_ID = /^c-[0-9a-f]{24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ARCHIVE_BYTES = 66 * 1024 * 1024;
const MAX_REASONS = 3;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const rootFor = session => path.join(resolveDataDir(session), "diagnostics");
const fileNames = bundleId => ({ archive: `${bundleId}.zip`, report: `${bundleId}.md`, audit: `${bundleId}.audit.json` });

const queues = new Map();
async function serialized(root, work) {
    const previous = queues.get(root) ?? Promise.resolve();
    const next = previous.then(work, work);
    queues.set(root, next);
    try { return await next; } finally { if (queues.get(root) === next) queues.delete(root); }
}

function invalid(message = "Choose a supported diagnostic bundle request.") { return new BoardError(message, 422); }

function stringList(value, max, length = 1000) {
    return value === undefined || Array.isArray(value) && value.length <= max && new Set(value).size === value.length
        && value.every(item => typeof item === "string" && item.length > 0 && item.length <= length);
}

function bound(value) {
    return value === undefined || typeof value === "string" && value.length <= 64
        && (DAY.test(value) || Number.isFinite(Date.parse(value)));
}

function timeContextValid(value) {
    return value === undefined || value && typeof value === "object" && !Array.isArray(value)
        && typeof value.timeZone === "string" && value.timeZone.length <= 100
        && typeof value.locale === "string" && value.locale.length <= 80
        && Object.keys(value).every(key => ["timeZone", "locale", "timeZoneFallback", "localeFallback"].includes(key));
}

/** Validate a preview or save request. Returns the call filters and the bundle options. */
export function diagnosticBundleRequest(input, { save = false } = {}) {
    const allowed = ["from", "to", "timeContext", "tools", "sourceSessionIds", "captureScope", "profile", "verdicts", "reviewedNarrative",
        ...(save ? ["expected"] : [])];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw invalid();
    if (!bound(input.from) || !bound(input.to) || !stringList(input.tools, 50, 200) || !stringList(input.sourceSessionIds, 500)
        || !timeContextValid(input.timeContext)
        || input.captureScope !== undefined && !SCOPES.includes(input.captureScope)
        || input.profile !== undefined && !PROFILES.includes(input.profile)
        || input.reviewedNarrative !== undefined && typeof input.reviewedNarrative !== "boolean"
        || input.verdicts !== undefined && (!input.verdicts || typeof input.verdicts !== "object" || Array.isArray(input.verdicts))) {
        throw invalid("Choose dates, Work IQ tools, a capture scope and a profile WIRE supports.");
    }
    if (input.expected !== undefined && (!input.expected || typeof input.expected !== "object"
        || Object.keys(input.expected).sort().join() !== "calls,failures"
        || !Number.isSafeInteger(input.expected.calls) || !Number.isSafeInteger(input.expected.failures))) throw invalid();
    const filters = Object.fromEntries(["from", "to", "tools", "sourceSessionIds", "timeContext"]
        .filter(key => input[key] !== undefined && !(Array.isArray(input[key]) && !input[key].length)).map(key => [key, input[key]]));
    return { filters, captureScope: input.captureScope, profile: input.profile ?? "internal", verdicts: input.verdicts,
        reviewedNarrative: input.reviewedNarrative === true, expected: input.expected };
}

const percent = (part, whole) => whole ? `${Math.round(part / whole * 1000) / 10}%` : "0%";
const plural = (count, one, many = one + "s") => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

function templateReason(value) {
    const match = typeof value === "string" ? /<error-template:([a-z-]+)>/.exec(value) : null;
    return match ? { timeout: "Request timed out", "internal-error": "Internal server error" }[match[1]] ?? match[1].replaceAll("-", " ") : null;
}

// WIRE keeps a screened reason for each failed call; the bundle keeps codes and statuses only.
function clusterReasons(bundle, records) {
    const byCall = new Map(records.map(record => [record.call_id, record]));
    const frames = new Map();
    for (const line of (bundle.files["failures.jsonl"] ?? "").split("\n")) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        frames.set(frame.frame_id, byCall.get(frame.call_id));
    }
    const reasons = {}, paths = {};
    for (const cluster of bundle.summary.clusters) {
        let members = cluster.frame_ids.map(id => frames.get(id)).filter(Boolean);
        if (!members.length) {
            const codes = new Set(cluster.error_codes), statuses = new Set(cluster.status_codes.map(String));
            members = records.filter(record => record.outcome === "fail" && record.tool === cluster.tool
                && (!record.error?.code || codes.has(record.error.code))
                && (record.status_code == null ? !statuses.size : statuses.has(String(record.status_code))));
        }
        const messages = [...new Set(members.map(record => record.error?.message).filter(text => typeof text === "string" && text.trim())
            .map(text => text.trim().slice(0, 300)))].slice(0, MAX_REASONS);
        reasons[cluster.id] = messages;
        paths[cluster.id] = [...new Set(members.flatMap(record => record.args?.entityUrls ?? []).filter(value => typeof value === "string"))].sort().slice(0, 5);
    }
    return { reasons, paths };
}

function rateFacts(summary) {
    if (summary.volume.rate_available) return { available: true, failPct: summary.volume.fail_pct_of_all, explanation: "" };
    const scope = summary.capture_scope;
    const explanation = scope === "sample" ? "No failure rate: this bundle is a sample, so it doesn't claim to hold every call."
        : scope === "failures-only" ? "No failure rate: this bundle holds failed calls only."
        : summary.reconciliation.status === false ? "No failure rate: WIRE's call totals didn't match the calls in the bundle."
        : "No failure rate: WIRE doesn't keep the replies of successful calls, so it can't check them for failures hidden inside. The bundle reports counts only.";
    return { available: false, explanation };
}

function plainLimitations(summary, truncated) {
    const lines = [];
    const raw = summary.raw_volume;
    if (truncated || summary.source_integrity?.truncated) lines.push("This view has more than 5,000 calls. The bundle holds the first 5,000, so it can't be complete.");
    if (summary.payload_scan.missing_nonfailed_payloads) lines.push("Replies of successful calls aren't kept, so failures hidden inside a successful reply can't be found.");
    if (raw.host_outcomes.unknown) lines.push(`${plural(raw.host_outcomes.unknown, "call")} ${raw.host_outcomes.unknown === 1 ? "has" : "have"} no recorded result. They aren't counted as completed or failed.`);
    if (summary.limitations.redaction_losses.some(item => item.startsWith("diagnostic.unreviewed-prose"))) {
        lines.push("Error message text is left out of the bundle. Error codes and HTTP statuses stay.");
    }
    if (summary.limitations.not_visible.some(item => item.startsWith("request IDs"))) lines.push("Server request IDs aren't recorded. Match calls by chat, call ID and time.");
    if (summary.limitations.not_visible.some(item => item.startsWith("environment"))) lines.push("The Work IQ server version, transport and sign-in method aren't recorded.");
    if (summary.limitations.not_visible.some(item => item.includes("no timestamp"))) lines.push("Some calls have no recorded time.");
    lines.push("Counts cover only the Copilot app history WIRE has collected.");
    return lines;
}

function presentClusters(summary, { reasons = {}, paths = {} } = {}, audit = {}) {
    const failed = summary.raw_volume.host_outcomes.fail + summary.raw_volume.embedded_failure_calls;
    return summary.clusters.map(cluster => ({
        id: cluster.id, tool: cluster.tool, count: cluster.count, share: percent(cluster.count, failed),
        paths: cluster.paths?.length ? cluster.paths.slice(0, 5) : paths[cluster.id] ?? [], statusCodes: cluster.status_codes.map(String), errorCodes: cluster.error_codes,
        reasons: reasons[cluster.id]?.length ? reasons[cluster.id]
            : [templateReason(cluster.sample_error)].filter(Boolean),
        firstSeen: cluster.first_seen, lastSeen: cluster.last_seen, days: cluster.distinct_days, sessions: cluster.sessions?.length ?? 0,
        verdict: cluster.verdict,
        ...(audit[cluster.id] ? { audit: audit[cluster.id] } : {}),
    }));
}

function headline(summary) {
    const raw = summary.raw_volume, failed = raw.host_outcomes.fail, groups = summary.clusters.length;
    const text = `${failed.toLocaleString("en-US")} of ${plural(raw.calls, "Work IQ tool call")} failed`
        + (groups ? `, in ${plural(groups, "failure group")}.` : ".");
    return raw.host_outcomes.unknown ? `${text} ${plural(raw.host_outcomes.unknown, "more call")} ${raw.host_outcomes.unknown === 1 ? "has" : "have"} no recorded result.` : text;
}

function presentation(summary, { truncated = false, details, audit } = {}) {
    const raw = summary.raw_volume;
    return {
        headline: headline(summary),
        totals: { calls: raw.calls, failures: raw.host_outcomes.fail, completed: raw.host_outcomes.ok, unknown: raw.host_outcomes.unknown },
        observed: { from: summary.window.from ?? null, to: summary.window.to ?? null },
        captureScope: summary.capture_scope, profile: summary.profile,
        rate: rateFacts(summary),
        clusters: presentClusters(summary, details, audit),
        limitations: plainLimitations(summary, truncated),
    };
}

/** Build the bundle in memory from WIRE's diagnostic calls. Nothing is written. */
export function prepareDiagnosticBundle(calls, request, { now, nonce } = {}) {
    const eligible = calls.coverage?.complete === true;
    const captureScope = request.captureScope ?? (eligible ? "complete" : "sample");
    if (captureScope === "complete" && !eligible) {
        throw Object.assign(new BoardError("WIRE can't include every call in this view, so the bundle can't be complete. Choose sample.", 422),
            { code: "incomplete-capture" });
    }
    const records = captureScope === "failures-only" ? calls.records.filter(record => record.outcome === "fail") : calls.records;
    const base = { window: { from: request.filters.from ?? null, to: request.filters.to ?? null,
        timeZone: request.filters.timeContext?.timeZone ?? "UTC" }, requestedTools: request.filters.tools ?? [],
    completeEligible: eligible, captureScope, profile: request.profile,
    selection: { calls: calls.totals.calls, failures: calls.totals.hostFailures, unknown: calls.totals.unknown } };
    if (!records.length) return { empty: true, preview: { ...base, empty: true, tools: [] } };
    let bundle;
    try {
        bundle = buildBundle(records, {
            server: "workiq", org: "wire", adapter: "wire", collector: "wire", profile: request.profile, captureScope,
            ...(captureScope === "complete" ? { expectedCalls: calls.totals.calls, expectedFailures: calls.totals.hostFailures } : {}),
            ...(calls.coverage?.truncated ? { sourceTruncated: true } : {}),
            ...(request.verdicts ? { verdicts: request.verdicts } : {}), reviewedNarrative: request.reviewedNarrative,
            ...(now ? { now } : {}), ...(nonce ? { nonce } : {}),
        });
    } catch (error) {
        if (error instanceof RedactionGateError) throw Object.assign(new BoardError("The final privacy check found details that weren't removed, so WIRE won't package this bundle. Nothing was written.", 422), { code: "redaction-gate" });
        if (error instanceof InputError) throw new BoardError(error.message, 422);
        throw error;
    }
    const details = clusterReasons(bundle, records);
    const tools = [...new Set(records.map(record => record.tool))].sort();
    return { bundle, details, tools, preview: { ...base, tools, ...presentation(bundle.summary, { truncated: calls.coverage?.truncated, details }),
        report: bundle.report, warnings: bundle.warnings } };
}

// ---- storage ----

async function ensureRoot(root) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
}

async function readIndex(root) {
    let text;
    try { text = await readFile(path.join(root, "index.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, bundles: [], deleted: [] }; throw error; }
    let index;
    try { index = JSON.parse(text); } catch { index = null; }
    if (!index || index.schemaVersion !== 1 || !Array.isArray(index.bundles) || !Array.isArray(index.deleted)
        || index.bundles.some(entry => !BUNDLE_ID.test(entry?.bundleId))) {
        throw new BoardError("WIRE couldn't read its list of saved diagnostic bundles. The files were left unchanged.", 500);
    }
    return index;
}

async function writeAtomic(file, text) {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, file); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function writeExclusive(file, bytes) {
    const handle = await open(file, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function readOwned(root, name, maxBytes) {
    const file = path.join(root, name);
    let info;
    try { info = await lstat(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!info.isFile() || info.size > maxBytes) throw Object.assign(new BoardError("A file in this diagnostic bundle isn't a regular saved file, so WIRE won't open it.", 422), { code: "bundle-altered" });
    return readFile(file);
}

async function readAudit(root, bundleId) {
    const bytes = await readOwned(root, fileNames(bundleId).audit, 1024 * 1024);
    if (!bytes) return {};
    try {
        const value = JSON.parse(bytes.toString("utf8"));
        return value && value.schemaVersion === 1 && value.clusters && typeof value.clusters === "object" ? value.clusters : {};
    } catch { return {}; }
}

function publicEntry(entry, { available, audit = {} } = {}) {
    const { hashes, reasons, paths, clusterIds, ...rest } = entry;
    return { ...structuredClone(rest), clusterCount: clusterIds.length,
        reviewed: clusterIds.filter(id => audit[id] && audit[id].verdict !== "unclassified").length,
        ...(available === undefined ? {} : { available }) };
}

async function present(root, entry) {
    const names = fileNames(entry.bundleId);
    const found = await Promise.all([names.archive, names.report].map(name => lstat(path.join(root, name)).then(info => info.isFile(), () => false)));
    return publicEntry(entry, { available: found.every(Boolean), audit: await readAudit(root, entry.bundleId) });
}

export async function listDiagnosticBundles(session) {
    const root = rootFor(session);
    return serialized(root, async () => {
        const index = await readIndex(root);
        const bundles = await Promise.all(index.bundles.map(entry => present(root, entry)));
        return { bundles: bundles.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.bundleId.localeCompare(b.bundleId)) };
    });
}

/** Write a prepared bundle. Never overwrites; refuses a changed population. */
export async function saveDiagnosticBundle(session, calls, request, { now, nonce } = {}) {
    if (request.expected && (request.expected.calls !== calls.totals.calls || request.expected.failures !== calls.totals.hostFailures)) {
        throw Object.assign(new BoardError("The recorded calls changed after this preview. Review the new preview before saving. Nothing was written.", 409),
            { code: "diagnostic-preview-stale" });
    }
    const prepared = prepareDiagnosticBundle(calls, request, { now, nonce });
    if (prepared.empty) throw new BoardError("There are no Work IQ tool calls to package in this view. Nothing was written.", 422);
    const { bundle } = prepared;
    const root = rootFor(session);
    return serialized(root, async () => {
        await ensureRoot(root);
        const index = await readIndex(root);
        if (index.deleted.includes(bundle.bundleId) || index.bundles.some(entry => entry.bundleId === bundle.bundleId)) {
            throw new BoardError("This bundle identity is already saved or deleted. Nothing was written.", 409);
        }
        const names = fileNames(bundle.bundleId), zip = bundleZip(bundle), report = Buffer.from(bundle.report, "utf8");
        const written = [];
        try {
            await writeExclusive(path.join(root, names.archive), zip); written.push(names.archive);
            await writeExclusive(path.join(root, names.report), report); written.push(names.report);
            const preview = prepared.preview;
            const entry = {
                bundleId: bundle.bundleId, savedAt: bundle.summary.generated_at,
                window: preview.window, observed: preview.observed, tools: preview.tools,
                captureScope: preview.captureScope, profile: preview.profile, totals: preview.totals,
                rateAvailable: preview.rate.available, files: { archive: names.archive, report: names.report },
                hashes: { archive: sha256(zip), report: sha256(report) },
                clusterIds: bundle.summary.clusters.map(cluster => cluster.id), reasons: prepared.details.reasons, paths: prepared.details.paths,
            };
            await writeAtomic(path.join(root, "index.json"), JSON.stringify({ ...index, bundles: [...index.bundles, entry] }, null, 2));
            return { saved: true, bundle: publicEntry(entry, { available: true }),
                files: { archive: path.join(root, names.archive), report: path.join(root, names.report) } };
        } catch (error) {
            for (const name of written.reverse()) await unlink(path.join(root, name)).catch(() => {});
            if (error.code === "EEXIST") throw new BoardError("A file with this bundle's name already exists. Nothing was overwritten.", 409);
            throw error;
        }
    });
}

function findEntry(index, bundleId) {
    if (typeof bundleId !== "string" || !BUNDLE_ID.test(bundleId)) throw invalid("Choose a saved diagnostic bundle by its ID.");
    const entry = index.bundles.find(item => item.bundleId === bundleId);
    if (!entry) throw new BoardError("This diagnostic bundle is no longer saved.", 404);
    return entry;
}

const altered = detail => Object.assign(new BoardError(`This diagnostic bundle changed or is missing files since it was saved, so WIRE won't show it. ${detail}`, 422), { code: "bundle-altered" });

/** Verified Open: the zip and report.md must match what was saved. */
export async function openDiagnosticBundle(session, bundleId) {
    const root = rootFor(session);
    return serialized(root, async () => {
        const index = await readIndex(root);
        const entry = findEntry(index, bundleId);
        const zip = await readOwned(root, entry.files.archive, MAX_ARCHIVE_BYTES);
        const report = await readOwned(root, entry.files.report, 16 * 1024 * 1024);
        if (!zip) throw altered("The bundle zip is missing.");
        if (!report) throw altered("Its report.md is missing.");
        if (sha256(zip) !== entry.hashes.archive) throw altered("The bundle zip was modified.");
        if (sha256(report) !== entry.hashes.report) throw altered("Its report.md was modified.");
        let inspected;
        try { inspected = inspectBundle(zip); }
        catch (error) { if (error instanceof BundleRefusedError) throw altered(error.message); throw error; }
        if (inspected.summary.bundle_id !== entry.bundleId || inspected.manifest.checksums["report.md"] !== `sha256:${entry.hashes.report}`) {
            throw altered("Its report.md doesn't match the bundle.");
        }
        const audit = await readAudit(root, entry.bundleId);
        return {
            bundle: publicEntry(entry, { available: true, audit }),
            report: report.toString("utf8"),
            ...presentation(inspected.summary, { details: { reasons: entry.reasons, paths: entry.paths }, audit }),
            files: { archive: path.join(root, entry.files.archive), report: path.join(root, entry.files.report) },
        };
    });
}

/** Delete one bundle's files and index entry. Reports, drafts and activity are not touched. */
export async function deleteDiagnosticBundle(session, input) {
    if (!input || typeof input !== "object" || Object.keys(input).join() !== "bundleId") throw invalid("Choose one saved diagnostic bundle.");
    const root = rootFor(session);
    return serialized(root, async () => {
        const index = await readIndex(root);
        const entry = findEntry(index, input.bundleId), names = fileNames(entry.bundleId);
        for (const name of [names.archive, names.report, names.audit]) {
            const file = path.join(root, name);
            try {
                const info = await lstat(file);
                if (!info.isFile() && !info.isSymbolicLink()) throw new BoardError("A bundle file isn't a regular file. Nothing more was deleted.", 409);
                await unlink(file);
            } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        await writeAtomic(path.join(root, "index.json"), JSON.stringify({ ...index,
            bundles: index.bundles.filter(item => item.bundleId !== entry.bundleId),
            deleted: [...index.deleted, entry.bundleId] }, null, 2));
        return { deleted: true, bundleId: entry.bundleId };
    });
}

function workItemUrl(value) {
    if (value === undefined) return undefined;
    let url;
    try { url = new URL(value); } catch { url = null; }
    if (typeof value !== "string" || value.length > 2048 || !url || url.protocol !== "https:" || url.username || url.password) {
        throw invalid("Give the work item as an https link.");
    }
    return url.href;
}

/** Record a cluster's audit verdict and work item beside the frozen bundle. */
export async function recordDiagnosticAudit(session, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !["bundleId", "clusterId", "verdict", "workItemUrl", "note"].includes(key))) throw invalid();
    if (typeof input.clusterId !== "string" || !CLUSTER_ID.test(input.clusterId)) throw invalid("Choose a cluster by its stable ID (c-…).");
    if (!AUDIT_VERDICTS.includes(input.verdict)) throw invalid(`Choose a verdict: ${AUDIT_VERDICTS.join(", ")}.`);
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 500 || /[\u0000-\u0008\u000b-\u001f]/.test(input.note))) {
        throw invalid("Keep the note to 500 characters of plain text.");
    }
    const url = workItemUrl(input.workItemUrl);
    const root = rootFor(session);
    return serialized(root, async () => {
        const index = await readIndex(root);
        const entry = findEntry(index, input.bundleId);
        if (!entry.clusterIds.includes(input.clusterId)) throw new BoardError("That cluster isn't in this bundle.", 404);
        const clusters = await readAudit(root, entry.bundleId);
        const value = { verdict: input.verdict, ...(url ? { workItemUrl: url } : {}),
            ...(input.note?.trim() ? { note: input.note.trim() } : {}), recordedAt: new Date().toISOString() };
        clusters[input.clusterId] = value;
        await writeAtomic(path.join(root, fileNames(entry.bundleId).audit), JSON.stringify({ schemaVersion: 1, bundleId: entry.bundleId, clusters }, null, 2));
        return { recorded: true, bundleId: entry.bundleId, clusterId: input.clusterId, audit: value };
    });
}
