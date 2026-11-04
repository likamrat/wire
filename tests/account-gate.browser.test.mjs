import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createMicrosoftSession, MicrosoftSessionError } from "../lib/microsoft-session.mjs";
import { createFixtureRuntimeAccess, createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { mountThemeControl } from "../web/theme-control.mjs";
import { accountSettingsStyles } from "../web/account-settings-styles.mjs";
import { mountAccountSettingsPresentation } from "../web/account-settings-presentation.mjs";
import { createNativeConnectionState } from "../web/native-connection-state.mjs";
import { privateFixture } from "./helpers.mjs";
import { presentationFixture, verifiedGitHubProfile } from "./account-settings-presentation-fixture.mjs";

let { createBoardTransport } = await import("../lib/client-transport.mjs");
if (process.env.WIRE_GATE_TRANSPORT) {
    const bytes = await readFile(process.env.WIRE_GATE_TRANSPORT);
    assert.match(process.env.WIRE_GATE_TRANSPORT_SHA256 || "", /^[a-f0-9]{64}$/);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), process.env.WIRE_GATE_TRANSPORT_SHA256);
    ({ createBoardTransport } = await import(pathToFileURL(process.env.WIRE_GATE_TRANSPORT).href));
}

function pageHtml(handshake, sourceAware = false) {
    if (sourceAware) handshake = { ...handshake, accessBootstrap: { ...handshake.accessBootstrap, collectionMode: "source-aware" } };
    const nonce = "actual-gate-control";
    let html = renderHtmlShell(handshake.capability, nonce, handshake.accessBootstrap);
    html = html.slice(0, html.lastIndexOf(`<script nonce="${nonce}">`)) + "</body></html>";
    html = html.replace(/<link rel="icon"[^>]*>/, "").replace("</head>", `<style>${accountSettingsStyles}</style></head>`);
    const script = `
${sourceAware ? `const originalFetch=fetch.bind(window);
window.fetch=async(...args)=>{
 const response=await originalFetch(...args),json=response.json.bind(response);
 response.json=async()=>{
  const value=await json();
  return response.ok&&["/api/access/status","/api/access/watch"].includes(new URL(response.url).pathname)
   ? {...value,collectionMode:"source-aware"}:value;
 };
 return response;
};` : ""}
const ux=(${createEvidenceUX.toString()})(${JSON.stringify(uxIcons).replaceAll("<", "\\u003c")});
document.getElementById("loading").hidden=true;
for(const link of document.querySelectorAll(".primary-navigation [data-nav]"))link.prepend(ux.icon("navigation-"+link.dataset.nav));
document.getElementById("navigationToggle").replaceChildren(ux.icon("menu"));
mountNavigation(ux);
(${mountThemeControl.toString()})(evidenceTheme,ux);
window.gateApi=(${createBoardTransport.toString()})(${JSON.stringify(handshake.capability)},()=>{},${JSON.stringify(handshake.accessBootstrap)});
window.gateFactory=${mountAccountSettingsPresentation.toString()};
window.gateConnectionChanges=0;
window.gateView=gateFactory({
 api:gateApi,ux,accountSlot:document.getElementById("wireAccountEntry"),connectionSlot:document.getElementById("microsoftConnectionHost"),
 createNativeConnectionState:${createNativeConnectionState.toString()},onConnectionChange:()=>{gateConnectionChanges++}
});
gateApi.subscribeAccess(value=>{
 if(!value.readable)gateView.withdrawAccess();
 gateView.receiveAccess(value);
});
gateApi.startAccess();
window.addEventListener("pagehide",()=>gateApi.suspendAccess());
document.body.dataset.gateReady="true";`;
    return html.replace("</body>", `<script nonce="${nonce}">${script}</script></body>`);
}

