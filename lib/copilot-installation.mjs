import { stat } from "node:fs/promises";
import path from "node:path";
import { BoardError } from "./store.mjs";

function unavailable(message, code, status = 503) {
    return Object.assign(new BoardError(message, status), { code });
}
async function existingFile(environment, setting, fallback, kind) {
    const value = Object.hasOwn(environment, setting) ? environment[setting] : fallback;
    if (typeof value !== "string" || !value || value.trim() !== value || !path.isAbsolute(value)) {
        throw unavailable(`Set ${setting} to the existing absolute Copilot ${kind} file. No alternate installation was selected.`, `copilot-${kind}-path-invalid`);
    }
    let info;
    try { info = await stat(value); }
    catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
        throw unavailable(`The configured Copilot ${kind} file is unavailable. No alternate installation was selected.`, `copilot-${kind}-unavailable`);
    }
    if (!info.isFile()) throw unavailable(`The configured Copilot ${kind} path is not a file.`, `copilot-${kind}-not-file`);
    return path.normalize(value);
}

// Filesystem resolution only: no SDK import, account lookup, process or session.
export async function resolveCopilotInstallation(environment = process.env) {
    if (Object.keys(environment).some(key => key.startsWith("COPILOT_PROVIDER_") && environment[key])) {
        throw unavailable("A custom provider is configured. This consent permits GitHub Copilot only.", "copilot-provider-unapproved", 403);
    }
    const local = environment.LOCALAPPDATA;
    const root = typeof local === "string" && path.isAbsolute(local) ? local : null;
    const sdkPath = await existingFile(environment, "WORKIQ_EVIDENCE_COPILOT_SDK",
        root ? path.join(root, "Programs", "GitHub Copilot", "copilot-sdk", "index.js") : null, "sdk");
    const cliPath = await existingFile(environment, "WORKIQ_EVIDENCE_COPILOT_CLI",
        root ? path.join(root, "Microsoft", "WinGet", "Links", "copilot.exe") : null, "cli");
    return { sdkPath, cliPath };
}
