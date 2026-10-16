import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { chooseTheme, selectActivityOption } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

test("Search paints only the actual hovered or pressed row, with fixed geometry and exact Open/Back", { timeout: 30000 }, async t => {
    const cleanup = [], app = await searchFixture({ after: fn => cleanup.push(fn) });
    const browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : undefined,
        headless: !process.env.WIRE_SEARCH_NATIVE_HEADFUL, ignoreDefaultArgs: ["--hide-scrollbars"],
    });
    const proofs = process.env.WIRE_SEARCH_ROW_PROOFS, cases = [], errors = [], nonlocal = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    t.after(async () => {
        await browser.close();
        for (const fn of cleanup) await fn();
        assert.deepEqual(errors, []); assert.deepEqual(nonlocal, []);
    });
    const transparent = color => color === "rgba(0, 0, 0, 0)";
    async function paint(row) {
        return row.evaluate(node => {
            const css = getComputedStyle(node), before = getComputedStyle(node, "::before"), rect = node.getBoundingClientRect();
            return {
                hover: node.matches(":hover"), active: node.matches(":active"), focused: document.activeElement === node,
                background: css.backgroundColor, ink: css.color, outline: css.outlineStyle, outlineWidth: css.outlineWidth,
                shadow: css.boxShadow, border: css.borderTopWidth,
                before: { content: before.content, background: before.backgroundColor, border: before.borderTopColor,
                    shadow: before.boxShadow, width: before.width, height: before.height, pointerEvents: before.pointerEvents },
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                content: [...node.querySelectorAll(".wire-search-title,.wire-search-kind,.wire-search-source,.wire-search-excerpt,.wire-search-outcome,mark,.wire-icon")].map(part => {
                    const css = getComputedStyle(part);
                    return { role: part.localName === "mark" ? "mark" : part.className.baseVal || part.className,
                        color: css.color, background: css.backgroundColor, underline: css.textDecorationLine };
                }),
                paper: getComputedStyle(document.querySelector("#wireSearchPanel")).backgroundColor,
            };
        });
    }
    const fill = value => value.before.content !== "none" && !transparent(value.before.background)
        ? value.before.background : value.background;
    async function capture(page, name) {
        if (proofs) await page.screenshot({ path: path.join(proofs, name + ".png") });
    }
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        const page = await browser.newPage({ viewport: { width, height: width === 375 ? 812 : 1000 }, reducedMotion: "reduce" });
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", route => {
            if (new URL(route.request().url()).origin !== new URL(app.runtime.url).origin) {
                nonlocal.push(route.request().url()); return route.abort();
            }
            return route.continue();
        });
        await page.goto(app.runtime.url);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.evaluate(() => document.fonts.ready);
        await chooseTheme(page, theme);
        const input = page.locator("#wireSearch"), panel = page.locator("#wireSearchPanel");
        const fieldBefore = await input.boundingBox();
        await input.fill("Invented local");
        await selectActivityOption(page, "wireSearchType", "interaction");
        await page.locator("#wireSearchFilterSummary").click();
        const rows = page.locator("#wireSearchResults button"), first = rows.first(), neighbor = rows.nth(1);
        await expect(rows).toHaveCount(3);
        await expect(first).toContainText("The physician treated an injured patient in the hospital.");
        await input.focus(); await page.mouse.move(0, 0);
        const idle = await paint(first), neighborIdle = await paint(neighbor);
        const readingY = await page.evaluate(() => scrollY), id = await first.getAttribute("data-search-id");
        const rowName = await first.getAttribute("aria-label");
        const { x, y, width: rowWidth, height } = idle.rect;
        const point = [x + rowWidth / 2, y + height / 2];
        assert.ok(y >= 0 && y + height <= page.viewportSize().height);
        assert.ok(await first.evaluate((node, point) => node.contains(document.elementFromPoint(...point)), point));
        await capture(page, `${theme}-${width}-idle`);
        await page.mouse.move(...point);
        await capture(page, `${theme}-${width}-hover`);
        const hover = await paint(first), neighborHover = await paint(neighbor);
        assert.equal(hover.hover, true); assert.equal(hover.focused, false);
        assert.deepEqual(await input.boundingBox(), fieldBefore);
        await page.mouse.down();
        await capture(page, `${theme}-${width}-pressed`);
        const pressed = await paint(first), neighborPressed = await paint(neighbor);
        assert.equal(pressed.active, true);
        assert.deepEqual(await input.boundingBox(), fieldBefore);
        await page.mouse.up();
        await expect(page.locator("#closeContextSidebar")).toBeVisible();
        const destination = page.url();
        assert.equal(new URL(destination).hash, "#request?request=search-0");
        await expect(page.locator("#requestContent")).toContainText("The physician treated an injured patient in the hospital.");
        await page.goBack();
        await expect(first).toBeFocused();
        await expect(first).toHaveAttribute("data-search-id", id);
        await expect(first).toHaveAttribute("aria-label", rowName);
        await expect(input).toHaveValue("Invented local");
        await page.mouse.move(0, 0);
        await input.focus(); await page.keyboard.press("ArrowDown");
        const keyboard = await paint(first);
        assert.equal(keyboard.outline, "solid"); assert.ok(parseFloat(keyboard.outlineWidth) >= 2);
        assert.equal(await page.evaluate(() => scrollY), readingY);
        assert.deepEqual(await input.boundingBox(), fieldBefore);
        assert.deepEqual(hover.rect, idle.rect); assert.deepEqual(pressed.rect, idle.rect);
        assert.deepEqual(neighborHover, neighborIdle); assert.deepEqual(neighborPressed, neighborIdle);
        await capture(page, `${theme}-${width}-keyboard-back`);
        await first.evaluate(node => { node.disabled = true; });
        await page.mouse.move(...point); await page.mouse.down();
        const disabled = await paint(first);
        assert.ok(transparent(fill(disabled)), "Disabled rows cannot advertise an enabled action");
        assert.equal(disabled.before.content, "none");
        assert.equal(disabled.border, "0px"); assert.equal(disabled.shadow, "none");
        await page.mouse.move(0, 0); await page.mouse.up();
        await first.evaluate(node => { node.disabled = false; });
        await input.focus();
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden(); await expect(input).toBeFocused();
        cases.push({ theme, width, idle, hover, pressed, keyboard, destination,
            hoverPainted: !transparent(fill(hover)),
            pressedPainted: !transparent(fill(pressed)),
            pressedDistinct: fill(pressed) !== fill(hover) || pressed.before.shadow !== hover.before.shadow,
        });
        await page.close();
    }
    if (proofs) await writeFile(path.join(proofs, "measurements.json"), JSON.stringify({ cases, url: app.runtime.url }, null, 2));
    for (const value of cases) {
        assert.ok(transparent(fill(value.idle)), `${value.theme}/${value.width}: idle rows stay unfilled`);
        assert.equal(value.idle.border, "0px"); assert.equal(value.idle.shadow, "none");
        assert.equal(value.hoverPainted, true, `${value.theme}/${value.width}: native hover must visibly fill the row`);
        assert.equal(value.pressedPainted, true, `${value.theme}/${value.width}: native press must visibly fill the row`);
        assert.equal(value.pressedDistinct, true, `${value.theme}/${value.width}: pressed feedback differs from hover`);
        for (const state of [value.hover, value.pressed]) {
            assert.equal(state.before.pointerEvents, "none", "Paint must not intercept the native button target");
            assert.ok(Math.abs(parseFloat(state.before.width) - state.rect.width) < 1, "Fill spans only the row width");
            assert.ok(Math.abs(parseFloat(state.before.height) - state.rect.height) < 1, "Fill spans the full clickable row");
        }
        assert.ok(contrast(value.hover.ink, fill(value.hover)) >= 4.5);
        assert.ok(contrast(value.pressed.ink, fill(value.pressed)) >= 4.5);
        for (const state of [value.idle, value.hover, value.pressed, value.keyboard]) {
            const surface = transparent(fill(state)) ? state.paper : fill(state);
            for (const part of state.content) {
                assert.ok(contrast(part.color, transparent(part.background) ? surface : part.background)
                    >= (part.role === "wire-icon" ? 3 : 4.5), `${value.theme}/${value.width}: ${part.role} contrast`);
                if (part.role === "mark") assert.ok(part.underline.includes("underline"), "Match meaning is not color alone");
            }
        }
    }
});
