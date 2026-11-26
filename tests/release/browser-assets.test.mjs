import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createBrowserBuildStamp, loadBrowserAssets } from "../../lib/browser-assets.mjs";

async function assets(t, entries = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-browser-assets-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".vite"));
    await writeFile(path.join(root, ".vite", "manifest.json"), JSON.stringify(entries));
    await writeFile(path.join(root, "wire-build.json"), JSON.stringify(await createBrowserBuildStamp([])));
    return root;
}

test("browser delivery admits only manifest-owned built assets, not arbitrary local files", async t => {
    const root = await assets(t, {
        "web/browser-entry.mjs": { file: "browser-Abc12345.js", isEntry: true, css: ["screen-Def67890.css"] },
        "screen.css": { file: "screen-Def67890.css" },
    });
    await writeFile(path.join(root, "browser-Abc12345.js"), "export const ready = true;");
    await writeFile(path.join(root, "screen-Def67890.css"), "body{color:black}");
    await writeFile(path.join(root, "private.txt"), "not a browser asset");
    const result = await loadBrowserAssets({ directory: root });
    assert.equal(result.entry, "/assets/client/browser-Abc12345.js");
    assert.deepEqual(result.styles, ["/assets/client/screen-Def67890.css"]);
    assert.equal(result.get(result.entry).type, "text/javascript; charset=utf-8");
    assert.equal(result.get("/assets/client/private.txt"), undefined);
    assert.equal(result.get("/assets/client/../private.txt"), undefined);
    assert.equal(result.get("/assets/client/browser-Abc12345.js?path=private.txt"), undefined);
});

test("invalid or absent builds fail explicitly instead of falling back to another renderer", async t => {
    const root = await assets(t, {
        "web/browser-entry.mjs": { file: "../private.js", isEntry: true },
    });

    await assert.rejects(loadBrowserAssets({ directory: root }), { code: "WIRE_BROWSER_BUILD_INVALID" });
    await assert.rejects(loadBrowserAssets({ directory: path.join(root, "missing") }), { code: "WIRE_BROWSER_BUILD_MISSING" });
});

test("a stale source stamp refuses the build before any panel can receive its old code", async t => {
    const root = await assets(t, { "web/browser-entry.mjs": { file: "browser-Abc12345.js", isEntry: true } });
    const stamp = await createBrowserBuildStamp([]);
    stamp.sources["lib/render.mjs"] = "0".repeat(64);
    await writeFile(path.join(root, "wire-build.json"), JSON.stringify(stamp));
    await assert.rejects(loadBrowserAssets({ directory: root }), { code: "WIRE_BROWSER_BUILD_STALE" });
});
