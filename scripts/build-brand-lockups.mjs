import { readFile, writeFile } from "node:fs/promises";

const artwork = JSON.parse(await readFile(new URL("../assets/wire-brand.json", import.meta.url), "utf8"));
if (process.argv.slice(2).some(argument => argument !== "--check")) {
    throw new TypeError("Usage: node scripts/build-brand-lockups.mjs [--check]");
}
const check = process.argv.includes("--check");
const paths = [artwork?.symbol?.outline, artwork?.symbol?.shade, artwork?.lettering?.path];
const dimensions = [artwork?.symbol?.width, artwork?.symbol?.height, artwork?.lettering?.width, artwork?.lettering?.height];
if (artwork?.schemaVersion !== 1
    || !paths.every(value => typeof value === "string" && /^[Mm][MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(value))
    || !dimensions.every(value => Number.isFinite(value) && value > 0)) {
    throw new TypeError("Unsupported or incomplete WIRE brand artwork.");
}
for (const gradient of [artwork.symbol.upperGradient, artwork.symbol.lowerGradient]) {
    if (!["x1", "y1", "x2", "y2"].every(key => Number.isFinite(gradient?.[key]))) {
        throw new TypeError("WIRE brand gradients need finite coordinates.");
    }
}
for (const theme of ["light", "dark"]) for (const role of ["low", "high", "ink"]) {
    if (!/^#[a-f0-9]{6}$/i.test(artwork.palette?.[theme]?.[role] ?? "")) {
        throw new TypeError(`WIRE brand palette is missing ${theme}/${role}.`);
    }
}

const number = value => Number(value.toFixed(8));
const iconScale = 82 / Math.max(artwork.symbol.width, artwork.symbol.height);
const iconY = number((82 - artwork.symbol.height * iconScale) / 2);
const wordScale = 292 / artwork.lettering.width;
const wordY = number((82 - artwork.lettering.height * wordScale) / 2);

function gradient(id, coordinates, palette) {
    return `    <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${coordinates.x1}" y1="${coordinates.y1}" x2="${coordinates.x2}" y2="${coordinates.y2}">
      <stop class="brand-low" stop-color="${palette.low}"/>
      <stop class="brand-high" offset="1" stop-color="${palette.high}"/>
    </linearGradient>`;
}

function svg(theme, { icon = false, adaptive = false } = {}) {
    const palette = artwork.palette[theme];
    const dark = artwork.palette.dark;
    const media = adaptive ? `\n  <style>@media(prefers-color-scheme:dark){.brand-low{stop-color:var(--wire-brand-dark-low)}.brand-high{stop-color:var(--wire-brand-dark-high)}}</style>` : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon ? 82 : 402} 82" role="img" aria-labelledby="title desc" style="--wire-brand-low:${palette.low};--wire-brand-high:${palette.high};--wire-brand-dark-low:${dark.low};--wire-brand-dark-high:${dark.high}">
  <title id="title">WIRE</title>
  <desc id="desc">Magenta Human Path ${icon ? "symbol" : "symbol and custom WIRE lettering"}.</desc>
  <defs>
${gradient("human-path-upper", artwork.symbol.upperGradient, palette)}
${gradient("human-path-lower", artwork.symbol.lowerGradient, palette)}
    <clipPath id="human-path-boundary"><path d="${artwork.symbol.outline}" clip-rule="evenodd"/></clipPath>
  </defs>${media}
  <g transform="translate(0 ${iconY}) scale(${number(iconScale)})">
    <path d="${artwork.symbol.outline}" fill="url(#human-path-upper)" fill-rule="evenodd"/>
    <path d="${artwork.symbol.shade}" fill="url(#human-path-lower)" clip-path="url(#human-path-boundary)" fill-rule="evenodd"/>
  </g>${icon ? "" : `
  <path id="wire-lettering" transform="translate(110 ${wordY}) scale(${number(wordScale)})" d="${artwork.lettering.path}" fill="${palette.ink}" fill-rule="evenodd"/>`}
</svg>
`;
}

// Historical wire-wordmark and wire-report-brand-v1 assets are never generator outputs.
for (const [file, theme, options] of [
    ["wire-lockup.svg", "light", {}],
    ["wire-lockup-dark.svg", "dark", {}],
    ["wire-icon.svg", "light", { icon: true, adaptive: true }],
    ["wire-icon-dark.svg", "dark", { icon: true }],
]) {
    const target = new URL(`../assets/${file}`, import.meta.url), expected = svg(theme, options);
    if (check) {
        const actual = (await readFile(target, "utf8")).replaceAll("\r\n", "\n");
        if (actual !== expected) throw new Error(`${file} is out of date; regenerate the current brand assets.`);
    } else await writeFile(target, expected);
}
