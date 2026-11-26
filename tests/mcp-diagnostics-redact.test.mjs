import test from "node:test";
import assert from "node:assert/strict";
import {
    PLACEHOLDER_CONTENT, PLACEHOLDER_NARRATIVE, PLACEHOLDER_PROSE, Redactor, verify,
} from "../lib/mcp-diagnostics/redact.mjs";

const J = JSON.stringify;
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ."
    + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const REQUEST_ID = "9f1c2b3d-4e5f-6071-8293-a4b5c6d7e8f9";

test("case-sensitive identifiers keep distinct, stable external aliases", () => {
    const redactor = new Redactor("external");
    const upper = redactor.identifier("AAMkAGCaseSensitiveResource123456", "path-id");
    const lower = redactor.identifier("AAMkAGcaseSensitiveResource123456", "path-id");
    assert.notEqual(upper, lower);
    assert.equal(redactor.identifier("AAMkAGCaseSensitiveResource123456", "path-id"), upper);
    assert.match(upper, /^<path-id-1:[0-9a-f]{12}>$/);
    assert.equal(new Redactor("external", { salt: Buffer.alloc(32, 7) }).identifier("x", "id"),
        new Redactor("external", { salt: Buffer.alloc(32, 7) }).identifier("x", "id"));
});

test("external environment cannot restore an unaliased server name", () => {
    const redactor = new Redactor("external");
    const label = "private-customer-mcp";
    const expected = redactor.identifier(label, "server");
    const projected = redactor.environment({ server: { name: label, version: "1.0" } });
    assert.equal(projected.server.name, expected);
    assert.ok(!J(projected).includes(label));
    assert.equal(redactor.environment({ server: { name: expected } }).server.name, expected);
});

test("nested $expand never preserves filter or search literals", () => {
    for (const profile of ["internal", "external"]) {
        const safe = new Redactor(profile).argsString(J({
            entityUrl: "/groups?$expand=members($filter=displayName eq ProjectORCHID;$select=id;"
                + "$expand=owners($search=CustomerPlan))",
        }));
        assert.ok(!safe.includes("ProjectORCHID") && !safe.includes("CustomerPlan"));
        assert.ok(safe.includes("$select=id"));
        assert.ok(safe.includes("$filter=displayName eq <redacted-literal>"));
        assert.ok(verify({ "args.json": safe }, profile).passed);
    }
});

test("structured identifier values and invalid scalar diagnostics are omitted", () => {
    for (const profile of ["internal", "external"]) {
        const safe = new Redactor(profile).diagnostic({
            statusCode: 500, requestId: { note: "Project ORCHID customer escalation" },
            headers: { "client-request-id": ["PrivatePlan"] },
        });
        assert.ok(!safe.includes("ORCHID") && !safe.includes("PrivatePlan") && safe.includes("500"));
    }
    const redactor = new Redactor();
    for (const value of ["true", "500.5", "NaN", "Infinity", '{"private": "text"}']) {
        const safe = redactor.diagnostic(`{"statusCode": ${value}, "code": {"private": "text"}}`);
        for (const residue of ["NaN", "Infinity", "private", "true"]) assert.ok(!safe.includes(residue), `${value}: ${safe}`);
    }
});

test("unknown argument keys, content and credentials fail closed", () => {
    const redactor = new Redactor("internal");
    const safe = redactor.argsString(J({
        query: "planned layoffs", password: "hunter2", unknownShort: "Priya", unknownContainer: { statusCode: 418 },
        options: J({ top: 5, unknownNested: { body: "private" } }),
        entityUrl: "/me/messages/AAMkAGVeryRealIdentifier123456789?$select=subject&$filter=subject eq confidential"
            + '&$search="private plan"',
    }));
    for (const residue of ["planned layoffs", "hunter2", "unknownShort", "unknownContainer", "unknownNested"]) {
        assert.ok(!safe.includes(residue), residue);
    }
    for (const kept of ['"top": 5', "$select=subject", "$filter=subject eq <redacted-literal>", "$search=<redacted-content>"]) {
        assert.ok(safe.includes(kept), kept);
    }
    const report = redactor.report();
    assert.ok(report.unknown_fields_dropped.some((item) => item.startsWith("argument.unknown-key")));
    assert.ok(!report.unknown_fields_dropped.some((item) => item.includes("unknownShort")));
    const unparsed = new Redactor().argsString("query=private merger&password=hunter2");
    assert.equal(JSON.parse(unparsed), PLACEHOLDER_CONTENT);
});

