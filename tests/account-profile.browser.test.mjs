import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createCopilotAccountBridge } from "../lib/copilot-account-snapshot.mjs";
import { createMicrosoftSession, MicrosoftSessionError } from "../lib/microsoft-session.mjs";
import { createFixtureRuntimeAccess, createNativeRuntimeAccess, createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createBoardTransport } from "../lib/client-transport.mjs";
import { mountAccountSettingsPresentation } from "../web/account-settings-presentation.mjs";
import { privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

function syntheticImage() {
    const chunk = (type, data) => {
        const content = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
        length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(content));
        return Buffer.concat([length, content, crc]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
    const rows = Buffer.alloc(32 * 97);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const color = x >= 8 && x < 24 && y >= 8 && y < 24 ? [165, 208, 222] : [45, 99, 123];
        Buffer.from(color).copy(rows, y * 97 + 1 + x * 3);
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const png = syntheticImage();
async function setup(t, { qualified = true, sourceAware = false, copilotOnly = false, connect, observedUPN } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) });
    let lifecycle, persistence, access, bridge, runtime, browser;
    const errors = [], external = [], calls = [];
    t.after(async () => {
        await browser?.close(); await runtime?.close(); bridge?.close(); await access?.close(); persistence?.close(); await lifecycle?.close();
        for (const work of cleanup.reverse()) await work();
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
    });
    const transport = sourceAware ? createMicrosoftNativeReadTransport({
        async open() { if (!connect) assert.fail("Enrollment proof must not open a provider."); },
        async verifyAccount(operation) {
            if (!connect) assert.fail("Enrollment proof must not acquire identity.");
            await connect(operation);
            return { tenantId: "synthetic-tenant", subjectId: "synthetic-subject", knownAccountMatched: true,
                ...(observedUPN ? { presentation: { source: "microsoft-native-principal", email: observedUPN } } : {}),
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString(),
                    ...(observedUPN ? { namespace: "m365.accountInfo.objectId", realm: "prod" } : {}) } };
        },
        async stop() { return { processExited: true, profileReleased: true }; },
    }) : undefined;
    lifecycle = copilotOnly ? null : await createMicrosoftSession(context, { collection: { paused: true, windowDays: 30 },
        ...(sourceAware ? { sourceAware: true, globalCollection: null, transport,
            persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) } : {}) });
    persistence = sourceAware ? await createNativePersistence(context, { lifecycle, transport, preAccount: "metadata-only", configurationIntents: true }) : null;
    access = copilotOnly ? await createCopilotRuntimeAccess(context) : sourceAware ? await createNativeRuntimeAccess(context, {
        lifecycle, nativePersistence: persistence, sourceAware: true, nativeAcquisition: false, nativeConnection: Boolean(connect),
        async acquireNative() { assert.fail("Enrollment proof must not collect activity."); },
    }) : await createFixtureRuntimeAccess(context, { lifecycle });
    const host = { login: "synthetic-riley", name: "Riley Chen", selected: "selection-one", calls: 0, publicCalls: [] };
    const existing = { sessionId: "synthetic-qualified-host", rpc: {
        accounts: { get: async () => {
            host.calls++;
            return { kind: "activeAccount",
                account: { active: true, kind: "githubDotCom", host: "github.com", login: host.login, selectionId: host.selected },
                authInfo: { type: "user", host: "github.com", login: host.login } };
        } },
        gitHubAuth: { getStatus: async () => ({ isAuthenticated: true, authType: "user", host: "github.com", login: host.login }) },
    } };
    bridge = createCopilotAccountBridge(() => existing, qualified
        ? { expectedSessionId: existing.sessionId, binding: "copilot-app" } : {});
    runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false }, access,
        githubProfile: { copilot: bridge.copilot, fetch: async url => {
            host.publicCalls.push(url);
            return url.startsWith("https://api.github.com/") ? Response.json({
                type: "User", id: 70001, login: host.login, name: host.name,
                email: "never-publish@example.invalid", avatar_url: "https://avatars.githubusercontent.com/u/70001",
            }) : new Response(png, { headers: { "content-type": "image/png" } });
        } },
    });
    const origin = new URL(runtime.url).origin;
    const session = await fetch(origin + "/api/session", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" }).then(response => response.json());
    if (!copilotOnly) await fetch(origin + "/api/access/command", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": session.capability },
        body: JSON.stringify({ schemaVersion: 1, action: "wire-sign-in", operationId: randomUUID(), generation: (await lifecycle.status()).generation }) });
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    async function panel(beforeNavigate) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
            const url = new URL(request.url());
            if (url.pathname.startsWith("/api/")) calls.push({ page, path: url.pathname, body: request.postDataJSON() });
        });
        await page.route(url => url.origin !== origin, route => { external.push(route.request().url()); return route.abort(); });
        if (beforeNavigate) await beforeNavigate(page);
        await page.goto(runtime.url + "#settings?section=connection");
        await expect(page.locator(copilotOnly ? "#connectionSourceTitle" : "#wireMicrosoftConnection")).toBeVisible();
        return page;
    }
    return { panel, host, calls, lifecycle, access, context, runtime };
}
async function gate(page, label) {
    if (await page.locator("#wireAccountTrigger").getAttribute("aria-expanded") !== "true") await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toHaveText(label);
    await expect(page.locator("#wireAccountGate")).toBeEnabled();
    await page.locator("#wireAccountGate").click();
}
async function capture(page, name) {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name);
    if (!process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS) return;
    await mkdir(process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS, name + ".png") });
}

