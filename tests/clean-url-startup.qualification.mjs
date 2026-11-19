import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const recordId = "invented-clean-url";
const fromRepo = file => new URL(file, import.meta.url).href;
const pages = ["analyze", "trends", "reports", "compare", "settings", "request", "collection-status"];

async function launch(root) {
    // Keep the real contributor launcher, store selection, access gate and compiled React entry.
    // Only the invented retained record is seeded. No source is configured to schedule collection.
    const seed = `
        import { contributorDataDir } from ${JSON.stringify(fromRepo("../lib/paths.mjs"))};
        import { replaceEvidence } from ${JSON.stringify(fromRepo("../lib/store.mjs"))};
        import { fixture } from ${JSON.stringify(fromRepo("./helpers.mjs"))};
        const record = fixture(${JSON.stringify(recordId)});
        record.capturedAt = new Date().toISOString();
        await replaceEvidence({ dataDir: contributorDataDir() }, () => ({ records: [record], importCoverage: null }));
        globalThis.fetch = () => { throw new Error("No outbound profile/provider reads in this fixture."); };
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
        /^(SystemRoot|WINDIR|ComSpec|PATH|PATHEXT|LANG|LC_ALL)$/i.test(k)));
    Object.assign(env, { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: root, XDG_CONFIG_HOME: root,
        COPILOT_HOME: path.join(root, "invented-source"), GH_CONFIG_DIR: path.join(root, "no-account"),
        TEMP: root, TMP: root, TMPDIR: root });
    const child = fork(new URL("../scripts/start.mjs", import.meta.url), ["--contributor", "--port", "0"], {
        env, execArgv: ["--import", "data:text/javascript," + encodeURIComponent(seed)], silent: true,
    });
    const exited = once(child, "exit");
    const stop = async () => {
        if (child.connected) child.disconnect();
        const timer = setTimeout(() => child.kill(), 5000);
        try { const [code] = await exited; assert.equal(code, 0, "Contributor fixture did not close cleanly."); }
        finally { clearTimeout(timer); }
    };
    let timer;
    try {
        const info = await new Promise((resolve, reject) => {
            let stdout = "", stderr = "";
            child.stderr.on("data", bytes => {
                stderr = (stderr + bytes).slice(-2000);
                if (/browser assets are unavailable|could not start|port is already owned/.test(stderr))
                    reject(new Error("Fixture startup failed: " + stderr));
            });
            child.stdout.on("data", bytes => {
                stdout += bytes;
                const match = /ready at (http:\/\/127\.0\.0\.1:\d+\/)\r?\nContributor checkout \(react\); private store: (.+)\r?\n/.exec(stdout);
                if (match) resolve({ url: match[1], store: match[2].trimEnd() });
            });
            child.once("error", reject);
            child.once("exit", () => reject(new Error("Fixture startup failed: " + stderr)));
            timer = setTimeout(() => reject(new Error("Fixture startup timed out: " + stderr)), 30000);
        });
        return { ...info, stop };
    } catch (error) {
        await stop().catch(() => {});
        throw error;
    } finally { clearTimeout(timer); }
}

// Keep invalid request-targets literal: URL/fetch would normalize some into valid page paths.
function raw(origin, target, method = "GET", headers = {}) {
    return new Promise((resolve, reject) => {
        const req = request(origin, { path: target, method, headers }, res => {
            let body = "";
            res.setEncoding("utf8").on("data", bytes => { body += bytes; });
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on("error", reject).end();
    });
}

async function checkDispatch(origin) {
    const capabilities = new Set();
    const root = await raw(origin, "/");
    function shell(response, route) {
        assert.equal(response.status, 200, route);
        for (const header of ["content-type", "cache-control", "x-content-type-options", "referrer-policy"]) {
            assert.equal(response.headers[header], root.headers[header], `${route}: ${header}`);
        }
        const csp = r => r.headers["content-security-policy"].replace(/'nonce-[^']+'/g, "'nonce'");
        assert.equal(csp(response), csp(root), route);
        const bootstrap = /<script id="wireBootstrap"[^>]*>([^<]+)<\/script>/.exec(response.body);
        assert.ok(bootstrap, `Missing bootstrap at ${route}`);
        const { capability, accessBootstrap, renderer } = JSON.parse(bootstrap[1]);
        assert.equal(renderer, "react"); assert.equal(accessBootstrap.mode, "enforced");
        assert.equal(accessBootstrap.collectionMode, "copilot-only");
        assert.match(capability, /^[a-f0-9]{64}$/); assert.ok(!capabilities.has(capability), "New panel required.");
        capabilities.add(capability);
    }
    shell(root, "/");
    assert.equal(root.headers["referrer-policy"], "no-referrer");
    for (const page of pages) {
        for (const suffix of ["", "/?from=fixture"]) {
            const route = `/${page}${suffix}`;
            shell(await raw(origin, route), route);
        }
    }
    for (const [target, method, headers] of [
        ["/api/state"], ["/api/missing"], ["/assets/missing.js"], ["/report.html"], ["/unknown"],
        ["/settings/child"], ["/Settings"], ["/%73ettings"], ["/trends//"], ["//"], ["/other/../reports"],
        ["/settings", "HEAD"], ["/trends", "POST"], ["/reports", "OPTIONS"],
        ["/analyze", "GET", { Origin: "https://fixture.invalid" }],
        ["/analyze", "GET", { Host: "localhost:" + new URL(origin).port }],
    ]) {
        const response = await raw(origin, target, method, headers);
        assert.equal(response.status, 403, `${method ?? "GET"} ${target}`);
        assert.match(response.headers["content-type"], /application\/json/);
    }
    assert.match((await raw(origin, "/favicon.svg")).headers["content-type"], /image\/svg/);
    assert.equal(JSON.parse((await raw(origin, "/health")).body).service, "workiq-evidence");
}

// Capture the registered canvas without installing an adapter or joining an account.
// The open/action/close callbacks and their port-bound network client are the real ones.
async function openCanvas(t, origin) {
    const key = "wireCanvas" + randomUUID();
    const sdk = `export const createCanvas = c => c;
        export const joinSession = async s => { globalThis[${JSON.stringify(key)}] = s.canvases[0]; return {}; };
        export class CanvasError extends Error {}`;
    const entry = fromRepo("../extension.mjs") + "?clean-url=" + randomUUID();
    const hooks = registerHooks({ resolve(specifier, context, next) {
        if (context.parentURL === entry && specifier === "@github/copilot-sdk/extension")
            return { url: "data:text/javascript," + encodeURIComponent(sdk), shortCircuit: true };
        return next(specifier, context);
    } });
    let canvas;
    try { await import(entry); canvas = globalThis[key]; }
    finally { hooks.deregister(); delete globalThis[key]; }
    const nativeFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (url, options) => {
        assert.equal(new URL(url).origin, origin, "No fallback to another WIRE runtime.");
        return nativeFetch(url, options);
    });
    const instanceId = "clean-url-" + randomUUID();
    const opened = await canvas.open({ instanceId,
        input: { boardId: "workiq-evidence-board-v1", runtimePort: Number(new URL(origin).port) } });
    try {
        const action = canvas.actions.find(a => a.name === "get_state");
        const state = await action.handler({ instanceId, actionName: action.name, input: {} });
        assert.deepEqual(state.scenarios.map(s => s.scenarioId), [recordId]);
        return opened.url;
    } finally { await canvas.onClose({ instanceId }); }
}

test("normal contributor canvas and browser use protected clean URLs on the selected port", { timeout: 120000 }, async t => {
    const proofs = process.env.WIRE_CLEAN_URL_PROOFS;
    assert.ok(proofs, "Set WIRE_CLEAN_URL_PROOFS to an owned directory outside the checkout.");
    const root = path.resolve(proofs, "clean-url-fixture-" + randomUUID());
    await mkdir(root, { recursive: true });
    let app, browser;
    try {
        app = await launch(root);
        const { origin, port } = new URL(app.url);
        assert.ok(!["", "0", "4000", "4002"].includes(port));
        const checkout = await realpath(fileURLToPath(new URL("../", import.meta.url)));
        const key = createHash("sha256").update(checkout).digest("hex");
        assert.equal(app.store, path.join(root, "WorkIQEvidence", "checkouts", key, "data"));
        assert.deepEqual(await readdir(path.join(root, "WorkIQEvidence")), ["checkouts"]);
        await checkDispatch(origin);
        const opened = await openCanvas(t, origin);
        assert.equal(opened, app.url);
        browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
        const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, colorScheme: "light",
            reducedMotion: "reduce", serviceWorkers: "block" });
        const leaks = [], offOrigin = [], errors = [], observed = new Set();
        await context.route("**/*", async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== origin) { offOrigin.push(url.origin); return route.abort(); }
            if ((await request.allHeaders()).referer || url.href.includes(recordId)) leaks.push(url.pathname);
            if (url.pathname.startsWith("/api/")) observed.add("API");
            if (url.pathname.startsWith("/assets/")) observed.add("asset");
            return route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", e => errors.push(e.message));
        await page.goto(opened);
        const ready = p => expect(p.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await ready(page);
        assert.equal(page.url(), origin + "/");
        await page.reload(); await ready(page);
        await expect(page).toHaveURL(origin + "/"); await expect(page.locator("#pageTitle")).toHaveText("Analyze");
        await page.goto(origin + "/analyze/?service=Multiple%20workloads");
        await ready(page); await expect(page.locator("#serviceFilter")).toHaveValue("Multiple workloads");
        await expect(page).toHaveURL(origin + "/?service=Multiple+workloads");
        await page.goto(origin + "/#analyze"); await ready(page);
        await expect(page).toHaveURL(origin + "/");
        const nav = view => page.locator(`nav a[data-nav="${view}"]`);
        for (const view of ["analyze", "trends", "reports", "compare", "settings"]) {
            const href = new URL(await nav(view).getAttribute("href"), page.url());
            assert.deepEqual([href.origin, href.pathname, href.hash], [origin, view === "analyze" ? "/" : "/" + view, ""]);
        }
        // A modified native click opens a separate top-level document, not another SPA state.
        const [tab] = await Promise.all([context.waitForEvent("page"), nav("reports").click({ modifiers: ["ControlOrMeta"] })]);
        await expect(tab).toHaveURL(origin + "/reports"); await expect(tab.locator("#reportsView")).toBeVisible();
        await tab.close();
        await nav("trends").press("Enter");
        await expect(page).toHaveURL(origin + "/trends"); await expect(page.locator("#trendsView")).toBeVisible();
        await nav("reports").click();
        await expect(page).toHaveURL(origin + "/reports");
        await page.goBack(); await expect(page.locator("#trendsView")).toBeVisible(); await expect(page).toHaveURL(origin + "/trends");
        await page.goForward(); await expect(page.locator("#reportsView")).toBeVisible(); await expect(page).toHaveURL(origin + "/reports");
        // A legacy private fragment can deliver the invented selection to its original tab only.
        await page.goto(origin + "/#request?request=" + recordId);
        await expect(page.locator("#requestContent")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
        assert.equal(new URL(page.url()).pathname, "/request"); assert.ok(!page.url().includes(recordId));
        await page.goto(origin + "/trends/"); await expect(page.locator("#trendsView")).toBeVisible();
        await page.reload(); await expect(page.locator("#trendsView")).toBeVisible();
        const previous = page.url();
        await page.goto(origin + "/#settings?section=privacy");
        await expect(page).toHaveURL(origin + "/settings?section=privacy");
        await expect(page.locator('[data-settings-section="privacy"]')).toBeVisible();
        await page.goBack(); await expect(page).toHaveURL(previous);
        await expect(page.locator("#trendsView")).toBeVisible();
        await page.goForward(); await expect(page.locator('[data-settings-section="privacy"]')).toBeVisible();
        assert.deepEqual([...observed].sort(), ["API", "asset"]);
        assert.deepEqual(leaks, [], "No request should disclose the fixture ID in a URL or the document URL as Referer.");
        assert.deepEqual(offOrigin, []); assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(proofs, "clean-url-settings.png") });
        t.diagnostic(`Registered canvas -> ${app.url}; contributor/react in isolated WorkIQEvidence/checkouts/${key}/data; fixture removed on exit.`);
    } finally {
        try { await browser?.close(); }
        finally { try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); } }
    }
});
