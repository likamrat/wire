import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture } from "./helpers.mjs";

test("the built React workspace runs with production dependencies and no frontend toolchain", { timeout: 180000 }, async t => {
    const cleanup = [];
    const { context, root } = await privateFixture({ after: work => cleanup.push(work) }, [fixture("production-browser")]);
    let child, browser, diagnostics = "";
    t.after(async () => {
        try { await browser?.close(); }
        finally {
            try {
                if (child && child.exitCode === null && child.signalCode === null) {
                    await new Promise((resolve, reject) => {
                        let forced = false;
                        const timer = setTimeout(() => { forced = true; child.kill(); }, 5000);
                        child.once("close", code => {
                            clearTimeout(timer);
                            if (forced || code !== 0) reject(new Error("Packaged runtime did not close cleanly."));
                            else resolve();
                        });
                        if (child.connected) child.send("stop");
                        else child.kill();
                    });
                }
            } finally { for (const work of cleanup.reverse()) await work(); }
        }
    });
    const destination = path.join(root, "production-browser"), run = promisify(execFile);
    await mkdir(destination);
    for (const name of ["lib", "web", "dist", "package.json", "package-lock.json", "vite.config.mjs"]) {
        await cp(new URL(`../${name}`, import.meta.url), path.join(destination, name), { recursive: true });
    }
    await mkdir(path.join(destination, "assets"));
    for (const entry of await readdir(new URL("../assets", import.meta.url), { withFileTypes: true })) {
        if (entry.name !== "fonts" && !/\.(?:svg|json)$/.test(entry.name)) continue;
        await cp(new URL(`../assets/${entry.name}`, import.meta.url), path.join(destination, "assets", entry.name), { recursive: true });
    }
    const args = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
    if (process.platform === "win32") await run(process.env.ComSpec, ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd: destination });
    else await run("npm", args, { cwd: destination });
    for (const dependency of ["react", "react-dom", "react-icons", "lucide-static", "vite", "typescript"]) {
        await assert.rejects(readFile(path.join(destination, "node_modules", dependency, "package.json")), { code: "ENOENT" });
    }
    const runner = path.join(destination, "browser-runtime-proof.mjs");
    await writeFile(runner, `
import { startServer } from "./lib/server.mjs";
import { createExportController } from "./lib/export.mjs";
const context = ${JSON.stringify(context)};
const runtime = await startServer(context, createExportController(context), {
    port: 0, frontend: "react", collector: { timers: false },
    evaluation: { evaluatorFactory() { throw new Error("No providers in packaging proof."); } },
});
process.on("message", async value => {
    if (value !== "stop") return;
    await runtime.close();
    process.disconnect();
});
process.send({ url: runtime.url });
`);
    child = fork(runner, [], { cwd: destination, env: { ...process.env, NODE_PATH: "" },
        stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr.on("data", bytes => { diagnostics += bytes; });
    const url = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => reject(new Error(`Packaged runtime ended before readiness (${code}): ${diagnostics}`)));
        child.once("message", message => resolve(message.url));
    });
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#activityList .request-card-open")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await expect(page.locator("body")).toHaveClass(/wire-frontend-react/);
    await expect(page.locator(".frontend-record-slot").first()).toBeAttached();
    await expect(page.locator("#wireSearchHome svg[data-icon-role=search]")).toHaveCount(1);
    await expect(page.locator("#activityList svg[data-icon-role='activity-panel']").first()).toBeVisible();
    assert.deepEqual(errors, []);
});
