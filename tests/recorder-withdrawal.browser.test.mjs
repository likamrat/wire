import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { createRecorderDiagnostics } from "../lib/recorder-diagnostics.mjs";
import { mountRecorderDiagnostics } from "../web/recorder-diagnostics.mjs";
import { renderHtmlShell } from "../lib/render.mjs";

async function setup(t, grant = "current") {
    const f = await recollectionFixture(t), browser = await chromium.launch();
    let respond, sent = 0, gate;
    const releases = [], calls = [];
    const service = createRecorderDiagnostics(f.context, { testTransport: () => {
        sent++; return new Promise(resolve => { respond = () => resolve(new Response("SYNTHETIC_ONLY", { status: 200 })); });
    } });
    f.closeClient(async () => { releases.forEach(release => release()); respond?.(); await browser.close(); await service.close(); });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const shell = renderHtmlShell("a".repeat(64), "recorder-withdrawal", {
        schemaVersion: 1, mode: "unbound", runtimeId: "00000000-0000-4000-8000-000000000012",
    }), start = shell.indexOf('<details id="recorderDiagnostics"');
    assert.ok(start >= 0);
    const markup = shell.slice(start, shell.indexOf("</details>", start) + 10);
    await page.route("**/*", route => {
        assert.equal(route.request().url(), "https://wire.invalid/");
        return route.fulfill({ contentType: "text/html", body: `<html><body><button id="safe">Safe</button>${markup}<dialog id="overlay"><h2 id="dialogTitle"></h2><div id="detail"></div></dialog></body></html>` });
    });
    await page.exposeFunction("recorderFixture", async (path, input) => {
        calls.push({ path, input });
        const result = path === "/api/record" ? await service.start(input) : await service.status(input.attemptId);
        if (gate?.path === path) {
            const held = gate; gate = null; held.enter(); await held.promise;
            if (held.failure) return { fixtureError: "PRIVATE_REVOKED_STATUS_ERROR" };
        }
        return result;
    });
    await page.goto("https://wire.invalid/");
    await page.addScriptTag({ content: `window.mountRecorder=${mountRecorderDiagnostics};` });
    await page.evaluate(grant => {
        window.epoch = 1; window.live = true; window.completedCalls = 0; window.grant = grant; window.apiCallAttempts = 0;
        const api = async (path, input) => {
            window.apiCallAttempts++;
            if (!window.live) throw new Error("Synthetic revoked access");
            try {
                const result = await window.recorderFixture(path, input);
                if (result.fixtureError) throw new Error(result.fixtureError);
                return result;
            }
            finally { window.completedCalls++; }
        };
        api.publicationToken = () => !window.live || window.grant === "null" ? null
            : window.grant === "stale" ? window.epoch - 1 : window.epoch;
        api.isCurrent = token => window.grant === "truthy" ? {} : token !== null && window.live && token === window.epoch;
        const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; };
        window.owner = window.mountRecorder({ api, el,
            button: (text, action) => { const node = el("button", "", text); node.addEventListener("click", action); return node; },
            openDialog: title => {
                document.getElementById("dialogTitle").textContent = title;
                const body = document.getElementById("detail"); body.replaceChildren();
                document.getElementById("overlay").showModal(); return body;
            } });
        window.withdraw = () => {
            window.live = false; window.epoch++;
            document.getElementById("overlay").close();
            window.owner.withdrawAccess(); window.owner.withdrawAccess();
            document.getElementById("safe").focus();
        };
        window.renew = () => { window.live = true; window.epoch++; window.owner.resumeAccess(); };
    }, grant);
    function hold(path, failure = false) {
        let release, enter;
        const promise = new Promise(resolve => { release = resolve; });
        const arrived = new Promise(resolve => { enter = resolve; });
        gate = { path, promise, enter, failure }; releases.push(release);
        return { release, arrived };
    }
    async function show() {
        await page.locator("#recorderDiagnostics>summary").click();
        await expect(page.locator("#recordBtn")).toBeEnabled();
    }
    async function begin() {
        await show(); await page.locator("#recordBtn").click();
        await page.getByRole("button", { name: "Send public request", exact: true }).click();
    }
    async function cleared() {
        for (const id of ["recorderStatus", "recorderEvidence", "recorderStorageWarning"]) assert.equal(await page.locator("#" + id).textContent(), "");
        assert.equal(await page.locator("#recorderResultLink").isVisible(), false);
        assert.equal(await page.locator("#detail").textContent(), "");
        assert.equal(await page.evaluate(() => document.activeElement.id), "safe");
    }
    return { page, calls, hold, show, begin, cleared, sent: () => sent, finish: async () => { respond?.(); await service.close(); } };
}

