import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { marked } from "marked";

// GitHub's global.css uses page theme for these links, with OS preference only in auto mode.
const githubImageThemes = `
:root[data-color-mode=dark] .readme [href$="#gh-light-mode-only"],
:root[data-color-mode=light] .readme [href$="#gh-dark-mode-only"] { display: none; }
@media (prefers-color-scheme: dark) {
    :root[data-color-mode=auto] .readme [href$="#gh-light-mode-only"] { display: none; }
}
@media (prefers-color-scheme: light) {
    :root[data-color-mode=auto] .readme [href$="#gh-dark-mode-only"] { display: none; }
}`;

test("GitHub page themes select one legible README logo and matching responsive diagrams independently of OS theme", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", async route => {
            const url = new URL(route.request().url());
            assert.equal(url.origin, "http://wire-docs.test", "Documentation proof must not fetch external assets");
            const file = new URL(".." + url.pathname, import.meta.url);
            const body = await readFile(file);
            await route.fulfill({ contentType: url.pathname.endsWith(".svg") ? "image/svg+xml" : "image/png", body });
        });
        const themes = [
            { mode: "dark", os: "light", expected: "dark" },
            { mode: "light", os: "dark", expected: "light" },
            { mode: "dark", os: "dark", expected: "dark" },
            { mode: "light", os: "light", expected: "light" },
            { mode: "auto", os: "dark", expected: "dark" },
            { mode: "auto", os: "light", expected: "light" },
        ];
        for (const file of ["README.md", "docs/architecture.md"]) {
            const markdown = await readFile(new URL("../" + file, import.meta.url), "utf8");
            await page.setContent(`<base href="http://wire-docs.test/${file}"><style>${githubImageThemes}</style>
                <article class="readme">${marked.parse(markdown)}</article>`);
            for (const width of [1280, 440]) {
                await page.setViewportSize({ width, height: 900 });
                for (const { mode, os, expected } of themes) {
                    await page.emulateMedia({ colorScheme: os });
                    await page.evaluate(mode => document.documentElement.dataset.colorMode = mode, mode);
                    const dark = expected === "dark" ? "-dark" : "";
                    if (file === "README.md") {
                        const logo = page.locator('img[alt="WIRE"]:visible');
                        await expect(logo).toHaveCount(1);
                        await expect.poll(() => logo.evaluate(image => new URL(image.currentSrc).pathname))
                            .toBe(`/docs/images/wire-readme-logo${dark}.svg`);
                        await expect.poll(() => logo.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
                        if (width === 1280) {
                            const source = await readFile(new URL(`../docs/images/wire-readme-logo${dark}.svg`, import.meta.url));
                            const color = await page.evaluate(async svg => {
                                const image = new Image();
                                image.src = `data:image/svg+xml;base64,${svg}`;
                                await image.decode();
                                const canvas = document.createElement("canvas");
                                canvas.width = 402; canvas.height = 82;
                                const context = canvas.getContext("2d");
                                context.drawImage(image, 0, 0, 402, 82);
                                return [...context.getImageData(244, 41, 1, 1).data];
                            }, source.toString("base64"));
                            assert.equal(color[3], 255, "Measure an opaque pixel inside the WIRE lettering");
                            const luminance = rgb => rgb.slice(0, 3).reduce((sum, value, index) => {
                                const channel = value / 255;
                                return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
                                    * [.2126, .7152, .0722][index];
                            }, 0);
                            for (const background of expected === "dark" ? [[13, 17, 23], [34, 39, 46]] : [[255, 255, 255]]) {
                                const a = luminance(color), b = luminance(background);
                                assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5,
                                    "The selected wordmark must be readable on GitHub Light, Dark and Dark dimmed");
                            }
                        }
                    }
                    const name = file === "README.md" ? "wire-evidence-flow" : "wire-runtime";
                    const diagram = page.locator(`img[src*="${name}"]:visible`);
                    await expect(diagram).toHaveCount(1);
                    await expect.poll(() => diagram.evaluate(image => new URL(image.currentSrc).pathname))
                        .toBe(`/docs/images/${name}${width < 768 ? "-narrow" : ""}${dark}.png`);
                    const href = await diagram.evaluate(image => image.closest("a").href);
                    assert.equal(new URL(href).pathname, `/docs/images/${name}${dark}.png`);
                    await expect.poll(() => diagram.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
                }
            }
        }
    } finally {
        await browser.close();
    }
});

test("README-scale brand strokes have clean contours rather than traced pixel teeth", async () => {
    const source = await readFile(new URL("../assets/wire-lockup-dark.svg", import.meta.url));
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const measurements = await page.evaluate(async svg => {
            const image = new Image();
            image.src = `data:image/svg+xml;base64,${svg}`;
            await image.decode();
            const scale = 4, canvas = document.createElement("canvas");
            canvas.width = 402 * scale; canvas.height = 82 * scale;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const alpha = (x, y) => x < 0 || x >= canvas.width ? 0 : pixels[(y * canvas.width + x) * 4 + 3];
            function edge({ name, left, right, top, bottom, side }) {
                const points = [];
                for (let y = top * scale; y < bottom * scale; y++) {
                    let x = side === "left" ? left * scale : right * scale;
                    const step = side === "left" ? 1 : -1;
                    while (x >= left * scale && x <= right * scale && alpha(x, y) < 128) x += step;
                    if (x < left * scale || x > right * scale) throw new Error(`Missing ${name} edge at ${y}`);
                    const inside = alpha(x, y), outside = alpha(x - step, y);
                    const crossing = x - step + step * (128 - outside) / (inside - outside);
                    points.push([y / scale, crossing / scale]);
                }
                const n = points.length, meanY = points.reduce((sum, p) => sum + p[0], 0) / n;
                const meanX = points.reduce((sum, p) => sum + p[1], 0) / n;
                const slope = points.reduce((sum, p) => sum + (p[0] - meanY) * (p[1] - meanX), 0)
                    / points.reduce((sum, p) => sum + (p[0] - meanY) ** 2, 0);
                const residuals = points.map(([y, x]) => x - meanX - slope * (y - meanY));
                return { name, rms: Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / n),
                    maximumDeviation: Math.max(...residuals.map(Math.abs)) };
            }
            return [
                edge({ name: "W outer diagonal", left: 110, right: 228, top: 16, bottom: 65, side: "left" }),
                edge({ name: "I right stem", left: 230, right: 258, top: 16, bottom: 65, side: "right" }),
                edge({ name: "R outer diagonal", left: 260, right: 338, top: 54, bottom: 70, side: "right" }),
                edge({ name: "symbol left wall", left: 0, right: 22, top: 20, bottom: 50, side: "left" }),
            ];
        }, source.toString("base64"));
        for (const edge of measurements) {
            assert.ok(edge.rms <= 0.075 && edge.maximumDeviation <= 0.2,
                `${edge.name} contains visible contour noise: ${JSON.stringify(measurements)}`);
        }
    } finally {
        await browser.close();
    }
});