test("the ordinary client delivers the qualified existing-host profile and withdraws it across tabs, Pause and reload", { timeout: 60000 }, async t => {
    const app = await setup(t), first = await app.panel(), second = await app.panel();
    for (const page of [first, second]) {
        await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
        await expect(page.locator("#wireAccountTrigger img")).toBeVisible();
        assert.equal(await page.locator("#wireAccountTrigger img").evaluate(image => image.complete && image.naturalWidth > 0), true);
        assert.doesNotMatch(await page.content(), /never-publish@example/);
        assert.match(await page.locator("#wireAccountTrigger img").getAttribute("src"), /^\/api\/profile\/github\/avatar\/[a-f0-9]{64}$/);
    }
    const board = await loadBoardState(app.context);
    await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
    await expect(first.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(first.locator("#workspace")).toBeVisible();
    await second.evaluate(() => {
        const walker = document.createTreeWalker(document.getElementById("wireAccountEntry"), NodeFilter.SHOW_TEXT);
        window.profileNodes = [];
        while (walker.nextNode()) if (/Riley|synthetic-riley/.test(walker.currentNode.data)) profileNodes.push(walker.currentNode);
        window.profileImage = document.querySelector("#wireAccountTrigger img").getAttributeNode("src");
    });
    await gate(first, "Sign out of this instance");
    await expect(second.locator("#message")).toContainText("signed out");
    await expect(second.locator("#wireAccountTrigger")).not.toContainText("Riley");
    await expect(second.locator("#wireAccountTrigger img")).toHaveCount(0);
    assert.deepEqual(await second.evaluate(() => profileNodes.map(node => node.data)), [""]);
    assert.equal(await second.evaluate(() => profileImage.value), "");
    const reads = app.calls.filter(call => call.page === second && call.path === "/api/profile/github").length;
    await second.reload();
    await expect(second.locator("#message")).toContainText("signed out");
    assert.equal(app.calls.filter(call => call.page === second && call.path === "/api/profile/github").length, reads);
    await gate(first, "Sign in to WIRE");
    await expect(second.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    assert.deepEqual(await loadBoardState(app.context), board);
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/command").map(call => call.body.action),
        ["wire-sign-out", "wire-sign-in"]);
});

test("the ordinary account menu keeps a neutral fallback and action without a default tutorial", { timeout: 30000 }, async t => {
    const app = await setup(t, { qualified: false, copilotOnly: true }), page = await app.panel();
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountProfileMessage")).toBeHidden();
    await expect(page.locator("#wireAccountMenu > p:visible")).toHaveCount(1);
    await expect(page.locator(".wire-account-identity")).toHaveText("Local WIRE access", { useInnerText: true });
    await expect(page.locator("#wireAccountTrigger")).toContainText("This instance");
    await expect(page.locator("#wireAccountGate")).toHaveAccessibleDescription(
        "Stops collection and hides saved activity. Does not delete data or sign out of GitHub or Copilot.");
    await expect(page.locator("#wireAccountProfileRetry")).toBeHidden();
    await expect(page.locator("#wireAccountGate")).toBeEnabled();
    await expect(page.locator("#wireAccountTrigger [data-lucide-icon='user-round']")).toBeVisible();
    assert.equal(app.host.calls, 0); assert.deepEqual(app.host.publicCalls, []);
    await capture(page, "ordinary-unbound-profile");
});

test("Copilot-only sign-out is instance-local and reentry restores retained access without a GitHub login", { timeout: 45000 }, async t => {
    const app = await setup(t, { qualified: false, copilotOnly: true });
    const independent = await setup(t, { qualified: false, copilotOnly: true });
    const first = await app.panel(), second = await app.panel(), other = await independent.panel();
    const before = await loadBoardState(app.context), otherBefore = await loadBoardState(independent.context);
    await gate(first, "Sign out of this instance");
    await expect(second.locator("#message")).toContainText("signed out");
    await expect(other.locator("#workspace")).toBeVisible();
    assert.equal((await app.access.status()).retained, false);
    assert.equal((await independent.access.status()).retained, true);
    await second.reload();
    await expect(second.locator("#message")).toContainText("signed out");
    await second.locator("#wireAccountTrigger").click();
    await expect(second.locator("#wireAccountGateScope")).toBeHidden();
    await expect(second.locator("#wireAccountGate")).toHaveText("Sign in to WIRE");
    await gate(first, "Sign in to WIRE");
    await expect(second.locator("#workspace")).toBeVisible();
    assert.equal((await app.access.status()).retained, true);
    assert.deepEqual(await loadBoardState(app.context), before);
    assert.deepEqual(await loadBoardState(independent.context), otherBefore);
    assert.equal(app.host.calls + independent.host.calls, 0);
    assert.deepEqual([...app.host.publicCalls, ...independent.host.publicCalls], []);
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/command").map(call => call.body.action),
        ["wire-sign-out", "wire-sign-in"]);
    assert.equal(independent.calls.some(call => call.path === "/api/access/command"), false);
});

