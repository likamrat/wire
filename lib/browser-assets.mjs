import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = fileURLToPath(new URL("../dist/client", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const requiredSources = ["package.json", "package-lock.json", "vite.config.mjs", "lib/render.mjs", "lib/search-text.mjs",
    "web/icon-roles.mjs", "assets/react-icons-lucide.json"];
const sourceName = value => typeof value === "string" && !value.split("/").some(part => !part || part === "." || part === "..")
    && (/^(?:web|lib)\/[A-Za-z0-9_./-]+\.(?:mjs|ts|tsx|css)$/.test(value) || requiredSources.includes(value));
const digest = value => createHash("sha256").update(value).digest("hex");
const entries = { bundled: "web/browser-entry.mjs", react: "web/frontend/entry.tsx" };
const filename = value => typeof value === "string" && /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(value);
const failure = (code, cause) => Object.assign(new Error(
    "WIRE browser assets are unavailable or invalid. Run npm ci and npm run build in this checkout before starting WIRE.",
    { cause }), { code });

export async function createBrowserBuildStamp(files) {
    const sources = {};
    for (const file of [...new Set([...requiredSources, ...files])].sort()) {
        if (!sourceName(file)) throw failure("WIRE_BROWSER_BUILD_INVALID");
        sources[file] = digest(await readFile(path.join(sourceRoot, ...file.split("/"))));
    }
    return { schemaVersion: 1, sources };
}

export async function loadBrowserAssets({ directory: root = directory, renderer = "bundled" } = {}) {
    if (!Object.hasOwn(entries, renderer)) throw failure("WIRE_BROWSER_BUILD_INVALID");
    let manifest, canonicalRoot, stamp;
    try {
        canonicalRoot = await realpath(root);
        manifest = JSON.parse(await readFile(path.join(canonicalRoot, ".vite", "manifest.json"), "utf8"));
        stamp = JSON.parse(await readFile(path.join(canonicalRoot, "wire-build.json"), "utf8"));
    } catch (error) {
        throw failure(error.code === "ENOENT" ? "WIRE_BROWSER_BUILD_MISSING" : "WIRE_BROWSER_BUILD_INVALID", error);
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
        || manifest[entries[renderer]]?.isEntry !== true) throw failure("WIRE_BROWSER_BUILD_INVALID");
    if (stamp?.schemaVersion !== 1 || !stamp.sources || typeof stamp.sources !== "object" || Array.isArray(stamp.sources)
        || requiredSources.some(file => !Object.hasOwn(stamp.sources, file))
        || Object.entries(stamp.sources).some(([file, hash]) => !sourceName(file) || !/^[a-f0-9]{64}$/.test(hash))) {
        throw failure("WIRE_BROWSER_BUILD_INVALID");
    }
    try {
        for (const [file, hash] of Object.entries(stamp.sources)) {
            if (digest(await readFile(path.join(sourceRoot, ...file.split("/")))) !== hash) {
                throw failure("WIRE_BROWSER_BUILD_STALE");
            }
        }
    } catch (error) {
        if (error.code === "WIRE_BROWSER_BUILD_STALE") throw error;
        throw failure("WIRE_BROWSER_BUILD_INVALID", error);
    }
    const names = new Set();
    for (const entry of Object.values(manifest)) {
        if (!entry || typeof entry !== "object" || !filename(entry.file)
            || entry.css !== undefined && (!Array.isArray(entry.css) || entry.css.some(file => !filename(file) || !file.endsWith(".css")))
            || ["imports", "dynamicImports"].some(key => entry[key] !== undefined
                && (!Array.isArray(entry[key]) || entry[key].some(name => typeof name !== "string" || !Object.hasOwn(manifest, name))))) {
            throw failure("WIRE_BROWSER_BUILD_INVALID");
        }
        names.add(entry.file);
        for (const file of entry.css ?? []) names.add(file);
    }
    const assets = new Map(), prefix = "/assets/client/";
    try {
        for (const name of names) {
            const file = await realpath(path.join(canonicalRoot, name));
            const relative = path.relative(canonicalRoot, file);
            if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure("WIRE_BROWSER_BUILD_INVALID");
            assets.set(prefix + name, Object.freeze({ bytes: await readFile(file),
                type: name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }));
        }
    } catch (error) {
        if (error.code === "WIRE_BROWSER_BUILD_INVALID") throw error;
        throw failure("WIRE_BROWSER_BUILD_INVALID", error);
    }
    const styles = new Set(), visited = new Set();
    function collect(name) {
        if (visited.has(name)) return;
        visited.add(name);
        for (const dependency of manifest[name].imports ?? []) collect(dependency);
        for (const file of manifest[name].css ?? []) styles.add(prefix + file);
    }
    collect(entries[renderer]);
    return Object.freeze({ entry: prefix + manifest[entries[renderer]].file,
        styles: Object.freeze([...styles]), renderer, get: url => assets.get(url) });
}