async function setup(t, { enforced = true, sessionTtlMs, nativeConnection = false, sourceAware = false, verifyNative, stopNative } = {}) {
    const cleanup = [], { context, root } = await privateFixture({ after: work => cleanup.push(work) });
    await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
    const configFile = path.join(context.dataDir, "collector", "config.json");
    await writeFile(configFile, JSON.stringify({ schemaVersion: 1, approved: true, approvedAt: "2026-10-01T00:00:00Z",
        appDbPath: path.join(root, "never-read.db"), sessionRoot: path.join(root, "never-read-history"),
        enabled: false, windowDays: 30, pollSeconds: 60 }));
    const before = await loadBoardState(context), config = await readFile(configFile);
    const nativeCalls = [];
    const transport = nativeConnection ? createMicrosoftNativeReadTransport({
        async open() { nativeCalls.push("open"); },
        async verifyAccount(operation) {
            nativeCalls.push("verify");
            if (verifyNative) await verifyNative(operation);
            return { tenantId: "example-tenant", subjectId: "example-subject", knownAccountMatched: true,
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
        },
        async stop(operation) {
            nativeCalls.push("stop");
            return stopNative ? stopNative(operation) : { processExited: true, profileReleased: true };
        },
    }) : undefined;
    const lifecycle = enforced ? await createMicrosoftSession(context, { collection: { paused: true, windowDays: 30 }, transport }) : null;
    const access = enforced ? nativeConnection
        ? await createNativeRuntimeAccess(context, { lifecycle, nativeSource: async () => [], nativeConnection: true })
        : await createFixtureRuntimeAccess(context, { lifecycle }) : undefined;
    const deniedServices = [];
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false }, access, sessionTtlMs,
        githubProfile: { fetch: async () => { deniedServices.push("profile-provider"); throw new Error("No profile provider in gate proof."); } },
        evaluation: { evaluatorFactory: async () => { deniedServices.push("model"); throw new Error("No model in gate proof."); } },
    });
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const pages = [], errors = [], denied = [], calls = [], requests = [];
    const origin = new URL(runtime.url).origin;
    async function panel() {
        const response = await fetch(origin + "/api/session", { method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" });
        const handshake = await response.json();
        assert.equal(response.status, 200);
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        pages.push(page);
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
            requests.push(new URL(request.url()).pathname);
            if (new URL(request.url()).pathname.startsWith("/api/access/")) calls.push({
                page: pages.indexOf(page), path: new URL(request.url()).pathname,
                body: request.method() === "POST" ? request.postDataJSON() : null,
            });
        });
        await page.route("**/*", route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) { denied.push(url.origin); return route.abort(); }
            if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: pageHtml(handshake, sourceAware) });
            return route.continue();
        });
        await page.goto(origin);
        assert.deepEqual(errors, []);
        await expect(page.locator("body")).toHaveAttribute("data-gate-ready", "true");
        return page;
    }
    t.after(async () => {
        try {
            for (const page of pages) if (await page.evaluate(() => document.body.dataset.gateReady === "true")) {
                await page.evaluate(() => { gateApi.suspendAccess(); gateView.dispose(); });
            }
        } finally {
            await browser.close();
            if (runtime.server.listening) await runtime.close();
            access?.close(); await lifecycle?.close();
        }
        const after = await loadBoardState(context);
        assert.deepEqual(after.evidence, before.evidence); assert.deepEqual(after.cards, before.cards); assert.deepEqual(after.exports, before.exports);
        assert.deepEqual(await readFile(configFile), config);
        for (const work of cleanup.reverse()) await work();
        assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.deepEqual(deniedServices, []);
        assert.equal(requests.some(route => route.startsWith("/api/profile/")), false);
    });
    return { panel, lifecycle, runtime, calls, requests, nativeCalls };
}

async function showConnectionFixture(page) {
    await page.evaluate(() => {
        for (let node = document.getElementById("wireMicrosoftConnection"); node; node = node.parentElement) node.hidden = false;
    });
}

async function gate(page, label) {
    if (!await page.locator("#wireAccountTrigger").isVisible()) await page.locator("#navigationToggle").click();
    if (!await page.locator("#wireAccountMenu").isVisible()) await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toHaveText(label);
    await expect(page.locator("#wireAccountGate")).toBeEnabled();
    return page.locator("#wireAccountGate");
}

test("the actual account button signs the real fixture gate in and out without Microsoft or profile calls", { timeout: 45000 }, async t => {
    const app = await setup(t), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(async () => (await app.lifecycle.status()).wire).toBe("signed-in");
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    await gate(page, "Sign out of WIRE");
    const statusReads = app.calls.filter(call => call.path === "/api/access/status").length;
    const watches = app.calls.filter(call => call.path === "/api/access/watch").length;
    await page.waitForTimeout(2200);
    assert.equal(app.calls.filter(call => call.path === "/api/access/status").length, statusReads,
        "Watch heartbeats do not become an automatic status poll or keepalive.");
    assert.ok(app.calls.filter(call => call.path === "/api/access/watch").length > watches);
    const state = await page.evaluate(() => gateApi("/api/state"));
    assert.ok(state);
    await page.evaluate(() => { window.beforeSignOutPublication = gateApi.publicationToken(); });
    await (await gate(page, "Sign out of WIRE")).click();
    await expect.poll(async () => (await app.lifecycle.status()).wire).toBe("signed-out");
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(false);
    await assert.rejects(page.evaluate(() => gateApi("/api/state")), /unavailable|retired|revoked/i);
    assert.equal(await page.evaluate(() => gateView.receive(null, beforeSignOutPublication)), false);
    await assert.rejects(page.evaluate(() => gateView.receive(null)), /original publication token/);
    await gate(page, "Sign in to WIRE");
    await page.locator("#wireAccountGate").evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })));
    await page.waitForTimeout(100);
    assert.equal((await app.lifecycle.status()).wire, "signed-out", "A delayed double-click cannot reopen the gate after the label changes.");
    const commands = app.calls.filter(call => call.path === "/api/access/command");
    assert.deepEqual(commands.map(call => call.body.action), ["wire-sign-in", "wire-sign-out"]);
    assert.ok(commands.every(call => Object.keys(call.body).sort().join(",") === "action,generation,operationId,schemaVersion"));
    assert.equal(await page.locator("#wireMicrosoftAction").isDisabled(), true);
    assert.equal(await page.locator("#wireAccountTrigger img").count(), 0);
});

