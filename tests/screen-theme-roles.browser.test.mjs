import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { privateFixture, fixture, chooseTheme } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

test("screen roles resolve explicit and system dark without changing light, forced colors or semantic inks", { timeout: 45000 }, async t => {
    const { context } = await privateFixture(t, [fixture("screen-role-calendar")]);
    let providers = 0;
    const refuse = async () => { providers++; throw Error("No provider work in screen role proof."); };
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: refuse, readSource: refuse } });
    const before = await loadBoardState(context), browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const evidence = [], errors = [], requests = [], proofs = process.env.WIRE_THEME_ROLE_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const entry of [
        { name: "explicit-dark", preference: "dark", system: "light", forced: "none", theme: "dark" },
        { name: "system-dark", preference: null, system: "dark", forced: "none", theme: "dark" },
        { name: "explicit-light", preference: "light", system: "dark", forced: "none", theme: "light" },
        { name: "forced-dark", preference: "dark", system: "dark", forced: "active", theme: "dark" },
        { name: "forced-light", preference: "light", system: "light", forced: "active", theme: "light" },
    ]) {
        const profile = await browser.newContext({ colorScheme: entry.system, forcedColors: entry.forced,
            viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
        await profile.addInitScript(preference => {
            if (preference) localStorage.setItem("workiq-evidence.theme", preference);
        }, entry.preference);
        const page = await profile.newPage();
        page.setDefaultTimeout(7000);
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
            assert.equal(new URL(request.url()).origin, new URL(runtime.url).origin);
            if (request.method() === "POST") requests.push(new URL(request.url()).pathname);
        });
        await page.goto(runtime.url);
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        assert.equal(await page.locator("html").getAttribute("data-evidence-theme"), entry.theme);
        if (entry.preference === null) await page.evaluate(() => document.documentElement.removeAttribute("data-evidence-theme"));
        await page.evaluate(() => document.fonts.ready);
        const inkBlue = entry.theme === "dark" && entry.forced === "none";
        const paper = inkBlue ? "#192330" : entry.theme === "dark" ? "#202020" : "#ffffff";
        const roles = await page.evaluate(() => {
            const root = getComputedStyle(document.documentElement);
            return Object.fromEntries(["--page", "--paper", "--navigation-paper", "--context-paper", "--floating-paper",
                "--hover", "--accent-soft", "--pill-pressed", "--muted", "--danger", "--copilot-chat-title",
                "--chart-service-calendar-label"].map(name => [name, root.getPropertyValue(name).trim()]));
        });
        assert.equal(roles["--paper"], paper);
        assert.equal(roles["--navigation-paper"], inkBlue ? "#10161f" : paper);
        assert.equal(roles["--context-paper"], inkBlue ? "#1c2939" : paper);
        assert.equal(roles["--floating-paper"], inkBlue ? "#202c3b" : paper);
        assert.equal(roles["--danger"], entry.theme === "dark" ? "#f28b82" : "#b3261e");
        if (inkBlue) {
            assert.equal(roles["--copilot-chat-title"], "#ad88f0");
            assert.equal(roles["--chart-service-calendar-label"], "#5792fa");
            const inks = [roles["--copilot-chat-title"], ...Object.values(createDimensionalCharts().servicePalette).map(value => value.dark.label)];
            for (const ink of inks) for (const surface of ["--paper", "--context-paper", "--floating-paper", "--hover", "--accent-soft", "--pill-pressed"]) {
                assert.ok(contrast(ink, roles[surface]) >= 4.5, `${entry.name}: ${ink} on ${surface}`);
            }
        }
        const card = page.locator(".request-card-open").first();
        await card.hover();
        await card.click();
        await page.locator("#contextSidebar[open]").waitFor();
        await page.locator("#requestContent .reader-call-toggle").first().hover();
        const service = await page.locator("#requestContent .reader-call-services .service-cue").first().evaluate(node => {
            let parent = node;
            while (getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)") parent = parent.parentElement;
            return { ink: getComputedStyle(node).color, fill: getComputedStyle(parent).backgroundColor };
        });
        assert.ok(contrast(service.ink, service.fill) >= 4.5, `${entry.name}: actual reader Calendar`);
        const pane = await page.locator("#contextSidebar").evaluate(node => ({
            paper: getComputedStyle(node).getPropertyValue("--paper").trim(),
            controlPaper: getComputedStyle(node).getPropertyValue("--pill-fill").trim(),
        }));
        assert.equal(pane.paper, roles["--context-paper"]);
        assert.equal(pane.controlPaper, pane.paper);
        await page.locator("#outcomeFilter-control").click();
        await page.locator(".select-popup .select-all").click();
        const disabled = await page.locator(".select-popup .select-apply").evaluate(node => ({
            disabled: node.disabled, visible: node.checkVisibility(), ink: getComputedStyle(node).color,
            fill: getComputedStyle(node, "::before").backgroundColor,
        }));
        assert.equal(disabled.disabled, true);
        assert.equal(disabled.visible, true);
        if (inkBlue) {
            assert.match(disabled.fill, /^rgba\(\d+, \d+, \d+, 0\)$/);
            assert.equal(disabled.ink, "rgb(187, 197, 212)");
        }
        const menu = await page.locator(".select-popup").evaluate(node => ({
            paper: getComputedStyle(node).getPropertyValue("--paper").trim(),
            controlPaper: getComputedStyle(node).getPropertyValue("--pill-fill").trim(),
        }));
        assert.equal(menu.paper, roles["--floating-paper"]);
        assert.equal(menu.controlPaper, menu.paper);
        const glyphs = await page.locator("#themePreference").evaluate(node => {
            const active = node.getAttribute("aria-checked") === "true" ? "moon" : "sun";
            return [...node.querySelectorAll("[data-lucide-icon]")].map(icon => ({
                role: icon.dataset.lucideIcon, ink: getComputedStyle(icon).color,
                fill: getComputedStyle(node.querySelector(icon.dataset.lucideIcon === active ? ".theme-thumb" : ".theme-track")).backgroundColor,
            }));
        });
        for (const glyph of glyphs) assert.ok(contrast(glyph.ink, glyph.fill) >= 3, JSON.stringify(glyph));
        evidence.push({ ...entry, roles, service, pane, menu, disabled, glyphs });
        if (proofs) await page.screenshot({ path: path.join(proofs, entry.name + ".png") });
        await profile.close();
    }
    const after = await loadBoardState(context);
    for (const key of ["evidence", "exports", "collection", "personalEvaluation"]) assert.deepEqual(after[key], before[key]);
    assert.equal(providers, 0); assert.deepEqual(errors, []);
    assert.ok(!requests.some(endpoint => /\/api\/(?:export|deletion\/confirm|collection\/(?:now|configure|enabled))$/.test(endpoint)));
    if (proofs) await writeFile(path.join(proofs, "roles.json"), JSON.stringify(evidence, null, 2));
});

