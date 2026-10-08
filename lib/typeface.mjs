import { readFileSync } from "node:fs";

export const uiFontStack = '"Asta Sans","Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif';
export const fontDataUrl = `data:font/woff2;base64,${readFileSync(new URL("../assets/fonts/asta-sans-latin-variable.woff2", import.meta.url)).toString("base64")}`;
const license = readFileSync(new URL("../assets/fonts/OFL.txt", import.meta.url), "utf8");

// Keep the license with every immutable HTML/PDF source that embeds the font.
export const fontFaceStyles = `
/* ${license.replaceAll("*/", "* /")} */
@font-face {
 font-family:"Asta Sans";src:url("${fontDataUrl}") format("woff2");
 font-style:normal;font-weight:300 800;font-display:swap;
 unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
`;
