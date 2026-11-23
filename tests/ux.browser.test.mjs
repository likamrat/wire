import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { styles } from "../web/styles.mjs";
import { uxStyles } from "../web/ux-styles.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { renderHtmlReport } from "../lib/product-report.mjs";

const proofDir = process.env.WORKIQ_UX_PROOF_DIR;
const exactCommand = "  node example.mjs --name=\"SYNTHETIC \u03b1\u65e5\u672c\u8a9e \ud83d\udccb e\u0301\"\r\n\t--path='/me/messages?$filter=" + "synthetic".repeat(40) + "'  \n";
const previewMasked = "[PERSON] contact [EMAIL]\n  credential [SECRET]";
const printableRecords = [{
    projectionVersion: 3, promptMode: "masked", scenarioId: "synthetic-export-scenario", sourceSessionId: "synthetic-export-session",
    projectId: "synthetic-export-project", capturedAt: "2026-01-10T12:00:00Z",
    prompts: [{ label: "Request", status: "full", representation: "masked", text: previewMasked, changes: [{ category: "credentials", mandatory: true }] }],
    toolCalls: [{ tool: "workiq-fetch", toolCallId: "synthetic-export-call", requestedApiPath: "/me/events", requestArgs: {}, toolSucceeded: true, reportedOutcome: "succeeded" }],
}];

function primitives() {
    const host = document.querySelector("main");
    const ux = createEvidenceUX(uxIcons);
    window.fixtureUX = ux;
    const command = ux.codeBlock(window.syntheticCommand, { label: "Command", copyLabel: "Copy command" });
    command.id = "command-block";
    host.append(command);
    const pre = document.createElement("pre");
    pre.append("SYNTHETIC masked ", Object.assign(document.createElement("mark"), { textContent: "[EMAIL]" }), "\n  exact spacing \u65e5\u672c\u8a9e");
    host.append(pre);
    const masked = ux.attachCopy(pre, { label: "Masked prompt", copyLabel: "Copy masked prompt", getText: () => pre.textContent, prose: true });
    masked.id = "masked-block";
    host.append(ux.inlineCode("/me/messages?$select=id", { label: "Copy API path" }));
    const launch = document.createElement("button");
    launch.id = "preview";
    launch.textContent = "Preview report";
    launch.disabled = true;
    host.append(launch);
    ux.explainDisabled(launch, () => "Choose a request and mark it ready before previewing.");
    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    const close = document.createElement("button");
    close.textContent = "Close dialog";
    close.addEventListener("click", () => dialog.close());
    const content = ux.codeBlock("SYNTHETIC dialog code", { label: "Dialog code", copyLabel: "Copy dialog code" });
    dialog.append(close, content);
    document.body.append(dialog);
    const open = document.createElement("button");
    open.id = "open-dialog";
    open.textContent = "Open dialog";
    open.addEventListener("click", () => dialog.showModal());
    host.append(open);
}

