import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { createNativeConfigurationState } from "../web/native-configuration-state.mjs";
import { createSourceCollectionState } from "../web/source-collection-state.mjs";
import { mountSourceCollectionSettings } from "../web/source-collection-settings.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";

// Controller protocol proof only: no source records, fake captures or backend acceptance.
function html() {
    const nonce = "source-controls-protocol";
    let page = renderHtmlShell("a".repeat(64), nonce);
    page = page.slice(0, page.lastIndexOf(`<script nonce="${nonce}">`)) + "</body></html>";
    page = page.replace(/<link rel="icon"[^>]*>/, "");
    return page.replace("</body>", `<script nonce="${nonce}">
const $=id=>document.getElementById(id);
const ux=(${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});
mountNavigation(ux);
const historyStatus=(${createCollectionStatus.toString()})();
const configure=(${createNativeConfigurationState.toString()});
const bootstrap={schemaVersion:1,mode:"enforced",runtimeId:"00000000-0000-4000-8000-000000000001",maxWaitMs:1000,freshnessMs:5000,collectionMode:"source-aware"};
window.access={...bootstrap,readable:true,state:{generation:2,authorizationRevision:4}};
window.token={};window.writes=[];window.jobs=[];window.reads=0;window.collects=0;
const api={publicationToken:()=>access.readable?token:null,isCurrent:value=>access.readable&&value===token,accessState:()=>access};
window.composite={
 schemaVersion:1,kind:"source-aware-collection",generation:2,authorizationRevision:4,
 global:{state:"legacy-compatible",revision:null,actions:["pause","resume"]},
 github:{status:{state:"disconnected",connected:false,config:null,configVersion:null,revision:0,deletionVersion:0,artifactRevision:0},actions:["configure"]},
 microsoft:{status:{schemaVersion:1,kind:"native-account-unavailable",reason:"microsoft-account-not-configured",generation:2,authorizationRevision:4,revision:7,
 rawWriterAdmission:"withheld",configured:false,configuration:null,actions:[],blockers:["NATIVE_RETENTION_ACCOUNT_UNAVAILABLE"]},
 configurationOffer:{schemaVersion:2,kind:"native-configuration-offer",generation:2,authorizationRevision:4,globalRevision:null,intent:"enable",available:false,
 expectedRevision:null,supportedSurfaces:["chat","cowork"],values:{surfaces:["chat","cowork"],windowDays:30},basis:"native-defaults",blockers:["NATIVE_CONFIGURATION_ACCOUNT_REQUIRED"]},
 actions:[]}
};
window.authority=(${createSourceCollectionState.toString()})({bootstrap,collectionStatus:historyStatus,createNativeConfigurationState:configure});
window.ui=(${mountSourceCollectionSettings.toString()})({
 api,ux,sourceCollection:authority,collectionStatus:historyStatus,createNativeConfigurationState:configure,
 write:(endpoint,input)=>{writes.push({endpoint,input});return new Promise((resolve,reject)=>jobs.push({resolve,reject}));},
 read:async()=>{reads++;publish();return composite;},collect:async()=>{collects++;},onDraftChange:()=>{}
});
window.publish=()=>{authority.receive(composite,access);ui.receive(composite,token);};
$("loading").hidden=true;$("workspace").hidden=false;$("settingsView").hidden=false;
for(const child of $("workspace").children)child.hidden=child.id!=="settingsView"&&!child.classList.contains("page-heading");
$("pageTitle").textContent="Settings";$("pageIntro").hidden=true;$("pagePrimaryActions").hidden=true;
ui.resumeAccess();publish();document.body.dataset.ready="true";
</script></body>`);
}

async function setup(t) {
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], unexpected = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (route.request().url() === "http://source-controls.fixture.invalid/") return route.fulfill({ contentType: "text/html", body: html() });
        unexpected.push(route.request().url()); return route.abort();
    });
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); });
    await page.goto("http://source-controls.fixture.invalid/");
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    return page;
}

