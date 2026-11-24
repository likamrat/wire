import { defineConfig, normalizePath } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { uxIcons, lucideLicense } from "./web/ux-icons.mjs";
import { dimensionalIcons } from "./web/dimensional-icons.mjs";
import { searchWireContract } from "./lib/search-wire-contract.mjs";
import { createBrowserBuildStamp } from "./lib/browser-assets.mjs";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const publicModules = new Map([
    ["./web/ux-icons.mjs", { uxIcons, lucideLicense }],
    ["./web/dimensional-icons.mjs", { dimensionalIcons }],
].map(([file, values]) => [normalizePath(fileURLToPath(new URL(file, import.meta.url))), values]));

export default defineConfig({
    base: "/assets/client/",
    plugins: [
        {
            name: "wire-public-icon-assets",
            enforce: "pre",
            load(id) {
                const values = publicModules.get(normalizePath(id));
                if (!values) return null;
                return Object.entries(values).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join("\n");
            },
            async generateBundle() {
                const files = [...this.getModuleIds()].flatMap(id => {
                    if (id.startsWith("\0")) return [];
                    const relative = path.relative(projectRoot, id.split("?")[0]).split(path.sep).join("/");
                    return /^(?:web|lib)\//.test(relative) ? [relative] : [];
                });
                this.emitFile({ type: "asset", fileName: "wire-build.json",
                    source: JSON.stringify(await createBrowserBuildStamp(files)) });
            },
        },
        react(),
    ],
    define: {
        __WIRE_TEXT_POLICY__: JSON.stringify({
            matchPolicyId: searchWireContract.matchPolicyId, types: searchWireContract.allTypes,
        }),
    },
    build: {
        target: "es2022",
        outDir: "dist/client",
        assetsDir: "",
        manifest: true,
        sourcemap: false,
        rolldownOptions: {
            input: {
                browser: fileURLToPath(new URL("./web/browser-entry.mjs", import.meta.url)),
                evaluation: fileURLToPath(new URL("./web/frontend/entry.tsx", import.meta.url)),
            },
            external: id => id.startsWith("/assets/"),
        },
    },
});
