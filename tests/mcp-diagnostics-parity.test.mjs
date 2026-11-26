// Contributor-only parity checks against the Python reference skills. Skips
// when python3 or the installed skills are unavailable. Fixtures are invented.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    cluster, diagnosticAnalysis, frameDiagnostic, loadRows, normalise, pyDumps, pyLoads, strictLoads,
} from "../lib/mcp-diagnostics/cluster.mjs";
import { Redactor, verify } from "../lib/mcp-diagnostics/redact.mjs";
import { buildBundle, writeBundle } from "../lib/mcp-diagnostics/collect.mjs";
import { inspectBundle } from "../lib/mcp-diagnostics/inspect.mjs";

const SKILLS = process.env.MCP_DIAGNOSTICS_SKILLS_DIR ?? join(homedir(), ".copilot", "skills");
const BUNDLE = join(SKILLS, "mcp-diagnostic-bundle", "scripts");
const AUDIT = join(SKILLS, "mcp-failure-audit", "scripts");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const skip = !hasPython ? "python3 is unavailable"
    : !existsSync(join(BUNDLE, "collect_bundle.py")) || !existsSync(join(AUDIT, "inspect_bundle.py"))
        ? "the Python reference skills are not installed" : false;

const work = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".mcp-diagnostics-parity-"));
after(() => rmSync(work, { recursive: true, force: true }));

const J = JSON.stringify;
const NOW = new Date(Date.UTC(2026, 8, 10, 12));
const SALT = Buffer.alloc(32, 1);