test("source controls preserve global UNSET and explicit Microsoft consent without automatic writes", async t => {
    const page = await setup(t);
    await expect(page.locator("#globalCollectionStatus")).toHaveText("Source settings apply");
    await expect(page.locator("#resumeGlobalCollection")).toBeHidden();
    await expect(page.locator("#globalCollectionHelp")).toBeHidden();
    await expect(page.locator("#saveMicrosoftCollection")).toBeDisabled();
    await expect(page.locator("#collectMicrosoftActivity")).toBeDisabled();
    assert.deepEqual(await page.evaluate(() => ({ writes, reads, collects })), { writes: [], reads: 0, collects: 0 });
    await page.locator("#pauseGlobalCollection").click();
    assert.deepEqual(await page.evaluate(() => writes), [{
        endpoint: "/api/collection/global/enabled",
        input: { schemaVersion: 1, enabled: false, generation: 2, authorizationRevision: 4, expectedRevision: null },
    }]);
    await page.evaluate(() => jobs[0].reject(new Error("Reply lost")));
    await expect(page.locator("#globalCollectionMessage")).toContainText("unconfirmed");
    await expect(page.locator("#pauseGlobalCollection")).toBeDisabled();
    await page.evaluate(() => ui.setSharedRecovery(true));
    await expect(page.locator("#readGlobalCollection")).toBeVisible();
    await page.locator("#readGlobalCollection").click();
    await expect(page.locator("#globalCollectionMessage")).toContainText("earlier change unconfirmed");
    assert.equal(await page.evaluate(() => writes.length), 1);
    assert.equal(await page.evaluate(() => reads), 1);
});

test("withdrawn source controls clear status and cannot settle an earlier operation under a new publication", async t => {
    const page = await setup(t);
    await page.locator("#pauseGlobalCollection").click();
    await page.evaluate(() => { access.readable=false;authority.withdraw();ui.withdrawAccess(); });
    await expect(page.locator("#globalCollectionControls")).toBeHidden();
    await expect(page.locator("#sourceMicrosoftSurfaces")).toHaveValue("");
    await page.evaluate(() => {
        access.readable=true;token={};ui.resumeAccess();publish();
        jobs[0].resolve({...composite,global:{state:"committed",revision:1,paused:false,actions:["pause"]}});
    });

    await expect(page.locator("#pauseGlobalCollection")).toBeDisabled();
    assert.equal(await page.evaluate(() => writes.length), 1);
    await expect(page.locator("#globalCollectionMessage")).not.toContainText("Global collection allowed");
    await page.locator("#readGlobalCollection").click();
    await expect(page.locator("#globalCollectionStatus")).toHaveText("Source settings apply");
});

test("a held global gesture cannot adopt a newly committed policy stamp", async t => {
    const page = await setup(t);
    await page.locator("#pauseGlobalCollection").dispatchEvent("pointerdown", { button: 0 });
    await page.evaluate(() => {
        composite.authorizationRevision=5;composite.microsoft.status.authorizationRevision=5;
        composite.microsoft.configurationOffer.authorizationRevision=5;
        composite.microsoft.configurationOffer.globalRevision=1;
        composite.global={state:"committed",revision:1,paused:false,actions:["pause"]};
        access.state.authorizationRevision=5;publish();
    });
    await page.locator("#pauseGlobalCollection").dispatchEvent("click");
    assert.equal(await page.evaluate(() => writes.length), 0);
    await expect(page.locator("#globalCollectionMessage")).toContainText("Settings changed");
});

