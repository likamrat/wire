import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";

test("pending feedback keeps its label and does not move the next action at enlarged text", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
    await page.setContent(`<html style="font-size:200%"><style>${styles}</style>
        <p id="status">1,234 matching tool calls</p><button id="reload">Reload</button><button id="cancel">Cancel</button>`);
    await page.addScriptTag({ content: `window.ux=(${createEvidenceUX})(${JSON.stringify(uxIcons)});
        document.querySelector("#reload").prepend(ux.icon("refresh"));` });
    const status = page.locator("#status"), reload = page.getByRole("button", { name: "Reload" });
    const cancel = page.getByRole("button", { name: "Cancel" });
    const labelLeft = () => status.evaluate(node => {
        const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
        const range = document.createRange(); range.selectNodeContents(text); return range.getBoundingClientRect().left;
    });
    const left = await labelLeft(), next = await cancel.boundingBox(), initial = await reload.boundingBox();
    for (const pending of [true, false]) {
        await page.evaluate(value => {
            for (const id of ["status", "reload"]) window.ux.pending(document.getElementById(id), value);
        }, pending);
        await expect(reload).toHaveAttribute("aria-busy", String(pending));
        await expect(status).toHaveText("1,234 matching tool calls");
        assert.equal(await labelLeft(), left);
        assert.deepEqual(await reload.boundingBox(), initial);
        assert.deepEqual(await cancel.boundingBox(), next);
    }
});
