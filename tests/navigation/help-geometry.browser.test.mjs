import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { chooseTheme, fixture, navigateMain, navigateSettings, privateFixture } from "../support/helpers.mjs";

const proofs = process.env.WIRE_HELP_GEOMETRY_PROOFS;
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, `${name}.png`) });
}

async function setup(t) {
    const record = fixture("geometry-batch");
    record.userPrompt.text = "Find the Cedar room and its review notes.";
    Object.assign(record.toolCalls[0], {
        startedAt: "2026-11-12T14:00:00Z", requestArgs: { entityUrls: ["/me/events", "/me/messages"] },
        apiResults: [{ index: 0, path: "/me/events", statusCode: 200 }, { index: 1, statusCode: 403 }],
    });
    let removeFixture;
    const { context } = await privateFixture({ after: fn => { removeFixture = fn; } }, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend: "react", collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", hasTouch: true });
    const rejected = [], errors = [];
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Unexpected clipboard read"); }, writeText() { throw Error("Unexpected clipboard write"); },
    } }));
    await page.route("**/*", route => {
        const r = route.request(), u = new URL(r.url());
        if (u.origin === new URL(runtime.url).origin && (r.method() === "GET" || r.method() === "POST" && (
            ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary", "/api/assessment/detail", "/api/assessment/overview"].includes(u.pathname)
            || u.pathname === "/api/app-update" && r.postDataJSON()?.action === "status"
        ))) return route.continue();
        rejected.push(r.method() + " " + u.pathname); return route.abort();
    });
    page.on("pageerror", e => errors.push(e.message));
    t.after(async () => {
        try { await browser.close(); await runtime.close(); assert.deepEqual(rejected, []); assert.deepEqual(errors, []); }
        finally { await removeFixture(); }
    });
    page.setDefaultTimeout(5000);
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    return page;
}

async function openBatch(page) {
    await page.getByRole("link", { name: /returned entry 2.*HTTP 403/i }).click();
    await expect(page.locator(".api-result-entry:focus")).toContainText("403");
    const help = page.getByRole("button", { name: "About batch target", exact: true });
    await expect(help).toBeVisible();
    return help;
}

async function resize(page, width, scale) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(n => { document.documentElement.style.fontSize = `${100 * n}%`; }, scale);
}

// Compare the last text character with the *outside* of Lucide's info circle,
// not the text span's width or the vertical stroke in the middle of the icon.
async function inlineGeometry(help) {
    return help.evaluate(button => {
        const label = button.closest(".returned-target-help");
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        const words = [];
        while (walker.nextNode()) if (!button.contains(walker.currentNode) && walker.currentNode.textContent.trim()) words.push(walker.currentNode);
        const range = document.createRange(); range.selectNodeContents(words.at(-1));
        const text = [...range.getClientRects()].at(-1), glyph = button.querySelector("svg circle").getBoundingClientRect(), target = button.getBoundingClientRect();
        range.selectNodeContents(words[0]);
        const lead = [...range.getClientRects()].at(-1);
        range.selectNodeContents(words[1]);
        const tail = range.getBoundingClientRect();
        return { gap: glyph.left - text.right, center: (glyph.bottom + glyph.top - text.top - text.bottom) / 2,
            sameLineOffset: tail.left >= lead.right - 1 ? tail.top - lead.top : 0,
            overlap: target.left < text.right, width: target.width, height: target.height };
    });
}

function checkInline(values) {
    const detail = JSON.stringify(values);
    assert.ok(values.gap >= 4 && values.gap <= 8, detail);
    assert.ok(Math.abs(values.center) <= 2, detail);
    assert.ok(Math.abs(values.sameLineOffset) <= 2, detail);
    assert.ok(values.width >= 44 && values.height >= 44 && !values.overlap, detail);
}

test("the returned entry's explanation sits next to the last word, not the middle of its hit target", async t => {
    const page = await setup(t);
    await chooseTheme(page, "dark");
    const help = await openBatch(page);
    await help.scrollIntoViewIfNeeded();
    checkInline(await inlineGeometry(help));
    await capture(page, "closed-returned-entry");
});

