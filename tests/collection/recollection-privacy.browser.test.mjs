import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { navigateMain, navigateSettings } from "../support/helpers.mjs";
import { createCopilotRuntimeAccess } from "../../lib/runtime-access.mjs";
import { createExportController } from "../../lib/export.mjs";
import { startServer } from "../../lib/server.mjs";
import { loadBoardState, replaceEvidence } from "../../lib/store.mjs";

test("enforced recollection erases its private DOM values before it detaches the rendered rows", async t => {
    const f = await recollectionFixture(t);
    await f.collector.setEnabled(true);
    await f.stop();
    const state = await loadBoardState(f.context);
    await replaceEvidence(f.context, records => ({ records: records.map(record => ({ ...record,
        toolCalls: record.toolCalls.map(call => {
            if (call.toolCallId !== "selected-A") return call;
            const { resultEvidence, ...old } = call;
            return old;
        }) })), importCoverage: state.importCoverage }));
    let runtime, access, browser;
    try {
        runtime = await startServer(f.context, createExportController(f.context), { port: 0,
            collector: { timers: false }, createAccess: async () => access = await createCopilotRuntimeAccess(f.context) });
        const origin = new URL(runtime.url).origin;
        browser = await chromium.launch();
        const page = await browser.newPage({ reducedMotion: "reduce", timezoneId: "UTC" });
        await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.goto(runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
        await navigateMain(page, "settings"); await navigateSettings(page, "data");
        const choose = async () => {
            await page.locator("#recollectActivity").click();
            await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
            await page.locator("#recollectFrom").fill(f.firstDay); await page.locator("#recollectTo").fill(f.firstDay);
            const correction = page.locator("#recollectCorrections");
            if (await correction.isVisible()) await correction.check();
            await page.locator("#recollectPreview").click();
            await expect(page.locator("#recollectConfirmation")).toBeVisible();
        };
        await choose();
        await page.locator("#recollectClose").click();
        await choose();
        const watched = await page.evaluate(() => {
            const result = window.clearance = { checked: [], bad: [] };
            const check = (label, ok) => { result.checked.push(label); if (!ok) result.bad.push(label); };
            // Check live, attached fixture nodes at the disposal boundary. Keep only booleans/labels.
            const audit = (root, valid) => {
                if (!root?.childNodes.length || !root.textContent.trim()) throw Error("No fixture content to retire");
                const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
                const before = () => { if (root.childNodes.length) check(root.id, valid(root)); };
                Object.defineProperty(root, "textContent", { configurable: true, get: text.get,
                    set(v) { before(); text.set.call(this, v); } });
                root.replaceChildren = function (...nodes) { before(); return Element.prototype.replaceChildren.apply(this, nodes); };
            };
            const noText = node => {
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                for (let t = walker.nextNode(); t; t = walker.nextNode()) if (t.data !== "") return false;
                return true;
            };
            const sources = document.querySelector("#recollectSources");
            for (const field of sources.querySelectorAll("label input")) {
                if (!field.getAttribute("value")) throw Error("No fixture source attribute");
                field.removeAttribute = function (name) {
                    if (name === "value") check("source-attr", this.getAttributeNode(name)?.value === "");
                    return Element.prototype.removeAttribute.call(this, name);
                };
            }
            audit(sources, r => [...r.querySelectorAll("label span")].every(noText)
                && [...r.querySelectorAll("label input")].every(f => !f.value && !f.checked));
            const ids = ["recollectScope", "recollectAvailability"];
            if (document.getElementById("recollectCorrections")?.checked) ids.push("recollectCorrectionList");
            for (const id of ids) audit(document.getElementById(id), noText);
            return [...ids, "recollectSources", "source-attr"];
        });
        const headers = { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" };
        const session = await page.request.post(origin + "/api/session", { headers, data: {} });
        headers["X-Board-Capability"] = (await session.json()).capability;
        const status = await page.request.get(origin + "/api/access/status", { headers });
        const signedOut = await page.request.post(origin + "/api/access/command", { headers, data: {
            schemaVersion: 1, generation: (await status.json()).generation, operationId: randomUUID(), action: "wire-sign-out",
        } });
        assert.equal(signedOut.status(), 200);
        await expect(page.locator("#accessShell")).toBeVisible();
        const result = await page.evaluate(() => window.clearance);
        assert.deepEqual(result.bad, []);
        for (const label of watched) assert.ok(result.checked.includes(label), label);
        assert.equal(await page.locator("#recollectTo").inputValue(), "");
        assert.equal((await page.locator("#recollectAvailabilityToggle").textContent()).trim(), "Source availability and limits");
    } finally { await browser?.close(); await runtime?.close(); await access?.close(); }
});
