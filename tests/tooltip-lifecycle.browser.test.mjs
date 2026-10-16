import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { uxStyles } from "../web/ux-styles.mjs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createSelectControls } from "../web/select-control.mjs";
import { selectStyles } from "../web/select-styles.mjs";
import { navigateMain, revealStoredRefresh } from "./helpers.mjs";
import { chooseReportScope, reportContents } from "./report-journey-helpers.mjs";

const proofDir = process.env.WORKIQ_TOOLTIP_PROOFS;

function primitives() {
    window.ux = createEvidenceUX(icons);
    window.activations = 0;
    window.events = [];
    const host = document.querySelector("main");
    function render() {
        host.innerHTML = '<button id="before">Before</button><button id="action" aria-describedby="static-help">Check for new activity</button><button id="after">After</button><p id="static-help">Existing description</p><p id="result" role="status">Ready</p><a id="navigate" href="#next">Source</a><button id="disabled" disabled>Save preferences</button><details id="details"><summary>Details</summary><p>Persistent disclosure text</p></details><label for="choice">Choice</label><select id="choice"><option value="one">A long synthetic option label for the narrow select</option><option value="two" data-detail="Saved 30 Sep 2026">Another option</option></select>';
        const action = document.querySelector("#action");
        action.replaceChildren(ux.icon("refresh"), Object.assign(document.createElement("span"), { textContent: "Check for new activity" }));
        action.classList.add("icon-action");
        ux.tooltip(action, "Read new calls and results from approved local Copilot history.");
        action.addEventListener("click", () => {
            window.activations++;
            window.events.push({ event: "action", visible: document.querySelectorAll('[role=tooltip]:not([hidden])').length });
            document.querySelector("#result").textContent = "Pending";
        });
        ux.tooltip(document.querySelector("#navigate"), "Open source settings.");
        ux.tooltip(document.querySelector("#disabled"), "Save approved preferences.");
        ux.explainDisabled(document.querySelector("#disabled"), "Review the source before saving.", { compact: true });
        host.append(ux.helpButton("recorded result", "This is an explanation, not an action."));
        host.append(ux.copyButton({ label: "Copy synthetic value", getText: () => "Synthetic value" }));
        return action;
    }
    window.replaceAction = () => {
        const action = render();
        ux.restoreFocus(action);
    };
    render();
    window.selects = createSelectControls(ux);
    if (performance.getEntriesByType("navigation")[0]?.type === "reload") document.querySelector("#action").focus();
}

async function fixture(t, options = {}) {
    const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}${uxStyles}${selectStyles}.select-control{max-width:200px}</style></head><body><main></main><script>const createEvidenceUX=${createEvidenceUX.toString()};const createSelectControls=${createSelectControls.toString()};const icons=${JSON.stringify(uxIcons)};(${primitives.toString()})()</script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce", ...options });
    page.setDefaultTimeout(3000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    return page;
}

async function noTooltip(page) {
    assert.equal(await page.locator('[role="tooltip"]:visible').count(), 0);
    assert.equal(await page.locator('[aria-describedby~="evidence-tooltip"]').count(), 0);
}

async function controlledClock(page) {
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
}

async function visibleTooltip(page, label) {
    assert.equal(await page.locator('[role="tooltip"]:visible').count(), 1, label);
    assert.equal(await page.locator('[aria-describedby~="evidence-tooltip"]').count(), 1, label);
}

