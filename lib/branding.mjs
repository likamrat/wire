import { readFileSync } from "node:fs";

export const PRODUCT_NAME = "WIRE";
export const PRODUCT_DESCRIPTION = "Work IQ Request Explorer";
export const PRODUCT_TITLE = `${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}`;
export const logoSvg = readFileSync(new URL("../assets/wire-icon.svg", import.meta.url), "utf8");
export const wordmarkSvg = readFileSync(new URL("../assets/wire-wordmark.svg", import.meta.url), "utf8");
export const darkWordmarkSvg = readFileSync(new URL("../assets/wire-wordmark-dark.svg", import.meta.url), "utf8");
export const lockupSvg = readFileSync(new URL("../assets/wire-lockup.svg", import.meta.url), "utf8");
export const darkLockupSvg = readFileSync(new URL("../assets/wire-lockup-dark.svg", import.meta.url), "utf8");

function inlineWordmark(svg, theme) {
    let markup = svg
        .replace('role="img" aria-labelledby="title desc"', `class="brand-logo" aria-hidden="true" focusable="false" data-brand-theme="${theme}"`)
        .replace(/\s*<(title|desc)\b[^>]*>[\s\S]*?<\/\1>/g, "")
        // The application already embeds the same licensed Asta Sans font.
        .replace(/<style>[\s\S]*?<\/style>\s*/g, "");
    // Both theme assets share a document; their paint/clip IDs must remain independent.
    for (const [, id] of [...markup.matchAll(/\bid="([^"]+)"/g)]) {
        markup = markup.replaceAll(`id="${id}"`, `id="wire-${theme}-${id}"`)
            .replaceAll(`url(#${id})`, `url(#wire-${theme}-${id})`);
    }
    return markup;
}

export const brandMark = inlineWordmark(wordmarkSvg, "light");
export const brandDarkMark = inlineWordmark(darkWordmarkSvg, "dark");
export const brandLockup = inlineWordmark(lockupSvg, "light");
export const brandDarkLockup = inlineWordmark(darkLockupSvg, "dark");
export const brandCompactMark = logoSvg
    .replace('role="img" aria-labelledby="title"', 'class="brand-compact" aria-hidden="true" focusable="false"')
    .replace(/\s*<title\b[^>]*>[\s\S]*?<\/title>/g, "");