test("source-aware metadata projection preserves protected account commands without changing receipts", { timeout: 45000 }, async t => {
    const app = await setup(t, { nativeConnection: true, sourceAware: true }), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    assert.equal(await page.evaluate(() => gateApi.accessState().collectionMode), "source-aware");
    await showConnectionFixture(page);
    await expect(page.locator("#wireMicrosoftAction")).toBeEnabled();
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    const commands = app.calls.filter(call => call.path === "/api/access/command");
    assert.deepEqual(commands.map(call => call.body.action), ["wire-sign-in", "microsoft-connect"]);
    assert.ok(commands.every(call => Object.keys(call.body).sort().join(",") === "action,generation,operationId,schemaVersion"));
});

test("opt-in native Settings Connect uses the protected command and does not configure or collect", { timeout: 45000 }, async t => {
    const app = await setup(t, { nativeConnection: true }), page = await app.panel();
    assert.deepEqual(app.nativeCalls, []);
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    await showConnectionFixture(page);
    const connect = page.locator("#wireMicrosoftAction");
    await expect(connect).toHaveText("Connect Microsoft 365");
    await expect(connect).toBeEnabled();
    assert.deepEqual(app.nativeCalls, []);
    await connect.click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(connect).toHaveText("Reconnect Microsoft 365");
    await expect(connect).toBeEnabled();
    await page.evaluate(() => gateView.receive({ github: { phase: "unavailable", profile: null }, lifecycle: null }, gateApi.publicationToken()));
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    const commands = app.calls.filter(call => call.path === "/api/access/command");
    assert.deepEqual(commands.map(call => call.body.action), ["wire-sign-in", "microsoft-connect"]);
    assert.ok(commands.every(call => Object.keys(call.body).sort().join(",") === "action,generation,operationId,schemaVersion"));
    assert.equal(new Set(commands.map(call => call.body.operationId)).size, commands.length);
    assert.equal(app.nativeCalls.filter(value => value === "verify").length, 1);
    assert.equal(app.requests.some(route => ["/api/collection/configure", "/api/collection/enabled", "/api/collection/now"].includes(route)), false);
});

test("opt-in native Settings Cancel remains available while the original Connect is pending", { timeout: 45000 }, async t => {
    const app = await setup(t, { nativeConnection: true, verifyNative: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new MicrosoftSessionError("cancelled")), { once: true });
    }) }), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    await showConnectionFixture(page);
    const control = page.locator("#wireMicrosoftAction");
    await expect(control).toBeEnabled();
    await control.click();
    await expect(control).toHaveText("Cancel sign-in");
    await expect(control).toBeEnabled();
    await expect(page.locator("#wireMicrosoftConnection .wire-connection-effect")).toHaveText("Continue in the Microsoft sign-in window.");
    assert.equal(await page.evaluate(() => gateView.unavailableConnectionFeedback()), "Microsoft sign-in result is unconfirmed.");
    await control.click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    await expect(control).toHaveText("Connect Microsoft 365");
    await expect(control).toBeEnabled();
    const commands = app.calls.filter(call => call.path === "/api/access/command");
    assert.deepEqual(commands.map(call => call.body.action), ["wire-sign-in", "microsoft-connect", "microsoft-cancel"]);
    assert.equal(new Set(commands.map(call => call.body.operationId)).size, 3);
    assert.equal(app.nativeCalls.filter(value => value === "verify").length, 1);
});

test("native pending guidance survives a lost command response while the same sign-in remains cancellable", { timeout: 30000 }, async t => {
    const entered = Promise.withResolvers();
    const app = await setup(t, { nativeConnection: true, verifyNative: ({ signal }) => new Promise((resolve, reject) => {
        entered.resolve();
        signal.addEventListener("abort", () => reject(new MicrosoftSessionError("cancelled")), { once: true });
    }) }), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    await showConnectionFixture(page);
    let originalReply;
    await page.route("**/api/access/command", async route => {
        originalReply = route.fetch();
        void originalReply.catch(() => {});
        await entered.promise;
        await route.abort("failed");
    }, { times: 1 });
    const control = page.locator("#wireMicrosoftAction");
    await expect(control).toBeEnabled();
    await control.click();
    await expect.poll(() => page.evaluate(() => gateConnectionChanges)).toBe(1);
    try {
        await expect(control).toHaveText("Cancel sign-in");
        await expect(control).toBeEnabled();
        await expect(page.locator("#wireMicrosoftConnection .wire-connection-effect")).toHaveText("Continue in the Microsoft sign-in window.");
    } finally {
        await control.click();
        const reply = await originalReply;
        try { assert.equal((await reply.json()).reason, "cancelled"); }
        finally { await reply.dispose(); }
    }
    await expect(control).toHaveText("Check connection result");
    await control.click();
    await expect(control).toHaveText("Connect Microsoft 365");
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/command").map(call => call.body.action),
        ["wire-sign-in", "microsoft-connect", "microsoft-cancel"]);
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/receipt").map(call => call.body.operationId),
        [app.calls.find(call => call.body?.action === "microsoft-connect").body.operationId]);
    assert.equal(app.nativeCalls.filter(value => value === "verify").length, 1);
});

