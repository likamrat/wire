import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { pdfParserEnvironment } from "../lib/search-corpus-pdf.mjs";

test("production-only installation extracts a real reviewed PDF without development dependencies", { timeout: 180000 }, async t => {
    const records = retainedContextFixture().records.slice(0, 2);
    records[0].userPrompt.text = "PACKAGING_ORIGIN_CANARY";
    records[1].followUpPrompts = [];
    for (const record of records) for (const call of record.toolCalls) call.requestArgs = { entityUrls: ["/me/drive/root/children"] };
    const { context, root } = await privateFixture(t, records), exports = createExportController(context);
    await seedRetainedReply(context, inventedSource(), "PACKAGING_REPLY_CANARY");
    const state = await loadBoardState(context);
    const preview = await exports.preview("packaging-fixture", undefined,
        { promptMode: "original", formats: ["pdf"], recordedContext: true },
        { kind: "selected", revision: state.revision, scenarioIds: [records[0].scenarioId] });
    await exports.review("packaging-fixture", preview.previewId, true);
    const { bundle } = await exports.confirm("packaging-fixture", preview.previewId, true);
    const bytes = await readFile(bundle.files["product-report.pdf"]);
    const directory = path.join(root, "omit-dev");
    await mkdir(directory);
    for (const name of ["package.json", "package-lock.json"]) {
        await copyFile(new URL(`../${name}`, import.meta.url), path.join(directory, name));
    }
    const worker = path.join(directory, "parser.mjs");
    await copyFile(new URL("../lib/search-corpus-pdf-worker.mjs", import.meta.url), worker);
    const args = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], run = promisify(execFile);
    if (process.platform === "win32") await run(process.env.ComSpec, ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd: directory });
    else await run("npm", args, { cwd: directory });
    const installed = JSON.parse(await readFile(path.join(directory, "node_modules", "pdfjs-dist", "package.json")));
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
    assert.equal(installed.version, manifest.dependencies["pdfjs-dist"]);
    await assert.rejects(readFile(path.join(directory, "node_modules", "@playwright", "test", "package.json")), { code: "ENOENT" });
    const result = await new Promise((resolve, reject) => {
        const child = fork(worker, [], { cwd: directory, execPath: process.execPath, execArgv: ["--disallow-code-generation-from-strings"],
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
});
