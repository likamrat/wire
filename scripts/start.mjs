import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { defaultDataDir } from "../lib/paths.mjs";
import { PRODUCT_NAME } from "../lib/branding.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { DEFAULT_RUNTIME_PORT } from "../lib/runtime-endpoint.mjs";
import path from "node:path";

const context = { dataDir: process.env.WORKIQ_EVIDENCE_DATA_DIR || defaultDataDir(), sessionId: null };
let runtime, nativeHost, copilotAccess, stopping = false, closing;
function startupOptions(args) {
    const options = { port: DEFAULT_RUNTIME_PORT, developmentMicrosoft: false, microsoftConfig: null, microsoftRetained: false, microsoftAccountOnly: false,
        microsoftVisibleSignIn: false, microsoftVisibilityExperiment: false, microsoftManualCollection: false };
    const seen = new Set();
    const invalid = () => { throw Object.assign(new Error(
        "Use npm start -- [--port 0-65535]. Microsoft incubation requires --development-microsoft; saved configuration is never adopted."),
    { code: "WIRE_START_OPTIONS_INVALID" }); };
    for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (seen.has(key)) invalid();
        seen.add(key);
        if (key === "--development-microsoft") options.developmentMicrosoft = true;
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
    if (options.microsoftConfig && options.microsoftRetained || options.microsoftAccountOnly && !options.microsoftConfig) invalid();
    if (options.microsoftVisibilityExperiment && options.microsoftVisibleSignIn) invalid();
    if (options.microsoftVisibilityExperiment) options.microsoftVisibleSignIn = true;
    if (options.microsoftVisibleSignIn && (!options.microsoftConfig || options.microsoftAccountOnly || options.microsoftRetained)) invalid();
    if (options.microsoftManualCollection && (options.microsoftRetained || options.microsoftAccountOnly || options.microsoftVisibilityExperiment)) invalid();
    if (!options.developmentMicrosoft && [...seen].some(key => key.startsWith("--microsoft-"))) invalid();
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
        } catch {
            console.error(`${PRODUCT_NAME} did not close cleanly. Owned source cleanup must finish before reconnecting.`);
            process.exitCode = 1;
        }
    })();
    return closing;
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
if (process.connected) process.once("disconnect", stop);
try {
    const options = startupOptions(process.argv.slice(2));
    const collector = { timers: !options.developmentMicrosoft };
    runtime = await startServer(context, createExportController(context), {
        port: options.port,
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
        console.log(`${PRODUCT_NAME} ready at ${runtime.url}`);
        if (options.developmentMicrosoft) console.log("Development-only Microsoft incubation. Automatic collection is off; saved configuration is not adopted.");
    }
} catch (error) {
    if (copilotAccess) await copilotAccess.close().catch(() => {
        console.error(`${PRODUCT_NAME} local access cleanup is incomplete.`);
    });
    if (nativeHost) await nativeHost.close().catch(() => {
        console.error(`${PRODUCT_NAME} source cleanup is incomplete.`);
    });
    console.error(["WIRE_START_OPTIONS_INVALID", "WIRE_COPILOT_STORE_INCOMPATIBLE"].includes(error.code) ? error.message : error.code === "EADDRINUSE"
        ? "The requested port is already owned. No second evidence writer was started; use the existing runtime or stop its owner explicitly."
        : `${PRODUCT_NAME} could not start. Check the private data directory, source configuration and runtime installation.`);
    process.exitCode = 1;
}
