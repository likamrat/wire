import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { styles } from "../web/styles.mjs";
import { deletionStyles } from "../web/deletion-styles.mjs";
import { createDeletionFlow, mountDeletion } from "../web/deletion-flow.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

function frameMarkup() {
    const shell = renderHtmlShell("a".repeat(64), "frame-proof");
    const start = shell.indexOf('<dialog id="deleteDialog"');
    return shell.slice(start, shell.indexOf("</dialog>", start) + 9);
}

test("native decision frame pins question and actions without exposing closed dialogs", { timeout: 30000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 375, height: 1000 }, reducedMotion: "reduce" });
    const markup = frameMarkup();
    await page.setContent(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${markup}</body></html>`);
    await page.addStyleTag({ content: styles + deletionStyles });
    const dialog = page.locator("#deleteDialog");
    assert.equal(await dialog.isVisible(), false);
    for (const theme of ["light", "dark"]) for (const forced of ["none", "active"]) {
        await page.emulateMedia({ forcedColors: forced });
        await page.evaluate(theme => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = "200%";
            const dialog = document.getElementById("deleteDialog");
            dialog.dataset.decisionPhase = "confirm";
            document.getElementById("deleteScopeForm").hidden = true;
            document.getElementById("deleteConfirmation").hidden = false;
            document.getElementById("deleteSummary").textContent = "All collected activity: 123 records across 24 current request groups.";
            document.getElementById("deleteChangeScope").hidden = false;
            document.getElementById("deleteConfirm").disabled = false;
            document.getElementById("deleteTitle").textContent = "Delete all collected activity?";
            dialog.querySelector("details").open = true;
            dialog.showModal();
            document.getElementById("deleteCancel").focus();
        }, theme);
        const geometry = await dialog.evaluate(node => {
            const rect = value => value.getBoundingClientRect().toJSON();
            const body = node.querySelector(".decision-body");
            body.scrollTop = body.scrollHeight;
            return { dialog: rect(node), heading: rect(node.querySelector(".delete-heading")),
                body: rect(body), actions: rect(node.querySelector(".delete-actions")),
                cancel: rect(document.getElementById("deleteCancel")), scroll: node.scrollTop,
                overflow: node.scrollWidth - node.clientWidth, bodyOverflow: body.scrollHeight - body.clientHeight,
                scopeInBody: body.contains(document.getElementById("deleteChangeScope")) };
        });
        assert.equal(geometry.scroll, 0, `${theme}/${forced}`);
        assert.ok(geometry.overflow <= 1);
        assert.ok(geometry.bodyOverflow > 0);
        assert.ok(geometry.heading.y >= geometry.dialog.y);
        assert.ok(geometry.actions.y + geometry.actions.height <= geometry.dialog.y + geometry.dialog.height);
        assert.ok(geometry.body.height > 100);
        assert.ok(geometry.cancel.height >= 44);
        assert.equal(geometry.scopeInBody, true);
        await page.keyboard.press("Escape");
        assert.equal(await dialog.isVisible(), false);
    }
});

for (const theme of ["light", "dark"]) test(`activity decision lifecycle keeps ${theme} narrow questions, recovery and safe dismissal coherent`, { timeout: 30000 }, async t => {
    const operationId = "00000000-0000-4000-8000-000000000003";
    const counts = { records: 3, requestGroups: 2, toolCalls: 3, graphRecords: 0, diagnostics: 0, other: 0,
        localCopies: 2, savedReports: 4, savedComparisons: 1 };
    const preserved = JSON.stringify({ counts, activity: ["synthetic-a", "synthetic-b", "synthetic-c"], saved: ["unchanged"] });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 375, height: 1000 }, reducedMotion: "reduce" });
    const calls = [], errors = [];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(async () => { release(); await browser.close(); assert.deepEqual(errors, []); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        assert.equal(route.request().url(), "https://wire.invalid/");
        return route.fulfill({ contentType: "text/html", body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><button id="deleteActivity">Review deletion</button>${frameMarkup()}</body></html>` });
    });
    await page.exposeFunction("syntheticDeletion", async (endpoint, input) => {
        calls.push({ endpoint, input });
        if (endpoint.endsWith("/preview")) return { operationId, scope: { ...input }, counts };
        assert.equal(input.operationId, operationId);
        if (endpoint.endsWith("/cancel")) return { cancelled: true };
        if (endpoint.endsWith("/confirm")) { await held; return { failure: "Synthetic unconfirmed deletion response." }; }
        assert.equal(endpoint, "/api/deletion/status");
        return { operationId, phase: "complete", counts };
    });
    await page.goto("https://wire.invalid/");
    await page.addStyleTag({ content: styles + deletionStyles });
    await page.addScriptTag({ content: `
        window.mountFlow=${mountDeletion.toString()};
        window.createFlow=${createDeletionFlow.toString()};
        window.createUx=${createEvidenceUX.toString()};
    ` });
    await page.evaluate(({ icons, theme }) => {
        document.documentElement.dataset.evidenceTheme = theme;
        document.documentElement.style.fontSize = "200%";
        window.refreshes = 0;
        window.mountFlow({
            api: async (endpoint, input) => { const value = await window.syntheticDeletion(endpoint, input); if (value.failure) throw Error(value.failure); return value; },
            flow: window.createFlow(), timeContext: () => ({ timeZone: "UTC", locale: "en-US" }),
            ux: window.createUx(icons), onCommitted: async () => { window.refreshes++; return true; },
        });
    }, { icons: uxIcons, theme });
    const dialog = page.locator("#deleteDialog");
    const proof = process.env.WIRE_DECISION_PROOF_DIR;
    if (proof) await mkdir(proof, { recursive: true });
    async function capture(phase) {
        if (proof) await page.screenshot({ path: path.join(proof, `activity-${phase}-${theme}-375-200.png`) });
    }
    assert.equal(await dialog.isVisible(), false);
    await page.locator("#deleteActivity").click();
    assert.equal(await page.locator("#deleteCancel").evaluate(node => node === document.activeElement), true);
    await page.locator("#deleteAll").check();
    await page.locator("#deletePreview").click();
    await page.locator('#deleteDialog[data-decision-phase="confirm"]').waitFor();
    assert.equal(await page.locator("#deleteTitle").textContent(), "Delete all collected activity?");
    assert.equal(await page.locator("#deleteCancel").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#deleteDialog").evaluate(node => node.scrollTop), 0);
    assert.match(await page.locator("#deleteSummary").textContent(), /3 records across 2/);
    assert.equal(await page.locator("#deleteBoundary").isVisible(), false, "The exact scope, not the selection explainer, leads confirmation.");
    const scopeOffset = await page.locator("#deleteSummary").evaluate(node => node.getBoundingClientRect().top - node.closest(".decision-body").getBoundingClientRect().top);
    assert.ok(scopeOffset <= 17, "Exact scope starts at the scrolling body's normal inset.");
    assert.equal(await page.locator(".decision-scope #deleteChangeScope").isVisible(), true);
    await capture("confirm");
    await page.locator("#deleteChangeScope").click();
    assert.equal(await page.locator("#deleteConfirm").isVisible(), false);
    assert.equal(calls.filter(value => value.endpoint.endsWith("/cancel")).length, 1);
    await page.locator("#deleteAll").check();
    await page.locator("#deletePreview").click();
    await page.locator('#deleteDialog[data-decision-phase="confirm"]').waitFor();
    await page.locator("#deleteConfirm").click();
    await page.locator('#deleteDialog[data-decision-phase="pending"]').waitFor();
    assert.equal(await page.locator("#deleteCancel").isDisabled(), true);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    await capture("pending");
    release();
    await page.locator('#deleteDialog[data-decision-phase="unknown"]').waitFor();
    const actions = dialog.locator(".delete-actions button:visible");
    assert.deepEqual(await actions.allTextContents(), ["Close", "Check deletion result"]);
    assert.equal(await page.locator("#deleteConfirm").isVisible(), false);
    const stored = await page.evaluate(() => sessionStorage.getItem("workiq-evidence.deletion-operation"));
    await page.locator("#deleteCancel").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#deleteCheck").evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.locator("#deleteCancel").evaluate(node => node === document.activeElement), true);
    await capture("unknown");
    await page.keyboard.press("Enter");
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.deletion-operation")), stored);
    assert.equal(calls.filter(value => value.endpoint.endsWith("/cancel")).length, 1, "Close is not cancellation of an issued deletion.");
    await page.locator("#deleteActivity").click();
    assert.equal(await page.locator("#deleteCancel").evaluate(node => node === document.activeElement), true);
    assert.equal(calls.filter(value => value.endpoint.endsWith("/preview")).length, 2);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.locator('#deleteDialog[data-decision-phase="complete"]').waitFor();
    assert.equal(calls.filter(value => value.endpoint.endsWith("/confirm")).length, 1);
    assert.deepEqual(calls.filter(value => value.endpoint.endsWith("/status")).map(value => value.input), [{ operationId }]);
    assert.equal(await page.locator("#deleteCancel").evaluate(node => node === document.activeElement), true);
    await capture("complete");
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.evaluate(() => window.refreshes), 1);
    assert.equal(JSON.stringify({ counts, activity: ["synthetic-a", "synthetic-b", "synthetic-c"], saved: ["unchanged"] }), preserved);
});

