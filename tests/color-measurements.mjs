export function rgb(value) {
    if (/^#[\da-f]{6}$/i.test(value)) return value.slice(1).match(/../g).map(part => parseInt(part, 16));
    if (/^rgba?\(/.test(value)) return value.match(/[\d.]+/g).slice(0, 3).map(Number);
    if (/^color\(srgb /.test(value)) return value.match(/[\d.]+/g).slice(0, 3).map(channel => Number(channel) * 255);
    throw new TypeError(`Unsupported measured color: ${value}`);
}

// Scan a flat widget's actual ink and marks, excluding its rounded outer border.
export async function paintedWidgetInsets(card, screenshotPath, foregroundSelector) {
    const image = await card.screenshot({ path: screenshotPath, animations: "disabled" });
    return card.evaluate(async (node, { base64, foregroundSelector }) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const bounds = node.getBoundingClientRect(), scale = width / bounds.width, css = getComputedStyle(node);
        const surface = (width * 2 + Math.floor(width / 2)) * 4;
        const inset = Math.ceil(Math.max(20, parseFloat(css.borderTopLeftRadius)) * scale);
        const foreground = foregroundSelector ? node.querySelector(foregroundSelector)?.getBoundingClientRect() : bounds;
        if (!foreground) throw new Error(`Missing measured widget foreground: ${foregroundSelector}`);
        const left = Math.max(inset, Math.floor((foreground.left - bounds.left) * scale));
        const right = Math.min(width - inset, Math.ceil((foreground.right - bounds.left) * scale));
        const top = Math.max(3, Math.floor((foreground.top - bounds.top) * scale));
        const bottom = Math.min(height - 3, Math.ceil((foreground.bottom - bounds.top) * scale));
        let first = height, last = -1;
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
            const i = (y * width + x) * 4;
            if (Math.max(Math.abs(data[i] - data[surface]), Math.abs(data[i + 1] - data[surface + 1]),
                Math.abs(data[i + 2] - data[surface + 2])) >= 24) {
                first = Math.min(first, y); last = Math.max(last, y);
            }
        }
        if (last < first) throw new Error("The widget has no measurable foreground paint.");
        return { top: first / scale - parseFloat(css.borderTopWidth),
            bottom: (height - last - 1) / scale - parseFloat(css.borderBottomWidth),
            width: bounds.width, height: bounds.height };
    }, { base64: image.toString("base64"), foregroundSelector });
}

// Measure ordinary screen text against its composed surface, including inset control faces.
export function visibleInk() {
    const rgba = value => {
        if (value.startsWith("color(srgb")) {
            const [color, alpha] = value.slice(11, -1).split("/");
            return [...color.trim().split(/\s+/).map(v => Number(v) * 255), Number(alpha ?? 1)];
        }
        const values = value.match(/[\d.]+/g).map(Number);
        return [...values.slice(0, 3), values[3] ?? 1];
    };
    const blend = (a, b) => a.slice(0, 3).map((n, i) => n * a[3] + b[i] * (1 - a[3]));
    function background(node) {
        if (!node) return [255, 255, 255];
        const css = getComputedStyle(node), surface = blend(rgba(css.backgroundColor), background(node.parentElement));
        const before = getComputedStyle(node, "::before");
        const coversText = parseFloat(before.width) >= node.getBoundingClientRect().width * .8
            && parseFloat(before.height) >= parseFloat(css.lineHeight);
        return before.content !== "none" && before.display !== "none" && coversText
            ? blend(rgba(before.backgroundColor), surface) : surface;
    }
    return [...document.querySelectorAll("body *")].filter(node => node.checkVisibility({ visibilityProperty: true })
        && !node.closest(".visually-hidden,.skip-link,svg,iframe") && !node.matches("option")
        && ([...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())
            || node.matches("input:not([type=checkbox],[type=radio]),textarea")))
        .map(node => {
            const css = getComputedStyle(node), bg = background(node), color = value => `rgb(${value.slice(0, 3).join(",")})`;
            return { target: node.id || node.tagName + "." + node.className, background: color(bg),
                ink: color(blend(rgba(css.color), bg)), font: css.fontFamily, weight: css.fontWeight,
                cardEmphasis: node.matches("#requestContent .reader-facts dt, #requestContent .facts dt") ? "400"
                    : node.matches("#activityList>.activity-card .activity-card-facts dt") ? "400"
                        : node.matches("#activityList>.activity-card .card-tool-name") ? "400" : null,
                placeholder: node.hasAttribute("placeholder") ? color(blend(rgba(getComputedStyle(node, "::placeholder").color), bg)) : null,
                code: !!node.closest("code,kbd,samp,.mono,pre:not(.full-text-content)") };
        });
}

// Browser-side paint measurement includes alpha edges and the action's inset face.
export function measureControlSurface(node) {
    const rgba = value => {
        if (value.startsWith("color(srgb")) {
            const [color, alpha] = value.slice(11, -1).split("/");
            return [...color.trim().split(/\s+/).map(channel => Number(channel) * 255), Number(alpha ?? 1)];
        }
        if (!/^rgba?\(/.test(value)) throw new Error(`Unsupported control color: ${value}`);
        const values = value.match(/[\d.]+/g).map(Number);
        return [...values.slice(0, 3), values[3] ?? 1];
    };
    const blend = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3]));
    const color = value => `rgb(${value.slice(0, 3).join(",")})`;
    function background(element) {
        return element ? blend(rgba(getComputedStyle(element).backgroundColor), background(element.parentElement)) : [255, 255, 255];
    }
    const css = getComputedStyle(node), before = getComputedStyle(node, "::before"), box = node.getBoundingClientRect();
    const backdrop = background(node.parentElement), own = blend(rgba(css.backgroundColor), backdrop);
    const inset = before.content !== "none" && parseFloat(before.width) >= box.width * .8
        && parseFloat(before.height) >= parseFloat(css.lineHeight);
    const paint = inset ? before : css;
    let opacity = 1;
    for (let parent = node; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
    const face = inset ? blend(rgba(before.backgroundColor), own) : own;
    const edge = parseFloat(paint.borderTopWidth) > 0 && paint.borderTopStyle !== "none" ? rgba(paint.borderTopColor) : [...face, 1];
    const border = blend(edge, face);
    const ink = blend(rgba(css.color), face);
    const focus = css.outlineStyle === "none" && inset ? before : css;
    const visible = value => color(blend([...value, opacity], backdrop));
    return { backdrop: color(backdrop), face: visible(face), border: visible(border), ink: visible(ink),
        borderWidth: parseFloat(paint.borderTopWidth),
        focus: focus.outlineStyle !== "none" ? color(blend(rgba(focus.outlineColor), backdrop)) : null,
        focusWidth: parseFloat(focus.outlineWidth), fontSize: parseFloat(css.fontSize),
        box: box.toJSON(), disabled: node.matches(":disabled,[aria-disabled=true]") };
}

