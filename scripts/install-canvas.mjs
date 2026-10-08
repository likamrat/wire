import { mkdir, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { writeExclusive } from "../lib/store.mjs";
import { PRODUCT_NAME } from "../lib/branding.mjs";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(project, "extension.mjs");
await readFile(entry);
const directory = path.join(os.homedir(), ".copilot", "extensions", "workiq-evidence");
await mkdir(directory, { recursive: true });
const destination = path.join(directory, "extension.mjs");
const content = `// Maintained source lives in the configured ${PRODUCT_NAME} project.\nawait import(${JSON.stringify(pathToFileURL(entry).href)});\n`;
let existing;
try { existing = await readFile(destination, "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing !== content) {
    if (existing !== undefined) {
        await writeExclusive(path.join(directory, `extension-${randomUUID()}.backup`), existing);
    }
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    await writeExclusive(temporary, content);
    await rename(temporary, destination);
}
console.log(`Canvas entry installed: ${destination}`);
console.log(`Reload Copilot extensions to discover ${PRODUCT_NAME}. The local runtime is managed separately.`);