test("actual account presentation handles profile failure, replacement identity and compact themed layouts", { timeout: 60000 }, async t => {
    const app = await setup(t, { copilotOnly: true }), page = await app.panel();
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await page.route("**/api/profile/github", route => route.fulfill({ status: 503, json: { error: "PRIVATE ERROR" } }));
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountProfileRetry")).toBeVisible();
    await expect(page.locator("#wireAccountTrigger img")).toHaveCount(0);
    assert.doesNotMatch(await page.locator("#wireAccountMenu").textContent(), /PRIVATE ERROR/);
    await capture(page, "ordinary-profile-error");
    await page.unroute("**/api/profile/github");
    app.host.login = "synthetic-morgan"; app.host.name = "Morgan Alexandra Rivera Singh"; app.host.selected = "selection-two";
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("#wireAccountProfileRetry")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#wireAccountTrigger")).toContainText("Morgan Alexandra Rivera Singh");
    await expect(page.locator("#wireAccountTrigger img")).toBeVisible();
    for (const theme of ["light", "dark"]) {
        await page.keyboard.press("Escape");
        await chooseTheme(page, theme);
        await page.locator("#wireAccountTrigger").hover();
        const hovered = await page.locator("#wireAccountTrigger").evaluate(node => getComputedStyle(node).backgroundColor);
        await page.mouse.down();
        const pressed = await page.locator("#wireAccountTrigger").evaluate(node => getComputedStyle(node).backgroundColor);
        assert.notEqual(pressed, hovered, "Existing pressed and hover faces remain distinct.");
        await page.mouse.up();
        await capture(page, `ordinary-account-${theme}-expanded`);
        await page.keyboard.press("Escape");
        await page.locator("#navigationCollapse").click();
        await page.locator("#wireAccountTrigger").click();
        await expect(page.locator("#wireAccountGate")).toBeFocused();
        await capture(page, `ordinary-account-${theme}-collapsed`);
        await page.keyboard.press("Escape");
        await page.locator("#navigationCollapse").click();
        for (const width of [768, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            if (width < 700) await page.locator("#navigationToggle").click();
            await page.locator("#wireAccountTrigger").click();
            await expect(page.locator("#wireAccountGate")).toBeFocused();
            await capture(page, `ordinary-account-${theme}-${width}`);
            await page.keyboard.press("Escape");
            await expect(page.locator("#wireAccountTrigger")).toBeFocused();
            if (width < 700) await page.keyboard.press("Escape");
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.locator("#navigationToggle").click();
    await page.locator("#wireAccountTrigger").click();
    const bounds = await page.locator("#wireAccountMenu").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 1000);
    await capture(page, "ordinary-account-200-percent");
    await page.keyboard.press("Escape");
    await expect(page.locator("#wireAccountTrigger")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#navigationToggle")).toBeFocused();
});

async function enrollmentRoutes(page, app, { prepare, read, initialPrepared = false } = {}) {
    let prepared = initialPrepared;
    const descriptor = async () => ({ schemaVersion: 1, generation: (await app.lifecycle.status()).generation,
        phase: prepared ? "prepared" : "available", actions: prepared ? [] : ["prepare"],
        reason: prepared ? "source-already-configured" : null });
    const reply = async (route, value) => route.fulfill({ json: value,
        headers: { "X-Wire-Runtime": app.runtime.runtimeId, "X-Wire-Generation": String(value.generation) } });
    await page.route("**/api/collection/microsoft/enrollment", async route => {
        assert.deepEqual(route.request().postDataJSON(), {});
        if (read) return read(route, await descriptor(), reply);
        return reply(route, await descriptor());
    });
    await page.route("**/api/collection/microsoft/enroll", async route => {
        const command = route.request().postDataJSON();
        assert.deepEqual(Object.keys(command).sort(), ["generation", "operationId", "schemaVersion"]);
        assert.equal(command.schemaVersion, 2);
        prepared = true;
        if (prepare) return prepare(route, await descriptor(), reply);
        return reply(route, await descriptor());
    });
}

test("withdrawal during the second Connect preflight retires the continuation even when control owner and generation survive", { timeout: 45000 }, async t => {
    const held = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    let armed = false, preflights = 0, connections = 0;
    const app = await setup(t, { sourceAware: true, qualified: false, connect: async () => { connections++; } });
    const page = await app.panel(async page => {
        await page.route(url => url.pathname === "/", async route => {
            const response = await route.fetch();
            let html = await response.text();
            const transport = createBoardTransport.toString(), presenter = mountAccountSettingsPresentation.toString();
            assert.equal(html.split(transport).length, 2);
            assert.equal(html.split(presenter).length, 2);
            html = html.replace(transport, () => transport.replace("return api;",
                "window.fixtureAccountApi = api; return api;"));
            const callback = "onConnect: continuePreparedConnection";
            assert.equal(presenter.split(callback).length, 2);
            html = html.replace(presenter, () => presenter.replace(callback,
                "onConnect: async intent => { try { return await continuePreparedConnection(intent); } finally { window.fixtureContinuationSettled = true; } }"));
            return route.fulfill({ response, body: html });
        });
        await enrollmentRoutes(page, app, { prepare: async (route, value, reply) => {
            armed = true; return reply(route, value);
        } });
        await page.route("**/api/access/status", async route => {
            if (armed && ++preflights === 2) { held.resolve(); await release.promise; }
            return route.continue();
        });
    });
    await expect(page.locator("#wireAccountGate")).toBeEnabled();
    await page.evaluate(() => {
        window.originalContinuationOwner = fixtureAccountApi.controlToken();
        window.originalContinuationPublication = fixtureAccountApi.publicationToken();
        window.originalContinuationGeneration = fixtureAccountApi.accessState().state.generation;
    });
    await page.locator("#wireMicrosoftPrepare").click();
    await held.promise;
    assert.equal(preflights, 2);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    assert.equal(await page.evaluate(() => fixtureAccountApi.publicationToken()), null);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.waitForFunction(() => fixtureAccountApi.accessState().readable);
    assert.deepEqual(await page.evaluate(() => ({
        sameOwner: fixtureAccountApi.controlToken() === originalContinuationOwner,
        sameGeneration: fixtureAccountApi.accessState().state.generation === originalContinuationGeneration,
        newPublication: fixtureAccountApi.publicationToken() !== originalContinuationPublication,
    })), { sameOwner: true, sameGeneration: true, newPublication: true });
    release.resolve();
    await page.waitForFunction(() => window.fixtureContinuationSettled === true);
    assert.equal(app.calls.filter(call => call.path === "/api/access/command" && call.body.action === "microsoft-connect").length, 0,
        "A retired Connect continuation must not dispatch under a replacement private publication.");
    assert.equal(connections, 0);
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    await expect(page.locator("#wireMicrosoftAction")).toBeEnabled();
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    assert.equal(connections, 1, "A new explicit Connect gesture remains usable.");
    assert.equal(app.calls.filter(call => call.path.endsWith("/enroll")).length, 1);
    assert.equal(app.calls.filter(call => call.path === "/api/access/command" && call.body.action === "microsoft-connect").length, 1);
});

test("one explicit Connect intent prepares internally, signs in once and leaves collection permission in the same Settings group", { timeout: 45000 }, async t => {
    let connections = 0;
    const app = await setup(t, { sourceAware: true, qualified: false, connect: async () => { connections++; } });
    const page = await app.panel(page => enrollmentRoutes(page, app));
    await expect(page.locator("#wireMicrosoftConnection input")).toHaveCount(0);
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    await expect(page.locator("#wireMicrosoftAction")).toBeHidden();
    await expect(page.locator("#wireMicrosoftPrepare")).toBeEnabled();
    await expect(page.locator("#wireMicrosoftPrepare")).toHaveText("Connect Microsoft 365");
    await expect(page.locator("#wireMicrosoftEnrollmentHelp")).toHaveCount(0);
    await expect(page.locator("#wireMicrosoftEnrollment > p:visible")).toHaveCount(0);
    await expect(page.locator("#connectionApproval, #settingsStoredHelp")).toHaveCount(0);
    await expect(page.locator("#wireMicrosoftConnection")).not.toContainText("browser profile");
    await expect(page.locator("#sourceMicrosoftCollection")).toBeHidden();
    assert.equal(app.calls.some(call => call.path.endsWith("/enroll")), false);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const width of [1440, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.locator("#wireMicrosoftPrepare").scrollIntoViewIfNeeded();
            await capture(page, `ordinary-enrollment-${theme}-${width}`);
        }
    }
    await page.locator("#wireMicrosoftPrepare").press("Enter");
    await expect(page.locator("#wireMicrosoftEnrollment")).toBeHidden();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(page.locator("#sourceMicrosoftCollection")).toBeVisible();
    await expect(page.locator("#wireMicrosoftConnection #sourceMicrosoftCollection")).toHaveCount(1);
    await expect(page.locator("#sourceMicrosoftTitle")).toHaveText("Activity to save");
    await expect(page.locator("#saveMicrosoftCollection")).toHaveText("Enable collection");
    await expect(page.locator("#saveMicrosoftCollection")).toBeEnabled();
    await expect(page.locator("#sourceMicrosoftHelp")).toHaveText("Save prompts, replies and tool activity locally. Microsoft may cache activity during sign-in.");
    await expect(page.locator("#wireMicrosoftAccount")).toBeHidden();
    await page.locator("#saveMicrosoftCollection").hover();
    await expect(page.locator('[role="tooltip"]:visible')).toHaveCount(0);
    assert.equal(connections, 1);
    const commands = app.calls.filter(call => call.path.endsWith("/enroll"));
    assert.equal(commands.length, 1);
    assert.deepEqual(Object.keys(commands[0].body).sort(), ["generation", "operationId", "schemaVersion"]);
    assert.equal(commands[0].body.schemaVersion, 2);
    const connectCommands = app.calls.filter(call => call.path === "/api/access/command");
    assert.equal(connectCommands.length, 1);
    assert.equal(connectCommands[0].body.action, "microsoft-connect");
    assert.equal(connectCommands[0].body.generation, commands[0].body.generation);
    assert.notEqual(connectCommands[0].body.operationId, commands[0].body.operationId);
    assert.equal(app.calls.some(call => /\/(?:configure|enabled|now)$/.test(call.path)), false);
    assert.equal((await loadBoardState(app.context)).nativeRetention, undefined);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.locator("#wireMicrosoftConnection").scrollIntoViewIfNeeded();
            await capture(page, `coherent-connected-${theme}-${width}`);
        }
    }
    await selectActivityOption(page, "sourceMicrosoftSurfaces", "cowork");
    await selectActivityOption(page, "sourceMicrosoftWindow", "14");
    await page.locator("#saveMicrosoftCollection").click();
    await expect.poll(() => app.calls.filter(call => call.path === "/api/collection/microsoft/configure").length).toBe(1);
    const enabled = app.calls.find(call => call.path === "/api/collection/microsoft/configure");
    assert.deepEqual(enabled.body.surfaces, ["cowork"]); assert.equal(enabled.body.windowDays, 14);
    await expect.poll(async () => (await loadBoardState(app.context)).nativeRetention?.settings.windowDays).toBe(14);
    assert.equal(app.calls.some(call => call.path.endsWith("/now")), false);
    await page.reload();
    await expect(page.locator("#sourceMicrosoftSurfaces")).toHaveValue("cowork");
    await expect(page.locator("#sourceMicrosoftWindow")).toHaveValue("14");
    await expect(page.locator("#saveMicrosoftCollection")).toHaveText("Save preferences");
    assert.equal(app.calls.filter(call => call.path === "/api/collection/microsoft/configure").length, 1);
    assert.deepEqual(app.host.publicCalls, []);
    t.diagnostic("Enrollment endpoints are contract fixtures; the actual source-aware runtime, transport and ordinary renderer are used. No enrollment writer or provider is invoked.");
});

