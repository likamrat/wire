import { readFileSync } from "node:fs";

export const PRODUCT_NAME = "WIRE";
export const PRODUCT_DESCRIPTION = "Work IQ Request Explorer";
export const PRODUCT_TITLE = `${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}`;
export const FAVICON_PATH = "/favicon.svg?v=human-path-2";
export const logoSvg = readFileSync(new URL("../assets/wire-icon.svg", import.meta.url), "utf8").replaceAll("\r\n", "\n");
export const darkLogoSvg = readFileSync(new URL("../assets/wire-icon-dark.svg", import.meta.url), "utf8").replaceAll("\r\n", "\n");
export const wordmarkSvg = readFileSync(new URL("../assets/wire-wordmark.svg", import.meta.url), "utf8");
export const darkWordmarkSvg = readFileSync(new URL("../assets/wire-wordmark-dark.svg", import.meta.url), "utf8");
export const lockupSvg = readFileSync(new URL("../assets/wire-lockup.svg", import.meta.url), "utf8").replaceAll("\r\n", "\n");
export const darkLockupSvg = readFileSync(new URL("../assets/wire-lockup-dark.svg", import.meta.url), "utf8").replaceAll("\r\n", "\n");

function inlineWordmark(svg, theme, className = "brand-logo", scope = theme) {
    let markup = svg
        .replace(/role="img" aria-labelledby="title(?: desc)?"/, `class="${className}" aria-hidden="true" focusable="false"${theme ? ` data-brand-theme="${theme}"` : ""}`)
        .replace(/\s*<(title|desc)\b[^>]*>[\s\S]*?<\/\1>/g, "")
        // Inline assets follow the application's explicit theme, not standalone SVG media rules.
        .replace(/<style>[\s\S]*?<\/style>\s*/g, "");
    // Both theme assets share a document; their paint/clip IDs must remain independent.
    for (const [, id] of [...markup.matchAll(/\bid="([^"]+)"/g)]) {
        markup = markup.replaceAll(`id="${id}"`, `id="wire-${scope}-${id}"`)
            .replaceAll(`url(#${id})`, `url(#wire-${scope}-${id})`);
    }
    return markup;
}

// These two assets remain byte-compatible inputs to historical report rendering.
export const brandMark = inlineWordmark(wordmarkSvg, "light");
export const brandDarkMark = inlineWordmark(darkWordmarkSvg, "dark");
export const brandV1Mark = inlineWordmark(readFileSync(new URL("../assets/wire-report-brand-v1.svg", import.meta.url), "utf8").replaceAll("\r\n", "\n"), "light");
export const brandV1DarkMark = inlineWordmark(readFileSync(new URL("../assets/wire-report-brand-v1-dark.svg", import.meta.url), "utf8").replaceAll("\r\n", "\n"), "dark");
export const brandLockup = inlineWordmark(lockupSvg, "light");
export const brandDarkLockup = inlineWordmark(darkLockupSvg, "dark");
export const brandCompactMark = inlineWordmark(logoSvg, null, "brand-compact", "compact");