test("recorder withdrawal clears a held start result, retains original attempt and never replays on readiness", { timeout: 30000 }, async t => {
    const f = await setup(t), { page, calls } = f;
    const held = f.hold("/api/record");
    try {
        await f.begin(); await held.arrived;
        const marker = await page.evaluate(() => sessionStorage.getItem("workiq-evidence.recorder-attempt"));
        const completed = await page.evaluate(() => window.completedCalls);
        await page.evaluate(() => window.withdraw()); await f.cleared();
        await page.evaluate(() => { window.renew(); dispatchEvent(new Event("pageshow")); });
        const count = calls.length;
        held.release(); await page.waitForFunction(n => window.completedCalls > n, completed);
        await f.finish(); await f.cleared();
        assert.equal(calls.length, count); assert.equal(f.sent(), 1);
        assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.recorder-attempt")), marker);
        await f.show();
        await expect(page.locator("#recorderEvidence")).toContainText(marker);
        assert.deepEqual(calls.at(-1), { path: "/api/record/status", input: { attemptId: marker } });
        assert.equal(f.sent(), 1);
    } finally { held.release(); }
});

for (const failure of [false, true]) test(`recorder timer/status ${failure ? "error" : "success"} cannot repaint or poll across withdrawal and pageshow`, { timeout: 30000 }, async t => {
    const f = await setup(t), { page, calls } = f;
    await page.clock.install();
    await f.begin();
    await expect(page.locator("#recorderStatus")).toContainText("Public request in progress");
    const marker = await page.evaluate(() => sessionStorage.getItem("workiq-evidence.recorder-attempt"));
    const held = f.hold("/api/record/status", failure);
    try {
        await page.clock.fastForward(800); await held.arrived;
        const count = calls.length, completed = await page.evaluate(() => window.completedCalls);
        await page.evaluate(() => { window.withdraw(); dispatchEvent(new Event("pageshow")); });
        await page.clock.fastForward(5000); await f.cleared();
        await page.evaluate(() => { window.renew(); dispatchEvent(new Event("pageshow")); });
        await page.clock.fastForward(5000);
        held.release(); await page.waitForFunction(n => window.completedCalls > n, completed);
        await page.clock.fastForward(5000); await f.cleared();
        assert.equal(calls.length, count, "Old timers and pageshow cannot create replacement reads");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.recorder-attempt")), marker);
        await f.finish();
        await f.show();
        await expect(page.locator("#recorderEvidence")).toContainText(marker);
        assert.deepEqual(calls.at(-1), { path: "/api/record/status", input: { attemptId: marker } });
        assert.equal(f.sent(), 1);
    } finally { held.release(); }
});

test("a detached recorder confirmation cannot start a public request after access renews", { timeout: 30000 }, async t => {
    const f = await setup(t), { page, calls } = f;
    await f.show(); await page.locator("#recordBtn").click();
    await page.getByRole("button", { name: "Send public request", exact: true }).evaluate(node => { window.retiredSend = node; });
    const count = calls.length;
    await page.evaluate(() => { window.withdraw(); window.renew(); window.retiredSend.click(); dispatchEvent(new Event("pageshow")); });
    await f.cleared();
    assert.equal(calls.length, count);
    assert.equal(f.sent(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.recorder-attempt")), null);
});

for (const grant of ["null", "stale", "truthy"]) test(`recorder ${grant} proof cannot dispatch, paint or resume a private status read`, { timeout: 30000 }, async t => {
    const f = await setup(t, grant), { page, calls } = f;
    await page.clock.install();
    const before = await page.locator("#recorderStatus").textContent();
    await page.locator("#recorderDiagnostics>summary").click();
    await page.evaluate(() => dispatchEvent(new Event("pageshow")));
    await page.clock.fastForward(5000);
    assert.equal(await page.locator("#recorderStatus").textContent(), before);
    assert.equal(await page.evaluate(() => window.apiCallAttempts), 0);
    await page.evaluate(() => { window.withdraw(); window.renew(); dispatchEvent(new Event("pageshow")); });
    await page.clock.fastForward(5000); await f.cleared();
    assert.equal(await page.evaluate(() => window.apiCallAttempts), 0);
    assert.deepEqual(calls, []);
    assert.equal(f.sent(), 0);
    await page.evaluate(() => { window.grant = "current"; window.renew(); });
    assert.equal(calls.length, 0);
    await f.show();
    assert.deepEqual(calls, [{ path: "/api/record/status", input: {} }]);
    assert.equal(f.sent(), 0);
});