test("Microsoft edits submit exactly their offered schema2 stamp and polling never rebases them", async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        composite.microsoft.status={
            schemaVersion:1,kind:"native-screened-retention",contractVersion:"m365-native-screened-observations-v1",
            rawWriterAdmission:"withheld",configured:false,accountRef:"synthetic-account-reference",
            generation:2,revision:7,configuration:null,actions:["configure"],blockers:["NATIVE_RETENTION_NOT_CONFIGURED"],
            receipt:null,receiptQuery:null
        };
        composite.microsoft.configurationOffer.available=true;
        composite.microsoft.configurationOffer.blockers=[];
        composite.microsoft.actions=["configure"];publish();
    });
    await page.selectOption("#sourceMicrosoftSurfaces", "cowork");
    await page.locator("#sourceMicrosoftSurfaces").dispatchEvent("input");
    await page.selectOption("#sourceMicrosoftWindow", "7");
    await page.locator("#sourceMicrosoftWindow").dispatchEvent("input");
    await page.evaluate(() => publish());
    await expect(page.locator("#sourceMicrosoftWindow")).toHaveValue("7");
    await page.locator("#saveMicrosoftCollection").click();
    assert.deepEqual(await page.evaluate(() => writes), [{
        endpoint: "/api/collection/microsoft/configure",
        input: { schemaVersion: 2, intent: "enable", generation: 2, authorizationRevision: 4,
            globalRevision: null, expectedRevision: null, surfaces: ["cowork"], windowDays: 7 },
    }]);
    await page.evaluate(() => jobs[0].reject(new Error("Reply lost")));
    await expect(page.locator("#saveMicrosoftCollection")).toBeDisabled();
    await page.locator("#readMicrosoftCollection").click();
    assert.equal(await page.evaluate(() => writes.length), 1);
    await expect(page.locator("#sourceMicrosoftWindow")).toHaveValue("7");
    await page.evaluate(() => {
        composite.authorizationRevision=5;composite.microsoft.configurationOffer.authorizationRevision=5;
        composite.microsoft.configurationOffer.globalRevision=1;
        composite.global={state:"committed",revision:1,paused:true,actions:["resume"]};
        access.state.authorizationRevision=5;publish();
    });
    await expect(page.locator("#sourceMicrosoftDraft")).toContainText("changed");
    await expect(page.locator("#saveMicrosoftCollection")).toBeDisabled();
    await expect(page.locator("#sourceMicrosoftSurfaces")).toHaveValue("cowork");
    await page.locator("#cancelMicrosoftCollection").click();
    await expect(page.locator("#sourceMicrosoftWindow")).toHaveValue("30");
    await expect(page.locator("#globalCollectionStatus")).toHaveText("Paused");
    await expect(page.locator("#globalCollectionHelp")).toHaveText("Refresh can still check GitHub history.");
    await expect(page.locator("#globalCollectionHelp")).toBeVisible();
    assert.equal(await page.evaluate(() => collects), 0);
});

for (const [code, label, explanation] of [
    ["NATIVE_RETENTION_OPERATION_UNKNOWN", "Collection outcome unconfirmed",
        "The previous Microsoft collection is unconfirmed. Read its status before starting another collection."],
    ["NATIVE_RETENTION_AUTOMATIC_STOPPED", "Automatic collection stopped",
        "Automatic Microsoft collection stopped after an error. Read the current connection before starting a new collection."],
]) test(`accepted ${code} presentation preserves a projected new manual collection`, async t => {
    const page = await setup(t);
    await page.evaluate(({ code, explanation }) => {
        // Isolate this consumer from the separately owned producer/decoder contract.
        const view = authority.view.bind(authority), reason = historyStatus.persistenceReason.bind(historyStatus);
        composite.microsoft.status = {
            configured: true, configuration: { settings: { paused: false }, surfaces: ["chat", "cowork"] },
            blockers: [code], actions: ["collect-now"],
        };
        authority.view = access => {
            const value = view(access);
            return { ...value, status: composite, actions: { ...value.actions, microsoft: ["collect-now"] } };
        };
        historyStatus.persistenceReason = status => status.nativePersistence.blockers.includes(code) ? explanation : reason(status);
        ui.receive(composite, token);
    }, { code, explanation });
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText(label);
    await expect(page.locator("#sourceMicrosoftHelp")).toContainText(explanation);
    await expect(page.locator("#collectMicrosoftActivity")).toBeEnabled();
    assert.equal(await page.evaluate(() => collects), 0);
    await page.locator("#collectMicrosoftActivity").click();
    assert.equal(await page.evaluate(() => collects), 1);
    assert.deepEqual(await page.evaluate(() => writes), []);
});