test("wrapped adjacent actions receive one native click without losing hoverable or keyboard help", async t => {
    const page = await fixture(t, { hasTouch: true }), measurements = [];
    await page.evaluate(() => {
        const group = document.createElement("div");
        group.id = "adjacent-actions";
        group.className = "page-actions";
        group.style.cssText = "position:fixed;bottom:8px;right:20px;left:20px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px";
        const target = document.createElement("button"), source = document.createElement("button");
        target.id = "adjacent-target"; target.textContent = "Remove from report";
        source.id = "adjacent-source"; source.textContent = "Continue to report";
        group.append(target, source); document.body.append(group);
        window.adjacentActivations = 0;
        target.addEventListener("click", () => {
            window.adjacentActivations++;
            target.textContent = target.textContent === "Remove from report" ? "Add to report" : "Remove from report";
        });
        window.ux.tooltip(source, "Review selected activity and the report's author choices.");
        window.ux.tooltip(target, "Change this interaction's report selection.");
        window.ux.explainDisabled(target, "No reportable activity.", { compact: true });
        window.ux.explainDisabled(source, "Select activity before continuing.", { compact: true });
    });
    await controlledClock(page);
    const target = page.locator("#adjacent-target"), source = page.locator("#adjacent-source");
    const center = async node => {
        const rect = await node.boundingBox();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, scale }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${scale * 100}%`;
        }, { theme, scale });
        await page.mouse.move(1, 1); await page.clock.runFor(120);
        const from = await center(source);
        await page.mouse.move(from.x, from.y); await page.clock.runFor(180); await visibleTooltip(page);
        const tip = await page.getByRole("tooltip").boundingBox(), to = await center(target);
        const initial = await target.textContent(), clicks = await page.evaluate(() => window.adjacentActivations);
        await page.mouse.move(to.x, to.y);
        await page.mouse.click(to.x, to.y);
        const pointer = { label: await target.textContent(), clicks: await page.evaluate(() => window.adjacentActivations),
            focused: await target.evaluate(node => node === document.activeElement) };
        measurements.push({ theme, width, scale, tip, to, initial, pointer });
        if (proofDir) {
            await mkdir(proofDir, { recursive: true });
            await writeFile(path.join(proofDir, "adjacent-native-actions.json"), JSON.stringify(measurements, null, 2));
        }
        assert.equal(pointer.clicks, clicks + 1, JSON.stringify(measurements.at(-1)));
        assert.notEqual(pointer.label, initial); assert.equal(pointer.focused, true);
        await noTooltip(page);
        await page.mouse.move(1, 1); await page.clock.runFor(120);
        await page.mouse.move(from.x, from.y); await page.clock.runFor(180);
        const help = await center(page.getByRole("tooltip"));
        await page.mouse.move(help.x, help.y, { steps: 10 }); await page.clock.runFor(1000); await visibleTooltip(page);
        assert.equal(await page.getByRole("tooltip").innerText(), "Review selected activity and the report's author choices.");
        await page.keyboard.press("Escape"); await noTooltip(page);
        await target.focus(); await page.keyboard.press("Tab"); await visibleTooltip(page);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await target.evaluate(node => node === document.activeElement && node.matches(":focus-visible")), true);
        await page.keyboard.press("Enter"); await noTooltip(page);
        assert.equal(await page.evaluate(() => window.adjacentActivations), clicks + 2);
        assert.equal(await target.textContent(), initial);
    }
});

for (const retainedFocus of [false, true]) test(`pointer departure clears the portal within 150ms (retained pointer focus: ${retainedFocus})`, async t => {
    const page = await fixture(t, { reducedMotion: retainedFocus ? "no-preference" : "reduce" }), action = page.locator("#action");
    if (retainedFocus) {
        await action.click();
        await page.mouse.move(1, 1);
    }
    await action.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await action.evaluate(node => {
        node.addEventListener("pointerleave", () => {
            window.departedAt = performance.now();
            const observer = new MutationObserver(() => {
                if (!document.querySelector('[role="tooltip"]:not([hidden])') &&
                    !document.querySelector('[aria-describedby~="evidence-tooltip"]')) {
                    window.hiddenAfter = performance.now() - window.departedAt;
                    observer.disconnect();
                }
            });
            observer.observe(document.body, { subtree: true, attributes: true, childList: true });
        }, { once: true });
    });
    await page.mouse.move(1100, 800);
    await page.waitForTimeout(500);
    const observed = await page.evaluate(() => ({
        hiddenAfter: window.hiddenAfter ?? null,
        elapsed: performance.now() - window.departedAt,
        focused: document.activeElement?.id,
        portalVisible: !!document.querySelector('[role="tooltip"]:not([hidden])'),
        described: !!document.querySelector('[aria-describedby~="evidence-tooltip"]'),
    }));
    t.diagnostic(JSON.stringify(observed));
    assert.ok(observed.hiddenAfter !== null && observed.hiddenAfter <= 150, JSON.stringify(observed));
    await noTooltip(page);
    if (retainedFocus) assert.equal(observed.focused, "action");
    assert.equal(await action.getAttribute("aria-describedby"), "static-help");
});

test("continuous outside movement and description refresh cannot postpone the 120ms departure deadline", async t => {
    const page = await fixture(t), action = page.locator("#action");
    await controlledClock(page);
    await action.click(); await page.mouse.move(1, 1); await page.clock.runFor(120);
    await action.hover(); await page.clock.runFor(180); await visibleTooltip(page);
    await page.mouse.move(1100, 800);
    for (let elapsed = 0; elapsed < 100; elapsed += 20) {
        await page.clock.runFor(20);
        await page.mouse.move(1100 - elapsed, 800 - elapsed);
        await page.evaluate(() => window.ux.tooltip(document.querySelector("#action"), "Refreshed current description."));
        await visibleTooltip(page);
    }
    await page.clock.runFor(19); await visibleTooltip(page);
    await page.clock.runFor(1); await noTooltip(page);
    assert.equal(await action.evaluate(node => document.activeElement === node), true);
});

test("suppressed restored focus cannot cancel another tooltip's departure deadline", async t => {
    const page = await fixture(t);
    await controlledClock(page);
    await page.locator("#action").hover(); await page.clock.runFor(180); await visibleTooltip(page);
    await page.mouse.move(1100, 800); await page.clock.runFor(60);
    await page.evaluate(() => window.ux.restoreFocus(document.querySelector("#navigate")));
    await page.clock.runFor(60); await noTooltip(page);
    assert.equal(await page.locator("#navigate").evaluate(node => document.activeElement === node), true);
});

test("fast and slow departures in four directions share one bounded outside deadline", async t => {
    const page = await fixture(t), action = page.locator("#action");
    await page.evaluate(() => { document.querySelector("main").style.padding = "250px"; });
    await controlledClock(page);
    for (const steps of [1, 10]) for (const direction of ["left", "right", "up", "down"]) {
        await page.mouse.move(1, 1); await page.clock.runFor(120);
        await action.hover(); await page.clock.runFor(180); await visibleTooltip(page);
        const box = await action.boundingBox();
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        // Down travels diagonally around the visible help, rather than counting time inside it as outside.
        const outside = { left: [box.x - 100, y], right: [box.x + box.width + 100, y],
            up: [x, box.y - 100], down: [box.x + box.width + 180, box.y + box.height + 150] }[direction];
        await page.mouse.move(...outside, { steps });
        await page.clock.runFor(119); await visibleTooltip(page);
        await page.clock.runFor(1); await noTooltip(page);
    }
});

test("icon and text descendants, transit into help, and immediate reentry do not flicker", async t => {
    const page = await fixture(t), action = page.locator("#action");
    await controlledClock(page);
    await action.locator("svg").hover(); await page.clock.runFor(180);
    await visibleTooltip(page);
    await action.locator("span").hover(); await page.clock.runFor(500);
    await visibleTooltip(page);
    const box = await action.boundingBox(), tip = await page.getByRole("tooltip").boundingBox();
    const x = Math.max(box.x, tip.x) + 15;
    await page.mouse.move(x, box.y + box.height + 4);
    await page.clock.runFor(60); await visibleTooltip(page);
    await page.mouse.move(x, tip.y + 5); await page.clock.runFor(1000);
    await visibleTooltip(page);
    await page.mouse.move(1100, 800); await page.clock.runFor(80);
    await action.hover(); await page.clock.runFor(500); await visibleTooltip(page);
    await page.mouse.move(1100, 800); await page.clock.runFor(120); await noTooltip(page);
    await action.hover(); await page.clock.runFor(179); await noTooltip(page);
    await page.clock.runFor(1); await visibleTooltip(page);
});

test("genuine keyboard focus owns help through pointer departure; restored focus does not", async t => {
    const page = await fixture(t), action = page.locator("#action");
    await controlledClock(page);
    await page.locator("#before").focus(); await page.keyboard.press("Tab");
    await visibleTooltip(page);
    await action.hover(); await page.clock.runFor(180);
    await page.mouse.move(1100, 800); await page.clock.runFor(1000);
    await visibleTooltip(page);
    assert.equal(await action.evaluate(node => node === document.activeElement && node.matches(":focus-visible")), true);
    await page.keyboard.press("Escape"); await noTooltip(page);
    await page.evaluate(() => window.replaceAction());
    await action.hover(); await page.clock.runFor(180); await visibleTooltip(page);
    await page.mouse.move(1100, 800); await page.clock.runFor(120); await noTooltip(page);
    assert.equal(await action.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    await visibleTooltip(page);
    await page.keyboard.press("Tab"); await page.clock.runFor(120); await noTooltip(page);
});

test("departure cancels pending help and removal or destroy releases pending and open portals", async t => {
    const page = await fixture(t), action = page.locator("#action");
    await controlledClock(page);
    await action.hover(); await page.clock.runFor(179); await noTooltip(page);
    await page.mouse.move(1100, 800); await page.clock.runFor(1000); await noTooltip(page);
    await action.hover(); await page.clock.runFor(180); await visibleTooltip(page);
    await action.evaluate(node => node.remove()); await noTooltip(page);
    await page.evaluate(() => window.replaceAction());
    await page.clock.runFor(1000); await noTooltip(page);
    await page.mouse.move(1, 1); await action.hover();
    await action.evaluate(node => node.remove());
    await page.clock.runFor(1000); await noTooltip(page);
    await page.evaluate(() => window.replaceAction());
    await page.mouse.move(1, 1); await action.hover();
    await page.evaluate(() => window.ux.destroy());
    await page.clock.runFor(1000); await noTooltip(page);
    assert.equal(await page.locator('[role="tooltip"]').count(), 0);
});

test("scroll and reflow do not turn stale hover into a new visit or extend departure", async t => {
    const page = await fixture(t), action = page.locator("#action");
    await controlledClock(page);
    await page.evaluate(() => { document.body.style.minHeight = "2000px"; });
    await action.hover(); await page.clock.runFor(180); await visibleTooltip(page);
    await page.evaluate(() => { document.querySelector("main").style.marginTop = "300px"; });
    // Hit testing runs on native compositor frames, not Playwright's JavaScript clock.
    await page.waitForTimeout(50);
    await page.clock.runFor(140);
    await noTooltip(page);
    await action.hover(); await page.clock.runFor(180); await visibleTooltip(page);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => window.scrollY > 0);
    await page.clock.runFor(140); await noTooltip(page);
    await page.clock.runFor(1000); await noTooltip(page);
});

test("navigation, truncated selects, disabled wrappers, info and copy controls share pointer departure", async t => {
    const page = await fixture(t);
    await controlledClock(page);
    await page.locator("#choice").evaluate(node => node.setAttribute("aria-describedby", "static-help"));
    for (const selector of ["#navigate", "#choice-control", ".ux-disabled-help", ".ux-help", ".ux-copy"]) {
        const control = page.locator(selector).first();
        await page.mouse.move(1100, 800);
        await control.hover(); await page.clock.runFor(180); await visibleTooltip(page, selector);
        await page.mouse.move(1100, 800); await page.clock.runFor(120); await noTooltip(page);
    }
    assert.equal(await page.locator("#choice-control").getAttribute("aria-describedby"), "static-help");
    assert.equal(await page.locator("#choice").inputValue(), "one");
    assert.equal(await page.evaluate(() => window.activations), 0);
    await page.locator("#choice-control").click();
    await page.mouse.move(1100, 800); await page.clock.runFor(1000); await noTooltip(page);
    assert.equal(await page.getByRole("listbox").isVisible(), true);
    assert.equal(await page.locator(".select-option-detail").innerText(), "Saved 30 Sep 2026");
});

test("activation dismisses before its handler and stays dismissed through retained focus and replacement", async t => {
    const page = await fixture(t);
    const action = page.locator("#action");
    await action.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await action.click();
    await noTooltip(page);
    assert.deepEqual(await page.evaluate(() => window.events), [{ event: "action", visible: 0 }]);
    await page.evaluate(() => window.replaceAction());
    await page.waitForTimeout(350);
    await noTooltip(page);
    assert.equal(await action.getAttribute("aria-describedby"), "static-help");
    assert.equal(await action.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.activations), 1);
    await page.mouse.move(1, 1);
    await action.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
});

test("hiding alone does not let restored focus resurrect a dismissed tooltip", async t => {
    const page = await fixture(t);
    await page.locator("#action").focus();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await noTooltip(page);
    await page.evaluate(() => window.replaceAction());
    await page.waitForTimeout(250);
    await noTooltip(page);
});

test("activation cancels a not-yet-visible hover timer", async t => {
    const page = await fixture(t);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.locator("#action").hover();
    await page.clock.runFor(179);
    await noTooltip(page);
    await page.locator("#action").click();
    await page.clock.runFor(1000);
    await noTooltip(page);
});

test("keyboard dismissal when the pointer is elsewhere does not suppress its first genuine hover visit", async t => {
    const page = await fixture(t), action = page.locator("#action");
    await page.mouse.move(1, 1);
    await action.focus(); await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Escape"); await noTooltip(page);
    await action.hover(); await page.getByRole("tooltip").waitFor({ state: "visible" });
    await action.click(); await noTooltip(page);
});

for (const key of ["Enter", "Space"]) test(`${key} dismisses once, keeps visible focus, and allows a new keyboard visit`, async t => {
    const page = await fixture(t);
    const action = page.locator("#action");
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press(key);
    await noTooltip(page);
    assert.equal(await page.evaluate(() => window.activations), 1);
    assert.equal(await action.evaluate(node => node === document.activeElement && node.matches(":focus-visible")), true);
    await page.evaluate(() => window.replaceAction());
    await page.waitForTimeout(250);
    await noTooltip(page);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.replaceAction());
    await page.waitForTimeout(250);
    await noTooltip(page);
});

test("same-target pointer movement cannot rearm Escape or activation; actual exit and re-entry can", async t => {
    const page = await fixture(t), action = page.locator("#action");
    await page.clock.install();
    await action.hover(); await page.clock.runFor(200);
    await page.keyboard.press("Escape");
    const box = await action.boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10); await page.clock.runFor(1000);
    await noTooltip(page);
    await page.evaluate(() => window.replaceAction());
    await page.mouse.move(box.x + 12, box.y + 12); await page.clock.runFor(1000);
    await noTooltip(page);
    await page.mouse.move(1, 1); await action.hover(); await page.clock.runFor(200);
    assert.equal(await page.locator('[role=tooltip]:visible').count(), 1);
    await action.click();
    await page.evaluate(() => {
        const node = document.querySelector("#action");
        window.ux.explainDisabled(node, "Check in progress.", { compact: true });
        node.disabled = true;
        window.ux.pending(node, true);
    });
    await page.clock.runFor(100);
    await page.mouse.move(box.x + 13, box.y + 13); await page.clock.runFor(1000);
    await noTooltip(page);
    await page.evaluate(() => {
        const node = document.querySelector("#action");
        node.disabled = false;
        window.ux.pending(node, false);
        window.ux.restoreFocus(node);
    });
    await page.clock.runFor(5000); await noTooltip(page);
});

test("native links preserve Enter navigation and Space semantics without orphan help on hash or Back", async t => {
    const page = await fixture(t), link = page.locator("#navigate");
    await page.locator("#before").focus();
    await link.focus();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Space");
    assert.equal(new URL(page.url()).hash, "");
    await page.keyboard.press("Enter");
    await page.waitForURL("**/#next");
    await noTooltip(page);
    await page.goBack();
    await page.waitForTimeout(250);
    await noTooltip(page);
    await page.mouse.move(1, 1); await link.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await link.click();
    await noTooltip(page);
});

test("native browser reload suppresses restored focus and stationary hover, but not a later real visit", async t => {
    const page = await fixture(t), action = page.locator("#action");
    await action.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await action.click();
    await page.reload();
    await page.waitForTimeout(400);
    await noTooltip(page);
    assert.equal(await action.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.mouse.move(1, 1); await action.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.reload();
    await page.waitForTimeout(400);
    await noTooltip(page);
});

test("touch action is transient while deliberate info help and disabled explanations remain available", async t => {
    const page = await fixture(t, { viewport: { width: 375, height: 900 }, hasTouch: true, isMobile: true });
    await page.locator("#action").tap();
    await page.waitForTimeout(250); await noTooltip(page);
    assert.equal(await page.evaluate(() => window.activations), 1);
    await page.getByRole("button", { name: "About recorded result" }).tap();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.match(await page.getByRole("tooltip").innerText(), /not an action/);
    await page.locator("#before").tap(); await noTooltip(page);
    await page.locator(".ux-disabled-help").focus();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.match(await page.getByRole("tooltip").innerText(), /Review the source/);
    await page.locator("#disabled").dispatchEvent("click");
    assert.equal(await page.evaluate(() => window.activations), 1);
    assert.equal(await page.locator('[role=tooltip]:visible').count(), 1);
});

test("custom select help dismisses without closing its listbox, identity details or static disclosures", async t => {
    const page = await fixture(t), trigger = page.locator("#choice-control");
    await trigger.focus();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("ArrowDown");
    await noTooltip(page);
    await page.getByRole("listbox").waitFor({ state: "visible" });
    assert.equal(await page.locator(".select-option-detail").innerText(), "Saved 30 Sep 2026");
    await page.keyboard.press("End"); await page.keyboard.press("Enter");
    await page.waitForTimeout(250); await noTooltip(page);
    assert.equal(await page.locator("#choice").inputValue(), "two");
    assert.equal(await trigger.getAttribute("aria-describedby"), null);
    await page.locator("#details>summary").click();
    await page.getByRole("button", { name: "About recorded result" }).click();
    await page.locator("#before").click();
    assert.equal(await page.locator("#details").evaluate(node => node.open), true);
    assert.equal(await page.locator("#result").innerText(), "Ready");
});

test("restoration API, stable view keys, stale-node cleanup and destroy never accumulate overlays or listeners", async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        document.querySelector("#action").removeAttribute("id");
        document.querySelector("main").dataset.viewKey = "synthetic-actions";
        window.keyed = () => document.querySelector('[aria-describedby="static-help"]');
    });
    const action = page.locator('button[aria-describedby~="static-help"]');
    await action.focus(); await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Enter"); await noTooltip(page);
    await page.evaluate(() => {
        const old = window.keyed(), next = old.cloneNode(true);
        old.replaceWith(next);
        window.ux.tooltip(next, "Replaced description.");
        next.focus();
    });
    await page.waitForTimeout(250); await noTooltip(page);
    await page.evaluate(() => window.ux.restoreFocus(document.querySelector("#navigate")));
    await noTooltip(page);
    await page.evaluate(() => {
        window.selects.destroy();
        window.ux.destroy();
        window.ux = createEvidenceUX(icons);
        window.ux.tooltip(document.querySelector("#navigate"), "New manager.");
    });
    assert.equal(await page.locator('[role=tooltip]').count(), 1);
    await page.mouse.move(1, 1); await page.locator("#navigate").hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.evaluate(() => window.ux.destroy());
    await page.waitForTimeout(250);
    assert.equal(await page.locator('[role=tooltip]').count(), 0);
    await noTooltip(page);
});

test("delayed readable help and immediate dismissal remain bounded at every theme, width and text size", { timeout: 30000 }, async t => {
    const page = await fixture(t);
    const measurements = [];
    if (proofDir) await mkdir(proofDir, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const textScale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, textScale }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${textScale * 100}%`;
            document.querySelector("#before").focus();
        }, { theme, textScale });
        await page.mouse.move(1, 1);
        const layoutBefore = await page.locator("#action").boundingBox();
        await page.locator("#action").hover();
        await page.getByRole("tooltip").waitFor({ state: "visible" });
        const bounds = await page.getByRole("tooltip").evaluate(node => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width,
                overflow: node.scrollWidth > node.clientWidth, font: getComputedStyle(node).fontSize };
        });
        assert.ok(bounds.x >= 7 && bounds.right <= width - 7 && bounds.y >= 7 && bounds.bottom <= 993, JSON.stringify({ theme, width, textScale, bounds }));
        assert.equal(bounds.overflow, false);
        measurements.push({ theme, width, textScale, ...bounds });
        const screenshot = proofDir && (width === 375 && textScale === 2 || width === 1200 && textScale === 1);
        if (screenshot) await page.screenshot({ path: path.join(proofDir, `help-${theme}-${width}-${textScale}.png`) });
        await page.mouse.move(width - 2, 998);
        await page.waitForTimeout(150);
        await noTooltip(page);
        assert.deepEqual(await page.locator("#action").boundingBox(), layoutBefore, "Tooltip appearance/departure never moves its trigger");
        await page.locator("#action").hover();
        await page.getByRole("tooltip").waitFor({ state: "visible" });
        await page.locator("#action").click();
        await noTooltip(page);
        assert.equal(await page.locator("#result").innerText(), "Pending");
        if (screenshot) await page.screenshot({ path: path.join(proofDir, `dismissed-${theme}-${width}-${textScale}.png`) });
    }
    if (proofDir) await writeFile(path.join(proofDir, "tooltip-layout.json"), JSON.stringify(measurements, null, 2));
});

