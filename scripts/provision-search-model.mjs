import { mkdir, mkdtemp, writeFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SEARCH_MODEL, SearchError, searchHash, readSearchModel, defaultSearchModelDirectory } from "../lib/search-model-assets.mjs";

const publicHosts = new Set(["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.hf.co",
    "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co"]);
async function download(spec) {
    let url = new URL(`https://huggingface.co/${SEARCH_MODEL.name}/resolve/${SEARCH_MODEL.revision}/${spec.name}`);
    for (let redirects = 0; redirects <= 5; redirects++) {
        if (url.protocol !== "https:" || !publicHosts.has(url.hostname) || url.username || url.password || url.port) {
            throw new SearchError("provision-host-denied");
        }
        const response = await fetch(url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(120000) });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get("location");
            if (!location) throw new SearchError("provision-redirect");
            url = new URL(location, url);
            continue;
        }
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new SearchError("provision-download");
        }
        const reader = response.body.getReader(), parts = [];
        let size = 0;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                size += next.value.byteLength;
                if (size > spec.bytes) throw new SearchError("provision-integrity");
                parts.push(next.value);
            }
        } finally { await reader.cancel(); reader.releaseLock(); }
        const bytes = Buffer.concat(parts);
        if (size !== spec.bytes || searchHash(bytes) !== spec.sha256) throw new SearchError("provision-integrity");
        return bytes;
    }
    throw new SearchError("provision-redirect");
}

export async function provisionSearchModel(directory = defaultSearchModelDirectory) {
    directory = path.resolve(directory);
    let exists = false;
    try { await lstat(directory); exists = true; }
    catch (error) { if (error.code !== "ENOENT") throw new SearchError("provision-unreadable"); }
    if (exists) {
        await readSearchModel(directory);
        return { state: "verified", revision: SEARCH_MODEL.revision };
    }
    await mkdir(path.dirname(directory), { recursive: true });
    const staging = await mkdtemp(path.join(path.dirname(directory), ".provision-"));
    try {
        for (const spec of SEARCH_MODEL.files) {
            const bytes = await download(spec), target = path.join(staging, ...spec.name.split("/"));
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, bytes, { flag: "wx" });
        }
        await readSearchModel(staging);
        await rename(staging, directory);
        return { state: "verified", revision: SEARCH_MODEL.revision };
    } catch (error) {
        if (error instanceof SearchError) throw error;
        throw new SearchError("provision-failed");
    } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        if (process.argv.length !== 2) throw new SearchError("provision-arguments");
        console.log(JSON.stringify(await provisionSearchModel()));
    } catch (error) {
        console.error(error instanceof SearchError ? error.message : "Local search unavailable (provision-failed).");
        process.exitCode = 1;
    }
}