test("Help topics and the active answer keep distinct, usable space through theme, viewport and text changes", async t => {
    const page = await setup(t);
    await page.locator("#openEvidenceHelp").click();
    const nav = page.getByRole("navigation", { name: "Help topics" });
    const topic = nav.getByRole("link", { name: "Understand activity counts" });
    await topic.press("Enter");
    await expect(topic).toHaveAttribute("aria-current", "page");
    const article = page.locator("#wireHelpView article:visible");
    await expect(article.getByRole("heading", { level: 2 })).toHaveText("Understand activity counts");
    for (const theme of ["light", "dark"]) for (const width of [1200, 820, 375]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme); await resize(page, width, scale);
        const menu = await nav.boundingBox(), answer = await article.boundingBox();
        assert.ok(menu.x + menu.width <= answer.x + 1 || menu.y + menu.height <= answer.y + 1);
        const choices = await nav.getByRole("link").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
        assert.ok(choices.length > 1 && choices.every(h => h >= 44));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (width === 375 && scale === 2 || width === 1200 && scale === 1) await capture(page, `topics-${theme}-${width}-${scale}`);
    }
});

async function tipGeometry(control, useGlyph) {
    return control.evaluate((node, useGlyph) => {
        const a = (useGlyph ? node.querySelector("svg") : node).getBoundingClientRect(), tip = document.getElementById("evidence-tooltip");
        const r = tip.getBoundingClientRect(), css = getComputedStyle(tip), range = document.createRange();
        range.selectNodeContents(tip); const text = range.getBoundingClientRect();
        return { above: a.top - r.bottom, gaps: [a.top-r.bottom, r.top-a.bottom, a.left-r.right, r.left-a.right],
            fits: r.left >= 8 && r.right <= document.documentElement.clientWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8,
            clips: tip.scrollHeight > tip.clientHeight + 1 || tip.scrollWidth > tip.clientWidth + 1,
            emptyX: r.width - text.width - 2 * parseFloat(css.paddingLeft),
            emptyY: r.height - text.height - 2 * parseFloat(css.paddingTop) - (parseFloat(css.lineHeight) - parseFloat(css.fontSize)) };
    }, useGlyph);
}

async function checkTooltip(control, glyph, { short = false } = {}) {
    await expect(async () => {
        const g = await tipGeometry(control, glyph);
        // A wrapped paragraph can break before a long word. Check unused width
        // on a short explanation as well, so a fixed-width empty box cannot pass.
        assert.ok(g.fits && !g.clips && (!short || g.emptyX <= 35) && g.emptyY <= 3 && g.gaps.some(n => n >= 4 && n <= 10), JSON.stringify(g));
    }).toPass({ timeout: 2000 });
}

test("a live text resize preserves glyph-anchored help without clipping or spare popup space", async t => {
    const page = await setup(t), help = await openBatch(page);
    // Keep the entry in view through reflow. Offscreen anchors dismiss help.
    await page.setViewportSize({ width: 1200, height: 1800 });
    await help.scrollIntoViewIfNeeded(); await help.focus();
    await expect(page.getByRole("tooltip")).toContainText("Its recorded status still counts.");
    await checkTooltip(help, true);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await checkTooltip(help, true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toBeHidden();
});

test("Formats keeps four separate keyboard and touch targets; inspecting the menu doesn't select a file", async t => {
    const page = await setup(t);
    await navigateMain(page, "reports");
    const entry = page.getByRole("button", { name: "Formats: HTML", exact: true });
    const choices = page.getByRole("group", { name: "Formats", exact: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 1], [375, 2]]) {
        await resize(page, width, scale); await chooseTheme(page, theme);
        await entry.press("Enter"); await expect(choices).toBeVisible();
        const controls = choices.getByRole("checkbox"); await expect(controls).toHaveCount(4);
        const rects = await controls.evaluateAll(nodes => nodes.map(n => n.labels[0].getBoundingClientRect().toJSON()));
        for (const [i, r] of rects.entries()) {
            assert.ok(r.height >= 44 && r.width >= 44 && r.x >= 0 && r.right <= width, JSON.stringify(r));
            for (const other of rects.slice(i+1)) assert.ok(r.right <= other.x || other.right <= r.x || r.bottom <= other.y || other.bottom <= r.y);
        }
        const pdf = choices.getByRole("checkbox", { name: "PDF", exact: true });
        await choices.getByRole("checkbox", { name: "HTML", exact: true }).focus();
        await page.keyboard.press("Tab"); await expect(pdf).toBeFocused(); await expect(pdf).not.toBeChecked();
        await pdf.press("Space"); await expect(pdf).toBeChecked();
        await pdf.tap(); await expect(pdf).not.toBeChecked();
        await expect(choices.locator("input:checked")).toHaveCount(1);
        await page.keyboard.press("Escape"); await expect(choices).toBeHidden(); await expect(entry).toBeFocused();
    }
});

