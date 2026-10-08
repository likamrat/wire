import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { styles } from "../web/styles.mjs";
import { assessmentPresentationStyles } from "../web/assessment-presentation.mjs";
import { mountAutomaticScoresRow, mountAutomaticScoresApproval, automaticScoreStyles } from "../web/automatic-score-views.mjs";

async function fixture(t, snapshot = null) {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, hasTouch: true, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.setContent(`<html lang="en" data-evidence-theme="light"><head><style>${styles}${assessmentPresentationStyles}${automaticScoreStyles}</style></head><body>
        <main><h1>Collection preferences</h1><section class="settings-reply-row"><h3>Recorded replies</h3>
        <label><input id="localSaving" type="checkbox" checked>Save Copilot replies locally</label></section><div id="automatic"></div></main>
        <dialog id="approval"></dialog></body></html>`);
    await page.addScriptTag({ content: `
        window.packets=[]; window.reads=[];
        const setup = {
            sourceRevision: 7, approvalRevision: 0, minimumSessionAiCredits: 30, snapshot: ${JSON.stringify(snapshot)},
            source: { sourceConfigRef:"sourceconfig-${"a".repeat(32)}", sourceConfigRevision:1, windowDays:30 },
            method: {provider:"github-copilot",model:"gpt-6-astra",rubricId:"wire-recorded-interaction-review",rubricVersion:1},
            chats:[{chatRef:"chat-${"b".repeat(32)}",name:"Synthetic calendar chat",outsideWindow:1},
                {chatRef:"chat-${"c".repeat(32)}",name:"Synthetic research chat",outsideWindow:0}],
        };
        const ux={restoreFocus:node=>node.focus()};
        window.row=(${mountAutomaticScoresRow.toString()})(document.getElementById("automatic"),{onReview:trigger=>{
            window.view=(${mountAutomaticScoresApproval.toString()})(document.getElementById("approval"),{
                setup,ux,onSubmit:packet=>window.packets.push(packet),
                onCheck:packet=>{window.reads.push(packet);window.view.pending();},onClose:()=>{},
            });
            window.view.open(trigger);
        }});
    ` });
    const dialog = page.getByRole("dialog", { name: "Automatic scores", exact: true });
    return { page, dialog };
}
async function chooseAllowance(dialog) {
    await dialog.getByRole("checkbox", { name: /Synthetic calendar chat/ }).check();
    await dialog.getByLabel("Total assessment allowance", { exact: true }).fill("2");
    await dialog.getByLabel("Total budget (AI credits)", { exact: true }).fill("30");
    await dialog.getByRole("checkbox", { name: /Allow this evidence/ }).check();
}

test("unreferenced automatic approval view needs explicit scope, positive allowance and separate submission consent", async t => {
    const { page, dialog } = await fixture(t);
    assert.equal(await page.locator("#automatic p").innerText(), "Off");
    assert.deepEqual(await page.evaluate(() => window.packets), []);
    await page.getByRole("button", { name: "Set up automatic scores" }).click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /GitHub Copilot - gpt-6-astra/);
    assert.match(await dialog.innerText(), /30-day collection window/);
    assert.match(await dialog.innerText(), /1 recorded request outside the window will not be scored/);
    assert.equal(await dialog.getByRole("button", { name: "Approve automatic scores" }).isEnabled(), false);
    assert.equal(await dialog.getByLabel("Total assessment allowance", { exact: true }).inputValue(), "");
    assert.equal(await dialog.getByLabel("Total budget (AI credits)", { exact: true }).inputValue(), "");
    assert.equal(await dialog.getByRole("checkbox", { name: /Allow this evidence/ }).isChecked(), false);
    await chooseAllowance(dialog);
    await dialog.getByLabel("Total budget (AI credits)", { exact: true }).fill("0");
    assert.equal(await dialog.getByRole("button", { name: "Approve automatic scores" }).isEnabled(), false);
    await dialog.getByLabel("Total budget (AI credits)", { exact: true }).fill("29.99");
    assert.equal(await dialog.getByRole("button", { name: "Approve automatic scores" }).isEnabled(), false);
    assert.match(await dialog.innerText(), /at least 30 AI credits remaining/);
    assert.match(await dialog.innerText(), /allowance may cover only one assessment/);
    await dialog.getByLabel("Total budget (AI credits)", { exact: true }).fill("30");
    await dialog.getByRole("button", { name: "Approve automatic scores" }).click();
    const packets = await page.evaluate(() => window.packets);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].chatRefs.length, 1);
    assert.equal(packets[0].expectedSourceRevision, 7);
    assert.equal(packets[0].source.windowDays, 30);
    assert.equal(packets[0].maxCalls, 2);
    assert.equal(packets[0].maxAiCredits, 30);
    assert.deepEqual(packets[0].evidenceCategories, ["prompt", "answer", "references", "intent"]);
    assert.match(packets[0].mutationRef, /^mutation-[a-f0-9]{32}$/);
    assert.match(packets[0].receiptToken, /^[a-f0-9]{64}$/);
    assert.equal(await page.locator("#localSaving").isChecked(), true);
    assert.equal(await dialog.getByRole("button", { name: "Saving approval..." }).isEnabled(), false);
    await page.evaluate(() => window.view.complete());
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Set up automatic scores" }).evaluate(node => node === document.activeElement), true);
});

