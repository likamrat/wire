import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { createNativePersistence, readNativeCollectionSettings } from "../lib/native-persistence.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";

const dataDir = process.argv[2], relative = typeof dataDir === "string" ? path.relative(os.tmpdir(), dataDir) : "";
if (!/^workiq-evidence-test-[^\\/]+[\\/]data$/.test(relative)) throw new Error("Restart proof requires its owned test store.");
const context = { dataDir, sessionId: "native-restart-proof" };
let lifecycle, persistence, access, runtime, providerAttempts = 0, acquisitions = 0;
const transport = createMicrosoftNativeReadTransport({
    async open() { providerAttempts++; throw new Error("Paused restart must not open a provider."); },
    async verifyAccount() { providerAttempts++; throw new Error("Paused restart must not verify a provider."); },
    async stop() { return { processExited: true, profileReleased: true }; },
});
try {
    const settings = await readNativeCollectionSettings(context);
    if (!settings || settings.paused !== true) throw new Error("Committed paused settings are required.");
    lifecycle = await createMicrosoftSession(context, { transport,
        collection: { paused: settings.paused, windowDays: settings.windowDays },
        persistCollectionSettings: (value, token) => persistence.persistCollectionSettings(value, token),
    });
    persistence = await createNativePersistence(context, { lifecycle, transport });
    access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
        async acquireNative() { acquisitions++; throw new Error("Paused restart must not acquire source data."); },
    });
    runtime = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false } });
    const origin = new URL(runtime.url).origin;
    async function api(route, input, capability) {
        const response = await fetch(origin + route, { method: "POST", headers: {
            Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
        }, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
    }
    const capability = (await api("/api/session", {})).body.capability;
    const snapshot = await api("/api/snapshot", { layer: "tool", groupBy: "endpoint", filters: { scope: "all" }, limit: 10 }, capability);
    if (snapshot.status !== 200) throw new Error(`Paused snapshot failed: ${snapshot.body.code ?? snapshot.status}`);
    const native = snapshot.body.scenarios.filter(row => row.nativeConversation).map(row => row.nativeConversation);
    const status = await api("/api/collection/status", {}, capability);
    if (status.status !== 200) throw new Error("Paused status read failed.");
    createCollectionStatus().persistence(status.body);
    console.log(JSON.stringify({ pid: process.pid, providerAttempts, acquisitions, settings,
        dataDigest: createHash("sha256").update(JSON.stringify(native)).digest("hex"),
        conversations: native.length, readback: snapshot.body.nativeRead.readback,
        collection: (await lifecycle.status()).collection, receipt: status.body.nativePersistence.receipt,
        actions: status.body.nativePersistence.actions, backfill: status.body.nativePersistence.backfill }));
} finally {
    await runtime?.close(); access?.close(); persistence?.close(); await lifecycle?.close();
}