test("changing screen roles leaves verified saved document paint and every saved format unchanged", { timeout: 30000 }, async t => {
    const { context } = await privateFixture(t, [fixture("screen-role-frozen")]);
    const exports = createExportController(context), state = await loadBoardState(context);
    const timeContext = { timeZone: "UTC", locale: "en-US" };
    const preview = await exports.preview("screen-role-fixture", undefined, {
        title: "Invented palette preservation", promptMode: "none", formats: ["html", "pdf", "json", "markdown"], timeContext,
    }, { kind: "all", revision: state.revision });
    await exports.review("screen-role-fixture", preview.previewId, true, timeContext);
    const saved = (await exports.confirm("screen-role-fixture", preview.previewId, true, timeContext)).bundle;
    const digest = bytes => createHash("sha256").update(bytes).digest("hex");
    const originals = await Promise.all(Object.values(saved.files).map(async file => digest(await readFile(file))));
    let providers = 0;
    const refuse = async () => { providers++; throw Error("No provider or source access in frozen paint proof."); };
    const runtime = await startServer(context, exports, { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: refuse, readSource: refuse } });
    const browser = await chromium.launch(), page = await browser.newPage({ colorScheme: "light", viewport: { width: 1440, height: 1100 } });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        assert.equal(new URL(request.url()).origin, new URL(runtime.url).origin);
        if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
    });
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    const documentBody = page.frameLocator("#savedReportReader iframe").locator("body");
    await documentBody.waitFor(); await documentBody.evaluate(() => document.fonts.ready);
    const frame = page.locator("#savedReportReader iframe"), identity = await frame.elementHandle(), box = await frame.boundingBox();
    const main = documentBody.locator(":scope>main"), content = await main.boundingBox();
    const padding = await main.evaluate(node => {
        const css = getComputedStyle(node);
        return { left: parseFloat(css.paddingLeft), right: parseFloat(css.paddingRight), top: parseFloat(css.paddingTop) };
    });
    // The screen's navigation shadow can cross the frame gutter, not the document's content paint.
    const top = Math.max(box.y + 1, content.y + padding.top);
    const clip = { x: content.x + padding.left, y: top, width: content.width - padding.left - padding.right,
        height: Math.min(content.height, box.y + box.height - 1 - top, 1100 - top) };
    const paint = () => documentBody.evaluate(node => {
        const css = getComputedStyle(node), heading = getComputedStyle(node.querySelector("h1"));
        return { text: node.textContent, font: css.fontFamily, ink: css.color, fill: css.backgroundColor,
            heading: { font: heading.fontFamily, ink: heading.color, size: heading.fontSize, weight: heading.fontWeight } };
    });
    await page.mouse.move(0, 0);
    const before = await paint(), pixels = await page.screenshot({ clip });
    await chooseTheme(page, "dark");
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    assert.equal(await frame.evaluate((node, original) => node === original, identity), true);
    assert.deepEqual(await frame.boundingBox(), box);
    assert.deepEqual(await paint(), before);
    const darkPixels = await page.screenshot({ clip });
    if (process.env.WIRE_THEME_ROLE_PROOFS) {
        await mkdir(process.env.WIRE_THEME_ROLE_PROOFS, { recursive: true });
        await writeFile(path.join(process.env.WIRE_THEME_ROLE_PROOFS, "frozen-light.png"), pixels);
        await writeFile(path.join(process.env.WIRE_THEME_ROLE_PROOFS, "frozen-dark.png"), darkPixels);
        t.diagnostic(JSON.stringify(await documentBody.evaluate(() => ({
            width: innerWidth, clientWidth: document.documentElement.clientWidth,
            height: innerHeight, clientHeight: document.documentElement.clientHeight,
            scheme: getComputedStyle(document.documentElement).colorScheme,
        }))));
    }
    const difference = await page.evaluate(async ({ light, dark }) => {
        async function decode(base64) {
            const image = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), value => value.charCodeAt(0))]));
            const canvas = document.createElement("canvas");
            canvas.width = image.width; canvas.height = image.height;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0); image.close();
            return context.getImageData(0, 0, canvas.width, canvas.height);
        }
        const a = await decode(light), b = await decode(dark);
        let changed = 0, left = a.width, top = a.height, right = 0, bottom = 0;
        for (let pixel = 0; pixel < a.data.length; pixel += 4) {
            if ([0, 1, 2, 3].every(channel => a.data[pixel + channel] === b.data[pixel + channel])) continue;
            changed++;
            const x = pixel / 4 % a.width, y = Math.floor(pixel / 4 / a.width);
            left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
        return { sameSize: a.width === b.width && a.height === b.height, changed,
            bounds: changed ? { left, top, right, bottom } : null };
    }, { light: pixels.toString("base64"), dark: darkPixels.toString("base64") });
    assert.equal(difference.sameSize, true);
    assert.equal(difference.changed, 0, `Frozen document pixels: ${JSON.stringify(difference)}`);
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(async file => digest(await readFile(file)))), originals);
    assert.equal(providers, 0); assert.deepEqual(errors, []);
    assert.equal(posts.filter(endpoint => endpoint === "/api/report/open").length, 1);
    assert.ok(!posts.some(endpoint => /\/api\/(?:preview|export|privacy-review|collection\/(?:configure|now|enabled))$/.test(endpoint)));
});
