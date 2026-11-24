import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { openActivitySessions, chooseTheme } from "./helpers.mjs";
import { contrast, distance } from "./color-measurements.mjs";

const proofs = process.env.WIRE_AUTHOR_VISIBILITY_PROOFS;
const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");

test("Human prompt uses a distinctive shared accent on real light/dark list and detail surfaces", { timeout: 45000 }, async t => {
    const app = await authorFilterFixture(t), selected = new Set(["ownMail", "agentMail", "unverified"].map(key => app.cases[key].scenarioId));
    await replaceEvidence(app.context, () => ({ records: app.state.evidence.filter(record => selected.has(record.scenarioId)), importCoverage: app.state.importCoverage }));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, reducedMotion: "reduce" });
    const errors = [], forbidden = [], observations = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(app.runtime.url).origin || /\/api\/(?:collection\/(?:now|configure|enabled)|evaluation\/(?:start|automatic\/(?:approve|revoke)))/.test(url.pathname)) {
            forbidden.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    app.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(forbidden, []); });
    if (proofs) await mkdir(proofs, { recursive: true });
    const ownId = app.cases.ownMail.scenarioId;
    for (const theme of ["light", "dark"]) for (const width of [1200, 375]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.goto(app.runtime.url + "#activity"); await ready(page); await chooseTheme(page, theme); await openActivitySessions(page);
        const group = page.locator("#activityList");
        const ownRow = group.locator(`.request-row[data-view-key="request:${ownId}"]`);
        for (const state of ["default", "hover", "focus"]) {
            if (state === "hover") await ownRow.hover();
            else {
                await page.locator("#pageTitle").hover();
                if (state === "focus") {
                    await ownRow.locator(".request-card-open").focus();
                    await expect(ownRow.locator(".request-card-open")).toBeFocused();
                }
            }
            const cues = await group.locator(".request-card-author").evaluateAll(nodes => nodes.map(node => {
                let parent = node, background;
                while (parent && (!background || background === "rgba(0, 0, 0, 0)")) { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; }
                const style = getComputedStyle(node);
                return { actor: node.dataset.promptActor, label: node.textContent, color: style.color,
                    icon: getComputedStyle(node.querySelector("svg")).color, background };
            }));
            const own = cues.find(cue => cue.actor === "user"), agent = cues.find(cue => cue.actor === "agent"), unknown = cues.find(cue => cue.actor === "unknown");
            assert.ok(own && agent && unknown);
            assert.equal(own.label, "Human prompt");
            assert.equal(agent.label, "Agent prompt");
            assert.equal(unknown.label, "Sender unclear");
            for (const cue of cues) {
                assert.ok(contrast(cue.color, cue.background) >= 4.5, `${theme}/${state}: text contrast`);
                assert.ok(contrast(cue.icon, cue.background) >= 3, `${theme}/${state}: author icon contrast`);
            }
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            observations.push({ surface: "list", theme, width, state, cues });
            if (proofs) await group.screenshot({ path: path.join(proofs, `authors-${theme}-${width}-${state}.png`) });
        }
        await ownRow.locator(".request-card-open").press("Enter"); await ready(page);
        const reader = page.locator('[data-reader-section="prompt"]'), heading = reader.locator(".reader-section-heading [data-prompt-actor=user]");
        const detail = await reader.evaluate(node => ({
            heading: getComputedStyle(node.querySelector(".reader-section-heading [data-prompt-actor=user] svg")).color,
            body: getComputedStyle(node.querySelector("pre")).color,
            ink: getComputedStyle(document.body).color,
            text: node.querySelector("pre").textContent,
        }));
        assert.equal(detail.text, app.cases.ownMail.content);
        assert.equal(detail.body, detail.ink, "The prompt body keeps the normal reading color");
        const listOwn = observations.at(-1).cues.find(cue => cue.actor === "user");
        assert.equal(detail.heading, listOwn.icon, "Analyze and the reader identify the same author");
        assert.equal(await heading.getAttribute("data-prompt-actor"), "user");
        observations.push({ surface: "detail", theme, width, ...detail, text: undefined });
        if (proofs) await reader.screenshot({ path: path.join(proofs, `your-detail-${theme}-${width}.png`) });
    }
    if (proofs) await writeFile(path.join(proofs, "palette-measurements.json"), JSON.stringify(observations, null, 2));
    for (const observation of observations.filter(item => item.surface === "list")) {
        const own = observation.cues.find(cue => cue.actor === "user"), agent = observation.cues.find(cue => cue.actor === "agent");
        assert.ok(distance(own.icon, agent.icon) >= 12, "Human and Agent icons remain visibly distinct");
    }
});