test("field explanation stays on its final line without covering the text across wrap thresholds", async t => {
    const page = await setup(t), help = await openBatch(page);
    let min = Infinity, max = -Infinity;
    for (const scale of [1, 2]) for (let width = 320; width <= 1440; width += 20) {
        await resize(page, width, scale);
        const box = await inlineGeometry(help);
        checkInline(box);
        min = Math.min(min, box.gap); max = Math.max(max, box.gap);
    }
    t.diagnostic(`Text to info circle: ${min.toFixed(2)}–${max.toFixed(2)} CSS px`);
});

test("help flips above a low glyph; Source access keeps its action's own tooltip anchor", async t => {
    const page = await setup(t), help = await openBatch(page);
    await resize(page, 375, 2); await help.scrollIntoViewIfNeeded();
    await help.evaluate(n => {
        const pane = n.closest("#contextSidebarBody");
        pane.scrollTop += n.getBoundingClientRect().bottom - innerHeight + 12;
    });
    await help.hover(); await expect(page.getByRole("tooltip")).toBeVisible();
    await checkTooltip(help, true);
    const { above } = await tipGeometry(help, true); assert.ok(above >= 4 && above <= 10, `above: ${above}`);
    await capture(page, "bottom-edge");
    await page.keyboard.press("Escape"); await page.locator("#closeContextSidebar").click();
    await resize(page, 1200, 1);
    await navigateMain(page, "settings"); await navigateSettings(page, "source-access");
    const action = page.getByRole("button", { name: "Review source & connect", exact: true });
    await action.press("Enter"); await page.getByLabel("Copilot metadata database", { exact: true }).fill("");
    const approve = page.getByRole("button", { name: "Approve source and start collection", exact: true });
    await expect(approve).toBeDisabled();
    const why = page.getByRole("group", { name: "Approve source and start collection", exact: true });
    await why.scrollIntoViewIfNeeded(); await why.focus();
    await expect(page.getByRole("tooltip")).toHaveText("Enter both source paths.");
    await checkTooltip(approve, false, { short: true });
    assert.ok((await approve.boundingBox()).height >= 44);
    await page.keyboard.press("Escape"); await expect(page.getByRole("tooltip")).toBeHidden();
    await expect(why).toBeFocused();
});

test("hover, held press, keyboard and touch leave the info hit area unpainted and the returned entry unchanged", async t => {
    const page = await setup(t), help = await openBatch(page);
    const entry = page.locator(".api-result-entry").filter({ has: help });
    async function paint() {
        return help.evaluate(n => {
            const s = getComputedStyle(n), owner = n.closest(".api-result-entry").getBoundingClientRect();
            const relative = node => {
                const b = node.getBoundingClientRect();
                return [b.x - owner.x, b.y - owner.y, b.width, b.height];
            };
            return { bg: s.backgroundColor, image: s.backgroundImage, shadow: s.boxShadow,
                outline: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth), before: getComputedStyle(n, "::before").content,
                after: getComputedStyle(n, "::after").content, target: relative(n), glyph: relative(n.querySelector("svg")) };
        });
    }
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 1], [375, 2]]) {
        // Set the theme before re-entering the modal reader on small screens.
        await page.locator("#closeContextSidebar").click(); await resize(page, width, scale); await chooseTheme(page, theme); await openBatch(page);
        await help.scrollIntoViewIfNeeded();
        const before = await paint(), content = await entry.innerText();
        await help.hover(); await expect(page.getByRole("tooltip")).toBeVisible(); const hover = await paint();
        await page.mouse.down(); const pressed = await paint(); await page.mouse.up();
        await page.keyboard.press("Escape");
        await help.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); await expect(help).toBeFocused();
        await expect(page.getByRole("tooltip")).toBeVisible(); await expect(help).toHaveAttribute("aria-describedby", /evidence-tooltip/);
        const focus = await paint(); assert.ok(focus.outline === "solid" && focus.outlineWidth >= 2);
        await help.press("Escape"); await help.press("Enter"); await expect(page.getByRole("tooltip")).toBeVisible();
        await help.press("Escape"); await help.tap(); await expect(page.getByRole("tooltip")).toBeVisible(); const touch = await paint();
        for (const state of [hover, pressed, focus, touch]) {
            assert.equal(state.bg, "rgba(0, 0, 0, 0)"); assert.equal(state.image, "none"); assert.equal(state.shadow, "none");
            assert.ok([state.before, state.after].every(x => ["none", "normal"].includes(x)));
            assert.deepEqual(state.target, before.target); assert.deepEqual(state.glyph, before.glyph);
        }
        await entry.getByText("Returned target", { exact: true }).tap(); await expect(page.getByRole("tooltip")).toBeHidden();
        assert.equal(await entry.innerText(), content);
    }
});
