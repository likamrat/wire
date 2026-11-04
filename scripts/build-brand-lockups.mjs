import { readFile, writeFile } from "node:fs/promises";
import { fontFaceStyles } from "../lib/typeface.mjs";

for (const [name, source, ink] of [
    ["wire-lockup.svg", "wire-wordmark.svg", "#1b2d45"],
    ["wire-lockup-dark.svg", "wire-wordmark-dark.svg", "#c1d1df"],
]) {
    const wordmark = await readFile(new URL(`../assets/${source}`, import.meta.url), "utf8");
    const lockup = wordmark
        .replace('viewBox="24 62 500 158"', 'viewBox="24 62 500 204"')
        .replace("</defs>", `<style><![CDATA[${fontFaceStyles}]]></style>\n  </defs>`)
        .replace("</svg>", `  <text id="descriptor" x="35" y="253" fill="${ink}" font-family="Asta Sans" font-size="40" font-weight="400" letter-spacing="0">Work IQ Request Explorer</text>\n</svg>`);
    await writeFile(new URL(`../assets/${name}`, import.meta.url), lockup.replaceAll("\r\n", "\n").replace(/[ \t]+$/gm, ""));
}
