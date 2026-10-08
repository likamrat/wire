import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { defaultDataDir } from "../lib/paths.mjs";
import { PRODUCT_NAME } from "../lib/branding.mjs";

const context = { dataDir: process.env.WORKIQ_EVIDENCE_DATA_DIR || defaultDataDir(), sessionId: null };
try {
    const runtime = await startServer(context, createExportController(context));
    console.log(`${PRODUCT_NAME} ready at ${runtime.url}`);
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        runtime.server.close(error => {
            if (error) { console.error(`${PRODUCT_NAME} did not close cleanly.`); process.exitCode = 1; }
        });
        runtime.server.closeIdleConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
} catch (error) {
    console.error(error.code === "EADDRINUSE"
        ? "Port 47831 is already owned. No second evidence writer was started; use the existing runtime or stop its owner explicitly."
        : `${PRODUCT_NAME} could not start. Check the private data directory and runtime installation.`);
    process.exitCode = 1;
}