test("native connection feedback preserves a received failure through unavailable access without exposing connection controls", { timeout: 30000 }, async t => {
    const app = await setup(t, { nativeConnection: true, verifyNative: async () => { throw new MicrosoftSessionError("timed-out"); } });
    const page = await app.panel();
    assert.equal(await page.evaluate(() => gateView.unavailableConnectionFeedback()), "");
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    await showConnectionFixture(page);
    await expect(page.locator("#wireMicrosoftAction")).toBeEnabled();
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftConnection .wire-connection-effect")).toHaveText("Microsoft sign-in timed out.");
    await expect.poll(() => page.evaluate(() => gateView.unavailableConnectionFeedback())).toBe("Microsoft sign-in timed out.");
    await app.runtime.close();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().reason)).toBe("connection-unavailable");
    await expect(page.locator("#microsoftConnectionHost")).toBeHidden();
    assert.equal(await page.evaluate(() => gateView.unavailableConnectionFeedback()), "Microsoft sign-in timed out.");
    await page.evaluate(() => gateApi.startAccess());
    assert.equal(await page.evaluate(() => gateView.unavailableConnectionFeedback()), "Microsoft sign-in timed out.");
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/command").map(call => call.body.action),
        ["wire-sign-in", "microsoft-connect"]);
    assert.equal(app.nativeCalls.filter(value => value === "verify").length, 1);
});

test("opt-in native Settings lost response recovers only the same original operation receipt", { timeout: 45000 }, async t => {
    const app = await setup(t, { nativeConnection: true }), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    await showConnectionFixture(page);
    const control = page.locator("#wireMicrosoftAction");
    await expect(control).toBeEnabled();
    let original;
    await page.route("**/api/access/command", async route => {
        original = route.request().postDataJSON();
        const response = await route.fetch();
        try { assert.equal((await response.json()).outcome, "completed"); }
        finally { await response.dispose(); }
        await route.abort("failed");
    }, { times: 1 });
    await control.click();
    await expect(control).toHaveText("Reconnect Microsoft 365");
    await expect(control).toBeEnabled();
    const nativeCommands = app.calls.filter(call => call.path === "/api/access/command" && call.body.action.startsWith("microsoft-"));
    assert.equal(nativeCommands.length, 1);
    const lookups = app.calls.filter(call => call.path === "/api/access/receipt");
    assert.deepEqual(lookups.map(call => call.body), [{ schemaVersion: 1, operationId: original.operationId }]);
    assert.equal(app.nativeCalls.filter(value => value === "verify").length, 1);
});

test("opt-in native Settings does not adopt an uncertain operation after control-owner replacement", { timeout: 45000 }, async t => {
    const app = await setup(t, { nativeConnection: true }), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    await showConnectionFixture(page);
    const control = page.locator("#wireMicrosoftAction");
    await expect(control).toBeEnabled();
    await page.route("**/api/access/command", async route => {
        const response = await route.fetch();
        await response.dispose();
        await route.abort("failed");
    }, { times: 1 });
    await page.route("**/api/access/receipt", route => route.fulfill({ json: null }), { times: 1 });
    await control.click();
    await expect(control).toHaveText("Check connection result");
    await expect.poll(() => app.calls.filter(call => call.path === "/api/access/receipt").length).toBe(1);
    await page.route("**/api/access/status", route => route.fulfill({
        status: 403, contentType: "application/json", body: JSON.stringify({ code: "session_expired", error: "Fixture capability retired." }),
    }), { times: 1 });
    await page.evaluate(() => gateApi("/api/access/status").catch(() => null));
    await expect(control).toHaveText("Connection result unavailable");
    await expect(control).toBeDisabled();
    await control.evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(app.calls.filter(call => call.path === "/api/access/receipt").length, 1,
        "Only the original owner's automatic read ran; replacement cannot rebind recovery.");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command" && call.body.action.startsWith("microsoft-")).length, 1);
});

