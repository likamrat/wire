export function rgb(value) {
    if (/^#[\da-f]{6}$/i.test(value)) return value.slice(1).match(/../g).map(part => parseInt(part, 16));
    if (/^rgba?\(/.test(value)) return value.match(/[\d.]+/g).slice(0, 3).map(Number);
    if (/^color\(srgb /.test(value)) return value.match(/[\d.]+/g).slice(0, 3).map(channel => Number(channel) * 255);
    throw new TypeError(`Unsupported measured color: ${value}`);
}

// Runs in the browser so contrast covers actual paint, not a gradient's solid fallback.
export function measureChartPaint(selector) {
    return [...document.querySelectorAll(selector)].filter(node => node.checkVisibility()).map(node => {
        const css = getComputedStyle(node), svg = node.ownerSVGElement;
        let surface = node.parentElement;
        while (surface && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement;
        const background = getComputedStyle(surface || document.body).backgroundColor;
        let colors, local = true, gradient = false;
        if (svg && css.fill.startsWith("url(")) {
            const reference = css.fill.match(/url\(["']?(.*?)["']?\)$/)[1];
            const id = reference.slice(reference.lastIndexOf("#") + 1);
            const definition = document.getElementById(id);
            local = !!definition && definition.ownerSVGElement === svg &&
                (reference.startsWith("#") || reference.slice(0, reference.lastIndexOf("#")) === location.href.split("#")[0]);
            colors = definition ? [...definition.querySelectorAll("stop")].map(stop => getComputedStyle(stop).stopColor) : [];
            gradient = true;
        } else if (!svg && css.backgroundImage.startsWith("linear-gradient(")) {
            colors = css.backgroundImage.match(/rgba?\([^)]*\)|color\(srgb [^)]*\)/g) || [];
            gradient = true;
        } else colors = [svg ? css.fill : css.backgroundColor];
        return { category: node.dataset.category || node.dataset.segment, background, colors, gradient, local,
            opacity: Number(css.opacity) * (svg ? Number(css.fillOpacity) : 1) };
    });
}

const linear = value => rgb(value).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
export function luminance(value) {
    return linear(value).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}
export function contrast(a, b) {
    const first = luminance(a), second = luminance(b);
    return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}
export function oklab(value) {
    const [r, g, b] = linear(value);
    const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
    const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
    const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
    return [
        .2104542553 * l + .793617785 * m - .0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
        .0259040371 * l + .7827717662 * m - .808675766 * s,
    ];
}
export function distance(a, b) {
    const first = oklab(a), second = oklab(b);
    return 100 * Math.hypot(...first.map((value, index) => value - second[index]));
}
export function pairwise(colors) {
    return Object.entries(colors).flatMap(([first, a], index, entries) => entries.slice(index + 1).map(([second, b]) => ({
        first, second, distance: distance(a, b),
    }))).sort((a, b) => a.distance - b.distance);
}
export function hue(value) {
    const [r, g, b] = rgb(value).map(n => n / 255), max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < .015) return null;
    const sector = max === r ? (g - b) / (max - min) : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    return (sector * 60 + 360) % 360;
}