test("a failed Microsoft profile read clears only Settings identity and retries independently of the GitHub footer", { timeout: 30000 }, async t => {
    const email = "riley.rivera@operations.example.invalid";
    const app = await setup(t, { sourceAware: true, qualified: true, connect: async () => {}, observedUPN: email });
    const page = await app.panel(page => enrollmentRoutes(page, app));
    await page.locator("#wireMicrosoftPrepare").click();
    await expect(page.locator("#wireMicrosoftAccount")).toHaveText(email);
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(page.locator("#wireAccountTrigger img")).toBeVisible();
    const heldEmail = await page.locator("#wireMicrosoftAccount").evaluateHandle(node => node.firstChild);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await page.locator("#wireMicrosoftAccount").scrollIntoViewIfNeeded();
        await capture(page, `microsoft-connection-email-${theme}-narrow-200`);
        const bounds = await page.locator("#wireMicrosoftAccount").boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.route("**/api/profile/microsoft", route => route.fulfill({ status: 503, json: { error: "Invented profile failure." } }));
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await expect(page.locator("#wireMicrosoftProfileError")).toContainText("Work account details could not be read.");
    await expect(page.locator("#wireAccountProfileRetry")).toBeHidden();
    await expect(page.locator("#wireMicrosoftAccount")).toBeHidden();
    assert.equal(await heldEmail.evaluate(node => node.data), "");
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(page.locator("#wireAccountTrigger")).not.toContainText(email);
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(page.locator("#wireAccountTrigger img")).toBeVisible();
    const githubReads = app.calls.filter(call => call.path === "/api/profile/github").length;
    await capture(page, "microsoft-profile-error-independent-footer");
    await page.unroute("**/api/profile/microsoft");
    await page.locator("#wireMicrosoftProfileRetry").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#wireMicrosoftAccount")).toHaveText(email);
    await expect(page.locator("#wireMicrosoftProfileError")).toBeHidden();
    assert.equal(await heldEmail.evaluate(node => node.data), "");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 1);
    assert.equal(app.calls.filter(call => call.path === "/api/profile/github").length, githubReads);
    assert.equal(app.host.publicCalls.length, 2, "Only the synthetic GitHub name and image were requested.");
});

test("lost enrollment response reads current setup without replay or claiming the original result", { timeout: 30000 }, async t => {
    let connections = 0;
    const app = await setup(t, { sourceAware: true, qualified: false, connect: async () => { connections++; } });
    const page = await app.panel(page => enrollmentRoutes(page, app, { prepare: route => route.abort("failed") }));
    await page.locator("#wireMicrosoftPrepare").click();
    await expect(page.locator("#wireMicrosoftEnrollmentMessage")).toContainText("unconfirmed");
    await expect(page.locator("#wireMicrosoftPrepare")).toBeDisabled();
    await page.locator("#wireMicrosoftEnrollmentRead").click();
    await expect(page.locator("#wireMicrosoftEnrollmentMessage")).toHaveText("Earlier request unconfirmed.");
    await expect(page.locator("#wireMicrosoftEnrollmentRead")).toBeHidden();
    await expect(page.locator("#wireMicrosoftConnection input")).toHaveCount(0);
    assert.equal(app.calls.filter(call => call.path.endsWith("/enroll")).length, 1);
    assert.equal(connections, 0, "A status-only prepared result never continues the original Connect intent.");
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    await capture(page, "ordinary-enrollment-unknown-before-signin");
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    assert.equal(connections, 1);
    assert.equal(app.calls.filter(call => call.path.endsWith("/enroll")).length, 1);
    await expect(page.locator("#wireMicrosoftEnrollmentMessage")).toHaveText("Earlier request unconfirmed.");
    await expect(page.locator("#wireMicrosoftConnection")).not.toContainText("Sign-in has not started");
    await capture(page, "ordinary-enrollment-unknown");
});

