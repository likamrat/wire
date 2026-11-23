import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture } from "./helpers.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { pdfParserEnvironment } from "../lib/search-corpus-pdf.mjs";

test("production-only installation", { timeout: 180000 }, async t => {
    const destination = await mkdtemp(path.join(os.tmpdir(), "wire-production-package-"));
    t.after(() => rm(destination, { recursive: true, force: true }));
    for (const name of ["package.json", "package-lock.json"]) {
        await copyFile(new URL(`../${name}`, import.meta.url), path.join(destination, name));
    }
    const args = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], run = promisify(execFile);
    if (process.platform === "win32") await run(process.env.ComSpec, ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd: destination });
    else await run("npm", args, { cwd: destination });
    for (const dependency of ["@playwright/test", "react", "react-dom", "react-icons", "lucide-static", "vite", "typescript"]) {
        await assert.rejects(readFile(path.join(destination, "node_modules", dependency, "package.json")), { code: "ENOENT" });
    }
    // The parser must work before the rest of WIRE's source tree is present.
    await t.test("the isolated worker extracts prompt and reply text from a reviewed PDF", t => checkPdf(t, destination));
    await t.test("the built React workspace opens with no frontend toolchain", t => checkBrowser(t, destination));
});

async function checkPdf(t, destination) {
    const records = retainedContextFixture().records.slice(0, 2);
    records[0].userPrompt.text = "PACKAGING_ORIGIN_CANARY";
    records[1].followUpPrompts = [];
    for (const record of records) for (const call of record.toolCalls) call.requestArgs = { entityUrls: ["/me/drive/root/children"] };
    const { context } = await privateFixture(t, records), exports = createExportController(context);
    await seedRetainedReply(context, inventedSource(), "PACKAGING_REPLY_CANARY");
    const state = await loadBoardState(context);
    const preview = await exports.preview("packaging-fixture", undefined,
        { promptMode: "original", formats: ["pdf"], recordedContext: true },
        { kind: "selected", revision: state.revision, scenarioIds: [records[0].scenarioId] });
    await exports.review("packaging-fixture", preview.previewId, true);
    const { bundle } = await exports.confirm("packaging-fixture", preview.previewId, true);
    const bytes = await readFile(bundle.files["product-report.pdf"]);
    const worker = path.join(destination, "parser.mjs");
    await copyFile(new URL("../lib/search-corpus-pdf-worker.mjs", import.meta.url), worker);
    t.after(() => rm(worker));
    const installed = JSON.parse(await readFile(path.join(destination, "node_modules", "pdfjs-dist", "package.json")));
    const manifest = JSON.parse(await readFile(path.join(destination, "package.json")));
    assert.equal(installed.version, manifest.dependencies["pdfjs-dist"]);
    const result = await new Promise((resolve, reject) => {
        const child = fork(worker, [], { cwd: destination, execPath: process.execPath, execArgv: ["--disallow-code-generation-from-strings"],
            serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], env: pdfParserEnvironment() });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
        let response;
        child.once("message", value => { response = value; });
        child.once("error", reject);
        child.once("close", code => {
            if (code !== 0 || response?.ok !== true) reject(new Error(`Isolated production parser failed (${response?.code ?? "process"}).`));
            else resolve(response);
        });
        child.send({ bytes, maxBytes: 32 * 1024 * 1024 });
    });
    assert.match(result.text, /PACKAGING_ORIGIN_CANARY/);
    assert.match(result.text, /PACKAGING_REPLY_CANARY/);
}

async function checkBrowser(t, destination) {
    const cleanup = [];
    const { context } = await privateFixture({ after: work => cleanup.push(work) }, [fixture("production-browser")]);
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
    for (const name of ["lib", "web", "dist", "vite.config.mjs"]) {
        await cp(new URL(`../${name}`, import.meta.url), path.join(destination, name), { recursive: true });
    }
    await mkdir(path.join(destination, "assets"));
    for (const entry of await readdir(new URL("../assets", import.meta.url), { withFileTypes: true })) {
        if (entry.name !== "fonts" && !/\.(?:svg|json)$/.test(entry.name)) continue;
        await cp(new URL(`../assets/${entry.name}`, import.meta.url), path.join(destination, "assets", entry.name), { recursive: true });
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
}
