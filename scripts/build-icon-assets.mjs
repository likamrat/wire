import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile, writeFile } from "node:fs/promises";
import * as selected from "./react-icon-selection.mjs";
import { uxIconSources, serviceIconSources, componentName, iconProps } from "../web/icon-roles.mjs";

const assets = new URL("../assets/", import.meta.url);
const glyphs = {};
for (const name of [...new Set([...Object.values(uxIconSources), ...Object.values(serviceIconSources)])].sort()) {
    const component = componentName(name);
    if (!Object.hasOwn(selected, component)) throw new TypeError(`Missing React Icons component ${component} for ${name}`);
    glyphs[name] = renderToStaticMarkup(createElement(selected[component], iconProps("WIRE_ROLE", name, "WIRE_SIZE")));
}
const wrapper = (await readFile(new URL("../LICENSE", import.meta.resolve("react-icons/lu")), "utf8")).split(/\r?\n---/)[0].trim();
const family = (await readFile(new URL("lucide-LICENSE.txt", assets), "utf8")).replaceAll("\r\n", "\n").trim();
const license = `React Icons (MIT)\n${wrapper.replaceAll("\r\n", "\n")}\n\nLucide (ISC); Feather-derived icons (MIT)\n${family}`;
const output = JSON.stringify({ license, glyphs }, null, 2) + "\n";
const destination = new URL("react-icons-lucide.json", assets);
if (process.argv.includes("--write")) await writeFile(destination, output);
else if ((await readFile(destination, "utf8")).replaceAll("\r\n", "\n") !== output) {
    throw new Error("React Icons assets are stale. Run npm run icons:generate and review the change.");
}