test("enrollment pending, rejected reads and logout retire preparation without stale completion or automatic replay", { timeout: 45000 }, async t => {
    const app = await setup(t, { sourceAware: true, qualified: false }), held = Promise.withResolvers();
    let rejectRead = true;
    t.after(() => held.resolve());
    const page = await app.panel(page => enrollmentRoutes(page, app, {
        read: (route, value, reply) => rejectRead ? route.fulfill({ status: 503, json: { error: "PRIVATE ERROR" } }) : reply(route, value),
        prepare: async (route, value, reply) => { await held.promise; return reply(route, value); },
    }));
    await expect(page.locator("#wireMicrosoftEnrollmentMessage")).toContainText("could not be read");
    assert.doesNotMatch(await page.locator("#wireMicrosoftEnrollment").textContent(), /PRIVATE ERROR/);
    rejectRead = false;
    await page.locator("#wireMicrosoftEnrollmentRead").click();
    await page.locator("#wireMicrosoftPrepare").click();
    await expect(page.locator("#wireMicrosoftPrepare")).toHaveText("Connecting...");
    await expect(page.locator("#wireMicrosoftPrepare")).toBeDisabled();
    await gate(page, "Sign out of this instance");
    await expect(page.locator("#wireMicrosoftConnection")).toBeHidden();
    held.resolve();
    await gate(page, "Sign in to WIRE");
    await expect(page.locator("#wireMicrosoftEnrollmentMessage")).toContainText("unconfirmed");
    assert.equal(app.calls.filter(call => call.path.endsWith("/enroll")).length, 1);
    await expect(page.locator("#wireMicrosoftConnection input")).toHaveCount(0);
});

