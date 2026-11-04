import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { collectedResultFixture } from "./retained-result-fixture.mjs";
import { chooseTheme, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const cases = [
    { name: "single-204", completion: { success: true, result: { structuredContent: { statusCode: 204, data: null } } },
        expected: "The source returned no body.", summary: "Reported status 204", members: 0 },
    { name: "application-error", completion: { success: true, result: { isError: true,
        content: [{ type: "text", text: "Required scope [Tasks.ReadWrite] is missing." }] } },
        expected: "Required scope [Tasks.ReadWrite] is missing.", summary: "reports an application error", members: 0 },
    { name: "mixed", completion: { success: true, result: { structuredContent: { results: [
        { statusCode: 200, body: "EXCLUDED_BODY" }, { statusCode: 403, error: { code: "Denied", message: "Only this returned member was denied." } },
    ] } } }, expected: "Only this returned member was denied.", summary: "Returned entry 2: Only this returned member was denied. (Denied; status 403)", members: 2 },
    { name: "absent", completion: { success: true }, expected: "The source did not supply result content.",
        summary: "Result content was not supplied", members: 0 },
    { name: "capped", completion: { success: true, result: { structuredContent: {
        results: Array.from({ length: 102 }, () => ({ statusCode: 200, body: "EXCLUDED_BODY" })),
    } } }, expected: "WIRE saved 100 of the 102 returned entries.", summary: "WIRE saved 100 of the 102 returned entries.", members: 100 },
    { name: "empty-error", completion: { success: false, error: {} }, expected: "The source did not supply error details.", members: 0 },
    { name: "sentinel-error", completion: { success: false, error: { code: "failure" } },
        expected: "The source supplied only a generic failure marker.", members: 0 },
    { name: "failure-no-error", completion: { success: false },
        expected: "For more detail, check the original Copilot chat, if it is still available.", members: 0 },
];

for (const example of cases) test(`ordinary retained ${example.name} has coherent card, completion filter, widget and reopened reader`, { timeout: 60000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const app = await collectedResultFixture(t, example.completion);
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const page = await browserContext.newPage(), errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    await browserContext.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(app.runtime.url).origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    const response = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.goto(app.runtime.url);
    const snapshot = await (await response).json();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    assert.equal(app.record.toolCalls[0].apiResults.length, example.members);
    assert.equal(snapshot.requestActivity.tool[0].outcome, example.completion.success ? "success" : "failure");
    if (example.completion.success) {
        await expect(page.getByRole("region", { name: "Tool call results", exact: true })).toContainText("Tool completed");
        await selectActivityOption(page, "outcomeFilter", "success");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await closeAnalyzeFilters(page);
        await expect(page.locator(".request-card-problem")).toContainText(example.summary);
        await expect(page.locator(".request-card-problem")).not.toContainText("worked");
        await expect(page.locator(".request-card-problem")).not.toContainText("missing..");
    }
    const ready = () => page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator(".request-card-open").click(); await ready();
        const call = page.locator('[data-reader-section=activity] [data-tool-call-id="result-call"]');
        const toggle = call.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        await expect(call).toContainText(example.expected);
        await expect(call).not.toContainText("EXCLUDED_");
        if (["empty-error", "sentinel-error"].includes(example.name)) {
            await expect(call.locator(".reader-call-summary")).not.toContainText(/not retained|not saved/);
        }
        await expect(call.locator(".reader-failure-guidance")).toHaveCount(example.name === "failure-no-error" ? 1 : 0);
        if (example.name === "application-error") {
            await expect(call.locator(".journey-result .recorded-result")).toHaveAttribute("data-outcome", "success");
            await expect(call.locator(".journey-result .recorded-result")).toHaveClass(/result-tone-success/);
            await expect(call.locator(".reader-call-summary")).toContainText("Call #1 completed");
            await expect(call.locator(".reader-call-summary")).not.toContainText("Worked");
            assert.equal((await call.innerText()).split(example.expected).length - 1, 1, "Expanded source error text is shown once");
            await expect(call.locator(".reader-call-summary .result-cause")).toBeHidden();
        }
        if (["application-error", "mixed", "capped"].includes(example.name)) {
            const text = await call.textContent(), width = await page.locator("#contextSidebar").evaluate(node => node.getBoundingClientRect().width);
            await page.locator("#widenInteraction").click();
            await page.locator("#expandInteraction").click();
            await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "expanded");
            await expect(toggle).toHaveAttribute("aria-expanded", "true");
            assert.equal(await call.textContent(), text);
            await page.locator("#expandInteraction").click();
            assert.equal(await page.locator("#contextSidebar").evaluate(node => node.getBoundingClientRect().width), width + 32);
            assert.equal(await call.textContent(), text);
            assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        }
        if (process.env.WIRE_FAILURE_PROOFS && ["single-204", "application-error", "empty-error"].includes(example.name)) {
            await mkdir(process.env.WIRE_FAILURE_PROOFS, { recursive: true });
            await call.locator(".technical-detail").scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(process.env.WIRE_FAILURE_PROOFS, `result-${example.name}-${theme}.png`) });
        }
        await page.locator("#closeContextSidebar").click(); await ready();
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
    }
    await page.reload(); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator(".request-card-open").click(); await ready();
    const toggle = page.locator('[data-tool-call-id="result-call"] .reader-call-toggle');
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(page.locator("#requestContent")).toContainText(example.expected);
    await app.unchanged();
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
