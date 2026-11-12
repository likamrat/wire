import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

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
