import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { defaultDataDir, contributorDataDir } from "../lib/paths.mjs";
import { PRODUCT_NAME } from "../lib/branding.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { DEFAULT_RUNTIME_PORT } from "../lib/runtime-endpoint.mjs";
import path from "node:path";

let runtime, nativeHost, copilotAccess, stopping = false, closing;
const managed = process.connected && process.env.WIRE_UPDATE_LAUNCHER === "1";
let finishChild, getStoreIdentity, startupMayOwnStorage = false;
function releaseChild(state) {
    if (!finishChild) return;
    finishChild(state);
    finishChild = undefined;
}
function startupOptions(args) {
    const options = { port: DEFAULT_RUNTIME_PORT, frontend: "bundled", developmentMicrosoft: false, microsoftConfig: null, microsoftRetained: false, microsoftAccountOnly: false,
        microsoftVisibleSignIn: false, microsoftVisibilityExperiment: false, microsoftManualCollection: false };
    const seen = new Set();
    const invalid = () => { throw Object.assign(new Error(
        "Use npm start -- [--port 0-65535] [--development-frontend bundled|react] [--verified-record-recovery], or npm run dev for a separate checkout store. Microsoft incubation requires --development-microsoft."),
    { code: "WIRE_START_OPTIONS_INVALID" }); };
    for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (seen.has(key)) invalid();
        seen.add(key);
        if (key === "--development-frontend") {
            const frontend = args[++index];
            if (!["bundled", "react"].includes(frontend)) invalid();
            options.frontend = frontend;
        } else if (key === "--verified-record-recovery") options.exactRecords = true;
        else if (key === "--contributor") options.contributor = true;
        else if (key === "--development-microsoft") options.developmentMicrosoft = true;
        else if (key === "--microsoft-retained") options.microsoftRetained = true;
        else if (key === "--microsoft-manual-collection") options.microsoftManualCollection = true;
        else if (key === "--microsoft-account-only") options.microsoftAccountOnly = true;
        else if (key === "--microsoft-visible-sign-in") options.microsoftVisibleSignIn = true;
        else if (key === "--microsoft-visibility-experiment") options.microsoftVisibilityExperiment = true;
        else if (key === "--microsoft-config") {
            const file = args[++index];
            if (!file || file.startsWith("--")) invalid();
            options.microsoftConfig = path.resolve(file);
        } else if (key === "--port") {
            const port = args[++index];
            if (!/^(?:0|[1-9]\d{0,4})$/.test(port ?? "") || Number(port) > 65535) invalid();
            options.port = Number(port);
        } else invalid();
    }
    if (options.exactRecords && options.developmentMicrosoft) invalid();
    if (options.microsoftConfig && options.microsoftRetained || options.microsoftAccountOnly && !options.microsoftConfig) invalid();
    if (options.microsoftVisibilityExperiment && options.microsoftVisibleSignIn) invalid();
    if (options.microsoftVisibilityExperiment) options.microsoftVisibleSignIn = true;
    if (options.microsoftVisibleSignIn && (!options.microsoftConfig || options.microsoftAccountOnly || options.microsoftRetained)) invalid();
    if (options.microsoftManualCollection && (options.microsoftRetained || options.microsoftAccountOnly || options.microsoftVisibilityExperiment)) invalid();
    if (!options.developmentMicrosoft && [...seen].some(key => key.startsWith("--microsoft-"))) invalid();
    if (options.contributor) {
        if (options.developmentMicrosoft) invalid();
        if (process.env.WORKIQ_EVIDENCE_DATA_DIR) throw Object.assign(new Error(
            "The contributor launcher uses a separate store for this checkout. Unset WORKIQ_EVIDENCE_DATA_DIR in this shell, or use npm start for an explicitly selected store."),
        { code: "WIRE_START_OPTIONS_INVALID" });
        if (!seen.has("--port")) options.port = 4100;
        if (!seen.has("--development-frontend")) options.frontend = "react";
    } else if (options.frontend === "react" && !options.developmentMicrosoft && !process.env.WORKIQ_EVIDENCE_DATA_DIR) {
        throw Object.assign(new Error(
            "React evaluation needs an explicitly owned store. Use npm run dev for this checkout, or set WORKIQ_EVIDENCE_DATA_DIR before starting."),
        { code: "WIRE_START_OPTIONS_INVALID" });
    }
    return options;
}
async function stop() {
    stopping = true;
    if (!runtime || closing) return closing;
    closing = (async () => {
        try {
            const finished = Promise.all([nativeHost?.close(), runtime.close()]);
            runtime.server.closeIdleConnections();
            await finished;
            await copilotAccess?.close();
            releaseChild("closed");
        } catch {
            console.error(`${PRODUCT_NAME} did not close cleanly. Owned source cleanup must finish before reconnecting.`);
            process.exitCode = 1;
        } finally {
            if (managed && process.connected) process.disconnect();
        }
    })();
    return closing;
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
if (process.connected) process.once("disconnect", stop);
if (managed) process.on("message", message => {
    if (message?.type === "wire-update-stop") void stop();
});
try {
    if (managed) {
        const { claimChild, storeIdentity, canonicalStore } = await import("../lib/update-launch-state.mjs");
        finishChild = claimChild(process.env.WIRE_UPDATE_DIRECTORY, process.env.WIRE_UPDATE_CHILD);
        const dataDir = process.env.WORKIQ_EVIDENCE_DATA_DIR;
        if (!path.isAbsolute(dataDir) || await canonicalStore(dataDir) !== dataDir) throw Error("The pinned store is no longer canonical.");
        getStoreIdentity = () => storeIdentity(dataDir);
        const identity = await getStoreIdentity().catch(error => { if (error.code !== "ENOENT") throw error; return ""; });
        if (identity !== process.env.WIRE_UPDATE_STORE) throw Error("The pinned store changed before launch.");
    }
    const options = startupOptions(process.argv.slice(2));
    const context = { dataDir: options.contributor ? contributorDataDir() : process.env.WORKIQ_EVIDENCE_DATA_DIR || defaultDataDir(), sessionId: null };
    const collector = { timers: !options.developmentMicrosoft };
    startupMayOwnStorage = true;
    runtime = await startServer(context, createExportController(context), {
        port: options.port,
        ...(finishChild?.recovery && { recoverLaunch: async initialize => {
            const { recoverLaunch } = await import("../lib/update-launch-recovery.mjs");
            return recoverLaunch(context, finishChild, initialize);
        } }),
        frontend: options.frontend,
        exactRecords: options.exactRecords === true,
        sourcePolicy: options.developmentMicrosoft ? "microsoft-incubation" : "copilot-only",
        collector, createAccess: async () => {
            if (!options.developmentMicrosoft) {
                copilotAccess = await createCopilotRuntimeAccess(context);
                return copilotAccess;
            }
            const { createMicrosoftNativeHost } = await import("../lib/microsoft-native-host.mjs");
            const { readMicrosoftNativeConfiguration, isMicrosoftNativeEnrollmentPolicy } = await import("../lib/microsoft-native-configuration.mjs");
            const configured = options.microsoftConfig ? await readMicrosoftNativeConfiguration(options.microsoftConfig) : null;
            const enrollmentPolicy = isMicrosoftNativeEnrollmentPolicy(configured) ? configured : null;
            if (enrollmentPolicy && (!options.microsoftConfig || options.microsoftRetained || options.microsoftAccountOnly
                || options.microsoftVisibilityExperiment)) throw Object.assign(new Error("Invalid enrollment policy mode."),
            { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
            const configuration = enrollmentPolicy ? null : configured;
            const ordinaryStartup = !options.microsoftRetained && !options.microsoftAccountOnly
                && !options.microsoftVisibilityExperiment && (!configuration || configuration.mode === "native-ui-history");
            if (options.microsoftManualCollection && !ordinaryStartup) throw Object.assign(
                new Error("Manual Microsoft collection requires ordinary native history startup."),
                { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
            nativeHost = await createMicrosoftNativeHost(context, { configuration, enrollmentPolicy,
                ordinaryStartup,
                nativeScheduling: false,
                ...(!configuration ? { sourceAware: true, nativeAcquisition: false } : {}),
                ...(options.microsoftVisibleSignIn ? { visibleSignIn: true } : {}),
                visibilityExperiment: options.microsoftVisibilityExperiment,
                ...(configuration?.mode === "native-ui-history" ? { sourceAware: true, nativeAcquisition: true,
                    blockedBootstrapChildOrigin: process.env.WIRE_NATIVE_BLOCKED_BOOTSTRAP_CHILD_ORIGIN ?? null,
                    observeAuthenticationChain: process.env.WIRE_NATIVE_AUTH_CHAIN_OBSERVATION === "1" } : {}),
                ...(options.microsoftRetained ? { sourceAware: true, nativeAcquisition: false } : {}),
                ...(options.microsoftAccountOnly ? { sourceAware: true, accountOnlyVerification: true, nativeAcquisition: false } : {}),
            });
            return nativeHost.access;
        },
    });
    if (stopping) await stop();
    else {
        if (managed) process.send({ type: "wire-update-ready", url: runtime.url, runtimeId: runtime.runtimeId,
            build: process.env.WIRE_UPDATE_BUILD, clientEntry: runtime.clientEntry, store: await getStoreIdentity() }, error => { if (error) void stop(); });
        else console.log(`${PRODUCT_NAME} ready at ${runtime.url}`);
        if (options.contributor) console.log(`Contributor checkout (${options.frontend}); private store: ${context.dataDir}`);
        if (options.developmentMicrosoft) console.log("Development-only Microsoft incubation. Automatic collection is off; saved configuration is not adopted.");
    }
} catch (error) {
    // A rejected startup can already have opened/changed the store without
    // returning a runtime handle. Only pre-admission refusals prove no writer.
    let clean = !startupMayOwnStorage || error.wireRefusedBeforeStore === true;
    if (copilotAccess) await copilotAccess.close().catch(() => {
        clean = false;
        console.error(`${PRODUCT_NAME} local access cleanup is incomplete.`);
    });
    if (nativeHost) await nativeHost.close().catch(() => {
        clean = false;
        console.error(`${PRODUCT_NAME} source cleanup is incomplete.`);
    });
    console.error(["WIRE_LAUNCH", "WIRE_START_OPTIONS_INVALID", "WIRE_COPILOT_STORE_INCOMPATIBLE", "WIRE_BROWSER_BUILD_MISSING", "WIRE_BROWSER_BUILD_INVALID", "WIRE_BROWSER_BUILD_STALE"].includes(error.code) ? error.message : error.code === "EADDRINUSE"
        ? "The requested port is already owned. No second evidence writer was started. Choose an unused port for an independent store, or verify the existing owner before using it."
        : `${PRODUCT_NAME} could not start. Check the private data directory, source configuration and runtime installation.`);
    process.exitCode = 1;
    if (clean) releaseChild("refused-before-store");
    if (managed && process.connected) process.disconnect();
}