test("source control groups retain usable widths and controls in both existing themes", async t => {
    const page = await setup(t), output = process.env.WIRE_SOURCE_CONTROL_PROOFS;
    if (output) await mkdir(output, { recursive: true });
    await page.evaluate(() => {
        for (const id of ["connectionSource", "connectionPreferences"]) document.getElementById(id).hidden=true;
    });
    for (const theme of ["light", "dark"]) for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(theme => document.documentElement.dataset.evidenceTheme=theme, theme);
        const measured = await page.locator("#sourceMicrosoftCollection").evaluate(node => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            width: node.getBoundingClientRect().width,
            clipped: [...node.querySelectorAll("select,button")].filter(control => control.checkVisibility())
                .some(control => control.getBoundingClientRect().width > node.getBoundingClientRect().width),
        }));
        assert.equal(measured.overflow, false, `${theme} ${width}px`);
        assert.equal(measured.clipped, false, `${theme} ${width}px`);
        assert.ok(measured.width > 250, `${theme} ${width}px`);
        if (output) await page.locator(".settings-content").screenshot({ path: path.join(output, `${theme}-${width}.png`) });
    }
});

const historySource = (changes = {}) => ({
    surface: "chat", startQualified: false, controlObserved: true, initial: "empty",
    pages: 1, chainPages: 1, exhausted: false, eligible: 5, handled: 3, suppressed: 0,
    pending: 2, unreadable: 0, stops: [], ...changes,
});
const historyProgress = (state, sources) => ({
    schemaVersion: 1, window: { from: "2026-10-01T12:00:00.000Z", to: "2026-10-08T12:00:00.000Z" },
    state, sources,
});

async function publishHistory(page, backfill) {
    await page.evaluate(backfill => {
        composite.microsoft.status = {
            schemaVersion: 1, kind: "native-screened-retention", contractVersion: "m365-native-screened-observations-v1",
            rawWriterAdmission: "withheld", configured: true, accountRef: "synthetic-account-reference",
            generation: 2, revision: 7, configuration: {
                configurationRevision: 1, privacyRevision: 1, policy: "native-screened-source-observations-v1",
                settings: { paused: false, windowDays: 7 }, surfaces: ["chat", "cowork"],
            },
            actions: ["configure", "collect-now"], blockers: [], receipt: null, receiptQuery: null,
            ...(backfill ? { backfill } : {}),
        };
        Object.assign(composite.microsoft.configurationOffer, {
            intent: "save", available: true, expectedRevision: 1, basis: "committed-native",
            values: { surfaces: ["chat", "cowork"], windowDays: 7 }, blockers: [],
        });
        composite.microsoft.actions = ["configure", "collect-now", "pause"];
        publish();
    }, backfill);
}

