import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createSavedArtifactDeletion } from "../web/saved-artifact-deletion.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { deletionStyles } from "../web/deletion-styles.mjs";

test("Escape dismisses a pending receipt check without losing recovery or sending deletion", { timeout: 15000 }, async t => {
    const browser = await chromium.launch(), page = await browser.newPage();
    const errors = [];
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.request().url() === "https://wire.invalid/"
        ? route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head></head><body><main><h2 id="saved" tabindex="-1">Saved reports</h2><button id="open">Check prior operation</button></main></body></html>' })
        : route.abort());
    const receipt = { operationId: "00000000-0000-4000-8000-000000000001", receiptToken: "a".repeat(64) };
    await page.goto("https://wire.invalid/");
    await page.addStyleTag({ content: styles + deletionStyles });
    await page.addScriptTag({ content: `window.createDeletion=${createSavedArtifactDeletion.toString()};window.createUX=${createEvidenceUX.toString()};` });
    await page.evaluate(({ receipt, icons }) => {
        sessionStorage.setItem("wire.saved-artifact-deletion", JSON.stringify(receipt));
        const token = Object.freeze({});
        window.receiptCalls = [];
        const held = new Promise(resolve => { window.releaseReceipt = resolve; });
        const api = Object.assign((endpoint, input) => {
            window.receiptCalls.push({ endpoint, input });
            return held;
        }, {
            publicationToken: () => token, isCurrent: value => value === token,
        });
        const flow = window.createDeletion({
            api, ux: window.createUX(icons), onDeleted: () => { throw Error("No deletion is expected."); },
            onError: message => { throw Error(message); }, fallbackFocus: () => document.getElementById("saved"),
        });
        document.getElementById("open").onclick = event => flow.open(null, event.currentTarget);
    }, { receipt, icons: uxIcons });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "Check deletion result", exact: true }).click();
    await page.waitForFunction(() => window.receiptCalls.length > 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(":modal").count(), 0, "Reading a receipt must not hold the user in a modal.");
    assert.equal(await page.locator("#open").evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("wire.saved-artifact-deletion"))), receipt);
    await page.evaluate(async receipt => {
        window.releaseReceipt({ operationId: receipt.operationId, phase: "pending" });
        await new Promise(requestAnimationFrame);
    }, receipt);
    assert.equal(await page.locator(":modal").count(), 0);
    assert.equal(await page.locator("#open").evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("wire.saved-artifact-deletion"))), receipt);
    assert.deepEqual(await page.evaluate(() => window.receiptCalls), [{ endpoint: "/api/artifact-deletion/status", input: receipt }]);
});
