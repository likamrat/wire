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
import { openReportComparison } from "./report-journey-helpers.mjs";

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

test("native saved-report options retain detail and disabled reasons through the shared control", { timeout: 30000 }, async t => {
    const { page, server } = await setup(t);
    const artifacts = ["earlier", "unavailable", "period"].map((id, index) => ({
        bundleId: `hierarchy-${id}`, kind: "report", title: `Invented ${id} report`,
        preparedAt: "2026-03-07T12:00:00Z", preparedAtDisplay: "Mar 7, 2026, 7:00 AM",
        requestGroupCount: 2, formats: ["html", "json"], promptMode: "none",
        comparisonEligibility: index === 2 ? "period-report-has-two-cohorts-not-one-source" : index ? "unavailable" : "available",
    }));
    await page.route("**/api/report-artifacts/list", route => route.fulfill({ json: { artifacts } }));
    await page.goto(server.url + "#reports"); await ready(page); await openReportComparison(page);
    const field = page.locator("#comparisonWorkspace select").first();
    await expect(field.locator('option[value="hierarchy-unavailable"]')).toHaveCount(1);
    const native = await field.locator('option[value="hierarchy-unavailable"]').textContent();
    const metadata = "Prepared Mar 7, 2026, 7:00 AM. 2 interactions. No prompts. Files: HTML, JSON. Report ID: hierarchy-unavailable";
    assert.equal(native, "Invented unavailable report (Prepared Mar 7, 2026, 7:00 AM; 2 interactions; No prompts) (structured facts unavailable)");
    await expect(field.locator('option[value="hierarchy-unavailable"]')).toHaveAttribute("data-detail", metadata);
    await expect(field.locator('option[value="hierarchy-unavailable"]')).toHaveAttribute("data-disabled-reason", "structured facts unavailable.");
    await expect(field.locator('option[value="hierarchy-earlier"]')).not.toHaveAttribute("data-disabled-reason");
    await expect(field.locator('option[value="hierarchy-period"]')).toHaveAttribute("data-disabled-reason", "two-cohort period report; open directly.");
    await expect(field.locator('option[value="hierarchy-period"]')).toContainText("(two-cohort period report; open directly)");
    await page.getByRole("combobox", { name: "Earlier report", exact: true }).click();
    const unavailable = page.locator('.select-popup [data-value="hierarchy-unavailable"]');
    await expect(unavailable).toHaveAttribute("aria-disabled", "true");
    await expect(unavailable).toHaveAccessibleDescription(`${metadata}; Unavailable: structured facts unavailable.`);
    await capture(page, "native-report-option");
    await page.keyboard.press("Escape");
    const states = [];
    for (const [state, reason] of [["normal", "structured facts unavailable."], ["replacement", "This saved report has no structured facts."]]) {
        if (state === "replacement") await field.locator('option[value="hierarchy-unavailable"]').evaluate((node, reason) => {
            node.dataset.disabledReason = reason;
        }, reason);
        for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 2]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            await chooseTheme(page, theme);
            await page.getByRole("combobox", { name: "Earlier report", exact: true }).click();
            await unavailable.scrollIntoViewIfNeeded();
            await expect(unavailable).toHaveAccessibleName("Invented unavailable report");
            await expect(unavailable).toHaveAttribute("aria-disabled", "true");
            await expect(unavailable).toHaveAccessibleDescription(`${metadata}; Unavailable: ${reason}`);
            const detail = await unavailable.locator(".select-option-detail").textContent();
            assert.equal(detail.split("Unavailable:").length - 1, 1);
            await expect(field.locator('option[value="hierarchy-unavailable"]')).toHaveAttribute("data-detail", metadata);
            await expect(field.locator('option[value="hierarchy-unavailable"]')).toHaveText(native);
            const geometry = await unavailable.locator(".select-option-detail").evaluate(node => {
                const box = node.getBoundingClientRect();
                return { x: box.x, right: box.right, clipped: node.scrollWidth - node.clientWidth,
                    vertical: node.scrollHeight - node.clientHeight };
            });
            assert.ok(geometry.x >= 0 && geometry.right <= width + 1 && geometry.clipped <= 1 && geometry.vertical <= 1);
            const box = await unavailable.boundingBox();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await expect(field).toHaveValue("");
            states.push({ state, theme, width, scale, detail, native, geometry });
            await capture(page, `native-option-${state}-${theme}-${width}-${scale}`);
            await page.keyboard.press("Escape");
        }
    }
    await field.locator('option[value="hierarchy-earlier"]').evaluate(node => {
        node.dataset.disabledReason = "Not applicable while this option is enabled.";
    });
    await page.getByRole("combobox", { name: "Earlier report", exact: true }).click();
    const available = page.locator('.select-popup [data-value="hierarchy-earlier"]');
    await expect(available).toHaveAttribute("aria-disabled", "false");
    await expect(available).not.toHaveAccessibleDescription(/Not applicable/);
    await page.getByRole("combobox", { name: "Earlier report", exact: true }).press("End");
    await expect(page.getByRole("combobox", { name: "Earlier report", exact: true }))
        .toHaveAttribute("aria-activedescendant", await available.getAttribute("id"));
    await page.keyboard.press("Escape");
    if (proof) await writeFile(path.join(proof, "report-option-contract.json"), JSON.stringify(states, null, 2));
});