test("diagnostic projection keeps only status, codes, request IDs and known templates", () => {
    const safe = new Redactor("internal").diagnostic(J({
        statusCode: 403, code: "logicalPermissionAccessDenied", requestId: REQUEST_ID,
        message: "Access denied for /me/messages/AAMkAGVeryRealIdentifier123456789",
        subject: "Board layoffs discussion", markdown: "Private document body", value: [{ subject: "another secret" }],
        innerError: { requestId: REQUEST_ID, detail: "customer codename ORCHID" },
    }));
    assert.ok(safe.includes('"statusCode": 403') && safe.includes("logicalPermissionAccessDenied"));
    assert.equal(safe.split(REQUEST_ID).length - 1, 2);
    assert.ok(safe.includes("<error-template:access-denied>") && safe.includes(PLACEHOLDER_PROSE));
    for (const residue of ["Board layoffs", "Private document", "another secret", "ORCHID"]) assert.ok(!safe.includes(residue));
    const scalar = new Redactor().diagnostic({ statusCode: 403, error: "Access denied for /me/messages/AAMkAGIdentifier123456789" });
    assert.ok(scalar.includes("<error-template:access-denied>") && !scalar.includes("None"));
});

test("WorkIQ result arrays and MCP content envelopes are projected", () => {
    const redactor = new Redactor("internal");
    const workiq = redactor.diagnostic({ results: [
        { statusCode: 404, error: { code: "itemNotFound", message: "Not found", "request-id": "req-operation-123" },
            data: { subject: "Private meeting" } },
        { statusCode: 200, value: [{ body: "Successful private result" }] },
    ] });
    assert.ok(workiq.includes('"statusCode": 404') && workiq.includes('"statusCode": 200'));
    assert.ok(workiq.includes("itemNotFound") && workiq.includes("req-operation-123"));
    assert.ok(!workiq.includes("Private meeting") && !workiq.includes("Successful private result"));
    const mcp = redactor.diagnostic({ content: [{ type: "text", text: J({
        statusCode: 429, code: "activityLimitReached", "client-request-id": "req-operation-123",
        markdown: "Private response text" }) }] });
    assert.ok(mcp.includes('"mime_type": "text"') && mcp.includes("activityLimitReached"));
    assert.ok(!mcp.includes("Private response text"));
    const mime = redactor.diagnostic({ content: { mimeType: "application/json",
        value: J({ statusCode: 502, code: "badGateway", body: "Private upstream body" }) } });
    assert.ok(mime.includes('"mime_type": "application/json"') && mime.includes("badGateway"));
    assert.ok(!mime.includes("Private upstream body"));
});

test("external identifiers, hosts and opaque path components are aliased consistently", () => {
    const redactor = new Redactor("external");
    const first = redactor.identifier(REQUEST_ID, "request");
    const second = redactor.diagnostic({ requestId: REQUEST_ID, innerError: { requestId: REQUEST_ID } });
    assert.ok(!second.includes(REQUEST_ID));
    assert.equal(second.split(first).length - 1, 2);
    const safe = redactor.argsString(J({ entityUrl: "https://contoso.sharepoint.com/sites/Finance/Shared Documents/"
        + "SecretPlan.docx?$select=name&$filter=name eq 'SecretPlan.docx'" }));
    for (const residue of ["contoso", "Finance", "Shared Documents", "SecretPlan.docx"]) assert.ok(!safe.includes(residue));
    assert.ok(safe.includes("$select=name") && safe.includes("$filter=name eq <redacted-literal>"));
});