export async function shadowPaint(page, selector, side, distances = [2, 6, 12, 24, 40]) {
    const bounds = await page.locator(selector).boundingBox();
    const baseline = await page.screenshot();
    await page.locator(selector).evaluate(node => node.style.setProperty("box-shadow", "none", "important"));
    const flat = await page.screenshot();
    await page.locator(selector).evaluate(node => node.style.removeProperty("box-shadow"));
    const result = await page.evaluate(async ({ before, after, bounds, side, distances }) => {
        async function pixels(base64) {
            const image = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))]));
            const canvas = document.createElement("canvas");
            canvas.width = image.width; canvas.height = image.height;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            image.close();
            return context.getImageData(0, 0, canvas.width, canvas.height);
        }
        const a = await pixels(before), b = await pixels(after), bands = [];
        const bottom = side === "bottom";
        const edge = bottom ? bounds.y + bounds.height : side === "right" ? bounds.x + bounds.width : bounds.x;
        for (const distance of distances) {
            const cross = Math.floor(edge + (side === "left" ? -distance : distance));
            let delta = 0, count = 0;
            const start = Math.ceil(bottom ? bounds.x + 20 : bounds.y + 80);
            const end = bottom ? Math.min(a.width, bounds.x + bounds.width) - 20 : Math.min(a.height, bounds.y + bounds.height) - 40;
            for (let along = start; along < end; along++) {
                const x = bottom ? along : cross, y = bottom ? cross : along;
                if (x < 0 || x >= a.width || y < 0 || y >= a.height) continue;
                const i = (y * a.width + x) * 4;
                delta += (b.data[i] - a.data[i] + b.data[i + 1] - a.data[i + 1] + b.data[i + 2] - a.data[i + 2]) / 3;
                count++;
            }
            bands.push({ distance, darkening: count ? delta / count : 0 });
        }
        return bands;
    }, { before: baseline.toString("base64"), after: flat.toString("base64"), bounds, side, distances });
    return { bands: result, screenshot: baseline };
}

// Hide only text ink in the second exposure; the pseudo-face and composited opacity remain.
export async function paintedLabelContrast(control) {
    const before = await control.screenshot();
    const face = await control.screenshot({ style: "*{-webkit-text-fill-color:transparent!important;text-shadow:none!important}" });
    return control.evaluate(async (_, [normal, blank]) => {
        async function pixels(value) {
            const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(value), c => c.charCodeAt(0))]));
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0); bitmap.close();
            return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        }
        const [a, b] = await Promise.all([pixels(normal), pixels(blank)]);
        if (a.length !== b.length) throw new Error("The control moved during the paint measurement.");
        const channel = v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
        const luminance = (data, i) => .2126 * channel(data[i] / 255) + .7152 * channel(data[i+1] / 255) + .0722 * channel(data[i+2] / 255);
        const ratios = [];
        for (let i = 0; i < a.length; i += 4) {
            if (a[i] === b[i] && a[i+1] === b[i+1] && a[i+2] === b[i+2]) continue;
            const l = luminance(a, i), r = luminance(b, i);
            ratios.push((Math.max(l, r) + .05) / (Math.min(l, r) + .05));
        }
        ratios.sort((a, b) => a-b);
        return ratios[Math.floor(ratios.length * .99)] ?? 1;
    }, [before.toString("base64"), face.toString("base64")]);
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
