import { mkdir, mkdtemp, writeFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SEARCH_LINGUISTICS, SEARCH_LINGUISTICS_ID, readSearchLinguistics, defaultSearchLinguisticsDirectory } from "../lib/search-linguistics-assets.mjs";
import { SearchError, searchHash } from "../lib/search-model-assets.mjs";

async function download(spec) {
    const url = new URL(spec.url);
    if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com" || url.username || url.password || url.port) {
        throw new SearchError("linguistics-provision-host");
    }
    const response = await fetch(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new SearchError("linguistics-provision-download");
    }
    const reader = response.body.getReader(), parts = [];
    let size = 0;
    try {
        while (true) {
            const value = await reader.read();
            if (value.done) break;
            size += value.value.byteLength;
            if (size > spec.bytes) throw new SearchError("linguistics-provision-integrity");
            parts.push(value.value);
        }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== spec.bytes || searchHash(bytes) !== spec.sha256) throw new SearchError("linguistics-provision-integrity");
    return bytes;
}
export async function provisionSearchLinguistics(directory = defaultSearchLinguisticsDirectory) {
    directory = path.resolve(directory);
    try {
        await lstat(directory);
        await readSearchLinguistics(directory);
        return { state: "verified", resourceId: SEARCH_LINGUISTICS_ID, enabled: false };
    } catch (error) {
        if (error.code !== "ENOENT") throw error instanceof SearchError ? error : new SearchError("linguistics-provision-unreadable");
    }
    await mkdir(path.dirname(directory), { recursive: true });
    const staging = await mkdtemp(path.join(path.dirname(directory), ".linguistics-provision-"));
    try {
        for (const spec of SEARCH_LINGUISTICS.files) {
            const bytes = await download(spec), target = path.join(staging, ...spec.name.split("/"));
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, bytes, { flag: "wx" });
        }
        await readSearchLinguistics(staging);
        await rename(staging, directory);
        return { state: "verified", resourceId: SEARCH_LINGUISTICS_ID, enabled: false };
    } catch (error) {
        throw error instanceof SearchError ? error : new SearchError("linguistics-provision-failed");
    } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        if (process.argv.length !== 2) throw new SearchError("linguistics-provision-arguments");
        console.log(JSON.stringify(await provisionSearchLinguistics()));
    } catch (error) {
        console.error(error instanceof SearchError ? error.message : "Local search unavailable (linguistics-provision-failed).");
        process.exitCode = 1;
    }
}