test("environment projection follows the typed schema and profile identity rules", () => {
    const source = {
        collected_at: "2026-09-05T12:00:00Z",
        host: { name: "workstation-7", version: "1.2.3", os: { name: "macOS", version: "15.6", architecture: "arm64" },
            debug: "secret" },
        server: { name: "workiq", endpoint: "https://contoso.example/api", transport: "stdio", auth_mode: null },
        transport: "stdio",
        local_offset: "-07:00",
        identity: { upn: "tolga@contoso.com", object_id: "object-123" },
        tenant: { id: "72f988bf-86f1-41af-91ab-2d7cd011db47", name: "Contoso", region: "westus" },
        tools: [{ name: "workiq-fetch", schema_sha256: "a".repeat(64), description: "reads mail" }],
        unknownPersonName: "Priya",
    };
    const internal = new Redactor("internal").environment(source);
    const external = new Redactor("external").environment(source);
    assert.equal(internal.identity.upn, "tolga@contoso.com");
    assert.equal(internal.tenant.region, "westus");
    assert.equal(internal.host.os.architecture, "arm64");
    assert.equal(internal.server.auth_mode, null);
    assert.equal(internal.tools[0].schema_sha256, "a".repeat(64));
    assert.ok(!("identity" in external) && !("tenant" in external));
    assert.notEqual(external.host.name, "workstation-7");
    for (const residue of ["debug", "unknownPersonName", "reads mail"]) assert.ok(!J(external).includes(residue));
});

test("paths drop userinfo and function-call literals", () => {
    const safe = new Redactor("internal").argsString(J({
        entityUrl: "https://alice:private-password@graph.example/me/calendarView(startDateTime=2026-09-05T09:00:00Z,"
            + "endDateTime=2026-09-05T10:00:00Z)?$select=subject",
    }));
    for (const residue of ["alice", "private-password", "2026-09-05T09:00:00Z"]) assert.ok(!safe.includes(residue));
    assert.ok(safe.includes("calendarView(startDateTime=<redacted-literal>,endDateTime=<redacted-literal>)"));
});

test("probe and narrative boundaries", () => {
    const redactor = new Redactor("internal");
    const probe = J(redactor.probe({ tool: "workiq-fetch", statusCode: 404, requestId: "req-123",
        result: { statusCode: 404, code: "itemNotFound", subject: "Private meeting" }, operatorNote: "customer secret" }));
    assert.ok(probe.includes("itemNotFound") && !probe.includes("Private meeting") && !probe.includes("customer secret"));
    assert.equal(redactor.narrative("Project ORCHID", false), PLACEHOLDER_NARRATIVE);
    assert.equal(redactor.narrative("Reviewed generic action", true), "Reviewed generic action");
    assert.equal(redactor.narrative(`Reviewed but Bearer ${JWT}`, true), "Reviewed but <redacted-bearer>");
});

test("the final gate detects injected residue on exact final bytes", () => {
    const redactor = new Redactor("external");
    const artifacts = { "report.md": redactor.diagnostic({ statusCode: 403, code: "accessDenied", message: "Access denied" }) };
    assert.ok(verify(artifacts, "external").passed);
    const injected = verify({ ...artifacts, "report.md": `# Mock\n\nAuthorization: Bearer ${JWT}\n` }, "external");
    assert.equal(injected.passed, false);
    assert.ok(injected.finding_count > 0);
    assert.ok(injected.findings.every((finding) => finding.excerpt.endsWith("<<<HIT>>>") && !finding.excerpt.includes(JWT)));
    assert.ok(verify({ "report.md": "status=403 code=accessDenied" }, "external").passed);
    const dirty = verify({ "report.md": "Cookie: sid=private\nAuthorization: Basic dXNlcjpwYXNz" }, "external");
    assert.ok(!dirty.passed && dirty.finding_count >= 2);
});
