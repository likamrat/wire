import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function check(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!["node_modules", ".git", "test-results", "playwright-report"].includes(entry.name)) await check(file);
        } else if (/\.(?:cjs|mjs|js)$/.test(entry.name)) {
            const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
            if (result.error) throw result.error;
            if (result.status !== 0) process.exit(result.status ?? 1);
        }
    }
}

await check(process.cwd());
console.log("JavaScript syntax checks passed.");