test("shared native frame stays neutral without an explicit destructive kind and permits unavailable recovery scope", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 375, height: 1000 } });
    await page.setContent('<html><body><dialog class="deletion-dialog decision-frame" data-decision-phase="unknown"><div class="delete-heading"><h2>Result unknown</h2></div><div class="decision-body"><p>The original scope is unavailable in this receipt. Check its result; no operation will be repeated.</p></div><div class="delete-actions"><button>Close</button><button data-decision-action="check">Check result</button></div></dialog></body></html>');
    await page.addStyleTag({ content: styles + deletionStyles });
    assert.equal(await page.locator("dialog").isVisible(), false);
    for (const theme of ["light", "dark"]) {
        const result = await page.evaluate(theme => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = "200%";
            const dialog = document.querySelector("dialog");
            if (!dialog.open) dialog.showModal();
            const button = dialog.querySelector("[data-decision-action]"), heading = dialog.querySelector(".delete-heading");
            const style = getComputedStyle(button), normal = getComputedStyle(heading).backgroundColor;
            dialog.dataset.decisionKind = "destructive";
            const destructive = getComputedStyle(heading).backgroundColor;
            delete dialog.dataset.decisionKind;
            return { neutral: normal !== destructive, fill: style.getPropertyValue("--pill-fill").trim(),
                expected: style.getPropertyValue("--accent-fill").trim(),
                overflow: dialog.scrollWidth - dialog.clientWidth, scopeText: dialog.querySelector(".decision-body").textContent };
        }, theme);
        assert.equal(result.neutral, true);
        assert.equal(result.fill, result.expected);
        assert.ok(result.overflow <= 1);
        assert.match(result.scopeText, /scope is unavailable/);
        assert.doesNotMatch(result.scopeText, /0 records/);
    }
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog").isVisible(), false);
});