test("Microsoft history progress distinguishes observed histories from coverage and retained activity", async t => {
    const page = await setup(t);
    const cases = [
        [historyProgress("started", [historySource({ controlObserved: false, initial: "unobserved", pages: 0, chainPages: 0,
            eligible: 0, handled: 0, pending: 0 })]), "Not checked yet."],
        [historyProgress("progressing", [historySource()]), "Partly checked. 3 read, 2 pending."],
        [historyProgress("unqualified", [historySource({ exhausted: true, handled: 5, pending: 0 })]),
            "Coverage not verified. 5 read."],
        [historyProgress("covered", [historySource({ startQualified: true, exhausted: true, handled: 4, suppressed: 1, pending: 0 })]),
            "Window checked. 4 read, 1 kept deleted."],
        [historyProgress("progressing", [historySource({ handled: 2, suppressed: 1, pending: 1, unreadable: 1,
            stops: ["unreadable-history", "membership-budget"] })]),
            "Partly checked. 2 read, 1 kept deleted, 1 pending, 1 unreadable. More histories uncounted."],
        [historyProgress("progressing", [historySource({ stops: ["continuity-lost"] })]),
            "Partly checked. 3 read, 2 pending. Continuation interrupted."],
        [historyProgress("unqualified", [historySource({ exhausted: true, eligible: 0, handled: 0, pending: 0 })]),
            "Coverage not verified."],
        [historyProgress("covered", [historySource({ startQualified: true, exhausted: true, eligible: 0, handled: 0, pending: 0 })]),
            "Window checked. No histories in this window."],
        [historyProgress("started", [historySource({ controlObserved: false, initial: "unobserved", pages: 0, chainPages: 0,
            eligible: 0, handled: 0, pending: 0, stops: ["membership-unqualified"] })]),
            "Full history hasn't been confirmed."],
        [historyProgress("progressing", [historySource({ eligible: 0, handled: 0, pending: 0,
            stops: ["membership-unqualified"] })]), "Full history hasn't been confirmed."],
        [historyProgress("progressing", [historySource({ handled: 5, pending: 0, stops: ["membership-unqualified"] })]),
            "Full history hasn't been confirmed. 5 read."],
        ...["page-budget", "history-budget", "byte-budget", "record-budget", "time-budget"].map(stop => [
            historyProgress("progressing", [historySource({ handled: 5, pending: 0, stops: ["membership-unqualified", stop] })]),
            "Full history hasn't been confirmed. 5 read. Collection limit reached.",
        ]),
        [historyProgress("progressing", [historySource({ handled: 2, suppressed: 1, pending: 1, unreadable: 1,
            stops: ["membership-unqualified", "membership-budget", "unreadable-history"] })]),
            "Full history hasn't been confirmed. 2 read, 1 kept deleted, 1 pending, 1 unreadable. More histories uncounted."],
        [historyProgress("progressing", [historySource({ stops: ["membership-unqualified", "continuity-lost"] })]),
            "Full history hasn't been confirmed. 3 read, 2 pending. Continuation interrupted."],
        [historyProgress("progressing", [historySource({ pending: 0, handled: 5, stops: ["page-budget"] })]),
            "Partly checked. 5 read. More history to check."],
        [historyProgress("progressing", [historySource(), historySource({ surface: "cowork", eligible: 2, handled: 1, pending: 1 })]),
            "Partly checked. 3 read, 2 pending.", "Partly checked. 1 read, 1 pending."],
        [historyProgress("progressing", [
            historySource({ startQualified: true, exhausted: true, handled: 5, pending: 0 }),
            historySource({ surface: "cowork", eligible: 2, handled: 2, pending: 0, stops: ["membership-unqualified"] }),
        ]), "Window checked. 5 read.", "Full history hasn't been confirmed. 2 read."],
    ];
    for (const [backfill, chat, cowork = "Coverage not verified."] of cases) {
        await publishHistory(page, backfill);
        await expect(page.locator("#sourceMicrosoftProgress")).toHaveText(`Chat history: ${chat}\nCowork history: ${cowork}`);
        await expect(page.locator("#sourceMicrosoftProgress")).toBeVisible();
        await expect(page.locator("#sourceMicrosoftProgress .pending-indicator")).toHaveCount(0);
        await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Enabled");
        await expect(page.locator("#collectMicrosoftActivity")).toBeEnabled();
        await page.evaluate(() => ui.receiveSavedActivity("7 conversations / 20 tool calls.", token));
        await expect(page.locator("#sourceMicrosoftSaved")).toHaveText("7 conversations / 20 tool calls.");
    }
    assert.deepEqual(await page.evaluate(() => ({ writes, reads, collects })), { writes: [], reads: 0, collects: 0 });
});

