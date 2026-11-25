import { build } from "esbuild";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canvasDeclaration, canvasActions, agentTools } from "../lib/copilot-extension-manifest.mjs";
import { createCopilotAccountBridge } from "../lib/copilot-account-snapshot.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION } from "../lib/branding.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const check = process.argv.includes("--check");
const committed = path.join(root, "plugin");
const catalog = path.join(root, ".github", "plugin", "marketplace.json");
const plugin = { name: "wire", version: pkg.version, description: pkg.description };

// Files the bundled runtime reads relative to lib/wire.mjs, kept at the same relative paths.
const copies = [
    "lib/assessment-contract.mjs", "lib/period-comparison-math.mjs", "lib/report-result-contract.mjs",
    "lib/report-outcome-comparison.mjs", "lib/report-metric-comparison.mjs", "lib/wire-report-metric-adapter.mjs",
    "web/recorded-results.mjs",
    "assets/fonts/OFL.txt", "assets/fonts/asta-sans-latin-variable.woff2",
    ...["icon", "icon-dark", "lockup", "lockup-dark", "wordmark", "wordmark-dark", "report-brand-v1", "report-brand-v1-dark"]
        .map(name => `assets/wire-${name}.svg`),
    "dist/client",
    "node_modules/marked/lib/marked.esm.js", "node_modules/marked/LICENSE",
    "node_modules/pdfjs-dist/build/pdf.mjs", "node_modules/pdfjs-dist/build/pdf.worker.mjs",
    "node_modules/pdfjs-dist/cmaps", "node_modules/pdfjs-dist/standard_fonts", "node_modules/pdfjs-dist/LICENSE",
];

async function generate(out) {
    const extension = path.join(out, "com.github.copilot", "extensions", "wire");
    await rm(path.join(out, "com.github.copilot"), { recursive: true, force: true });
    await rm(path.join(out, "extensions"), { recursive: true, force: true });
    await mkdir(path.join(extension, "lib"), { recursive: true });
    await build({
        entryPoints: [path.join(root, "lib", "copilot-extension.mjs")],
        outfile: path.join(extension, "lib", "wire.mjs"),
        bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "eof", logLevel: "warning",
        external: ["@github/copilot-sdk", "@github/copilot-sdk/*", "playwright", "/assets/*"],
        define: { __WIRE_PACKAGED__: "true" },
        banner: { js: 'import { createRequire as __wireCreateRequire } from "node:module";\nconst require = __wireCreateRequire(import.meta.url);' },
    });
    await writeFile(path.join(extension, "extension.mjs"), 'import "./lib/wire.mjs";\n');
    const { name, description, parameters } = createCopilotAccountBridge(() => undefined).tool;
    await writeFile(path.join(extension, "extension.json"), JSON.stringify({
        version: 1, initialization: "module",
        tools: [{ name, description, parameters }, ...agentTools],
        canvases: [{ ...canvasDeclaration, actions: canvasActions }],
    }, null, 2) + "\n");
    for (const file of copies) await cp(path.join(root, file), path.join(extension, file), { recursive: true });
    await cp(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
    await writeFile(path.join(out, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        ...plugin, license: pkg.license, repository: "https://github.com/likamrat/wire",
        keywords: ["work-iq", "copilot", "evidence", "canvas"],
    }, null, 2) + "\n");
}

function marketplace() {
    return JSON.stringify({
        name: "wire", owner: { name: "likamrat" },
        metadata: { description: `Install ${PRODUCT_NAME} in the GitHub Copilot app.` },
        plugins: [{ ...plugin, source: "./plugin" }],
    }, null, 2) + "\n";
}

async function digestTree(directory, base = directory, files = new Map()) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await digestTree(file, base, files);
        else files.set(path.relative(base, file).split(path.sep).join("/"), createHash("sha256").update(await readFile(file)).digest("hex"));
    }
    return files;
}

if (check) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "wire-plugin-"));
    try {
        await cp(path.join(committed, "skills"), path.join(temporary, "skills"), { recursive: true });
        await generate(temporary);
        const [expected, actual] = await Promise.all([digestTree(temporary), digestTree(committed)]);
        const changed = [...new Set([...expected.keys(), ...actual.keys()])].filter(file => expected.get(file) !== actual.get(file)).sort();
        if (await readFile(catalog, "utf8").catch(() => "") !== marketplace()) changed.push(".github/plugin/marketplace.json");
        if (changed.length) {
            console.error(`plugin/ is out of date (${changed.length} file(s), e.g. ${changed.slice(0, 5).join(", ")}). Run npm run build:plugin and commit the result.`);
            process.exitCode = 1;
        } else console.log("plugin/ matches the current source.");
    } finally { await rm(temporary, { recursive: true, force: true }); }
} else {
    await generate(committed);
    await mkdir(path.dirname(catalog), { recursive: true });
    await writeFile(catalog, marketplace());
    console.log("Plugin built in plugin/. Test it with: copilot plugin marketplace add . && copilot plugin install wire@wire");
}