test("the GitHub footer and Microsoft Settings identity stay distinct through Connect, Pause, logout and reload", { timeout: 45000 }, async t => {
    const app = await setup(t, { sourceAware: true, qualified: true, connect: async () => {}, observedUPN: "Expected@Example.Invalid" });
    const first = await app.panel(page => enrollmentRoutes(page, app));
    await expect(first.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(first.locator("#wireAccountTrigger img")).toBeVisible();
    await first.locator("#wireMicrosoftPrepare").click();
    await expect(first.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(first.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(first.locator("#wireAccountTrigger")).not.toContainText("Expected@Example.Invalid");
    await expect(first.locator("#wireMicrosoftAccount")).toHaveText("Expected@Example.Invalid");
    const second = await app.panel(page => enrollmentRoutes(page, app, { initialPrepared: true }));
    await expect(second.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(second.locator("#wireMicrosoftAccount")).toHaveText("Expected@Example.Invalid");
    await expect(second.locator("#wireAccountTrigger")).not.toContainText("Microsoft 365");
    await expect(second.locator("#saveMicrosoftCollection")).toBeEnabled();
    assert.equal(app.calls.some(call => call.path === "/api/profile/github"), true);
    assert.equal(app.host.publicCalls.length, 2);
    assert.doesNotMatch(JSON.stringify(await loadBoardState(app.context)), /expected@example\.invalid/i);
    await second.locator("#saveMicrosoftCollection").click();
    await expect(second.locator("#pauseMicrosoftCollection")).toBeEnabled();
    await second.locator("#pauseMicrosoftCollection").click();
    await expect(second.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    const savedCollection = (await loadBoardState(app.context)).nativeRetention;
    await expect(second.locator("#sourceMicrosoftHelp")).toBeHidden();
    await expect(second.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(second.locator("#wireMicrosoftAccount")).toHaveText("Expected@Example.Invalid");
    await expect(second.locator("#settingsConnectionError")).toBeHidden();
    await second.locator("#wireAccountTrigger").click();
    await expect(second.locator("#wireAccountProfileMessage")).toBeHidden();
    await expect(second.locator("#wireAccountMenu > p:visible")).toHaveCount(1);
    await expect(second.locator("#wireAccountTrigger img")).toBeVisible();
    await capture(second, "distinct-github-and-microsoft-identities");
    await second.keyboard.press("Escape");
    await chooseTheme(second, "dark");
    await second.setViewportSize({ width: 390, height: 1000 });
    await second.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await second.locator("#navigationToggle").click();
    await second.locator("#wireAccountTrigger").click();
    await capture(second, "distinct-identities-dark-narrow-200");
    const menu = await second.locator("#wireAccountMenu").boundingBox();
    assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= 390 && menu.y + menu.height <= 1000);
    await second.keyboard.press("Escape");
    await expect(second.locator("#wireAccountTrigger")).toBeFocused();
    await second.keyboard.press("Escape");
    await second.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await second.setViewportSize({ width: 1440, height: 1000 });
    await second.evaluate(() => {
        window.heldGitHubLogin = document.querySelector("#wireAccountMenu .wire-account-identity small").firstChild;
        window.heldGitHubImage = document.querySelector("#wireAccountTrigger img").getAttributeNode("src");
        window.heldConnectionEmail = document.getElementById("wireMicrosoftAccount").firstChild;
    });
    await gate(first, "Sign out of this instance");
    await expect(second.locator("#message")).toContainText("signed out");
    assert.equal(await second.evaluate(() => heldGitHubLogin.data), "");
    assert.equal(await second.evaluate(() => heldGitHubImage.value), "");
    assert.equal(await second.evaluate(() => heldConnectionEmail.data), "");
    await expect(second.locator("#wireMicrosoftAccount")).toBeHidden();
    assert.doesNotMatch(await second.locator("body").innerText(), /Expected@Example\.Invalid/);
    await second.reload();
    await expect(second.locator("#message")).toContainText("signed out");
    await gate(first, "Sign in to WIRE");
    await expect(second.locator("#workspace")).toBeVisible();
    await expect(second.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(second.locator("#wireAccountTrigger")).not.toContainText("Expected@Example.Invalid");
    await expect(second.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(second.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    await expect(second.locator("#wireMicrosoftAccount")).toBeHidden();
    await expect(second.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    await expect(second.locator("#wireMicrosoftAction")).toBeEnabled();
    await expect(second.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention, savedCollection);
    const returnedAccess = await app.lifecycle.status();
    assert.equal(returnedAccess.wire, "signed-in");
    assert.equal(returnedAccess.microsoft.state, "reconnect-required");
    assert.equal(returnedAccess.microsoft.reason, "signed-out",
        "The current producer retains why Microsoft disconnected, not a current local sign-in requirement.");
    await capture(second, "wire-login-with-microsoft-disconnected");
    await expect(second.locator("#wireMicrosoftConnection")).not.toContainText("Sign in to WIRE to continue.");
    await expect(second.locator("#wireMicrosoftConnection .wire-connection-effect")).toBeHidden();
    await second.reload();
    await expect(second.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    await expect(second.locator("#wireMicrosoftAction")).toBeEnabled();
    await expect(second.locator("#wireMicrosoftConnection .wire-connection-effect")).toBeHidden();
    await expect(second.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention, savedCollection);
    await chooseTheme(second, "light");
    await capture(second, "wire-login-with-microsoft-disconnected-light");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command" && call.body.action === "microsoft-connect").length, 1);
});

test("a verified Microsoft connection never supplies footer identity when the Copilot host is unbound", { timeout: 30000 }, async t => {
    const email = "work-only@example.invalid";
    const app = await setup(t, { sourceAware: true, qualified: false, connect: async () => {}, observedUPN: email });
    const page = await app.panel(page => enrollmentRoutes(page, app));
    await page.locator("#wireMicrosoftPrepare").click();
    await expect(page.locator("#wireMicrosoftAccount")).toHaveText(email);
    await expect(page.locator("#wireAccountTrigger")).toContainText("Account");
    await expect(page.locator("#wireAccountTrigger")).not.toContainText(email);
    await expect(page.locator("#wireAccountTrigger img")).toHaveCount(0);
    await expect(page.locator("#wireAccountTrigger [data-lucide-icon='user-round']")).toBeVisible();
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountMenu")).not.toContainText(email);
    await expect(page.locator("#wireAccountGate")).toBeEnabled();
    assert.equal(app.host.calls, 0); assert.deepEqual(app.host.publicCalls, []);
    await capture(page, "unbound-github-connected-microsoft");
});

test("profile receivers reject swapped providers without replacing the other account presentation", { timeout: 30000 }, async t => {
    const app = await setup(t, { sourceAware: true, connect: async () => {}, observedUPN: "settings-only@example.invalid" });
    let github, microsoft;
    const page = await app.panel(async page => {
        await enrollmentRoutes(page, app);
        for (const provider of ["github", "microsoft"]) await page.route(`**/api/profile/${provider}`, async route => {
            const response = await route.fetch(), profile = await response.json();
            if (provider === "github") github = profile;
            else microsoft = profile;
            return route.fulfill({ response });
        });
    });
    await page.locator("#wireMicrosoftPrepare").click();
    await expect(page.locator("#wireMicrosoftAccount")).toHaveText("settings-only@example.invalid");
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await page.unroute("**/api/profile/github");
    await page.route("**/api/profile/github", async route => {
        const response = await route.fetch();
        return route.fulfill({ response, json: microsoft });
    });
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountProfileRetry")).toBeVisible();
    await expect(page.locator("#wireAccountTrigger")).not.toContainText("settings-only");
    await expect(page.locator("#wireAccountTrigger img")).toHaveCount(0);
    await expect(page.locator("#wireMicrosoftAccount")).toHaveText("settings-only@example.invalid");
    await page.keyboard.press("Escape");
    await page.unroute("**/api/profile/github");
    await page.unroute("**/api/profile/microsoft");
    await page.route("**/api/profile/microsoft", async route => {
        const response = await route.fetch();
        return route.fulfill({ response, json: github });
    });
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(page.locator("#wireMicrosoftAccount")).toBeHidden();
    await expect(page.locator("#wireMicrosoftProfileError")).toBeVisible();
    await expect(page.locator("#wireMicrosoftConnection")).not.toContainText("Riley Chen");
});

test("Microsoft presentation expiry clears its captured email without clearing the GitHub footer", { timeout: 30000 }, async t => {
    const app = await setup(t, { sourceAware: true, connect: async () => {}, observedUPN: "leased@example.invalid" });
    let shorten = false;
    const page = await app.panel(async page => {
        await enrollmentRoutes(page, app);
        await page.route("**/api/profile/microsoft", async route => {
            const response = await route.fetch(), profile = await response.json();
            if (shorten && profile.identity.state === "verified") {
                profile.identity.checkedAt = Date.now();
                profile.identity.expiresAt = Date.now() + 2000;
            }
            return route.fulfill({ response, json: profile });
        });
    });
    await page.locator("#wireMicrosoftPrepare").click();
    await expect(page.locator("#wireMicrosoftAccount")).toHaveText("leased@example.invalid");
    shorten = true;
    const reread = page.waitForResponse(response => new URL(response.url()).pathname === "/api/profile/microsoft");
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await reread;
    await expect(page.locator("#wireMicrosoftAccount")).toHaveText("leased@example.invalid");
    const heldEmail = await page.locator("#wireMicrosoftAccount").evaluateHandle(node => node.firstChild);
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.unroute("**/api/profile/microsoft");
    await page.route("**/api/profile/microsoft", async route => {
        const response = await route.fetch();
        pending.resolve(); await release.promise;
        return route.fulfill({ response });
    });
    await pending.promise;
    await expect(page.locator("#wireMicrosoftAccount")).toBeHidden();
    assert.equal(await heldEmail.evaluate(node => node.data), "");
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await gate(page, "Sign out of this instance");
    release.resolve();
    await expect(page.locator("#message")).toContainText("signed out");
    await expect(page.locator("#wireMicrosoftAccount")).toBeHidden();
    assert.equal(await heldEmail.evaluate(node => node.data), "");
    assert.doesNotMatch(await page.locator("body").innerText(), /leased@example\.invalid|Riley Chen/);
});

for (const outcome of ["completed", "failed", "unavailable", "mismatched", "direct-completed"]) test(`ordinary Connect return reads its original ${outcome} result without another sign-in`, { timeout: 30000 }, async t => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    const successful = outcome === "completed" || outcome === "direct-completed";
    let connects = 0, original;
    const app = await setup(t, { sourceAware: true, qualified: false, connect: async () => {
        connects++;
        entered.resolve();
        await finish.promise;
        if (!successful) throw new MicrosoftSessionError("transport-failed");
    } });
    t.after(() => finish.resolve());
    const page = await app.panel(page => enrollmentRoutes(page, app));
    if (outcome !== "direct-completed") await page.route("**/api/access/command", async route => {
        if (route.request().postDataJSON().action !== "microsoft-connect") return route.continue();
        original = route.request().postDataJSON();
        const response = await route.fetch();
        assert.equal((await response.json()).outcome, outcome === "completed" ? "completed" : "failed");
        await response.dispose();
        await route.abort("failed");
    });
    if (outcome === "unavailable") await page.route("**/api/access/receipt", route => route.fulfill({ json: null }));
    if (outcome === "mismatched") await page.route("**/api/access/receipt", async route => {
        const response = await route.fetch(), receipt = await response.json();
        await route.fulfill({ response, json: { ...receipt, operationId: randomUUID() } });
    });
    await page.locator("#wireMicrosoftPrepare").click();
    await entered.promise;
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Cancel sign-in");
    finish.resolve();
    const status = page.locator("#wireMicrosoftStatus"), action = page.locator("#wireMicrosoftAction");
    if (successful) {
        await expect(status).toHaveText("Connected");
        await expect(action).toHaveText("Reconnect Microsoft 365");
        await expect(page.locator("#wireMicrosoftConnection")).not.toContainText("unconfirmed");
    } else if (outcome === "failed") {
        await expect(status).toHaveText("Not connected");
        await expect(page.locator("#wireMicrosoftConnection")).toContainText("Microsoft could not connect.");
        await expect(action).toHaveText("Connect Microsoft 365");
    } else {
        await expect(action).toHaveText("Check connection result");
        await expect(page.locator("#wireMicrosoftConnection")).toContainText("Connection result unconfirmed.");
    }
    const expectedReads = outcome === "direct-completed" ? 0 : 1;
    await expect.poll(() => app.calls.filter(call => call.path === "/api/access/receipt").length).toBe(expectedReads);
    const calls = app.calls.filter(call => call.path === "/api/access/receipt");
    assert.deepEqual(calls.map(call => call.body), expectedReads ? [{ schemaVersion: 1, operationId: original.operationId }] : []);
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    assert.equal(app.calls.filter(call => call.path === "/api/access/receipt").length, expectedReads, "Unchanged heartbeats do not poll the receipt.");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 1);
    assert.equal(connects, 1);
    assert.equal(app.calls.some(call => /\/(?:configure|enabled|now)$/.test(call.path)), false);
    assert.equal((await app.lifecycle.status()).collection, "paused");
    if (successful) {
        await expect(page.locator("#saveMicrosoftCollection")).toBeEnabled();
        await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Not enabled");
        await expect(page.locator("#settingsConnectionError")).toBeHidden();
    }
    t.diagnostic(JSON.stringify({ outcome, originalReceiptReads: calls.length,
        settingsReadError: await page.locator("#settingsConnectionError").isVisible() }));
    await capture(page, `connect-return-${outcome}`);
    if (outcome === "failed") {
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await chooseTheme(page, "dark");
        await page.locator("#wireMicrosoftConnection").scrollIntoViewIfNeeded();
        await capture(page, "connect-return-failed-dark-narrow");
    }
});

for (const failedRead of [false, true]) test(`first connected Microsoft account ${failedRead ? "keeps a failed current read explicit" : "opens usable Settings before any collection is enabled"}`, { timeout: 30000 }, async t => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    const oldRead = Promise.withResolvers(), releaseRead = Promise.withResolvers();
    let signingIn = false, held = false, originalGeneration, signInWatchObserved = false;
    const app = await setup(t, { sourceAware: true, qualified: false, observedUPN: "Expected@Example.Invalid",
        connect: async () => { signingIn = true; entered.resolve(); await finish.promise; } });
    t.after(() => { finish.resolve(); releaseRead.resolve(); });
    const page = await app.panel(async page => {
        await enrollmentRoutes(page, app);
        await page.route("**/api/access/watch", async route => {
            if (signInWatchObserved) return route.continue();
            const response = await route.fetch(), status = await response.json();
            if (status.microsoft?.state === "signing-in") { signInWatchObserved = true; await entered.promise; }
            await route.fulfill({ response });
        });
        await page.route("**/api/snapshot", async route => {
            if (!signingIn) return route.continue();
            if (held) return failedRead ? route.fulfill({ status: 503, json: { error: "Synthetic current snapshot failure." } })
                : route.continue();
            held = true;
            const response = await route.fetch(), snapshot = await response.json();
            assert.equal(response.status(), 200);
            assert.equal(snapshot.nativeRead.reason, "microsoft-account-not-configured");
            originalGeneration = snapshot.nativeRead.generation;
            oldRead.resolve();
            await releaseRead.promise;
            await route.fulfill({ response });
        });
    });
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#wireMicrosoftPrepare").click();
    await entered.promise;
    await oldRead.promise;
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Cancel sign-in");
    finish.resolve();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    releaseRead.resolve();
    if (failedRead) {
        await expect(page.locator("#message")).toContainText("Synthetic current snapshot failure.");
        await expect(page.locator("#saveMicrosoftCollection")).toBeDisabled();
        await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Status unavailable");
    } else {
        await expect(page.locator("#saveMicrosoftCollection")).toBeEnabled();
        await expect(page.locator("#saveMicrosoftCollection")).toHaveText("Enable collection");
        await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Not enabled");
        await expect(page.locator("#settingsConnectionError")).toBeHidden();
        await expect(page.locator("#message")).toBeHidden();
        await expect(page.locator("#sourceMicrosoftHelp")).toHaveText("Save prompts, replies and tool activity locally. Microsoft may cache activity during sign-in.");
    }
    const lifecycle = await app.lifecycle.status();
    assert.equal(lifecycle.collection, "paused");
    assert.equal(lifecycle.generation, originalGeneration, "First account readiness changes within the existing generation.");
    const state = await loadBoardState(app.context);
    assert.equal(state.nativeRetention, undefined);
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 1);
    assert.equal(app.calls.some(call => /\/(?:configure|enabled|now)$/.test(call.path)), false);
    const snapshots = app.calls.filter(call => call.path === "/api/snapshot").length;
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    assert.equal(app.calls.filter(call => call.path === "/api/snapshot").length, snapshots,
        "Unchanged access heartbeats do not retry snapshot reads.");
    await capture(page, failedRead ? "connect-first-read-failed" : "connect-first-usable-settings");
});

test("first-account readiness waits for the actual source draft and reads after cancellation", { timeout: 30000 }, async t => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    let signInWatchObserved = false;
    const app = await setup(t, { sourceAware: true, qualified: false,
        connect: async () => { entered.resolve(); await finish.promise; } });
    t.after(() => finish.resolve());
    const page = await app.panel(async page => {
        await enrollmentRoutes(page, app);
        await page.route("**/api/access/watch", async route => {
            if (signInWatchObserved) return route.continue();
            const response = await route.fetch(), status = await response.json();
            if (status.microsoft?.state === "signing-in") { signInWatchObserved = true; await entered.promise; }
            await route.fulfill({ response });
        });
    });
    await page.locator("#wireMicrosoftPrepare").click();
    await entered.promise;
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Cancel sign-in");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#reviewSource").click();
    const draftPath = "C:\\synthetic-held-source\\data.db";
    await page.locator("#sourceDatabase").fill(draftPath);
    const snapshots = app.calls.filter(call => call.path === "/api/snapshot").length;
    finish.resolve();
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Reconnect Microsoft 365");
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    await expect(page.locator("#sourceDatabase")).toHaveValue(draftPath);
    assert.equal(app.calls.filter(call => call.path === "/api/snapshot").length, snapshots,
        "The actual source draft holds the first-account read.");
    await page.locator("#cancelSource").click();
    await expect.poll(() => app.calls.filter(call => call.path === "/api/snapshot").length).toBe(snapshots + 1);
    await expect(page.locator("#saveMicrosoftCollection")).toBeEnabled();
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Not enabled");
    await expect(page.locator("#settingsConnectionError")).toBeHidden();
    await expect(page.locator("#sourceEditor")).toBeHidden();
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    assert.equal(app.calls.filter(call => call.path === "/api/snapshot").length, snapshots + 1,
        "Released readiness is consumed by one current read.");
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 1);
    assert.equal(app.calls.some(call => /\/(?:configure|enabled|now)$/.test(call.path)), false);
});

test("ordinary Connect watch completes a lost-response return only from the original later receipt", { timeout: 30000 }, async t => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers(), responseDone = Promise.withResolvers();
    const app = await setup(t, { sourceAware: true, qualified: false, connect: async () => {
        entered.resolve();
        await finish.promise;
        throw new MicrosoftSessionError("transport-failed");
    } });
    t.after(() => finish.resolve());
    const page = await app.panel(page => enrollmentRoutes(page, app));
    await page.route("**/api/access/command", async route => {
        if (route.request().postDataJSON().action !== "microsoft-connect") return route.continue();
        const response = route.fetch();
        await entered.promise;
        await route.abort("failed");
        try { await (await response).dispose(); }
        finally { responseDone.resolve(); }
    });
    await page.locator("#wireMicrosoftPrepare").click();
    await entered.promise;
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    await page.waitForResponse(response => response.url().endsWith("/api/access/watch"));
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Waiting for Microsoft sign-in");
    await expect(page.locator("#wireMicrosoftConnection .wire-connection-effect")).toHaveText("Continue in the Microsoft sign-in window.");
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Cancel sign-in");
    assert.equal(app.calls.filter(call => call.path === "/api/access/receipt").length, 0);
    finish.resolve();
    await responseDone.promise;
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    await expect(page.locator("#wireMicrosoftConnection")).toContainText("Microsoft could not connect.");
    const commands = app.calls.filter(call => call.path === "/api/access/command");
    assert.equal(commands.length, 1);
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/receipt").map(call => call.body),
        [{ schemaVersion: 1, operationId: commands[0].body.operationId }]);
});

for (const boundary of ["withdrawal", "owner-replacement"]) test(`automatic Connect result cannot cross ${boundary}`, { timeout: 30000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), settled = Promise.withResolvers();
    t.after(() => release.resolve());
    const app = await setup(t, { sourceAware: true, qualified: false, connect: async () => {
        throw new MicrosoftSessionError("transport-failed");
    } });
    const page = await app.panel(async page => {
        await page.route(url => url.pathname === "/", async route => {
            const response = await route.fetch(), html = await response.text(), transport = createBoardTransport.toString();
            assert.equal(html.split(transport).length, 2);
            await route.fulfill({ response, body: html.replace(transport,
                () => transport.replace("return api;", "window.fixtureAccountApi = api; return api;")) });
        });
        await enrollmentRoutes(page, app);
    });
    await page.route("**/api/access/command", async route => {
        if (route.request().postDataJSON().action !== "microsoft-connect") return route.continue();
        await (await route.fetch()).dispose();
        await route.abort("failed");
    });
    await page.route("**/api/access/receipt", async route => {
        const response = await route.fetch();
        entered.resolve();
        await release.promise;
        await route.fulfill({ response });
        settled.resolve();
    }, { times: 1 });
    await page.locator("#wireMicrosoftPrepare").click();
    await entered.promise;
    await page.evaluate(() => {
        window.connectResultOwner = fixtureAccountApi.controlToken();
        window.connectResultPublication = fixtureAccountApi.publicationToken();
    });
    if (boundary === "withdrawal") {
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        await expect(page.locator("#wireMicrosoftConnection")).not.toBeVisible();
    } else {
        await page.route("**/api/access/status", route => route.fulfill({ status: 403,
            json: { code: "session_expired", error: "Synthetic owner replacement." } }), { times: 1 });
        await page.evaluate(() => fixtureAccountApi("/api/access/status").catch(() => null));
        await expect.poll(() => page.evaluate(() => fixtureAccountApi.isControlCurrent(connectResultOwner))).toBe(false);
    }
    release.resolve();
    await settled.promise;
    if (boundary === "withdrawal") {
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
        await expect.poll(() => page.evaluate(() => fixtureAccountApi.publicationToken() !== null
            && fixtureAccountApi.publicationToken() !== connectResultPublication)).toBe(true);
        assert.equal(await page.evaluate(() => fixtureAccountApi.isControlCurrent(connectResultOwner)), true);
        await expect(page.locator("#wireMicrosoftAction")).toHaveText("Check connection result");
        await page.locator("#wireMicrosoftAction").click();
        await expect(page.locator("#wireMicrosoftConnection")).toContainText("Microsoft could not connect.");
    } else {
        await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connection result unavailable");
        await expect(page.locator("#wireMicrosoftAction")).toBeDisabled();
        await page.locator("#wireMicrosoftAction").dispatchEvent("click");
    }
    assert.equal(app.calls.filter(call => call.path === "/api/access/receipt").length, boundary === "withdrawal" ? 2 : 1);
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 1);
});

