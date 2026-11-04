import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createSavedArtifactDeletion } from "../web/saved-artifact-deletion.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { deletionStyles } from "../web/deletion-styles.mjs";

test("saved-object receipt READ dismisses immediately and preserves recovery without sending deletion", { timeout: 15000 }, async t => {
    const browser = await chromium.launch(), page = await browser.newPage();
    const calls = [], errors = [];
    let entered, release;
    const reading = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    t.after(async () => { release(); await browser.close(); assert.deepEqual(errors, []); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.request().url() === "https://wire.invalid/"
        ? route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head></head><body><main><h2 id="saved" tabindex="-1">Saved reports</h2><button id="open">Check prior operation</button></main></body></html>' })
        : route.abort());
    const receipt = { operationId: "00000000-0000-4000-8000-000000000001", receiptToken: "a".repeat(64) };
    await page.exposeFunction("readReceipt", async (endpoint, input) => {
        calls.push({ endpoint, input });
        assert.equal(endpoint, "/api/artifact-deletion/status", "This test cannot send any mutation.");
        entered(); await hold;
        return { operationId: receipt.operationId, phase: "pending" };
    });
    await page.goto("https://wire.invalid/");
    await page.addStyleTag({ content: styles + deletionStyles });
    await page.addScriptTag({ content: `window.createDeletion=${createSavedArtifactDeletion.toString()};window.createUX=${createEvidenceUX.toString()};` });
    await page.evaluate(({ receipt, icons }) => {
        sessionStorage.setItem("wire.saved-artifact-deletion", JSON.stringify(receipt));
        const token = Object.freeze({});
        const api = Object.assign((...args) => window.readReceipt(...args), {
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
    await reading;
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(":modal").count(), 0, "Reading a receipt must not hold the user in a modal.");
    assert.equal(await page.locator("#open").evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("wire.saved-artifact-deletion"))), receipt);
    release();
    await page.waitForTimeout(100);
    assert.equal(await page.locator(":modal").count(), 0);
    assert.equal(calls.length, 1);
});