function python(code, input = "", args = []) {
    const result = spawnSync("python3", ["-B", "-c", code, ...args], {
        input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function pythonJson(code, input) {
    const result = python(code, input);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

const PRELUDE = `
import sys, json
sys.path.insert(0, ${J(BUNDLE)})
import cluster_failures as engine, redact
redact.os.urandom = lambda n: b"\\x01" * n
`;

// Deterministic invented corpus covering envelopes, batches, Unicode, floats and secrets.
function corpus() {
    let seed = 20260905;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
    const guid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
    const opaque = () => `AAMkAG${hex(30)}XyZ`;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWludmVudGVk";
    const stamps = [
        (d) => `2026-09-0${d}T0${d}:15:00Z`, (d) => `2026-09-0${d}T10:00:00.250+02:00`,
        (d) => `0${d}/Sep/2026:09:30:00 +0200`, (d) => `2026-09-0${d} 23:59:59.5-0700`,
    ];
    const errors = [
        () => ({ statusCode: 403, code: "logicalPermissionAccessDenied",
            message: `Access denied for /me/drive/items/${opaque()}/children`, requestId: guid() }),
        () => `{"statusCode":500,"code":"generalException","message":"An internal error occurred","requestId":"${guid()}"}`
            + ` | Authorization: Bearer ${jwt}`,
        () => "No MCP client found for tool ID: workiq-create_entity",
        () => ({ statusCode: 429, code: "activityLimitReached", message: "Too many requests", requestId: guid(),
            retryAfter: 30 }),
        () => ({ results: [{ statusCode: 200, data: { body: "invented private body" } },
            { statusCode: 404, error: { code: "itemNotFound", message: "Not found", "request-id": `req-${hex(10)}` } }] }),
        () => `Ünïcödé failure ${"😀 ".repeat(120)}${guid()} statusCode: "503" token=${hex(20)}`,
        () => ({ isError: true, content: [{ type: "text", text: J({ statusCode: 401, code: "unauthenticated",
            message: "authentication failed for tolga@contoso.com" }) }] }),
    ];
    const results = [
        () => ({ ok: true, count: 3, error: null }),
        () => ({ markdown: "", resultCount: 0, retrievalHits: [], stoppedReason: "error" }),
        () => ({ isError: true, statusCode: 502, message: "upstream unavailable", requestId: guid() }),
        () => [{ status: 200 }, { status: 500, code: "serverError", requestId: `op-${hex(8)}` }],
        () => ({ content: [{ type: "text", text: `host result: ${J([{ status: 200 }, { status: 503 }])} trailing` }] }),
        () => ({ "application/vnd.ms-workiq.retrieval": { stoppedReason: "error", markdown: "invented", resultCount: 0 } }),
    ];
    const args = [
        () => ({ entityUrls: [`/me/messages/${opaque()}?$select=subject,from&$filter=subject eq 'Q3 invented'`] }),
        () => ({ functionUrl: "/me/calendarView(startDateTime='2026-08-01T00:00:00Z')?$select=subject", top: 5 }),
        () => ({ entityUrl: "https://alice:pw@contoso.sharepoint.com/sites/Finance/Plan.docx?$expand=fields($select=id)",
            query: "invented confidential search", password: "hunter2" }),
        () => J({ options: J({ top: 10, unknownNested: { body: "private" } }), requestId: guid() }),
    ];
    const lines = [];
    for (let index = 0; index < 140; index += 1) {
        const day = 1 + (index % 7);
        const fail = rand() < 0.5;
        const row = {
            timestamp: pick(stamps)(day),
            session_id: rand() < 0.9 ? `sess-${String(1 + Math.floor(rand() * 12)).padStart(3, "0")}` : undefined,
            tool_call_id: rand() < 0.85 ? `call_${index}` : undefined,
            name: pick(["workiq-fetch", "workiq-call_function", "workiq-ask", "workiq-retrieve", "workiq-do_action"]),
            arguments_json: J(pick(args)()),
            tool_complete_success: !fail,
            duration_ms: Math.floor(rand() * 9000),
        };
        if (fail) row.tool_complete_error_message = pick(errors)();
        else row.tool_complete_result_content = pick(results)();
        if (rand() < 0.1) row.request_ids = [`req-${hex(12)}`];
        lines.push(J(row));
    }
    lines.push(lines[3]);
    lines.push('{"ts":"2026-09-04T08:00:00Z","tool":"workiq-fetch","outcome":"fail","duration_ms":12.0,'
        + '"error":{"statusCode":500.0,"code":"generalException","inner":{"n":1e16}},"session_id":"s-float","call_id":"f1"}');
    lines.push('{"ts":"2026-09-04T08:00:00Z","tool":"kusto-query","server":"kusto","outcome":"fail","status_code":500}');
    return `${lines.join("\n")}\n`;
}

test("cluster engine parity: signatures, IDs, members and scans", { skip }, () => {
    const text = corpus();
    const extra = [
        '{"tool":"t","err":"{\\"a\\":1,\\"a\\":2}"}',
        '{"tool":"t","err":"plain ٥٠٣ status \\"status\\": \\"٥٠٣\\" <path-id-3:abcd1234> 2026-09-01 10:00:00Z"}',
        '{"tool":"t","err":"","status_code":"404","error_code":null,"operations":[{"outcome":"FAIL","diagnostic":"{}"}]}',
        '{"tool":"t","err":{"error":{"code":null,"path":true,"requestIds":[{"x":1},"r-1"]}}}',
    ].join("\n");
    const rows = `${text}${extra}\n`.split("\n").filter(Boolean).map((line) => {
        const row = strictLoads(line);
        return { ...row, tool: row.tool ?? row.name, err: row.err ?? row.tool_complete_error_message
            ?? row.tool_complete_result_content ?? "" };
    });
    const bodies = rows.map((row) => (typeof row.err === "string" ? row.err : J(row.err)));
    const js = pyDumps({
        clusters: [20, 28].map((opaque) => cluster(rows, opaque)),
        frames: rows.map((row) => frameDiagnostic(row)),
        normalised: bodies.map((body) => normalise(body)),
        analyses: bodies.flatMap((body) => [diagnosticAnalysis(body), diagnosticAnalysis(body, "error")]),
    }, { sortKeys: true });
    const py = pythonJson(`${PRELUDE}
rows = []
for line in sys.stdin.read().splitlines():
    if not line: continue
    row = engine._json_loads(line)
    row["tool"] = row.get("tool", row.get("name"))
    err = row.get("err", row.get("tool_complete_error_message", row.get("tool_complete_result_content", "")))
    row["err"] = err
    rows.append(row)
bodies = [r["err"] if isinstance(r["err"], str) else json.dumps(r["err"]) for r in rows]
print(json.dumps({
    "clusters": [engine.cluster(rows, opaque) for opaque in (20, 28)],
    "frames": [engine.frame_diagnostic(r) for r in rows],
    "normalised": [engine.normalise(b) for b in bodies],
    "analyses": [a for b in bodies for a in (engine.diagnostic_analysis(b), engine.diagnostic_analysis(b, "error"))],
}, sort_keys=True), end="")
`, `${text}${extra}\n`);
    if (js !== py) {
        const jsIds = JSON.parse(js).clusters[0].map((item) => item.id);
        const pyIds = JSON.parse(py).clusters[0].map((item) => item.id);
        assert.deepEqual(jsIds, pyIds, "cluster IDs differ");
    }
    assert.equal(js, py);

    const path = join(work, "rows.jsonl");
    writeFileSync(path, Buffer.concat([Buffer.from(`${text}{bad}\n42\n`), Buffer.from([0xff, 0x0a])]));
    const loaded = loadRows(readFileSync(path));
    const pyLoaded = JSON.parse(pythonJson(`${PRELUDE}
rows, bad, seen = engine.load(${J(path)})
print(json.dumps({"rows": rows, "bad": len(bad), "seen": sorted(seen)}, sort_keys=True))`));
    assert.equal(pyDumps({ rows: loaded.rows, bad: loaded.bad.length, seen: [...loaded.seenKeys].sort() }, { sortKeys: true }),
        pyDumps(pyLoads(J(pyLoaded)), { sortKeys: true }));
});

test("redaction parity: projections, aliases, report and gate findings", { skip }, () => {
    const operations = [
        ["args", J({ entityUrls: ["/me/messages/AAMkAGVeryRealOpaqueIdentifier123456789?$select=subject,from"
            + "&$filter=subject eq 'Q3 secret'&$search=\"layoffs\"&$top=5&$orderby=receivedDateTime desc&odd=1"],
        query: "confidential", password: "hunter2", options: J({ top: 10, limit: "7", count: "TRUE",
            unknownNested: { body: "private" } }), unknownPersonName: "Priya", capabilities: ["read", "bad token"] })],
        ["args", J(J({ entityUrl: "https://bob:pw@Contoso.SharePoint.com:8443/sites/HR/Doc%20One.docx?$expand="
            + "members($filter=startswith(name,'x');$top=2;$expand=owners($search=CustomerPlan))", requestId: 42 }))],
        ["args", "not json"],
        ["args", J(["x", { path: "/users/tolga@contoso.com/drive/root:/Plan.docx", method: "GET" }])],
        ["diagnostic", J({ statusCode: 403, code: "logicalPermissionAccessDenied",
            message: "Access denied for /me/messages/AAMkAGVeryRealOpaqueIdentifier123456789",
            requestId: "9f1c2b3d-4e5f-6071-8293-a4b5c6d7e8f9", subject: "CONFIDENTIAL", durationMs: 12.5,
            innerError: J({ code: 7, detail: "Too many requests; rate limit", "client-request-id": "abc" }),
            headers: { "retry-after": "30", "x-ms-request-id": "req-1", other: "x" }, isError: null })],
        ["diagnostic", '{"results":[{"statusCode":404.0,"error":{"code":"itemNotFound","message":"Not found"}},'
            + '{"statusCode":200,"value":[{"body":"private"}]}],"content":{"mimeType":"application/problem+json",'
            + '"body":"{\\"status\\":\\"503\\",\\"type\\":\\"upstream\\"}"}}'],
        ["diagnostic", "Request timed out after 30s at /me/events/AAMkAGabcdefghijklmnop1234 with Cookie: a=b"],
        ["diagnostic", "{broken"],
        ["probe", J([{ tool: "workiq-fetch", statusCode: 503, ts: "2026-09-05T12:00:00Z", result: { code: "x" },
            replayed: true, note: "private" }, "Access denied"])],
        ["environment", J({ collected_at: "2026-09-05T12:00:00Z", host: { name: "workstation-7", os: "macOS",
            version: "1.2.3" }, server: { name: "workiq", endpoint: "https://contoso.example/api/v1", url: null },
        identity: { upn: "tolga@contoso.com", secret: "x" }, tenant: null, tools: ["workiq-fetch",
            { name: "workiq-ask", version: "2.0", schema_sha256: "A".repeat(64), extra: 1 }],
        source_offsets_seen: ["+02:00", "bad"], clock_skew_ms: 1.5, local_offset: "-0700", mystery: 1 })],
        ["text", "mail tolga@contoso.com id 72f988bf-86f1-41af-91ab-2d7cd011db47 host fabrikam.onmicrosoft.com "
            + "AAMkAGabcdefghijklmnop sig=?sig=abc&sv=2021 Basic dXNlcjpwYXNzd29yZA== ghp_abcdefghijklmnop1234"],
        ["narrative", "Reviewed: escalate for tolga@contoso.com with api_key=12345"],
        ["identifier", "9f1c2b3d-4e5f-6071-8293-a4b5c6d7e8f9"],
        ["identifier", "has space"],
    ];
    const run = (profile) => {
        const redactor = new Redactor(profile, { salt: SALT });
        const outputs = operations.map(([operation, value]) => {
            const parsed = ["probe", "environment"].includes(operation) ? pyLoads(value) : value;
            if (operation === "args") return redactor.argsString(value);
            if (operation === "diagnostic") return redactor.diagnostic(value);
            if (operation === "probe") return redactor.probe(parsed);
            if (operation === "environment") return redactor.environment(parsed);
            if (operation === "text") return redactor.text(value);
            if (operation === "narrative") return redactor.narrative(value, true);
            return redactor.identifier(value, "request");
        });
        const dirty = { "a.md": `x ${operations[10][1]}\nAuthorization: Bearer abc.def.ghi 😀 tolga@contoso.com` };
        return pyDumps({ outputs, report: redactor.report(), gate: verify(dirty, profile) }, { sortKeys: true });
    };
    const py = pythonJson(`${PRELUDE}
ops = json.loads(sys.stdin.read())
out = {}
for profile in ("internal", "external"):
    r = redact.Redactor(profile)
    outputs = []
    for op, value in ops:
        if op == "args": outputs.append(r.args_string(value))
        elif op == "diagnostic": outputs.append(r.diagnostic(value))
        elif op == "probe": outputs.append(r.probe(json.loads(value)))
        elif op == "environment": outputs.append(r.environment(json.loads(value)))
        elif op == "text": outputs.append(r.text(value))
        elif op == "narrative": outputs.append(r.narrative(value, reviewed=True))
        else: outputs.append(r.identifier(value, "request"))
    dirty = {"a.md": "x " + ops[10][1] + "\\nAuthorization: Bearer abc.def.ghi \\U0001F600 tolga@contoso.com"}
    out[profile] = json.dumps({"outputs": outputs, "report": r.report(), "gate": redact.verify(dirty, profile)}, sort_keys=True)
print(json.dumps(out))`, J(operations));
    const expected = JSON.parse(py);
    for (const profile of ["internal", "external"]) assert.equal(run(profile), expected[profile], profile);
});

const DRIVER = `
import sys, datetime as real_dt, types
sys.path.insert(0, ${J(BUNDLE)})
import collect_bundle, redact
FIXED = real_dt.datetime(2026, 9, 10, 12, 0, 0, tzinfo=real_dt.timezone.utc)
class Fixed(real_dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED
shim = types.SimpleNamespace(**{k: getattr(real_dt, k) for k in dir(real_dt) if not k.startswith("__")})
shim.datetime = Fixed
collect_bundle.dt = shim
collect_bundle.secrets.token_hex = lambda n: "0123abcd"
redact.os.urandom = lambda n: b"\\x01" * n
sys.exit(collect_bundle.main(sys.argv[1:]))
`;

function pythonBundle(name, inputPath, options, { zip = false } = {}) {
    const out = join(work, `py-${name}`);
    const flags = ["--input", inputPath, "--out", out, "--collector", options.collector, "--org", options.org,
        "--profile", options.profile, "--capture-scope", options.captureScope ?? "sample"];
    if (options.server) flags.push("--server", options.server);
    if (options.expectedCalls !== undefined) {
        flags.push("--expected-calls", String(options.expectedCalls), "--expected-failures", String(options.expectedFailures));
    }
    if (options.assumeOffset) flags.push(`--assume-offset=${options.assumeOffset}`);
    if (options.allowPartial) flags.push("--allow-partial");
    if (options.sourceTruncated) flags.push("--source-truncated");
    if (options.reviewedNarrative) flags.push("--reviewed-narrative");
    if (options.opaque) flags.push("--opaque", String(options.opaque));
    for (const [key, flag] of [["verdicts", "--verdicts"], ["environment", "--environment"], ["probe", "--probe"]]) {
        if (options[key] === undefined) continue;
        const path = join(work, `${name}-${key}.json`);
        writeFileSync(path, J(options[key]));
        flags.push(flag, path);
    }
    if (options.notVisible) flags.push("--not-visible", ...options.notVisible);
    if (!zip) flags.push("--no-zip");
    const result = python(DRIVER, "", flags);
    assert.equal(result.status, 0, result.stderr);
    const [bundle] = readdirSync(out).filter((entry) => !entry.endsWith(".zip"));
    return { dir: join(out, bundle), zip: zip ? join(out, `${bundle}.zip`) : null };
}

test("collector parity: every artifact is byte-identical to collect_bundle.py", { skip }, () => {
    const corpusPath = join(work, "corpus.jsonl");
    writeFileSync(corpusPath, corpus());
    const base = { server: "workiq", collector: "tester", org: "contoso", allowPartial: true };
    const clustersFor = (profile) => buildBundle(readFileSync(corpusPath),
        { ...base, profile, now: NOW, nonce: "0123abcd", salt: SALT }).summary.clusters;
    const [top, second] = clustersFor("external");
    const [chronic] = clustersFor("internal").filter((item) => item.distinct_days >= 3);
    const scenarios = [
        ["internal-sample", { ...base, profile: "internal" }],
        ["external-complete", { ...base, profile: "external", captureScope: "complete", expectedCalls: 140,
            expectedFailures: 60, sourceTruncated: true, opaque: 28 }],
        ["external-verdicts", { ...base, profile: "external", reviewedNarrative: true, notVisible: ["hook timing for x@y.com"],
            verdicts: { schema_version: 2, headline: "Reviewed headline | *bold* tolga@contoso.com", top_issues: [second.id, top.id],
                probe_frame_ids: [second.frame_ids[0]],
                asks: [{ cluster_id: top.id, ask: "Fix it", impact: "High", severity: "S2" }],
                our_actions: [{ cluster_id: second.id, kind: "retry", owner: "caller", action: "Back off" }],
                clusters: { [top.id]: { verdict: "product-bug", rw_class: "read", mechanism: "Invented mechanism",
                    reproduction_disposition: "inconclusive" }, [second.id]: { verdict: "caller-error" } } },
            environment: { host: { name: "copilot-cli", version: "1.0.3", os: { name: "macOS", version: "15.6" } },
                server: { name: "workiq", version: "2.0", transport: "stdio" }, tools: ["workiq-fetch", "workiq-never"],
                local_offset: "-07:00", identity: { upn: "tolga@contoso.com" } },
            probe: { tool: "workiq-fetch", statusCode: 503, result: { code: "upstreamUnavailable", subject: "private" } } }],
        ["internal-unverified-narrative", { ...base, profile: "internal",
            verdicts: { schema_version: 2, headline: "Unreviewed", clusters: { [chronic.id]: { verdict: "by-design",
                evidence_track: "B", reproduction_disposition: "not-reproduced-now", mechanism: "Unreviewed prose" } },
            probe_frame_ids: [chronic.frame_ids[0]] } }],
    ];
    for (const [name, options] of scenarios) {
        const js = buildBundle(readFileSync(corpusPath), { ...options, now: NOW, nonce: "0123abcd", salt: SALT });
        const { dir } = pythonBundle(name, corpusPath, options);
        const names = readdirSync(dir).sort();
        assert.deepEqual(Object.keys(js.files).sort(), names, name);
        for (const file of names) assert.equal(js.files[file], readFileSync(join(dir, file), "utf8"), `${name}: ${file}`);
    }
    const fixturePath = join(work, "make-fixture.jsonl");
    const generated = python(`import runpy, sys; sys.argv = ["make_fixture"]
runpy.run_path(${J(join(BUNDLE, "make_fixture.py"))}, run_name="__main__")`);
    assert.equal(generated.status, 0, generated.stderr);
    writeFileSync(fixturePath, generated.stdout);
    for (const profile of ["internal", "external"]) {
        const options = { server: "workiq", collector: "tester", org: "contoso", profile, captureScope: "complete",
            expectedCalls: 500, expectedFailures: 91 };
        const js = buildBundle(readFileSync(fixturePath), { ...options, now: NOW, nonce: "0123abcd", salt: SALT });
        const { dir } = pythonBundle(`fixture-${profile}`, fixturePath, options);
        for (const file of readdirSync(dir)) assert.equal(js.files[file], readFileSync(join(dir, file), "utf8"), file);
    }
    const naivePath = join(work, "naive.jsonl");
    writeFileSync(naivePath, [
        J({ ts: "2026-09-05 09:30:00", tool: "workiq-fetch", outcome: "fail", error: "Request timed out" }),
        J({ ts: "2026-09-05 09:31:00.250", tool: "workiq-fetch", outcome: "ok", result: { ok: true } }),
    ].join("\n"));
    const naive = { server: "workiq", collector: "tester", org: "unknown", profile: "internal", assumeOffset: "-07:00" };
    const js = buildBundle(readFileSync(naivePath), { ...naive, now: NOW, nonce: "0123abcd" });
    const { dir } = pythonBundle("naive", naivePath, naive);
    for (const file of readdirSync(dir)) assert.equal(js.files[file], readFileSync(join(dir, file), "utf8"), `naive: ${file}`);
});

test("inspect parity: each implementation accepts the other's archives and refuses tampering", { skip }, () => {
    const corpusPath = join(work, "inspect-corpus.jsonl");
    writeFileSync(corpusPath, corpus());
    const options = { server: "workiq", collector: "tester", org: "contoso", profile: "external", allowPartial: true };
    const inspectPy = (path) => python(`import sys; sys.argv = ["inspect", ${J(path)}]; sys.path.insert(0, ${J(AUDIT)})
import runpy; runpy.run_path(${J(join(AUDIT, "inspect_bundle.py"))}, run_name="__main__")`);

    const built = buildBundle(readFileSync(corpusPath), options);
    const jsZip = writeBundle(built, join(work, "js-archives"));
    assert.equal(inspectPy(jsZip).status, 0, inspectPy(jsZip).stderr);
    assert.equal(inspectBundle(jsZip).manifest.bundle_id, built.bundleId);

    const { zip: pyZip } = pythonBundle("inspect", corpusPath, options, { zip: true });
    assert.equal(inspectPy(pyZip).status, 0);
    assert.equal(inspectBundle(pyZip).summary.volume.calls, built.summary.volume.calls);

    const tampered = { ...built, files: { ...built.files, "report.md": `${built.files["report.md"]}\nedited` },
        bundleId: built.bundleId.replace(/[0-9a-f]{8}$/, "ffffffff") };
    tampered.archiveName = `${tampered.bundleId}.zip`;
    const tamperedZip = writeBundle(tampered, join(work, "js-archives"));
    const pyRefusal = inspectPy(tamperedZip);
    assert.equal(pyRefusal.status, 2);
    assert.throws(() => inspectBundle(tamperedZip), /Manifest\/archive root mismatch|Checksum mismatch/);
    assert.match(pyRefusal.stderr, /Bundle refused/);
});