test("unknown coverage and a simultaneous limit stay readable in the existing source group", async t => {
    const page = await setup(t), output = process.env.WIRE_SOURCE_CONTROL_PROOFS;
    await publishHistory(page, historyProgress("progressing", [
        historySource({ startQualified: true, exhausted: true, handled: 5, pending: 0 }),
        historySource({ surface: "cowork", eligible: 2, handled: 2, pending: 0, stops: ["membership-unqualified", "page-budget"] }),
    ]));
    const copy = "Chat history: Window checked. 5 read.\nCowork history: Full history hasn't been confirmed. 2 read. Collection limit reached.";
    await page.evaluate(() => ui.receiveSavedActivity("7 conversations / 20 tool calls.", token));
    if (output) await mkdir(output, { recursive: true });
    for (const [theme, width] of [["light", 1440], ["dark", 390]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(theme => document.documentElement.dataset.evidenceTheme = theme, theme);
        await expect(page.locator("#sourceMicrosoftProgress")).toHaveText(copy);
        await expect(page.locator("#sourceMicrosoftSaved")).toHaveText("7 conversations / 20 tool calls.");
        await expect(page.locator("#sourceMicrosoftMessage")).toBeHidden();
        await expect(page.locator("#collectMicrosoftActivity")).toBeEnabled();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (output) await page.locator("#sourceMicrosoftCollection").screenshot({
            path: path.join(output, `membership-unqualified-${theme}-${width}.png`),
        });
    }
    assert.deepEqual(await page.evaluate(() => ({ writes, reads, collects })), { writes: [], reads: 0, collects: 0 });
});

test("Microsoft history checkpoints clear on edits, failed reads and withdrawal; absent evidence stays unverified", async t => {
    const page = await setup(t), backfill = historyProgress("progressing", [
        historySource({ handled: 5, pending: 0, stops: ["membership-unqualified"] }),
    ]);
    await publishHistory(page, backfill);
    await page.selectOption("#sourceMicrosoftWindow", "14");
    await page.locator("#sourceMicrosoftWindow").dispatchEvent("input");
    await expect(page.locator("#sourceMicrosoftProgress")).toBeHidden();
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText("");
    await page.locator("#cancelMicrosoftCollection").click();
    await expect(page.locator("#sourceMicrosoftProgress")).toContainText("Full history hasn't been confirmed. 5 read.");
    await page.evaluate(() => ui.unavailable("Synthetic failed status read"));
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText("");
    await publishHistory(page, backfill);
    await expect(page.locator("#sourceMicrosoftProgress")).toBeVisible();
    await page.evaluate(() => {
        composite.microsoft.status.configuration.settings.paused = true;
        composite.microsoft.status.actions = ["configure"];
        composite.microsoft.status.blockers = ["NATIVE_RETENTION_PAUSED"];
        composite.microsoft.actions = ["configure", "resume"];
        publish();
    });
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    await expect(page.locator("#sourceMicrosoftProgress")).toContainText("Full history hasn't been confirmed. 5 read.");
    await expect(page.locator("#collectMicrosoftActivity")).toBeDisabled();
    await page.evaluate(() => {
        composite.microsoft.status.configuration.privacyRevision++;
        delete composite.microsoft.status.backfill;
        publish();
    });
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText(
        "Chat history: Coverage not verified.\nCowork history: Coverage not verified.");
    await publishHistory(page, null);
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText(
        "Chat history: Coverage not verified.\nCowork history: Coverage not verified.");
    await publishHistory(page, backfill);
    await page.evaluate(() => {
        window.oldHistoryToken = token;
        window.oldHistoryStatus = structuredClone(composite);
        access.readable = false;
        authority.withdraw();
        ui.withdrawAccess();
    });
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText("");
    await page.evaluate(() => {
        access.readable = true; token = {}; delete composite.microsoft.status.backfill;
        ui.resumeAccess(); publish();
        if (ui.receive(oldHistoryStatus, oldHistoryToken) !== false) throw new Error("Stale history publication was accepted.");
    });
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText(
        "Chat history: Coverage not verified.\nCowork history: Coverage not verified.");
    assert.deepEqual(await page.evaluate(() => ({ writes, reads, collects })), { writes: [], reads: 0, collects: 0 });
});