test("opt-in native Settings recovery is a separate advertised cleanup command, not a Connect replay", { timeout: 45000 }, async t => {
    let stops = 0;
    const app = await setup(t, { nativeConnection: true, stopNative: async () => ({
        processExited: ++stops > 1, profileReleased: stops > 1,
    }) }), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    await showConnectionFixture(page);
    const control = page.locator("#wireMicrosoftAction");
    await expect(control).toBeEnabled();
    await control.click();
    await expect(control).toHaveText("Reconnect Microsoft 365");
    await (await gate(page, "Sign out of WIRE")).click();
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    await showConnectionFixture(page);
    await expect(control).toHaveText("Recover connection");
    await expect(control).toBeEnabled();
    await control.click();
    await expect(control).toHaveText("Connect Microsoft 365");
    await expect(control).toBeEnabled();
    const nativeCommands = app.calls.filter(call => call.path === "/api/access/command" && call.body.action.startsWith("microsoft-"));
    assert.deepEqual(nativeCommands.map(call => call.body.action), ["microsoft-connect", "microsoft-recover"]);
    assert.equal(app.nativeCalls.filter(value => value === "verify").length, 1);
});

test("the real one-button gate remains keyboard operable in the native narrow navigation", { timeout: 45000 }, async t => {
    const app = await setup(t), page = await app.panel();
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; evidenceTheme.setPreference("dark"); });
    const signIn = await gate(page, "Sign in to WIRE");
    await signIn.focus(); await page.keyboard.press("Enter");
    await expect.poll(async () => (await app.lifecycle.status()).wire).toBe("signed-in");
    const signOut = await gate(page, "Sign out of WIRE");
    await signOut.focus();
    if (process.env.WIRE_ACCOUNT_GATE_PROOF) {
        await mkdir(process.env.WIRE_ACCOUNT_GATE_PROOF, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_ACCOUNT_GATE_PROOF, "actual-gate-dark-narrow-200.png") });
    }
    const box = await page.locator("#wireAccountMenu").boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 1000);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.keyboard.press(" ");
    await expect.poll(async () => (await app.lifecycle.status()).wire).toBe("signed-out");
    await gate(page, "Sign in to WIRE");
    await page.keyboard.press("Escape");
    await expect(page.locator("#wireAccountTrigger")).toBeFocused();
    await expect(page.locator("#navigationDrawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#navigationDrawer")).toBeHidden();
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/command").map(call => call.body.action),
        ["wire-sign-in", "wire-sign-out"]);
});

test("explicit unbound mode retains the inactive native hosts and never activates a gate command", async t => {
    const app = await setup(t, { enforced: false }), page = await app.panel();
    await expect(page.locator("#wireAccountEntry")).toBeHidden();
    await expect(page.locator("#microsoftConnectionHost")).toBeHidden();
    await page.locator("#wireAccountGate").evaluate(button => button.click());
    assert.equal(await page.evaluate(() => gateView.receive(null, gateApi.publicationToken())), false);
    assert.equal(app.calls.some(call => call.path === "/api/access/command"), false);
    assert.ok(await page.evaluate(() => gateApi("/api/state")));
});

test("a lost sign-out response recovers only its real original receipt and duplicate clicks never replay", { timeout: 45000 }, async t => {
    const held = Promise.withResolvers(), admitted = Promise.withResolvers();
    t.after(() => held.resolve());
    const app = await setup(t), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await gate(page, "Sign out of WIRE");
    await page.evaluate(() => { window.originalOwner = gateApi.controlToken(); });
    let original;
    await page.route("**/api/access/command", async route => {
        const response = await route.fetch();
        original = route.request().postDataJSON();
        assert.equal((await response.json()).outcome, "completed");
        admitted.resolve();
        await held.promise;
        await route.abort("failed");
    }, { times: 1 });
    await page.locator("#wireAccountGate").click();
    await admitted.promise;
    await page.locator("#wireAccountGate").evaluate(button => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 2);
    held.resolve();
    await gate(page, "Check sign-out");
    assert.equal(await page.evaluate(() => gateApi.isControlCurrent(originalOwner)), true);
    assert.equal(await page.evaluate(() => gateApi.publicationToken()), null);
    const malformedOwner = await page.evaluate(() => {
        const original = gateApi.isControlCurrent;
        try {
            gateApi.isControlCurrent = () => Promise.resolve(false);
            gateView.receiveAccess();
            const disabled = document.getElementById("wireAccountGate").disabled;
            document.getElementById("wireAccountGate").dispatchEvent(new MouseEvent("click", { bubbles: true }));
            return disabled;
        } finally { gateApi.isControlCurrent = original; gateView.receiveAccess(); }
    });
    assert.equal(malformedOwner, true, "A promise is not original-owner authorization.");
    assert.equal(app.calls.filter(call => call.path === "/api/access/receipt").length, 0);
    await gate(page, "Check sign-out");
    await page.locator("#wireAccountGate").click();
    await gate(page, "Sign in to WIRE");
    const receipts = app.calls.filter(call => call.path === "/api/access/receipt");
    assert.deepEqual(receipts.map(call => call.body), [{ schemaVersion: 1, operationId: original.operationId }]);
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 2);
    assert.equal((await app.lifecycle.status()).wire, "signed-out");
});