test("the combined Connect flow keeps Cancel and original-receipt recovery without repeating either command", { timeout: 45000 }, async t => {
    const entered = Promise.withResolvers();
    const app = await setup(t, { sourceAware: true, qualified: false, connect: ({ signal }) => new Promise((resolve, reject) => {
        entered.resolve();
        signal.addEventListener("abort", () => reject(new MicrosoftSessionError("cancelled")), { once: true });
    }) });
    const page = await app.panel(page => enrollmentRoutes(page, app));
    await page.route("**/api/access/command", async route => {
        if (route.request().postDataJSON().action !== "microsoft-connect") return route.continue();
        await route.fetch(); return route.abort("failed");
    });
    await page.locator("#wireMicrosoftPrepare").press("Enter");
    await entered.promise;
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Cancel sign-in");
    await expect(page.locator("#wireMicrosoftAction")).toBeEnabled();
    await expect(page.locator("#wireMicrosoftConnection .wire-connection-effect")).toHaveText("Continue in the Microsoft sign-in window.");
    await capture(page, "connect-pending-cancel");
    await expect(page.locator("#wireMicrosoftEnrollment")).toBeHidden();
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Check connection result");
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    assert.equal(app.calls.filter(call => call.path.endsWith("/enroll")).length, 1);
    const commands = app.calls.filter(call => call.path === "/api/access/command");
    assert.deepEqual(commands.map(call => call.body.action), ["microsoft-connect", "microsoft-cancel"]);
    const receiptReads = app.calls.filter(call => call.path === "/api/access/receipt");
    assert.ok(receiptReads.some(call => call.body.operationId === commands[0].body.operationId));
    assert.equal(app.calls.some(call => /\/(?:configure|enabled|now)$/.test(call.path)), false);
});
