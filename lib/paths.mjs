import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function defaultDataDir() {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
    return path.join(base, "WorkIQEvidence", "data");
}

export function contributorDataDir() {
    const checkout = realpathSync.native(sourceRoot);
    const key = createHash("sha256").update(checkout).digest("hex");
    return path.join(path.dirname(defaultDataDir()), "checkouts", key, "data");
}

export function dataDirFor(context) {
    const value = context?.dataDir ?? process.env.WORKIQ_EVIDENCE_DATA_DIR ?? defaultDataDir();
    if (typeof value !== "string" || !path.isAbsolute(value)) {
        throw new Error("WIRE requires an absolute private data directory.");
    }
    const resolved = path.resolve(value);
    const relative = path.relative(sourceRoot, resolved);
    if (relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        throw new Error("Private data must be outside the maintained source directory.");
    }
    return resolved;
}
