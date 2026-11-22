import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, selectActivityOption, closeAnalyzeFilters, chooseTheme } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";

const proof = process.env.WIRE_METADATA_PROOFS;
const baseline = process.env.WIRE_METADATA_BASELINE === "1";
const project = "Invented project \u00b7 original identity punctuation; long cross-team investigation and evidence review";
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function setup(t) {
    const cleanup = [], { records } = periodFixture();
    for (const record of records) { record.projectId = "hierarchy-project"; record.project = project; }
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context), errors = [], denied = [];
    const server = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw Error("No provider in hierarchy proof."); },
            readSource() { throw Error("No source reads in hierarchy proof."); } } });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "America/New_York" });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && ![
            "/api/session", "/api/session/release", "/api/snapshot", "/api/collection/status",
            "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary",
            "/api/report-artifacts/list", "/api/period-comparison",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        if (url.pathname === "/" && request.method() === "GET") {
            const response = await route.fetch(), html = await response.text();
            const binding = "readContext: readChartReferenceContext, renderExact:";
            assert.equal(html.split(binding).length, 2);
            return route.fulfill({ response, body: html.replace(binding, `readContext: () => {
                const value = readChartReferenceContext();
                window.observedScopeContext = value;
                return value;
            }, renderExact:`) });
        }
        return route.continue();
    });
    t.after(async () => {
        try {
            await browser.close(); await server.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(server.url + "#analyze"); await ready(page);
    return { page, server };
}
async function capture(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: path.join(proof, name + "-viewport.png") });
    await page.screenshot({ path: path.join(proof, name + "-full.png"), fullPage: true });
}

test("native accepted scope presents complete peer facts without parsing retained names", { timeout: 60000 }, async t => {
    const { page } = await setup(t), states = [];
    const caption = page.locator("#analyzeScopeCaption");
    await expect(caption).toBeEmpty();
    await expect(page.locator("#analyzeScopeSummary")).not.toBeVisible();
    await capture(page, "ordinary-default");
    if (!baseline) await expect(caption.locator(".analyze-scope-part")).toHaveCount(0);
    for (const [id, value] of [["serviceAssociationFilter", "Files"], ["outcomeFilter", ["failure"]],
        ["projectFilter", "hierarchy-project"]]) { await selectActivityOption(page, id, value); await ready(page); }
    await closeAnalyzeFilters(page);
    await expect(caption).toContainText(project);
    await expect(caption).toContainText("known matches");
    await expect(page.locator("#activityListScope")).toHaveText((await caption.textContent()).replace("All dates; Saved collection; ", ""));
    const accepted = await caption.textContent(), revision = await page.locator("#analyzeScopeSummary").getAttribute("data-revision");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [768, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.evaluate(() => scrollTo(0, 0));
        await expect(caption).toHaveText(accepted);
        await expect(page.locator("#analyzeScopeSummary")).toHaveAttribute("data-revision", revision);
        await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(new RegExp("Copilot project: Invented project"));
        const geometry = await caption.evaluate(node => {
            const rect = value => { const r = value.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
            const parts = [...node.querySelectorAll(".analyze-scope-part")];
            return { box: rect(node), overflow: document.documentElement.scrollWidth - innerWidth,
                parts: parts.map(part => {
                    const range = document.createRange(); range.selectNodeContents(part.firstChild);
                    return { text: part.firstChild.textContent, box: rect(part),
                        lines: [...range.getClientRects()].map(r => ({ x: r.x, right: r.right, y: r.y, bottom: r.bottom })) };
                }),
                homeFindings: document.querySelectorAll("#homeFindings").length };
        });
        assert.equal(geometry.homeFindings, 0, "The inventoried retired host is not present in the live shell");
        assert.ok(geometry.overflow <= 1);
        if (!baseline) {
            assert.equal(geometry.parts.length, 4);
            assert.equal(geometry.parts.at(-1).text, `Copilot project: ${project}`);
            for (const part of geometry.parts) assert.ok(part.lines.every(line => line.x >= geometry.box.x - 1
                && line.right <= geometry.box.right + 1 && line.y >= geometry.box.y - 1 && line.bottom <= geometry.box.bottom + 1));
        }
        states.push({ theme, width, scale, ...geometry });
        await capture(page, `ordinary-restricted-${theme}-${width}-${scale}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.locator("#openChartReference").click();
    if (!baseline) {
        const context = await page.evaluate(() => window.observedScopeContext);
        assert.deepEqual(context.qualificationParts, [
            "Service: Files", "Includes missing-service context: 2 known matches; 0 context-only",
            "Outcome: Tool failed", `Copilot project: ${project}`,
        ]);
        assert.equal(context.qualification, context.qualificationParts.join("; "));
    }
    await page.getByRole("button", { name: "See exact numbers", exact: true }).click();
    await page.locator("#chartReferenceSource > summary").click();
    await expect(page.locator("#periodHint")).toBeVisible();
    await page.locator("#periodHint").scrollIntoViewIfNeeded();
    if (!baseline) await expect(page.locator("#periodHint .analyze-scope-part")).toHaveText(["2 interactions; ", "2 Copilot chats"]);
    await capture(page, "guide-current-scope-counts");
    states.push({ periodHint: await page.locator("#periodHint").textContent() });
    await page.locator("#meaning").press("Escape");
    await expect(page.locator("#meaning")).toHaveAttribute("data-reference-view", "guide");
    await page.locator("#meaning").press("Escape");
    await page.locator("#comparePeriods").click();
    await page.locator("#openChartReference").click();
    if (!baseline) {
        const context = await page.evaluate(() => window.observedScopeContext);
        assert.equal(context.available, false);
        assert.equal(context.qualification, "");
        assert.deepEqual(context.qualificationParts, []);
    }
    await page.locator("#meaning").press("Escape");
    if (proof) await writeFile(path.join(proof, "native-reachability.json"), JSON.stringify(states, null, 2));
});
