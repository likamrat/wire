import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderAccountSettingsFixture, presentationFixture, verifiedGitHubProfile } from "./account-settings-presentation-fixture.mjs";
import { chooseTheme, selectActivityOption } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WIRE_ACCOUNT_PRESENTATION_PROOFS;
const receive = (page, snapshot) => page.evaluate(snapshot => window.fixtureReceive(snapshot), snapshot);
async function capture(page, name) {
    const measured = await page.evaluate(() => {
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
        canvas.width = canvas.height = 1;
        const rgba = color => {
            context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value);
        };
        const blend = (a, b) => a.slice(0, 3).map((value, index) => value * a[3] + b[index] * (1 - a[3]));
        function ground(node) {
            if (!node) return [255, 255, 255];
            const style = getComputedStyle(node), face = getComputedStyle(node, "::before");
            let result = blend(rgba(style.backgroundColor), ground(node.parentElement));
            if (face.content !== "none" && face.zIndex === "-1") result = blend(rgba(face.backgroundColor), result);
            return result;
        }
        const text = [...document.querySelectorAll("#wireAccountTrigger *,#wireAccountMenu *,#wireMicrosoftConnection *")]
            .filter(node => node.checkVisibility() && [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()))
            .map(node => {
                const background = ground(node), foreground = blend(rgba(getComputedStyle(node).color), background);
                return { text: node.textContent, foreground: `rgb(${foreground.join(",")})`, background: `rgb(${background.join(",")})` };
            });
        const targets = [...document.querySelectorAll("#wireAccountTrigger,#wireAccountMenu button,#wireMicrosoftAction")]
            .filter(node => node.checkVisibility()).map(node => ({ id: node.id, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
        return { text, targets, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    assert.ok(measured.overflow <= 1, name + ": page overflow");
    for (const target of measured.targets) assert.ok(target.width >= 44 && target.height >= 44, name + ": target " + target.id);
    for (const pair of measured.text) assert.ok(contrast(pair.foreground, pair.background) >= 4.5, name + ": low contrast " + pair.text);
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: false });
}

async function setup(t, options = {}) {
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ...options });
    const errors = [], external = [], warnings = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
    await page.route("https://wire.example.invalid/**", route => {
        if (new URL(route.request().url()).pathname === "/") return route.fulfill({
            contentType: "text/html", body: renderAccountSettingsFixture(),
        });
        external.push(route.request().url());
        return route.abort();
    });
    await page.route(url => url.hostname !== "wire.example.invalid", route => {
        external.push(route.request().url());
        return route.abort();
    });
    t.after(async () => {
        await browser.close();
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
    });
    await page.goto("https://wire.example.invalid/");
    await expect(page.locator("body")).toHaveAttribute("data-account-fixture-ready", "true");
    return { page, errors, external, warnings };
}

test("unqualified real-shell presentation is neutral and all account operations are unavailable", async t => {
    const { page } = await setup(t);
    await expect(page.locator("#wireAccountTrigger .wire-account-copy>span")).toHaveText("Account");
    await expect(page.locator("#wireAccountTrigger")).toContainText("Signed in");
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Unavailable");
    await expect(page.locator("#wireMicrosoftAction")).toBeDisabled();
    await expect(page.locator("#connectionSourceTitle")).toHaveText("GitHub Copilot app");
    await expect(page.locator("#connectionSource").getByText("GitHub Copilot app", { exact: true })).toHaveCount(1);
    await expect(page.locator("#connectionSource > .settings-help:visible")).toHaveCount(0);
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toBeDisabled();
    await expect(page.locator("#wireAccountMenu button")).toHaveCount(1);
    await capture(page, "unavailable-real-shell");
    await expect(page.locator("#workspace")).toBeVisible();
    assert.equal(await page.locator("#wireAccountEntry").evaluate(node => node.parentElement.id),
        process.env.WIRE_ACCOUNT_RENDERER_PIN ? "navigationContent" : "navigationFooter");
    assert.equal(await page.locator("#microsoftConnectionHost").evaluate(node => node.nextElementSibling.id), "connectionPreferences");
    if (process.env.WIRE_ACCOUNT_RENDERER_PIN) {
        await expect(page.locator("body")).toHaveAttribute("data-account-shell-source", process.env.WIRE_ACCOUNT_RENDERER_PIN);
        assert.equal(await page.locator("#wireAccountEntry").evaluate(node => node.previousElementSibling.id), "analyzeTools");
    }
    assert.deepEqual(await page.evaluate(() => window.fixtureWrites), []);
});

test("documented lifecycle fixtures cannot activate commands or replace Settings drafts", async t => {
    const { page } = await setup(t);
    await selectActivityOption(page, "collectionWindow", "7");
    await expect(page.locator("#saveCollection")).toBeEnabled();
    const draft = await page.locator("#collectionWindow").elementHandle();
    await receive(page, presentationFixture("disconnected", verifiedGitHubProfile));
    await expect(page.locator("#wireMicrosoftConnection")).not.toContainText("After sign-in");
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountMenu")).toBeFocused();
    for (const state of ["signing-in", "handoff", "connected", "reconnect-required", "unavailable", "recovery-required"]) {
        const snapshot = presentationFixture(state, verifiedGitHubProfile);
        snapshot.lifecycle.actions = ["wire-sign-out", "microsoft-connect", "microsoft-cancel", "microsoft-recover"];
        await receive(page, snapshot);
        await expect(page.locator("#wireMicrosoftStatus")).not.toContainText("(sample)");
        await expect(page.locator("#wireMicrosoftConnection")).not.toContainText("fixture");
        await expect(page.locator("#wireMicrosoftConnection")).not.toContainText("Synthetic");
        await expect(page.locator("#wireMicrosoftAction")).toBeDisabled();
        await expect(page.locator("#wireAccountGate")).toBeDisabled();
        await expect(page.locator("#wireAccountMenu")).toBeFocused();
        assert.equal(await draft.evaluate(node => node === document.getElementById("collectionWindow") && node.value === "7"), true);
        await expect(page.locator("#saveCollection")).toBeEnabled();
    }
    await page.keyboard.press("Escape");
    const paused = presentationFixture("connected", verifiedGitHubProfile);
    paused.lifecycle.collection = "paused";
    paused.lifecycle.microsoft.surfaces.cowork.access = "not-verified";
    await page.evaluate(() => fixtureCollection.receive({ configVersion: 2, connected: true, config: {
        approved: true, enabled: false, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\chats", windowDays: 30, pollSeconds: 15,
    } }, fixtureApi.publicationToken()));
    await receive(page, paused);
    await expect(page.locator(".wire-source-health")).toHaveCount(0);
    await expect(page.locator("#wireMicrosoftConnection")).not.toContainText("Collecting");
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(page.locator("#connectionStatus")).toHaveText("Paused");
    assert.equal(await draft.evaluate(node => node.value), "7");
    await capture(page, "light-paused-draft");
    await page.locator("#cancelPreferences").click();
    await page.locator("#editSource").click();
    await page.locator("#sourceDatabase").fill("C:\\synthetic\\edited.db");
    const sourceDraft = await page.locator("#sourceDatabase").elementHandle();
    await receive(page, presentationFixture("reconnect-required"));
    assert.equal(await sourceDraft.evaluate(node => node.value), "C:\\synthetic\\edited.db");
    assert.deepEqual(await page.evaluate(() => window.fixtureWrites), []);
});

test("GitHub loading, read failure and provider sign-out never become WIRE sign-out or Microsoft identity", async t => {
    const { page } = await setup(t);
    const snapshot = presentationFixture("connected");
    for (const phase of ["loading", "error", "unavailable"]) {
        snapshot.github = { phase, profile: null };
        await receive(page, snapshot);
        await expect(page.locator("#wireAccountTrigger .wire-account-copy>span")).toHaveText("Account");
        await expect(page.locator("#workspace")).toBeVisible();
    }
    const profile = structuredClone(verifiedGitHubProfile);
    profile.displayName = { value: null, source: "unavailable", freshness: "current" };
    snapshot.github = { phase: "ready", profile };
    await receive(page, snapshot);
    await expect(page.locator("#wireAccountTrigger")).toContainText("riley-chen");
    await expect(page.locator(".wire-account-trigger .wire-account-avatar")).toHaveText("R");
    profile.identity = { state: "signed-out", reason: "copilot-signed-out", host: null, login: null };
    profile.fallback = { kind: "neutral", text: null, source: "unavailable" };
    await receive(page, snapshot);
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toHaveText("Sign out of WIRE");
    await expect(page.locator("#wireAccountTrigger")).not.toContainText("riley");
    await expect(page.locator("#workspace")).toBeVisible();
    snapshot.lifecycle.wire = "signed-out";
    snapshot.lifecycle.authorization.retained = false;
    await receive(page, snapshot);
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toHaveText("Sign in to WIRE");
    await expect(page.locator("#wireAccountGate")).toBeDisabled();
    await expect(page.locator("#workspace")).toBeVisible();
    assert.equal(await page.locator("#connectionStatus").textContent(), "Collection on");
});

test("profile identity leases clear all old identity while ticket expiry preserves verified fallback", async t => {
    const { page } = await setup(t);
    await page.clock.install({ time: new Date("2026-10-20T10:00:00Z") });
    let requests = 0;
    await page.route("**/api/profile/github/avatar/*", route => {
        requests++;
        return route.fulfill({ contentType: "image/png",
            body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN3sAAAAASUVORK5CYII=", "base64") });
    });
    const now = await page.evaluate(() => Date.now());
    const profile = structuredClone(verifiedGitHubProfile);
    Object.assign(profile.identity, { generation: "fixture-lease", checkedAt: now, expiresAt: now + 15000 });
    profile.avatar = { state: "current", reason: null, url: "/api/profile/github/avatar/" + "1".repeat(64), expiresAt: now + 1000 };
    await receive(page, presentationFixture(null, profile));
    await expect(page.locator("#wireAccountTrigger img")).toBeVisible();
    const oldImage = await page.locator("#wireAccountTrigger img").elementHandle();
    await page.evaluate(() => { window.retiredImageSource = document.querySelector("#wireAccountTrigger img").getAttributeNode("src"); });
    await receive(page, presentationFixture("disconnected", profile));
    assert.equal(await oldImage.evaluate(image => image === document.querySelector("#wireAccountTrigger img")), true,
        "Unrelated lifecycle updates do not reload the same controlled image.");
    await page.clock.fastForward(1100);
    await expect(page.locator("#wireAccountTrigger img")).toHaveCount(0);
    assert.equal(await oldImage.getAttribute("src"), null, "Retired detached images do not retain their ticket URL.");
    assert.equal(await page.evaluate(() => retiredImageSource.value), "", "Held image attributes are scrubbed before removal.");
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    await expect(page.locator("#wireAccountTrigger .wire-account-avatar")).toHaveText("R");
    const afterTicketExpiry = requests;
    await page.clock.fastForward(1000);
    assert.equal(requests, afterTicketExpiry, "Ticket expiry does not retry images or acquire metadata.");
    profile.generation = "fixture-next";
    profile.identity.expiresAt = now + 4000;
    profile.displayName.value = "Next Fixture";
    profile.avatar.url = "/api/profile/github/avatar/" + "3".repeat(64);
    profile.avatar.expiresAt = now + 60000;
    await receive(page, presentationFixture(null, profile));
    await oldImage.evaluate(image => image.dispatchEvent(new Event("error")));
    await expect(page.locator("#wireAccountTrigger")).toContainText("Next Fixture");
    await page.clock.fastForward(2000);
    await expect(page.locator("#wireAccountTrigger img")).toHaveCount(0);
    await expect(page.locator("#wireAccountTrigger .wire-account-copy>span")).toHaveText("Account");
    await expect(page.locator("#wireAccountTrigger")).not.toContainText("Next Fixture");
    await expect(page.locator("#wireAccountTrigger .wire-account-avatar")).toHaveText("");
});

test("cached profile and image failure retain only the verified-login fallback without retry loops", async t => {
    const { page, warnings } = await setup(t);
    let requests = 0;
    await page.route("**/api/profile/github/avatar/*", route => { requests++; return route.fulfill({ status: 404, body: "" }); });
    const profile = structuredClone(verifiedGitHubProfile);
    profile.displayName.freshness = "cached";
    profile.avatar = { state: "cached", reason: null, url: "/api/profile/github/avatar/" + "2".repeat(64), expiresAt: Date.now() + 30000 };
    const snapshot = presentationFixture("connected", profile);
    await page.evaluate(snapshot => {
        fixtureReceive(snapshot);
        window.failedImage = document.querySelector("#wireAccountTrigger img");
        window.failedImageSource = failedImage.getAttributeNode("src");
        fixtureReceive(snapshot);
    }, snapshot);
    await expect(page.locator("#wireAccountTrigger img")).toHaveCount(0);
    assert.equal(await page.evaluate(() => failedImage.getAttribute("src")), null);
    assert.equal(await page.evaluate(() => failedImageSource.value), "");
    await expect(page.locator("#wireAccountTrigger .wire-account-avatar")).toHaveText("R");
    await page.locator("#wireAccountTrigger").click();
    await expect.poll(() => warnings.some(text => text === "GitHub profile image unavailable; using its verified fallback.")).toBe(true);
    await expect(page.locator(".wire-account-note")).toHaveCount(0);
    const count = requests;
    for (let i = 0; i < 3; i++) await receive(page, snapshot);
    assert.equal(requests, count);
    assert.equal(profile.displayName.freshness, "cached");
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
});

test("untrusted image destinations are rejected and profile names remain literal text", async t => {
    const { page } = await setup(t);
    const profile = structuredClone(verifiedGitHubProfile);
    profile.displayName.value = '<img src=x onerror="window.injected=true">';
    await receive(page, presentationFixture(null, profile));
    await expect(page.locator("#wireAccountTrigger")).toContainText(profile.displayName.value);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    for (const url of ["https://avatars.example/photo.png", "//example/photo.png", "data:image/png;base64,AA", "/api/profile/github/avatar/../secret"]) {
        profile.avatar = { state: "current", reason: null, url, expiresAt: Date.now() + 60000 };
        await assert.rejects(receive(page, presentationFixture(null, profile)), /same-origin profile image route/);
    }
});

test("native drawer, collapsed menu and focus remain usable across themes and enlarged narrow layouts", async t => {
    const { page } = await setup(t);
    const host = await page.locator("#wireAccountEntry").elementHandle();
    const trigger = await page.locator("#wireAccountTrigger").elementHandle();
    const profile = structuredClone(verifiedGitHubProfile);
    profile.identity.login = "morgan-alexandra-rivera-singh";
    profile.displayName.value = "Morgan Alexandra Rivera Singh";
    profile.fallback.text = "M";
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
        await receive(page, presentationFixture("disconnected", profile));
        if (!process.env.WIRE_ACCOUNT_RENDERER_PIN) {
            const footer = await page.locator("#navigationFooter").evaluate(node => {
                const rect = node.getBoundingClientRect(), rail = node.closest("aside").getBoundingClientRect();
                const settings = node.querySelector('[data-nav="settings"]').getBoundingClientRect();
                const account = node.querySelector("#wireAccountTrigger").getBoundingClientRect();
                return { bottom: rect.bottom, railBottom: rail.bottom, settings: settings.toJSON(), account: account.toJSON() };
            });
            assert.equal(footer.bottom, footer.railBottom - 16);
            assert.ok(footer.settings.left >= footer.account.right + 8, "Settings has its own target to the right of the account");
            assert.ok(Math.abs(footer.settings.top + footer.settings.height / 2 - footer.account.top - footer.account.height / 2) < 1);
        }
        await capture(page, theme + "-account-footer");
        await page.locator("#wireAccountTrigger").click();
        await expect(page.locator("#wireAccountMenu")).toBeFocused();
        await capture(page, theme + "-account-expanded");
        const scroll = await page.evaluate(() => scrollY);
        await page.keyboard.press("ArrowDown");
        await expect(page.locator("#wireAccountMenu")).toBeFocused();
        assert.equal(await page.evaluate(() => scrollY), scroll);
        await page.keyboard.press("Tab");
        await expect(page.locator("#wireAccountMenu")).toBeHidden();
        await page.locator("#wireAccountTrigger").click();
        await page.keyboard.press("Escape");
        await expect(page.locator("#wireAccountTrigger")).toBeFocused();
        await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.getElementById("sidebar").hasAttribute("data-navigation-moving"));
        await page.locator("#wireAccountTrigger").click();
        await capture(page, theme + "-account-collapsed");
        await page.keyboard.press("Escape");
        await expect(page.locator("#wireAccountTrigger")).toBeFocused();
        await page.locator('.primary-navigation [data-nav="settings"]').click();
        assert.match(page.url(), /#settings$/);
        await page.locator("#navigationCollapse").click();
    }
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.locator("#navigationToggle").click();
    assert.equal(await host.evaluate(node => node === document.querySelector("#navigationDrawer #wireAccountEntry")), true);
    assert.equal(await trigger.evaluate(node => node === document.getElementById("wireAccountTrigger")), true);
    await expect(page.locator("#wireAccountTrigger")).toHaveCount(1);
    await page.locator("#wireAccountTrigger").click();
    await capture(page, "narrow-account-200");
    const bounds = await page.locator("#wireAccountMenu").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 1000);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#wireAccountTrigger")).toBeFocused();
    await expect(page.locator("#navigationDrawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#navigationDrawer")).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.locator("#wireAccountTrigger").click();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await expect(page.locator("#wireAccountMenu")).toBeHidden();
});

test("compact footer keeps account and Settings independent through identity, rail and drawer changes", async t => {
    const { page } = await setup(t);
    const settings = page.locator('#navigationFooter [data-nav="settings"]');
    const host = await page.locator("#wireAccountEntry").elementHandle();
    const trigger = await page.locator("#wireAccountTrigger").elementHandle();
    const railWidth = await page.locator("#sidebar").evaluate(node => node.getBoundingClientRect().width);
    for (const profile of [verifiedGitHubProfile, {
        ...verifiedGitHubProfile, displayName: { ...verifiedGitHubProfile.displayName, value: "An exceptionally long synthetic account display name" },
    }]) {
        await receive(page, presentationFixture(null, profile));
        assert.equal(await page.locator("#sidebar").evaluate(node => node.getBoundingClientRect().width), railWidth,
            "Profile publication never resizes the navigation");
    }
    await expect(settings).toHaveAccessibleName("Settings");
    await expect(page.locator('[data-nav="settings"]')).toHaveCount(1);
    await settings.hover();
    await expect(page.getByRole("tooltip", { name: "Settings", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator("#wireAccountTrigger").focus();
    await page.keyboard.press("Tab"); await expect(settings).toBeFocused();
    await page.keyboard.press("Enter");
    assert.match(page.url(), /#settings$/);
    for (const [width, scale] of [[1440, 1], [768, 2], [390, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
            if (width < 700) {
                await page.locator("#navigationToggle").click();
                await page.waitForFunction(() => !document.querySelector("#navigationDrawer").getAnimations().length);
            }
            for (const mode of width < 700 ? ["drawer"] : ["expanded", "collapsed"]) {
                if (mode !== "drawer" && await page.locator("html").getAttribute("data-navigation") !== mode) await page.locator("#navigationCollapse").click();
                await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
                const geometry = await page.evaluate(() => {
                    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
                    return { account: rect("#wireAccountTrigger"), settings: rect('#navigationFooter [data-nav="settings"]'),
                        footer: rect("#navigationFooter"), parent: rect(matchMedia("(max-width:699px)").matches ? "#navigationDrawer" : "#sidebar") };
                });
                for (const target of [geometry.account, geometry.settings]) {
                    assert.ok(target.width >= 44 && target.height >= 44);
                    assert.ok(target.left >= geometry.parent.left && target.right <= geometry.parent.right);
                }
                if (mode === "collapsed") {
                    assert.ok(geometry.account.bottom + 8 <= geometry.settings.top);
                    assert.equal(geometry.account.left, geometry.settings.left);
                } else {
                    assert.ok(geometry.account.right + 8 <= geometry.settings.left);
                    assert.ok(Math.abs(geometry.account.top + geometry.account.height / 2 - geometry.settings.top - geometry.settings.height / 2) < 1);
                }
                assert.equal(await host.evaluate(node => node === document.querySelector("#navigationFooter #wireAccountEntry")), true);
                assert.equal(await trigger.evaluate(node => node === document.getElementById("wireAccountTrigger")), true);
                await page.locator("#wireAccountTrigger").click();
                await expect(page.locator("#wireAccountMenu")).toBeFocused();
                await page.keyboard.press("Escape"); await expect(page.locator("#wireAccountTrigger")).toBeFocused();
                await page.keyboard.press("Tab"); await expect(settings).toBeFocused();
                const overflow = await page.locator(width < 700 ? "#navigationDrawer" : "#sidebar").evaluate(node => ({
                    client: node.clientWidth, scroll: node.scrollWidth, left: node.scrollLeft,
                }));
                assert.ok(overflow.scroll <= overflow.client + 1 && overflow.left === 0, `${theme}/${width}/${scale}/${mode}: ${JSON.stringify(overflow)}`);
                await capture(page, `compact-${theme}-${width}-${scale}x-${mode}`);
            }
            if (width < 700) {
                await page.keyboard.press("Escape");
                await expect(page.locator("#navigationToggle")).toBeFocused();
            }
        }
    }
    await page.evaluate(() => fixturePresentation.dispose());
    await expect(page.locator("#wireAccountEntry")).toBeHidden();
    await page.locator("#navigationToggle").click();
    await settings.click();
    assert.match(page.url(), /#settings$/, "Settings is independent of a mounted account presenter");
});

test("compact footer glides and reverses without overlapping account and Settings targets", async t => {
    const { page } = await setup(t);
    await receive(page, presentationFixture(null, verifiedGitHubProfile));
    for (const [scale, theme] of [[1, "light"], [1, "dark"], [2, "light"], [2, "dark"]]) {
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.setViewportSize({ width: scale === 1 ? 1440 : 768, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const result = await page.evaluate(async () => {
            const rail = document.getElementById("sidebar"), toggle = document.getElementById("navigationCollapse");
            const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
            const samples = [], clicks = [];
            let phase = "initial", running = true;
            const sample = () => {
                const rect = id => document.getElementById(id).getBoundingClientRect().toJSON();
                return { phase, rail: rect("sidebar"), footer: rect("navigationFooter"), account: rect("wireAccountTrigger"),
                    settings: document.querySelector('#navigationFooter [data-nav="settings"]').getBoundingClientRect().toJSON() };
            };
            function observe() { samples.push(sample()); if (running) requestAnimationFrame(observe); }
            async function settle() {
                for (let i = 0; i < 120; i++) {
                    await frame();
                    if (i > 1 && !rail.hasAttribute("data-navigation-moving")) return;
                }
                throw new Error("Footer motion did not settle");
            }
            const click = next => {
                phase = next;
                const before = sample(); toggle.click();
                clicks.push({ before, after: sample() });
            };
            observe();
            click("collapse"); await settle();
            click("expand"); await settle();
            click("reverse-collapse");
            for (let i = 0; i < 4; i++) await frame();
            click("reverse-expand"); await settle();
            running = false; await frame();
            return { samples, clicks };
        });
        for (const { before, after } of result.clicks) for (const target of ["account", "settings"]) {
            for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(before[target][key] - after[target][key]) < 1,
                `${scale}x/${after.phase}/${target}: no initial ${key} snap`);
        }
        for (const { phase, account, settings, footer, rail } of result.samples) {
            assert.ok(account.width >= 43.9 && account.height >= 43.9 && settings.width >= 43.9 && settings.height >= 43.9);
            assert.ok(account.right <= settings.left + 1 || account.bottom <= settings.top + 1 || settings.bottom <= account.top + 1,
                `${scale}x/${phase}: separate full-sized targets ${JSON.stringify({ account, settings })}`);
            assert.ok(account.left >= rail.left - 1 && settings.left >= rail.left - 1);
            assert.ok(account.right <= rail.right + 1 && settings.right <= rail.right + 1);
            assert.ok(Math.abs(footer.bottom - result.samples[0].footer.bottom) < 1, "The footer stays bottom-anchored");
        }
        for (const phase of ["collapse", "expand", "reverse-collapse", "reverse-expand"]) {
            assert.ok(new Set(result.samples.filter(sample => sample.phase === phase).map(sample => Math.round(sample.rail.width))).size > 1);
        }
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            await writeFile(path.join(proofs, `compact-motion-${theme}-${scale}x.json`), JSON.stringify(result, null, 2));
            for (const phase of ["collapse", "expand"]) {
                await page.locator("#navigationCollapse").click();
                await page.evaluate(async () => {
                    for (const selector of ["#sidebar", "#shellBrand"]) for (const animation of document.querySelector(selector).getAnimations({ subtree: true })) {
                        animation.pause(); animation.currentTime = 80;
                    }
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                });
                await page.screenshot({ path: path.join(proofs, `compact-motion-${theme}-${scale}x-${phase}-80ms.png`) });
                await page.evaluate(() => {
                    for (const selector of ["#sidebar", "#shellBrand"]) for (const animation of document.querySelector(selector).getAnimations({ subtree: true })) animation.play();
                });
                await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
            }
        }
    }
});

test("account activation during expansion, collapse and reversal settles its real popup anchor", async t => {
    const { page } = await setup(t);
    const profile = structuredClone(verifiedGitHubProfile);
    profile.displayName.value = "An exceptionally long synthetic account display name";
    await receive(page, presentationFixture(null, profile));
    await page.evaluate(() => {
        window.footerActivationEvents = [];
        document.addEventListener("click", event => {
            if (event.target instanceof Element && event.target.closest("#wireAccountTrigger")) {
                window.footerActivationEvents.push({ moving: document.getElementById("sidebar").hasAttribute("data-navigation-moving"),
                    trusted: event.isTrusted, detail: event.detail });
            }
        }, { capture: true });
    });
    const trigger = page.locator("#wireAccountTrigger"), menu = page.locator("#wireAccountMenu");
    const observations = [];
    for (const theme of ["light", "dark"]) for (const phase of ["expand", "collapse", "reverse"]) for (const activation of ["pointer", "Enter", "Space"]) {
        await chooseTheme(page, theme);
        const initial = phase === "expand" ? "collapsed" : "expanded";
        if (await page.locator("html").getAttribute("data-navigation") !== initial) await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.getElementById("sidebar").hasAttribute("data-navigation-moving"));
        if (activation !== "pointer") await trigger.focus();
        const expected = phase === "collapse" ? "collapsed" : "expanded";
        await page.evaluate(async phase => {
            const toggle = document.getElementById("navigationCollapse");
            const frames = async () => {
                for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve));
            };
            toggle.click(); await frames();
            if (phase === "reverse") { toggle.click(); await frames(); }
        }, phase);
        if (activation === "pointer") {
            await trigger.hover({ force: true });
            assert.equal(await page.locator("#sidebar").evaluate(node => node.hasAttribute("data-navigation-moving")), true,
                "Hover does not settle the glide");
            await trigger.click({ force: true });
        } else await trigger.press(activation);
        await expect(menu).toBeFocused();
        const geometry = await page.evaluate(() => ({
            activation: window.footerActivationEvents.at(-1), moving: document.getElementById("sidebar").hasAttribute("data-navigation-moving"),
            mode: document.documentElement.dataset.navigation, scrollY,
            trigger: document.getElementById("wireAccountTrigger").getBoundingClientRect().toJSON(),
            menu: document.getElementById("wireAccountMenu").getBoundingClientRect().toJSON(),
        }));
        assert.equal(geometry.activation.trusted, true, "Pointer and keyboard input reach the native button");
        assert.equal(geometry.activation.moving, true, `${theme}/${phase}/${activation}: activate during real motion`);
        assert.equal(geometry.activation.detail, activation === "pointer" ? 1 : 0);
        assert.equal(geometry.moving, false, "The existing glide settles before the presenter measures its anchor");
        assert.equal(geometry.mode, expected, "Activation preserves the intended navigation state");
        assert.ok(Math.abs(geometry.menu.bottom + 8 - geometry.trigger.top) < 1);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(await menu.boundingBox(), { x: geometry.menu.x, y: geometry.menu.y, width: geometry.menu.width, height: geometry.menu.height });
        await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
        assert.equal(await page.evaluate(() => scrollY), geometry.scrollY);
        observations.push({ theme, phase, activation, ...geometry });
    }
    assert.deepEqual(await page.evaluate(() => window.fixtureWrites), []);
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, "account-activation-anchors.json"), JSON.stringify(observations, null, 2));
    }
});

test("Escape dismisses only the topmost account popup before the narrow navigation drawer", async t => {
    const { page } = await setup(t, { viewport: { width: 390, height: 900 } });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const drawer = page.locator("#navigationDrawer"), trigger = page.locator("#wireAccountTrigger");
    const menu = page.locator("#wireAccountMenu"), navigation = page.locator("#navigationToggle");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await navigation.click();
        await page.waitForFunction(() => !document.getElementById("navigationDrawer").getAnimations().length);
        await trigger.click(); await expect(menu).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        assert.equal(await drawer.evaluate(node => node.getAnimations().length), 0, "The parent must not begin exiting");
        // Wait through any accidentally started exit, not just the first open frame.
        await page.waitForFunction(() => !document.getElementById("navigationDrawer").getAnimations().length);
        await expect(drawer).toBeVisible();
        await expect(drawer).toHaveAttribute("open", "");
        await expect(trigger).toBeFocused();
        await expect(navigation).toHaveAttribute("aria-expanded", "true");
        await capture(page, "topmost-escape-" + theme);
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();
        await expect(navigation).toBeFocused();
        await expect(navigation).toHaveAttribute("aria-expanded", "false");
    }
    assert.deepEqual(await page.evaluate(() => window.fixtureWrites), []);
});

