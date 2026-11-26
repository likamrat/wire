// Harbor outcome paint for screens only. Every palette derives the same cool blue completion,
// softened coral failure and quiet quantity ink from its own roles. Values are fixed sRGB hex so
// no browser has to resolve relative color syntax. Saved reports never read these roles.
const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const toLinear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const fromLinear = c => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

function hexToOklch(hex) {
    const [r, g, b] = hexToRgb(hex).map(toLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
}

function oklchToLinear(L, C, H) {
    const a = C * Math.cos(H * Math.PI / 180), b = C * Math.sin(H * Math.PI / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

// Keep lightness and hue; reduce chroma until the color fits sRGB.
export function oklchHex(L, C, H) {
    const fits = c => oklchToLinear(L, c, H).every(v => v >= -1e-6 && v <= 1 + 1e-6);
    let low = 0, high = C;
    if (!fits(C)) for (let i = 0; i < 24; i++) { const mid = (low + high) / 2; if (fits(mid)) low = mid; else high = mid; }
    else low = C;
    return "#" + oklchToLinear(L, low, H).map(v => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))) * 255)
        .toString(16).padStart(2, "0")).join("");
}

export function harborOutcomeRoles({ masked, negative, returned }, mode) {
    const [, , blue] = hexToOklch(masked), [, , coral] = hexToOklch(negative), [, , amber] = hexToOklch(returned);
    const light = mode === "light", red = coral + 6;
    const mark = { positive: oklchHex(light ? 0.56 : 0.76, light ? 0.135 : 0.1, blue), negative: oklchHex(light ? 0.6 : 0.77, light ? 0.13 : 0.1, red) };
    return {
        // Text sits on tinted chips as well as paper, so it keeps more contrast than the marks.
        "tool-positive": oklchHex(light ? 0.46 : 0.82, light ? 0.13 : 0.085, blue),
        "tool-negative": oklchHex(light ? 0.46 : 0.82, light ? 0.13 : 0.085, red),
        "tool-positive-mark": mark.positive,
        "tool-negative-mark": mark.negative,
        "outcome-quantity": oklchHex(light ? 0.6 : 0.74, light ? 0.07 : 0.05, blue),
        "outcome-returned-mark": oklchHex(light ? 0.62 : 0.8, light ? 0.1 : 0.08, amber),
    };
}

export const harborOutcomeCss = (palette, mode) => Object.entries(harborOutcomeRoles(palette, mode))
    .map(([name, value]) => `--${name}:${value};`).join("");