async function pipeline(t, options = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "workiq-tooltip-synthetic-"));
    let db, runtime, browser;
    const errors = [], writes = [];
    t.after(async () => {
        await browser?.close(); await runtime?.close(); db?.close();
        await rm(root, { recursive: true, force: true });
        assert.deepEqual(errors, []);
    });
    const sessionRoot = path.join(root, "session-state");
    const appDbPath = path.join(root, "data.db");
    await mkdir(sessionRoot);
    db = new DatabaseSync(appDbPath);
    db.exec(`PRAGMA user_version=156;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
    const id = randomUUID(), folder = path.join(sessionRoot, id);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, "Synthetic tooltip history", "chat", null, "local");
    await mkdir(folder);
    const event = (type, data) => ({ id: randomUUID(), type, timestamp: new Date().toISOString(), data });
    await writeFile(path.join(folder, "events.jsonl"), [
        event("session.start", { sessionId: id, version: 1 }),
        event("user.message", { content: "Invented tooltip lifecycle request." }),
        event("tool.execution_start", { toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", toolCallId: "synthetic-tooltip-call", arguments: { entityUrls: ["/me/messages"] } }),
        event("tool.execution_complete", { toolCallId: "synthetic-tooltip-call", success: true }),
    ].map(row => JSON.stringify(row) + "\n").join(""));
    const context = { dataDir: path.join(root, "private") };
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    await runtime.collector.configure({ appDbPath, sessionRoot, approved: true, enabled: false, pollSeconds: 5, windowDays: 30 });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", ...options });
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/\/api\/collection\/(?:now|configure|enabled)$/.test(request.url())) writes.push(new URL(request.url()).pathname); });
    await page.goto(runtime.url); await ready(page);
    return { page, runtime, writes };
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}

test("real shell action, result, chart, source and report help clears without altering application state", { timeout: 30000 }, async t => {
    const { page, runtime, writes } = await pipeline(t);
    await runtime.collector.collectNow();
    await page.reload(); await ready(page);
    await controlledClock(page);
    async function leave(selector) {
        await page.mouse.move(1198, 998);
        await page.locator(selector).first().hover();
        await page.clock.runFor(180); await visibleTooltip(page);
        await page.mouse.move(1198, 998); await page.clock.runFor(120); await noTooltip(page);
    }
    for (const selector of ["#checkActivity", "#refreshBtn"]) {
        if (selector === "#refreshBtn") await revealStoredRefresh(page);
        await leave(selector);
    }
    for (const selector of ["#chart .time-column .dimensional-count", ".percentage-label[href]"]) {
        await page.locator(selector).first().hover();
        await page.clock.runFor(180); await noTooltip(page);
    }
    assert.equal(await page.locator("#checkActivity").getAttribute("aria-describedby"), "freshScope");
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    await page.locator("#outcomeFilter-control").click();
    await page.keyboard.press("w"); await page.keyboard.press("Enter"); await ready(page);
    const resultChip = page.getByRole("button", { name: /^Remove outcome filter:/ });
    assert.equal(await resultChip.getAttribute("data-ux-tooltip"), null);
    await resultChip.hover(); await page.clock.runFor(180); await noTooltip(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    await navigateMain(page, "settings");
    await leave("#editSource");
    await navigateMain(page, "reports");
    await chooseReportScope(page, "all");
    await reportContents(page);
    await leave("#exportBtn");
    await leave("#reportsView .ux-help:visible");
    assert.equal(await page.locator("#exportBtn").isDisabled(), false);
    assert.equal(await page.locator('input[name="reportScope"]:checked').inputValue(), "all");
    assert.deepEqual(writes, []);
});

test("percentage links drill down without duplicate help or a second keyboard action", { timeout: 30000 }, async t => {
    const { page, runtime, writes } = await pipeline(t, { hasTouch: true });
    await runtime.collector.collectNow();
    await page.reload(); await ready(page);
    await controlledClock(page);
    const legend = page.locator(".percentage-label[href]").first();
    await legend.focus(); await page.clock.runFor(180); await noTooltip(page);
    const slices = await page.locator(".percentage-slice").evaluateAll(nodes => nodes.map(node => {
        const proxy = node.closest("a"), card = node.closest(".percentage-card");
        const label = [...card.querySelectorAll(".percentage-legend-row")].find(row => row.dataset.category === node.dataset.category)?.querySelector(".percentage-label[href]");
        return {
            tag: node.tagName, role: node.getAttribute("role"), tabIndex: node.getAttribute("tabindex"), hidden: node.getAttribute("aria-hidden"),
            proxy: proxy && { tabIndex: proxy.tabIndex, hidden: proxy.getAttribute("aria-hidden"), sameRoute: proxy.getAttribute("href") === label?.getAttribute("href") },
        };
    }));
    assert.ok(slices.length > 0, "Approved dimensional artwork remains rendered");
    for (const { proxy, ...slice } of slices) {
        assert.deepEqual(slice, { tag: "path", role: null, tabIndex: null, hidden: "true" });
        if (proxy) assert.deepEqual(proxy, { tabIndex: -1, hidden: "true", sameRoute: true }, "Painted pointer proxies share the visible label's route, never a second keyboard stop");
    }
    await legend.tap(); await ready(page); await noTooltip(page);
    assert.match(page.url(), /#activity.*result=success/);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.deepEqual(writes, []);
});

test("real isolated check stays tooltip-free through stalled action, receipt, applying, polling and Reload view", { timeout: 30000 }, async t => {
    const { page, writes } = await pipeline(t);
    const action = page.locator("#checkActivity");
    let releaseCheck, releaseSnapshot;
    await page.route("**/api/collection/now", async route => {
        await new Promise(resolve => { releaseCheck = resolve; });
        await route.continue();
    });
    await action.hover(); await page.getByRole("tooltip").waitFor({ state: "visible" });
    await action.click();
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "checking");
    await noTooltip(page);
    await page.waitForTimeout(350); await noTooltip(page);
    await page.route("**/api/snapshot", async route => {
        await new Promise(resolve => { releaseSnapshot = resolve; });
        await route.continue();
    });
    releaseCheck();
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "applying");
    await noTooltip(page);
    while (!releaseSnapshot) await page.waitForTimeout(10);
    await page.unroute("**/api/snapshot");
    releaseSnapshot();
    await ready(page);
    await page.waitForFunction(() => ["complete", "partial"].includes(document.querySelector("#freshActivity").dataset.phase));
    await noTooltip(page);
    assert.equal(await action.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status") && response.ok(), { timeout: 7000 });
    await noTooltip(page);
    const reload = await revealStoredRefresh(page);
    await reload.hover(); await page.getByRole("tooltip").waitFor({ state: "visible" });
    await reload.click(); await ready(page); await page.waitForTimeout(250);
    await noTooltip(page);
    assert.deepEqual(writes, ["/api/collection/now"]);
    await page.mouse.move(1, 1); await action.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.route("**/api/collection/now", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic check failure." }) }));
    await action.click();
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "error");
    await page.waitForTimeout(250); await noTooltip(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
});

test("real shell result dropdown, chart actions, legend info and Settings navigation retain their distinct lifecycles", { timeout: 30000 }, async t => {
    const { page, runtime, writes } = await pipeline(t);
    await runtime.collector.collectNow();
    await page.reload(); await ready(page);
    await page.mouse.move(1, 1);
    const result = page.locator("#outcomeFilter-control");
    await result.click(); await page.keyboard.press("w"); await page.keyboard.press("Enter"); await ready(page);
    await page.waitForTimeout(250); await noTooltip(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    assert.equal(await result.evaluate(node => node === document.activeElement), true);
    const clear = page.getByRole("button", { name: /^Remove outcome filter:/ });
    await clear.hover(); await noTooltip(page);
    assert.equal(await clear.getAttribute("data-ux-tooltip"), null);
    await clear.click(); await ready(page); await page.waitForTimeout(250); await noTooltip(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "all");
    assert.equal(await result.evaluate(node => node === document.activeElement), true);
    const column = page.locator("#chart .time-column").first();
    await column.focus(); await noTooltip(page);
    await page.keyboard.press("Enter"); await ready(page);
    await page.waitForTimeout(250); await noTooltip(page);
    assert.match(page.url(), /#activity/);
    await page.goBack(); await ready(page); await noTooltip(page);
    const legend = page.locator(".percentage-label[href]").first();
    await legend.focus(); await noTooltip(page);
    await page.keyboard.press("Escape"); await noTooltip(page);
    await (await revealStoredRefresh(page)).click(); await ready(page); await noTooltip(page);
    await legend.click(); await ready(page); await noTooltip(page);
    await navigateMain(page, "settings");
    await page.waitForTimeout(250); await noTooltip(page);
    const edit = page.locator("#editSource");
    await edit.focus(); await page.getByRole("tooltip").waitFor({ state: "visible" });
    await edit.click(); await noTooltip(page);
    await page.locator("#cancelSource").click();
    await page.waitForTimeout(250); await noTooltip(page);
    assert.equal(await edit.evaluate(node => node === document.activeElement), true);
    await page.goBack(); await ready(page); await noTooltip(page);
    assert.deepEqual(writes, [], "Only the fixture-owned collector runs; navigation and help write no source preferences");
});