test("dispose removes only owned presentation and restores dormant real hosts", async t => {
    const { page } = await setup(t);
    await selectActivityOption(page, "collectionWindow", "7");
    const preference = await page.locator("#collectionWindow").elementHandle();
    await page.evaluate(() => { fixturePresentation.dispose(); fixturePresentation.dispose(); });
    await expect(page.locator("#wireAccountEntry")).toBeHidden();
    await expect(page.locator("#microsoftConnectionHost")).toBeHidden();
    await expect(page.locator("#wireAccountMenu")).toHaveCount(0);
    assert.equal(await preference.evaluate(node => node === document.getElementById("collectionWindow") && node.value === "7"), true);
    assert.deepEqual(await page.evaluate(() => window.fixtureWrites), []);
});

test("withdrawal clears captured profile presentation and focus cannot restore the old identity", async t => {
    const { page } = await setup(t);
    await receive(page, presentationFixture("connected", verifiedGitHubProfile));
    const trigger = await page.locator("#wireAccountTrigger").elementHandle();
    await page.locator("#wireAccountTrigger").click();
    const menu = await page.locator("#wireAccountMenu").elementHandle();
    await page.evaluate(() => {
        window.heldProfileText = [];
        for (const id of ["wireAccountTrigger", "wireAccountMenu"]) {
            const walker = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) if (/^R$|Riley|riley-chen/.test(walker.currentNode.data)) heldProfileText.push(walker.currentNode);
        }
        window.heldProfileLabel = document.getElementById("wireAccountTrigger").getAttributeNode("aria-label");
        window.profileBefore = { text: heldProfileText.map(node => node.data), label: heldProfileLabel.value };
        fixturePresentation.withdrawAccess();
        dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("#wireAccountTrigger")).not.toContainText("Riley");
    await expect(page.locator("#wireAccountMenu")).not.toContainText("riley-chen");
    await expect(page.locator("#wireAccountTrigger img")).toHaveCount(0);
    assert.equal(await page.evaluate(() => profileBefore.text.length), 6);
    assert.match(await page.evaluate(() => profileBefore.label), /Riley Chen/);
    assert.deepEqual(await page.evaluate(() => heldProfileText.map(node => node.data)), ["", "", "", "", "", ""]);
    assert.equal(await page.evaluate(() => heldProfileLabel.value), "");
    await receive(page, presentationFixture("connected", verifiedGitHubProfile));
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    assert.deepEqual(await page.evaluate(() => heldProfileText.map(node => node.data)), ["", "", "", "", "", ""]);
    assert.equal(await page.evaluate(() => heldProfileLabel.value), "");
    const replacement = structuredClone(verifiedGitHubProfile);
    replacement.generation = "fixture-newer";
    replacement.displayName.value = "Newer Fixture";
    const retired = await page.evaluate(({ older, newer }) => {
        const original = fixtureApi.isCurrent, token = fixtureApi.publicationToken();
        fixtureApi.isCurrent = value => {
            const allowed = original(value);
            fixtureApi.isCurrent = original;
            fixturePresentation.receive(newer, token);
            return allowed;
        };
        try { return fixturePresentation.receive(older, token); }
        finally { fixtureApi.isCurrent = original; }
    }, { older: presentationFixture("connected", verifiedGitHubProfile), newer: presentationFixture("disconnected", replacement) });
    assert.equal(retired, false, "A reentrant newer delivery retires the original before it can cache or paint.");
    await expect(page.locator("#wireAccountTrigger")).toContainText("Newer Fixture");
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    await page.evaluate(() => fixturePresentation.dispose());
    assert.doesNotMatch(await trigger.textContent(), /Riley|riley-chen/);
    assert.doesNotMatch(await menu.textContent(), /Riley|riley-chen/);
});