test("owner replacement leaves the original action unknown and sends no receipt or command under the new owner", { timeout: 45000 }, async t => {
    const held = Promise.withResolvers(), admitted = Promise.withResolvers();
    t.after(() => held.resolve());
    const app = await setup(t), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await gate(page, "Sign out of WIRE");
    await page.evaluate(() => { window.originalOwner = gateApi.controlToken(); });
    await page.route("**/api/access/command", async route => {
        const response = await route.fetch();
        admitted.resolve();
        await held.promise;
        await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#wireAccountGate").click();
    await admitted.promise;
    await page.evaluate(() => gateApi("/api/session/release", {}));
    await expect.poll(() => page.evaluate(() => gateApi.controlToken() !== null && !gateApi.isControlCurrent(originalOwner))).toBe(true);
    held.resolve();
    if (!await page.locator("#wireAccountMenu").isVisible()) await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toHaveText("Check sign-out");
    await expect(page.locator("#wireAccountGate")).toBeDisabled();
    await expect(page.locator("#wireAccountGateMessage")).toContainText("unconfirmed");
    await page.locator("#wireAccountGate").evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await page.waitForTimeout(200);
    assert.equal(app.calls.filter(call => call.path === "/api/access/receipt").length, 0);
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 2);
    assert.equal((await app.lifecycle.status()).wire, "signed-out");
});

test("an old Sign out click cannot turn into Sign in after another real panel changes the gate", { timeout: 45000 }, async t => {
    const held = Promise.withResolvers(), entered = Promise.withResolvers();
    t.after(() => held.resolve());
    const app = await setup(t), a = await app.panel(), b = await app.panel();
    await (await gate(a, "Sign in to WIRE")).click();
    await gate(a, "Sign out of WIRE"); await gate(b, "Sign out of WIRE");
    await a.route("**/api/access/status", async route => {
        const response = await route.fetch();
        entered.resolve();
        await held.promise;
        await route.fulfill({ response });
    }, { times: 1 });
    await a.locator("#wireAccountGate").click();
    await entered.promise;
    await b.locator("#wireAccountGate").click();
    await expect.poll(async () => (await app.lifecycle.status()).wire).toBe("signed-out");
    await expect.poll(() => a.evaluate(() => gateApi.accessState().state?.wire)).toBe("signed-out");
    held.resolve();
    await gate(a, "Sign in to WIRE");
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/command").map(call => call.body.action),
        ["wire-sign-in", "wire-sign-out"]);
    assert.equal((await app.lifecycle.status()).wire, "signed-out");
});

test("a malformed enforced status is not an unbound fallback and retry remains read-only", { timeout: 45000 }, async t => {
    const app = await setup(t), page = await app.panel();
    await gate(page, "Sign in to WIRE");
    await page.route("**/api/access/status", route => route.fulfill({ json: {
        schemaVersion: 1, mode: "unbound", runtimeId: "00000000-0000-0000-0000-000000000000",
    } }), { times: 1 });
    await page.locator("#wireAccountGate").click();
    await gate(page, "Check connection");
    await expect(page.locator("#wireAccountGateMessage")).toContainText("could not be read");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 0);
    assert.equal(await page.evaluate(() => gateApi.accessState().mode), "enforced");
    await page.locator("#wireAccountGate").click();
    await gate(page, "Sign in to WIRE");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 0);
    assert.equal((await app.lifecycle.status()).wire, "signed-out");
});

test("missing or mismatched receipts stay unknown until the original real receipt is read", { timeout: 45000 }, async t => {
    const app = await setup(t), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await gate(page, "Sign out of WIRE");
    await page.route("**/api/access/command", async route => {
        await route.fetch();
        await route.abort("failed");
    }, { times: 1 });
    await page.locator("#wireAccountGate").click();
    await gate(page, "Check sign-out");
    await page.route("**/api/access/receipt", route => route.fulfill({ json: null }), { times: 1 });
    await page.locator("#wireAccountGate").click();
    await gate(page, "Check sign-out");
    await expect(page.locator("#wireAccountGateMessage")).toContainText("unconfirmed");
    await page.route("**/api/access/receipt", async route => {
        const response = await route.fetch(), value = await response.json();
        await route.fulfill({ response, json: { ...value, operationId: "00000000-0000-0000-0000-000000000000" } });
    }, { times: 1 });
    await page.locator("#wireAccountGate").click();
    await gate(page, "Check sign-out");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 2);
    await page.locator("#wireAccountGate").click();
    await gate(page, "Sign in to WIRE");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 2);
    const ids = app.calls.filter(call => call.path === "/api/access/receipt").map(call => call.body.operationId);
    assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 1);
    assert.equal((await app.lifecycle.status()).wire, "signed-out");
});