test("reviewing a used allowance requires30 remaining without choosing a top-up or budget value", async t => {
    const { page, dialog } = await fixture(t, {
        approval: { state: "enabled", chatRefs: ["chat-" + "b".repeat(32)] },
        usage: { callsReserved: 1, spentAiCredits: 0.1, costUnknown: false },
    });
    await page.getByRole("button", { name: "Set up automatic scores" }).click();
    const credits = dialog.getByLabel("Total budget (AI credits)", { exact: true });
    assert.equal(await credits.getAttribute("min"), "30.1");
    assert.equal(await credits.inputValue(), "");
    await dialog.getByLabel("Total assessment allowance", { exact: true }).fill("2");
    await dialog.getByRole("checkbox", { name: /Allow this evidence/ }).check();
    await credits.fill("30");
    assert.equal(await dialog.getByRole("button", { name: "Approve automatic scores" }).isEnabled(), false);
    await credits.fill("30.1");
    assert.equal(await dialog.getByRole("button", { name: "Approve automatic scores" }).isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => window.packets), [], "No top-up is automatically submitted.");
});

test("uncertain approval checks the original receipt without replay; changed scope blocks unsent consent", async t => {
    const { page, dialog } = await fixture(t);
    await page.getByRole("button", { name: "Set up automatic scores" }).click();
    await chooseAllowance(dialog);
    await dialog.getByRole("button", { name: "Approve automatic scores" }).click();
    await page.evaluate(() => window.view.uncertain("The connection changed."));
    assert.match(await dialog.getByRole("alert").innerText(), /no approval will be repeated/);
    assert.equal(await dialog.getByRole("button", { name: "Approve automatic scores" }).isEnabled(), false);
    await dialog.getByRole("button", { name: "Check approval result" }).click();
    const result = await page.evaluate(() => ({ packets: window.packets, reads: window.reads }));
    assert.equal(result.packets.length, 1);
    assert.equal(result.reads[0].mutationRef, result.packets[0].mutationRef);
    assert.equal(result.reads[0].receiptToken, result.packets[0].receiptToken);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Set up automatic scores" }).click();
    await chooseAllowance(dialog);
    await page.evaluate(() => window.view.invalidate("The approved source changed."));
    assert.equal(await dialog.getByRole("button", { name: "Approve automatic scores" }).isEnabled(), false);
    assert.equal(await dialog.getByRole("checkbox", { name: /Allow this evidence/ }).isChecked(), false);
    assert.match(await dialog.getByRole("alert").innerText(), /review the current scope/);
    assert.equal((await page.evaluate(() => window.packets)).length, 1);
});

test("automatic score row and consent remain keyboard/touch readable at desktop, narrow and enlarged-text sizes", async t => {
    const { page, dialog } = await fixture(t);
    for (const [theme, width, zoom] of [["light", 1200, 100], ["dark", 375, 100], ["dark", 320, 200]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(({ theme, zoom }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = zoom + "%";
        }, { theme, zoom });
        const trigger = page.getByRole("button", { name: "Set up automatic scores" });
        await trigger.focus();
        await page.keyboard.press("Enter");
        await dialog.waitFor();
        assert.equal(await dialog.getByRole("button", { name: "Close", exact: true }).evaluate(node => node === document.activeElement), true);
        assert.equal(await dialog.locator("h2").evaluate(node => {
            const word = document.createRange();
            word.setStart(node.firstChild, 0); word.setEnd(node.firstChild, "Automatic".length);
            return word.getClientRects().length === 1;
        }), true, "The header must not break the word Automatic across lines at enlarged text sizes.");
        await dialog.getByRole("checkbox", { name: /Synthetic calendar chat/ }).tap();
        await dialog.getByRole("checkbox", { name: /Allow this evidence/ }).tap();
        await dialog.getByRole("button", { name: "Cancel" }).scrollIntoViewIfNeeded();
        assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        assert.equal(await dialog.locator(".assessment-dialog-body").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        assert.equal(await dialog.getByRole("button", { name: "Cancel" }).evaluate(node => node.getBoundingClientRect().height >= 44), true);
        if (process.env.WIRE_AUTO_SCORE_PROOF_DIR) {
            await mkdir(process.env.WIRE_AUTO_SCORE_PROOF_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_AUTO_SCORE_PROOF_DIR, `${theme}-${width}-${zoom}.png`) });
        }
        await page.keyboard.press("Escape");
        assert.equal(await dialog.isVisible(), false);
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    }
    assert.deepEqual(await page.evaluate(() => window.packets), []);
});