async function fixture(run) {
    const requests = [], errors = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-ux-fixture'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-src 'self'");
            if (req.url === "/print-report") return res.end(renderHtmlReport(printableRecords));
            if (req.url === "/primitives") return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}${uxStyles}</style></head><body><main><h1>Synthetic interaction fixtures</h1></main><script nonce="ux-fixture">const createEvidenceUX=${createEvidenceUX.toString()};const uxIcons=${JSON.stringify(uxIcons)};window.syntheticCommand=${JSON.stringify(exactCommand)};(${primitives.toString()})();</script></body></html>`);
            return res.writeHead(404).end();
        }
        requests.push(req.url);
        res.writeHead(403).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    context.setDefaultTimeout(5000);
    await context.addInitScript(() => {
        window.clipboardWrites = [];
        window.clipboardReads = 0;
        window.clipboardReject = false;
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            writeText: async (text) => {
                if (window.clipboardReject) throw new DOMException("Synthetic blocked clipboard.", "NotAllowedError");
                window.clipboardWrites.push(text);
            },
            readText: async () => { window.clipboardReads++; throw new Error("Clipboard reads are forbidden."); },
            read: async () => { window.clipboardReads++; throw new Error("Clipboard reads are forbidden."); },
        } });
    });
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, url });
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, [], "No write or read is needed by the static report or clipboard controls");
    } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
}
async function shot(page, name) {
    if (proofDir) {
        if (await page.getByRole("tooltip").isVisible()) await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
        await page.evaluate(() => window.scrollTo(0, 0));
        const modal = page.locator("dialog[open]");
        if (await modal.count()) await modal.evaluate((node) => { node.scrollTop = 0; });
        await page.screenshot({ path: path.join(proofDir, name + ".png"), fullPage: await modal.count() === 0 });
    }
}

test("withdrawal synchronously retires connected copy getters and held clipboard feedback before removal observers", async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/primitives");
    const result = await page.evaluate(async () => {
        let reads = 0, release;
        navigator.clipboard.writeText = () => new Promise(resolve => { release = resolve; });
        const root = document.createElement("section");
        const control = fixtureUX.copyButton({ label: "Private copy", getText: () => { reads++; return "PRIVATE_COPY"; } });
        root.append(control); document.body.append(root);
        control.click();
        fixtureUX.withdrawAccess([root]);
        control.click();
        const before = { reads, status: root.querySelector(".ux-copy-status")?.textContent ?? "",
            busy: control.hasAttribute("aria-busy"), label: control.getAttribute("aria-label") };
        release(); await Promise.resolve(); await Promise.resolve();
        return { before, after: { reads, status: root.querySelector(".ux-copy-status")?.textContent ?? "",
            state: control.dataset.copyState ?? null, tooltip: control.dataset.uxTooltip ?? null }, connected: control.isConnected };
    });
    assert.equal(result.connected, true);
    assert.deepEqual(result.before, { reads: 1, status: "", busy: false, label: null });
    assert.deepEqual(result.after, { reads: 1, status: "", state: null, tooltip: null });
    await page.locator("#preview").hover();
    await page.waitForFunction(() => document.getElementById("evidence-tooltip").textContent.includes("Choose a request"));
    await page.clock.install();
    await page.evaluate(async () => {
        navigator.clipboard.writeText = async () => {};
        const root = document.createElement("section");
        window.retiredResetCopy = fixtureUX.copyButton({ label: "Private timer", getText: () => "PRIVATE_TIMER" });
        root.append(window.retiredResetCopy); document.body.append(root);
        window.retiredResetCopy.click();
        await Promise.resolve(); await Promise.resolve();
        fixtureUX.withdrawAccess([root]);
    });
    await page.clock.runFor(2500);
    assert.deepEqual(await page.evaluate(() => ({ state: retiredResetCopy.dataset.copyState ?? null,
        label: retiredResetCopy.getAttribute("aria-label") })), { state: null, label: null });
}));

test("a withdrawing copy producer cannot dispatch its result or erase a successor control", async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/primitives");
    const result = await page.evaluate(async () => {
        const root = document.createElement("section");
        document.body.append(root);
        let next;
        const control = fixtureUX.copyButton({ label: "PRIVATE_COPY_LABEL", getText: () => {
            fixtureUX.withdrawAccess([root]);
            next = fixtureUX.copyButton({ label: "Fresh copy", getText: () => "FRESH_COPY" });
            root.append(next);
            return "PRIVATE_RETIRED_VALUE";
        } });
        root.append(control);
        const label = control.getAttributeNode("aria-label");
        control.click();
        await Promise.resolve(); await Promise.resolve();
        const before = { writes: [...clipboardWrites], retired: control.disabled, label: label.value,
            nextLabel: next.getAttribute("aria-label"), nextDisabled: next.disabled };
        next.click();
        await Promise.resolve(); await Promise.resolve();
        return { before, after: [...clipboardWrites] };
    });
    assert.deepEqual(result.before, { writes: [], retired: true, label: "", nextLabel: "Fresh copy", nextDisabled: false });
    assert.deepEqual(result.after, ["FRESH_COPY"]);
}));

for (const activation of ["initial focus", "help activation", "active refresh"]) test(`a withdrawing tooltip producer cannot replace a newer registration (${activation})`, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/primitives");
    const results = await page.evaluate(activation => [false, true].map(successor => {
        const refreshing = activation === "active refresh", help = activation === "help activation";
        const root = document.createElement("section"), next = document.createElement("button");
        const control = help ? fixtureUX.helpButton("Fixture control", "") : document.createElement("button");
        if (!help) control.textContent = "Fixture control";
        next.textContent = "Next control";
        root.append(control, next); document.body.append(root);
        const bubble = document.getElementById("evidence-tooltip");
        let held, withdrew = false;
        if (refreshing) {
            fixtureUX.tooltip(control, "PRIVATE_PREVIOUS_HELP"); control.focus();
            held = bubble.firstChild;
        }
        fixtureUX.tooltip(control, () => {
            fixtureUX.withdrawAccess([root]); withdrew = true;
            if (successor) { fixtureUX.tooltip(next, "FRESH_HELP"); next.focus(); }
            return "PRIVATE_RETIRED_HELP";
        });
        if (help) control.click();
        else if (!refreshing) control.focus();
        const result = { withdrew, text: bubble.textContent, hidden: bubble.hidden, oldText: held?.data ?? "",
            oldRegistered: control.hasAttribute("data-ux-tooltip"), nextRegistered: next.hasAttribute("data-ux-tooltip") };
        fixtureUX.withdrawAccess([root]); root.remove();
        return result;
    }), activation);
    assert.deepEqual(results, [
        { withdrew: true, text: "", hidden: true, oldText: "", oldRegistered: false, nextRegistered: false },
        { withdrew: true, text: "FRESH_HELP", hidden: false, oldText: "", oldRegistered: false, nextRegistered: true },
    ]);
}));

test("tooltip withdrawal erases held Text and description Attr handles while preserving static controls", async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/primitives");
    const result = await page.evaluate(() => {
        const root = document.createElement("section"), control = document.createElement("button");
        control.textContent = "Static control"; root.append(control); document.body.append(root);
        fixtureUX.tooltip(control, "PRIVATE_VISIBLE_HELP"); control.focus();
        const bubble = document.getElementById("evidence-tooltip"), text = bubble.firstChild;
        const description = control.getAttributeNode("aria-describedby"), before = text.data;
        fixtureUX.withdrawAccess([root]);
        return { before, text: text.data, description: description.value, bubble: bubble.textContent,
            hidden: bubble.hidden, control: control.textContent };
    });
    assert.deepEqual(result, { before: "PRIVATE_VISIBLE_HELP", text: "", description: "", bubble: "",
        hidden: true, control: "Static control" });
}));

test("clipboard icons copy exact Unicode, whitespace and marked display text, never reading clipboard", { timeout: 30000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/primitives");
    const command = page.getByRole("button", { name: "Copy command", exact: true });
    const beforeCopy = await page.locator("#command-block pre").boundingBox();
    assert.equal(await command.innerText(), "");
    assert.equal(await command.locator("svg[aria-hidden=true]").count(), 1);
    await command.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.clipboardWrites.length === 1);
    assert.equal(await page.evaluate(() => window.clipboardWrites[0]), exactCommand);
    assert.equal(await command.getAttribute("data-copy-state"), "success");
    assert.equal((await page.locator("#command-block pre").boundingBox()).y, beforeCopy.y, "Success feedback does not shift the code");
    assert.equal(await page.locator("#command-block .ux-copy-status").textContent(), "Copied to clipboard.");
    const masked = page.getByRole("button", { name: "Copy masked prompt", exact: true });
    await masked.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => window.clipboardWrites.length === 2);
    assert.equal(await page.evaluate(() => window.clipboardWrites[1]), "SYNTHETIC masked [EMAIL]\n  exact spacing \u65e5\u672c\u8a9e");
    await page.getByRole("button", { name: "Copy API path", exact: true }).click();
    await page.waitForFunction(() => window.clipboardWrites.length === 3);
    assert.equal(await page.evaluate(() => window.clipboardWrites[2]), "/me/messages?$select=id");
    assert.equal(await page.evaluate(() => window.clipboardReads), 0);
    assert.equal(await page.locator("#command-block pre").textContent(), exactCommand);
}));

test("clipboard rejection and unavailable API show truthful accessible errors without a success fallback", { timeout: 30000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/primitives");
    await page.evaluate(() => { window.clipboardReject = true; });
    await page.getByRole("button", { name: "Copy command", exact: true }).click();
    await page.locator("#command-block [role=alert]").waitFor({ state: "visible" });
    assert.match(await page.locator("#command-block [role=alert]").textContent(), /Couldn't copy.*Select the text/);
    assert.deepEqual(await page.evaluate(() => window.clipboardWrites), []);
    assert.equal(await page.getByRole("button", { name: "Copy command", exact: true }).getAttribute("data-copy-state"), "error");
    await page.evaluate(() => { window.clipboardReject = false; });
    await page.getByRole("button", { name: "Copy command", exact: true }).click();
    await page.waitForFunction(() => window.clipboardWrites.length === 1);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
    await page.getByRole("button", { name: "Copy masked prompt", exact: true }).click();
    await page.locator("#masked-block [role=alert]").waitFor({ state: "visible" });
    assert.match(await page.locator("#masked-block [role=alert]").textContent(), /Clipboard access is unavailable/);
}));

test("copy reads only on deliberate activation, preserves focus, and blocks duplicate pending writes", { timeout: 30000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/primitives");
    await page.evaluate(() => {
        window.textReads = 0;
        const copy = window.fixtureUX.copyButton({
            label: "Copy deliberate selection",
            getText: () => { window.textReads++; return "SYNTHETIC deliberate selection"; },
        });
        document.querySelector("main").append(copy);
        navigator.clipboard.writeText = (text) => new Promise((resolve) => {
            window.clipboardWrites.push(text);
            window.finishWrite = resolve;
        });
    });
    const copy = page.getByRole("button", { name: "Copy deliberate selection", exact: true });
    await copy.hover();
    await copy.focus();
    assert.equal(await page.evaluate(() => window.textReads), 0, "Hover and focus never access copy payloads");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => window.textReads), 1);
    assert.equal(await copy.getAttribute("aria-disabled"), "true");
    await page.evaluate(() => window.finishWrite());
    await page.waitForFunction(() => document.querySelector('[aria-label="Copy deliberate selection"]').dataset.copyState === "success");
    assert.equal(await copy.evaluate((node) => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => window.clipboardWrites), ["SYNTHETIC deliberate selection"]);
}));

test("tooltips support hover, focus, Escape, dynamic disabled guidance and the dialog top layer", { timeout: 30000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(url + "/primitives");
    const copy = page.getByRole("button", { name: "Copy command", exact: true });
    await copy.hover();
    const tooltip = page.getByRole("tooltip");
    await tooltip.waitFor({ state: "visible" });
    assert.equal(await tooltip.textContent(), "Copy command");
    assert.equal(await copy.getAttribute("aria-describedby"), "evidence-tooltip");
    await tooltip.hover();
    await page.waitForTimeout(200);
    assert.equal(await tooltip.isVisible(), true, "Tooltip content remains hoverable");
    await page.keyboard.press("Escape");
    assert.equal(await tooltip.isVisible(), false);
    assert.equal(await copy.getAttribute("aria-describedby"), null);
    await page.mouse.move(0, 0);
    await copy.evaluate((node) => node.setAttribute("aria-describedby", "existing-help"));
    await copy.focus();
    await tooltip.waitFor({ state: "visible" });
    assert.equal(await copy.getAttribute("aria-describedby"), "existing-help evidence-tooltip");
    await page.keyboard.press("Escape");
    assert.equal(await tooltip.isVisible(), false);
    assert.equal(await copy.getAttribute("aria-describedby"), "existing-help");
    assert.equal(await copy.evaluate((node) => node === document.activeElement), true);
    const wrapper = page.locator(".ux-disabled-help");
    await wrapper.focus();
    await tooltip.waitFor({ state: "visible" });
    assert.match(await tooltip.textContent(), /Choose a request/);
    await page.evaluate(() => { document.querySelector("#preview").disabled = false; });
    await page.waitForFunction(() => document.querySelector(".ux-disabled-help").tabIndex === -1);
    assert.equal(await wrapper.getAttribute("data-ux-tooltip"), null);
    await page.locator("#open-dialog").click();
    const dialogCopy = page.getByRole("button", { name: "Copy dialog code", exact: true });
    await dialogCopy.focus();
    await tooltip.waitFor({ state: "visible" });
    assert.equal(await tooltip.evaluate((node) => node.matches(":popover-open") && Boolean(node.closest("dialog[open]"))), true);
    const tipBox = await tooltip.boundingBox(), buttonBox = await dialogCopy.boundingBox();
    assert.ok(tipBox.x >= 0 && tipBox.x + tipBox.width <= 375, JSON.stringify({ tipBox, buttonBox, viewport: await page.evaluate(() => innerWidth) }));
    assert.ok(tipBox.y + tipBox.height <= buttonBox.y || tipBox.y >= buttonBox.y + buttonBox.height, "Tooltip does not cover its control");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#test-dialog").evaluate((node) => node.open), true, "First Escape dismisses tooltip, not dialog");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#test-dialog").evaluate((node) => node.open), false, "Next Escape retains native dialog behavior");
}));

test("formatted report prose stays readable and wide exact-data tables scroll without shrinking text", { timeout: 30000 }, async () => fixture(async ({ context, url }) => {
    for (const width of [375, 820, 1200]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url + "/print-report");
        assert.equal(await page.getByRole("heading", { level: 1, name: "Activity report", exact: true }).count(), 1);
        assert.equal(await page.locator(".prompt pre").textContent(), previewMasked);
        assert.ok(await page.locator(".prompt pre").evaluate((node) => parseFloat(getComputedStyle(node).fontSize) >= 16));
        assert.ok(await page.locator("table").first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize) >= 13));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const tableRegion = page.locator(".table-wrap").first();
        assert.equal(await tableRegion.getAttribute("tabindex"), "0");
        assert.equal(await tableRegion.getAttribute("role"), "region");
        await tableRegion.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        assert.ok(await tableRegion.evaluate(node =>
            node.querySelector("tr > :last-child").getBoundingClientRect().right <= node.getBoundingClientRect().right + 1),
        "The final column can be brought fully into view without scrolling the page");
        await shot(page, `print-${width}-report`);
        await page.close();
    }
}));
