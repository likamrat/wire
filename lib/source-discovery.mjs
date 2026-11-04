import { stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BoardError } from "./store.mjs";
import { hostPaths } from "./host-paths.mjs";
import { sourceHost } from "./source-host.mjs";
import { readSourceMetadata } from "./source-reader.mjs";

export { SOURCE_ADAPTER, DISCOVERY_LIMITS, sourcePromptCreation } from "./source-metadata.mjs";
const sourceError = (message, status, code) => Object.assign(new BoardError(message, status), { code });

export function sourceDefaults(env = process.env) {
    const root = env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
    return { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state") };
}

export function validateStoredSourcePaths(config) {
    if (typeof config?.appDbPath !== "string" || typeof config?.sessionRoot !== "string") {
        throw sourceError("Choose the Copilot app's absolute data.db path and CLI session-state directory. No other file tree is scanned.", 422, "source_paths_invalid");
    }
    const database = hostPaths.describe(config.appDbPath), history = hostPaths.describe(config.sessionRoot);
    if (database.foreignWindows !== history.foreignWindows || !database.absolute || !history.absolute
        || database.name.toLowerCase() !== "data.db" || history.name.toLowerCase() !== "session-state") {
        throw sourceError("Saved source references are invalid. No history was read.", 422, "source_paths_invalid");
    }
}

export function validateSourcePaths(config) {
    validateStoredSourcePaths(config);
    sourceHost(config).assertCurrent();
}

export async function detectSource() {
    const candidate = sourceDefaults();
    try {
        validateSourcePaths(candidate);
        const files = sourceHost(candidate);
        const [db, root] = await Promise.all([stat(files.databaseFile()), stat(files.historyRoot())]);
        if (!db.isFile() || !root.isDirectory()) throw new BoardError("The suggested local Copilot source is unavailable.", 422);
        return { ...candidate, available: true, basis: "COPILOT_HOME or documented default ~/.copilot; named app metadata only. Approval required before reading GitHub Copilot chats." };
    } catch (error) {
        return { ...candidate, available: false, error: error instanceof BoardError ? error.message : `Local source not found (${error.code ?? "SOURCE_UNAVAILABLE"}). Choose paths below.` };
    }
}

export async function discoverSources(config) {
    validateSourcePaths(config);
    return readSourceMetadata(sourceHost(config));
}