test("backend-projected actions stay authoritative and Pause leaves the private publication current", { timeout: 45000 }, async t => {
    const app = await setup(t), page = await app.panel();
    await gate(page, "Sign in to WIRE");
    const beforeMalformed = app.calls.length;
    const malformedTokens = await page.evaluate(() => {
        const capture = gateApi.controlToken, current = gateApi.isControlCurrent, facts = [];
        try {
            gateApi.isControlCurrent = () => true;
            for (const token of [undefined, null, Promise.resolve(capture()), { then() {} }]) {
                gateApi.controlToken = () => token;
                gateView.receiveAccess();
                facts.push(document.getElementById("wireAccountGate").disabled);
                document.getElementById("wireAccountGate").dispatchEvent(new MouseEvent("click", { bubbles: true }));
            }
        } finally { gateApi.controlToken = capture; gateApi.isControlCurrent = current; }
        return facts;
    });
    assert.deepEqual(malformedTokens, [true, true, true, true]);
    assert.equal(app.calls.slice(beforeMalformed).some(call => call.path !== "/api/access/watch"), false);
    await page.evaluate(() => gateView.receiveAccess());
    await gate(page, "Sign in to WIRE");
    await page.route("**/api/access/status", async route => {
        const response = await route.fetch(), value = await response.json();
        await route.fulfill({ response, json: { ...value, actions: [] } });
    }, { times: 1 });
    await page.locator("#wireAccountGate").click();
    await expect(page.locator("#wireAccountGate")).toHaveText("Sign in to WIRE");
    await expect(page.locator("#wireAccountGate")).toBeDisabled();
    assert.equal(app.calls.some(call => call.path === "/api/access/command"), false);
    await app.lifecycle.updateCollection({ paused: false, windowDays: 30 });
    await (await gate(page, "Sign in to WIRE")).click();
    await gate(page, "Sign out of WIRE");
    await page.evaluate(() => { window.beforePause = gateApi.publicationToken(); window.ownerBeforePause = gateApi.controlToken(); });
    await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
    await expect.poll(() => page.evaluate(() => gateApi.accessState().state?.collection)).toBe("paused");
    assert.equal(await page.evaluate(() => gateApi.isCurrent(beforePause)), true);
    assert.equal(await page.evaluate(() => gateApi.isControlCurrent(ownerBeforePause)), true);
    await gate(page, "Sign out of WIRE");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 1);
    assert.equal(await page.locator("#wireMicrosoftAction").isDisabled(), true);
});

test("a gesture begun on Sign out cannot activate Sign in after an external gate change", { timeout: 45000 }, async t => {
    const app = await setup(t), a = await app.panel(), b = await app.panel();
    await (await gate(a, "Sign in to WIRE")).click();
    await gate(a, "Sign out of WIRE"); await gate(b, "Sign out of WIRE");
    const box = await a.locator("#wireAccountGate").boundingBox();
    await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await a.mouse.down();
    await b.locator("#wireAccountGate").click();
    await expect.poll(() => a.evaluate(() => gateApi.accessState().state?.wire)).toBe("signed-out");
    await expect(a.locator("#wireAccountGate")).toHaveText("Sign in to WIRE");
    await expect(a.locator("#wireAccountGate")).toBeEnabled();
    await a.mouse.up();
    await a.waitForTimeout(200);
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/command").map(call => call.body.action),
        ["wire-sign-in", "wire-sign-out"]);
    assert.equal((await app.lifecycle.status()).wire, "signed-out");
});

test("missing or partial shared API rejects before any host or DOM mutation", async t => {
    const app = await setup(t), page = await app.panel();
    const results = await page.evaluate(() => {
        gateView.dispose();
        const methods = ["accessState", "publicationToken", "isCurrent", "controlToken", "isControlCurrent"];
        const variants = [["missing", undefined], ["null", null], ["not-callable", Object.fromEntries(methods.map(name => [name, gateApi[name]]))]];
        for (const missing of methods) {
            const partial = (...args) => gateApi(...args);
            for (const name of methods) if (name !== missing) partial[name] = gateApi[name];
            variants.push([missing, partial]);
        }
        return variants.map(([name, api]) => {
            const before = document.body.innerHTML;
            let mounted, error;
            try {
                mounted = gateFactory({ api, ux, accountSlot: document.getElementById("wireAccountEntry"),
                    connectionSlot: document.getElementById("microsoftConnectionHost") });
            } catch (failure) { error = failure.message; }
            const unchanged = before === document.body.innerHTML;
            mounted?.dispose();
            return { name, error, unchanged };
        });
    });
    for (const result of results) {
        assert.match(result.error || "", /shared access and original-owner interfaces/, result.name);
        assert.equal(result.unchanged, true, result.name + ": no partial mount");
    }
    assert.equal(app.requests.some(route => route.startsWith("/api/profile/")), false);
});

