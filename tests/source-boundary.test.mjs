import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirFor } from "../lib/paths.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("runtime refuses private storage inside maintained source", () => {
    assert.throws(() => dataDirFor({ dataDir: root }), /outside/);
    assert.throws(() => dataDirFor({ dataDir: path.join(root, "private") }), /outside/);
    assert.throws(() => dataDirFor({ dataDir: "relative-data" }), /absolute/);
});

test("maintained source contains no embedded evidence collection or private runtime artifacts", async () => {
    const constants = await readFile(path.join(root, "lib", "evidence.mjs"), "utf8");
    assert.doesNotMatch(constants, /REAL_EVIDENCE|userPrompt|sourceSessionId/);
    async function check(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (["node_modules", ".git", "test-results", "playwright-report"].includes(entry.name)) continue;
            const file = path.join(directory, entry.name);
            assert.ok(!["app-inventory.json", "history-window.json", "events.jsonl", "scenarios.jsonl", "workiq-board-data", "private-evidence"].includes(entry.name), `Private artifact in source: ${file}`);
            if (entry.isDirectory()) await check(file);
            else if (/\.(?:mjs|json|md)$/.test(entry.name) && !file.includes(`${path.sep}tests${path.sep}`)) {
                const text = await readFile(file, "utf8");
                assert.doesNotMatch(text, /[A-Z]:\\{1,2}Users\\{1,2}[^\\\r\n"']+\\{1,2}\.copilot\\{1,2}session-state\\{1,2}[a-f0-9-]{36}/i, `Session-specific dependency in ${file}`);
            }
        }
    }
    await check(root);
});
