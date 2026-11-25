import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { diagnosticRecords } from "./diagnostic-bundles-fixture.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { resolveDataDir } from "../lib/store.mjs";

// The agent tools reach a disposable runtime here; the hosted runtime is replaced so nothing
// probes or starts WIRE on the default port.
test("diagnostic agent tools preview, save, list, inspect and annotate through WIRE's server", async t => {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, diagnosticRecords());
    t.after(async () => { for (const fn of cleanup.reverse()) await fn(); });
    const access = await createCopilotRuntimeAccess(context);
    cleanup.push(() => access.close());
    const server = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false } });
    cleanup.push(() => server.close());
    let config;
    const key = "__wireDiagnosticToolSdk";
    globalThis[key] = {
        joinSession: async value => { config = value; return { sessionId: "synthetic-diagnostic-session", on() {}, rpc: {} }; },
        createCanvas: value => value,
        CanvasError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
        origin: server.url.replace(/\/$/, ""),
    };
    const sdk = `const sdk = globalThis.${key}; export const joinSession = sdk.joinSession, createCanvas = sdk.createCanvas, CanvasError = sdk.CanvasError;`;
    const hosted = `const sdk = globalThis.${key}; export async function compatibleRuntime() { return true; }
export function createHostedRuntime({ port }) { if (port !== 4000) throw new Error("unexpected port"); return { origin: sdk.origin, async ensure() {}, async close() {} }; }`;
    const hooks = registerHooks({ resolve(specifier, ctx, next) {
        if (specifier === "@github/copilot-sdk/extension") return { url: `data:text/javascript,${encodeURIComponent(sdk)}`, shortCircuit: true };
        if (specifier === "./hosted-runtime.mjs" && ctx.parentURL?.includes("/lib/copilot-extension.mjs")) {
            return { url: `data:text/javascript,${encodeURIComponent(hosted)}`, shortCircuit: true };
        }
        return next(specifier, ctx);
    } });
    t.after(() => { hooks.deregister(); delete globalThis[key]; });
    await import("../lib/copilot-extension.mjs?diagnostic-tools");
    const tools = Object.fromEntries(config.tools.definitions.map(tool => [tool.name, tool]));
    const call = async (name, input) => {
        const result = await tools[name].handler(input, { sessionId: "synthetic-diagnostic-session" });
        assert.equal(result.resultType, "success", result.textResultForLlm);
        return JSON.parse(result.textResultForLlm);
    };
    const window = { from: "2026-11-16T00:00:00Z", to: "2026-11-20T00:00:00Z" };
    const preview = await call("wire_diagnostic_bundle", window);
    assert.equal(preview.saved, false);
    assert.equal(preview.totals.failures, 9);
    assert.equal(preview.verdictsTemplate.schema_version, 2);
    const root = path.join(resolveDataDir(context), "diagnostics");
    await assert.rejects(readdir(root), { code: "ENOENT" });
    const saved = await call("wire_diagnostic_bundle", { ...window, save: true });
    assert.equal(path.dirname(saved.files.archive), root, "Saved inside WIRE's data folder, not beside it");
    const listed = await call("wire_diagnostic_bundles", {});
    assert.deepEqual(listed.bundles.map(item => item.bundleId), [saved.bundle.bundleId]);
    const inspected = await call("wire_inspect_bundle", { bundleId: saved.bundle.bundleId });
    assert.equal(inspected.accepted, true);
    assert.equal(Object.hasOwn(inspected, "report"), false);
    const clusterId = inspected.clusters[0].id;
    const recorded = await call("wire_record_audit_result", { bundleId: saved.bundle.bundleId, clusterId, verdict: "product-bug",
        workItemUrl: "https://dev.azure.example/items/7" });
    assert.equal(recorded.audit.verdict, "product-bug");
    assert.equal((await call("wire_diagnostic_bundles", {})).bundles[0].reviewed, 1);
    const refused = await tools.wire_record_audit_result.handler({ bundleId: saved.bundle.bundleId, clusterId, verdict: "product-bug",
        workItemUrl: "javascript:alert(1)" }, { sessionId: "synthetic-diagnostic-session" });
    assert.equal(refused.resultType, "failure");
    assert.match(refused.textResultForLlm, /https link/);
});