test("missing and stale profile tokens paint nothing and request no image under a current grant", async t => {
    const app = await setup(t), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await gate(page, "Sign out of WIRE");
    await page.evaluate(() => {
        window.staleProfileToken = gateApi.publicationToken();
        gateApi.suspendAccess(); gateApi.startAccess();
    });
    await expect.poll(() => page.evaluate(() => gateApi.publicationToken() !== null && !gateApi.isCurrent(staleProfileToken))).toBe(true);
    await gate(page, "Sign out of WIRE");
    const result = await page.evaluate(() => {
        const forbidden = { github: { phase: "ready", profile: {
            schemaVersion: 1, provider: "github", generation: "forbidden-old-result",
            identity: { state: "verified", reason: null, host: "github.com", login: "forbidden-profile" },
            displayName: { value: "PRIVATE_PROFILE_MUST_NOT_PAINT", source: "github-public-profile", freshness: "current" },
            avatar: { state: "current", reason: null, url: "/api/profile/github/avatar/" + "a".repeat(64), expiresAt: Date.now() + 60000 },
            fallback: { kind: "initials", text: "F", source: "verified-login" }, issues: [],
        } }, lifecycle: null };
        const owned = () => ["wireAccountEntry", "wireAccountMenu", "microsoftConnectionHost"]
            .map(id => document.getElementById(id).outerHTML).join("");
        let inspected = 0;
        const delivery = { get github() { inspected++; return forbidden.github; }, lifecycle: null };
        const before = owned();
        let missing;
        try { gateView.receive(delivery); } catch (error) { missing = error.message; }
        const denied = gateView.receive(delivery, null);
        const stale = gateView.receive(delivery, staleProfileToken);
        const original = gateApi.isCurrent, token = gateApi.publicationToken(), malformed = [];
        try {
            for (const result of [Promise.resolve(false), 1]) {
                gateApi.isCurrent = () => result;
                malformed.push(gateView.receive(delivery, token));
            }
            gateApi.isCurrent = () => true;
            for (const invalid of [Promise.resolve(token), { then() {} }]) malformed.push(gateView.receive(delivery, invalid));
        } finally { gateApi.isCurrent = original; }
        dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
        return { missing, denied, stale, malformed, inspected, unchanged: before === owned(), text: owned() };
    });
    assert.match(result.missing, /original publication token/);
    assert.equal(result.denied, false); assert.equal(result.stale, false); assert.equal(result.unchanged, true);
    assert.equal(result.inspected, 0, "Rejected delivery never reads or captures the private payload.");
    assert.deepEqual(result.malformed, [false, false, false, false]);
    assert.doesNotMatch(result.text, /PRIVATE_PROFILE_MUST_NOT_PAINT|forbidden-profile|avatar\/a{64}/);
    await page.waitForTimeout(100);
    assert.equal(app.requests.some(route => route.startsWith("/api/profile/")), false);
});

test("profile delivery retires cleanly when the real transport deadline withdraws synchronously", async t => {
    const app = await setup(t), page = await app.panel();
    await (await gate(page, "Sign in to WIRE")).click();
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    const result = await page.evaluate(snapshot => {
        const token = gateApi.publicationToken(), original = gateApi.isCurrent;
        window.retiredDeliveryToken = token;
        let now = performance.now(), calls = 0, error = null, delivered;
        Object.defineProperty(performance, "now", { configurable: true, value: () => now });
        gateApi.isCurrent = value => {
            if (++calls === 2) now += 6000;
            return original(value);
        };
        try { delivered = gateView.receive(snapshot, token); }
        catch (failure) { error = failure.message; }
        finally { gateApi.isCurrent = original; delete performance.now; }
        return { error, delivered, calls, access: gateApi.accessState(),
            profile: document.getElementById("wireAccountTrigger").textContent,
            connection: document.getElementById("wireMicrosoftStatus").textContent };
    }, presentationFixture(null, verifiedGitHubProfile));
    assert.ok(result.calls >= 2);
    assert.equal(result.error, null);
    assert.equal(result.delivered, false);
    assert.equal(result.access.readable, false);
    assert.equal(result.access.reason, "freshness-expired");
    assert.doesNotMatch(result.profile, /Riley|riley-chen/);
    assert.equal(result.connection, "");
    await expect.poll(() => page.evaluate(() => gateApi.accessState().readable)).toBe(true);
    assert.equal(await page.evaluate(() => gateApi.isCurrent(retiredDeliveryToken)), false);
    await page.evaluate(() => {
        dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("#wireAccountTrigger")).not.toContainText("Riley");
    assert.equal(app.requests.some(route => route.startsWith("/api/profile/")), false);
});
