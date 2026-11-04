import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { mountCollectionSettings } from "../web/settings.mjs";

function fixtureHtml() {
    const nonce = "settings-access-fixture";
    let html = renderHtmlShell("a".repeat(64), nonce);
    html = html.slice(0, html.lastIndexOf(`<script nonce="${nonce}">`)) + "</body></html>";
    html = html.replace(/<link rel="icon"[^>]*>/, "");
    const script = `
const ux=(${createEvidenceUX.toString()})(${JSON.stringify(uxIcons).replaceAll("<", "\\u003c")});
const $=id=>document.getElementById(id);
$("loading").hidden=true;$("workspace").hidden=false;
for(const child of $("workspace").children) child.hidden=child.id!=="settingsView"&&!child.classList.contains("page-heading");
$("settingsView").hidden=false;$("pageTitle").textContent="Settings";
$("pageIntro").hidden=true;$("pagePrimaryActions").hidden=true;
window.fixtureToken={epoch:1};window.fixtureAllowed=true;window.fixtureNow=0;window.fixtureDeadline=5000;
window.fixtureApi=Object.assign(()=>{throw Error("No transport requests in owner proof.");},{
 publicationToken:()=>fixtureAllowed&&fixtureNow<fixtureDeadline?fixtureToken:null,
 isCurrent:token=>token===fixtureToken&&fixtureAllowed&&fixtureNow<fixtureDeadline
});
window.fixtureStatus=(name="SECRET_ALPHA",version=1)=>({configVersion:version,connected:true,config:{
 approved:true,enabled:false,appDbPath:"C:\\\\fixture\\\\"+name+"\\\\data.db",sessionRoot:"C:\\\\fixture\\\\"+name+"\\\\session-state",windowDays:30,pollSeconds:5
}});
window.fixtureEvents=[];window.fixtureJobs=[];window.fixtureWrites=[];window.fixtureReads=0;
window.fixtureRevokeOnInvalidate=false;
window.fixtureRevoke=()=>{fixtureAllowed=false;fixtureToken={epoch:fixtureToken.epoch+1};$("settingsView").hidden=true;fixtureUI.withdrawAccess();};
window.fixtureGrant=()=>{fixtureAllowed=true;fixtureToken={epoch:fixtureToken.epoch+1};fixtureDeadline=fixtureNow+5000;return fixtureUI.resumeAccess();};
window.fixtureMount=${mountCollectionSettings.toString()};
window.fixtureUI=fixtureMount({
 api:fixtureApi,ux,
 write:(endpoint,input)=>{fixtureWrites.push({endpoint,input:structuredClone(input)});return new Promise((resolve,reject)=>fixtureJobs.push({kind:"write",resolve,reject}));},
 read:()=>{fixtureReads++;return new Promise((resolve,reject)=>fixtureJobs.push({kind:"read",resolve,reject}));},
 invalidate:()=>{fixtureEvents.push("invalidate");if(fixtureRevokeOnInvalidate)fixtureRevoke();},
 onDraftChange:dirty=>fixtureEvents.push("draft:"+dirty)
});
fixtureUI.receive(fixtureStatus(),fixtureApi.publicationToken());
fixtureUI.setSection("connection","source-paths");
document.body.dataset.fixtureReady="true";
`;
    return html.replace("</body>", `<script nonce="${nonce}">${script}</script></body>`);
}

async function setup(t) {
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (route.request().url() === "http://settings.fixture.invalid/") return route.fulfill({ contentType: "text/html", body: fixtureHtml() });
        requests.push(route.request().url()); return route.abort();
    });
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(requests, []); });
    await page.goto("http://settings.fixture.invalid/");
    await expect(page.locator("body")).toHaveAttribute("data-fixture-ready", "true");
    return page;
}
async function safeDraft(page) {
    await page.selectOption("#collectionWindow", "7");
    await page.locator("#collectionWindow").dispatchEvent("input");
    await page.selectOption("#collectionCadence", "15");
    await page.locator("#collectionCadence").dispatchEvent("input");
}
async function fresh(page, name = "SECRET_BETA", version = 2) {
    await page.evaluate(({ name, version }) => {
        fixtureUI.receive(fixtureStatus(name, version), fixtureApi.publicationToken());
        document.getElementById("settingsView").hidden = false;
    }, { name, version });
}
async function assertNoAlpha(page) {
    const values = await page.evaluate(() => {
        const body = document.body.cloneNode(true);
        body.querySelectorAll("script").forEach(node => node.remove());
        return { html: body.innerHTML,
            fields: [...document.querySelectorAll("input")].flatMap(input => [input.value, input.defaultValue, input.getAttribute("value"), input.title]) };
    });
    assert.doesNotMatch(JSON.stringify(values), /SECRET_ALPHA/);
}

test("withdrawal synchronously clears private source presentation but retains safe unsent preferences", async t => {
    const page = await setup(t);
    await safeDraft(page);
    await page.locator("#themePreference").focus();
    await page.evaluate(() => {
        fixtureUI.unavailable("SECRET_ALPHA_READ_ERROR", fixtureApi.publicationToken());
        window.heldSourceText = ["approvedDatabase", "approvedSessions", "settingsConnectionError"].map(id => document.getElementById(id).firstChild);
        window.heldSourceBefore = heldSourceText.map(node => node.data);
        window.oldToken=fixtureApi.publicationToken();
        window.beforeEvents=fixtureEvents.length;
        window.beforeFocus=document.activeElement;
        fixtureRevoke();fixtureUI.withdrawAccess();
    });
    await assertNoAlpha(page);
    assert.equal(await page.evaluate(() => heldSourceBefore.slice(0, 2).every(value => value.includes("SECRET_ALPHA"))), true);
    assert.equal(await page.evaluate(() => heldSourceBefore[2]), "Collection settings could not be read.");
    assert.deepEqual(await page.evaluate(() => heldSourceText.map(node => node.data)), ["", "", ""]);
    await expect(page.locator("#sourceDatabase")).toHaveValue("");
    await expect(page.locator("#sourceSessions")).toHaveValue("");
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#collectionCadence")).toHaveValue("15");
    assert.deepEqual(await page.evaluate(() => ({
        events:fixtureEvents.length===beforeEvents, focus:document.activeElement===beforeFocus,
        writes:fixtureWrites.length,reads:fixtureReads,dirty:fixtureUI.hasDraft(),refresh:fixtureUI.canRefresh(),
        late:fixtureUI.receive(fixtureStatus("SECRET_ALPHA_LATE"),oldToken),
        error:fixtureUI.unavailable("SECRET_ALPHA_ERROR_LATE",oldToken),
        checking:fixtureUI.setChecking(true,oldToken),explanation:fixtureUI.explain("sourceDatabase"),
    })), {events:true,focus:true,writes:0,reads:0,dirty:true,refresh:false,late:false,error:false,checking:false,explanation:""});
    await assertNoAlpha(page);
    await page.evaluate(() => fixtureGrant());
    await expect(page.locator("#sourceDatabase")).toHaveValue("");
    await fresh(page);
    assert.deepEqual(await page.evaluate(() => heldSourceText.map(node => node.data)), ["", "", ""]);
    await assertNoAlpha(page);
    await expect(page.locator("#sourceDatabase")).toHaveValue("C:\\fixture\\SECRET_BETA\\data.db");
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#collectionCadence")).toHaveValue("15");
    await expect(page.locator("#saveCollection")).toBeEnabled();
});

for (const result of ["success", "error"]) test(`old read ${result} and finalizer cannot repaint or unlock a newer read`, async t => {
    const page = await setup(t);
    await page.evaluate(() => fixtureUI.unavailable("SECRET_ALPHA_READ_ERROR",fixtureApi.publicationToken()));
    await page.locator("#reloadSettings").click();
    await expect.poll(() => page.evaluate(() => fixtureJobs.length)).toBe(1);
    await page.evaluate(() => {window.oldToken=fixtureApi.publicationToken();fixtureRevoke();fixtureGrant();});
    await fresh(page);
    await page.evaluate(() => fixtureUI.unavailable("Current read retry",fixtureApi.publicationToken()));
    await page.locator("#reloadSettings").click();
    await expect.poll(() => page.evaluate(() => fixtureJobs.length)).toBe(2);
    await page.evaluate(result => {
        window.eventsBeforeLate=fixtureEvents.length;
        if(result==="success")fixtureJobs[0].resolve(fixtureStatus("SECRET_ALPHA_LATE",9));
        else fixtureJobs[0].reject(new Error("SECRET_ALPHA_LATE_ERROR"));
    }, result);
    await page.evaluate(() => new Promise(resolve=>setTimeout(resolve,0)));
    await assertNoAlpha(page);
    assert.equal(await page.evaluate(()=>fixtureUI.isBusy()),true);
    assert.equal(await page.evaluate(()=>fixtureEvents.length===eventsBeforeLate),true);
    await page.evaluate(()=>fixtureJobs[1].resolve(fixtureStatus("SECRET_BETA",2)));
    await expect.poll(()=>page.evaluate(()=>fixtureUI.isBusy())).toBe(false);
    await assertNoAlpha(page);
    await expect(page.locator("#settingsConnectionError")).toBeHidden();
});

for (const result of ["success", "error"]) test(`revoked write ${result} keeps original uncertainty and never repaints or replays`, async t => {
    const page = await setup(t);
    await safeDraft(page);
    await page.locator("#saveCollection").click();
    await expect.poll(()=>page.evaluate(()=>fixtureWrites.length)).toBe(1);
    await page.evaluate(()=>{fixtureRevoke();fixtureGrant();});
    await fresh(page);
    await assertNoAlpha(page);
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await page.evaluate(result=>{
        window.eventsBeforeLate=fixtureEvents.length;window.focusBeforeLate=document.activeElement;
        if(result==="success")fixtureJobs[0].resolve(fixtureStatus("SECRET_ALPHA_COMMITTED",3));
        else fixtureJobs[0].reject(new Error("SECRET_ALPHA_WRITE_ERROR"));
    },result);
    await expect.poll(()=>page.evaluate(()=>fixtureUI.isBusy())).toBe(false);
    await assertNoAlpha(page);
    assert.equal(await page.evaluate(()=>fixtureEvents.length===eventsBeforeLate),true);
    assert.equal(await page.evaluate(()=>document.activeElement===focusBeforeLate),true);
    assert.equal(await page.evaluate(()=>fixtureUI.canRefresh()),false);
    await fresh(page);
    await expect(page.locator("#settingsMessage")).toContainText("unconfirmed");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await expect(page.locator("#reloadSettings")).toBeEnabled();
    await page.locator("#reloadSettings").click();
    await expect.poll(()=>page.evaluate(()=>fixtureJobs.length)).toBe(2);
    await page.evaluate(()=>fixtureJobs[1].resolve(fixtureStatus("SECRET_BETA",2)));
    await expect(page.locator("#saveCollection")).toBeEnabled();
    assert.equal(await page.evaluate(()=>fixtureWrites.length),1);
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#collectionCadence")).toHaveValue("15");
});

test("revocation before write invocation is not dispatched and does not invent write uncertainty", async t => {
    const page = await setup(t);
    await safeDraft(page);
    await page.evaluate(()=>{fixtureRevokeOnInvalidate=true;});
    await page.locator("#saveCollection").click();
    await assertNoAlpha(page);
    assert.equal(await page.evaluate(()=>fixtureWrites.length),0);
    assert.equal(await page.evaluate(()=>fixtureUI.isBusy()),false);
    await page.evaluate(()=>fixtureGrant());
    await fresh(page);
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await expect(page.locator("#reloadSettings")).toBeHidden();
});

test("current-authority errors retain original recovery and deadlines block dispatch", async t => {
    const page = await setup(t);
    await safeDraft(page);
    await page.locator("#saveCollection").click();
    await page.evaluate(()=>fixtureJobs[0].reject(new Error("Current fixture failure")));
    await expect(page.locator("#settingsMessage")).toContainText("unconfirmed");
    await expect(page.locator("#sourceDatabase")).toHaveValue("C:\\fixture\\SECRET_ALPHA\\data.db");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await page.locator("#reloadSettings").click();
    await page.evaluate(()=>fixtureJobs[1].resolve(fixtureStatus()));
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await page.evaluate(()=>{fixtureNow=5000;});
    await page.locator("#saveCollection").click();
    assert.equal(await page.evaluate(()=>fixtureWrites.length),1);
    await page.evaluate(()=>fixtureRevoke());
    await assertNoAlpha(page);
});

test("unqualified delivery is explicit and readiness alone restores no source data", async t => {
    const page = await setup(t);
    await assert.rejects(page.evaluate(()=>fixtureUI.receive(fixtureStatus())),/publication token/);
    await assert.rejects(page.evaluate(()=>fixtureMount({api:null})),/shared publication interface/);
    const malformed = await page.evaluate(() => {
        const original = fixtureApi.isCurrent, capture = fixtureApi.publicationToken;
        const before = document.getElementById("sourceDatabase").value;
        const facts = [];
        try {
            for (const result of [Promise.resolve(false), 1]) {
                fixtureApi.isCurrent = () => result;
                facts.push({ receive: fixtureUI.receive(fixtureStatus("SECRET_REJECTED"), capture()),
                    error: fixtureUI.unavailable("SECRET_REJECTED_ERROR", capture()),
                    checking: fixtureUI.setChecking(true, capture()), resume: fixtureUI.resumeAccess(),
                    refresh: fixtureUI.canRefresh(), unchanged: document.getElementById("sourceDatabase").value === before });
            }
            fixtureApi.isCurrent = () => true;
            for (const token of [undefined, null, Promise.resolve(capture()), { then() {} }]) {
                fixtureApi.publicationToken = () => token;
                facts.push({ resume: fixtureUI.resumeAccess(), refresh: fixtureUI.canRefresh(),
                    delivery: token === undefined ? "missing" : fixtureUI.receive(fixtureStatus("SECRET_REJECTED_TOKEN"), token) });
            }
        } finally { fixtureApi.isCurrent = original; fixtureApi.publicationToken = capture; }
        return facts;
    });
    assert.deepEqual(malformed.slice(0, 2), Array.from({ length: 2 }, () => ({
        receive: false, error: false, checking: false, resume: false, refresh: false, unchanged: true,
    })));
    assert.deepEqual(malformed.slice(2), [undefined, null, "promise", "thenable"]
        .map(token => ({ resume: false, refresh: false, delivery: token === undefined ? "missing" : false })));
    await page.evaluate(()=>fixtureRevoke());
    assert.equal(await page.evaluate(()=>fixtureUI.resumeAccess()),false);
    await page.evaluate(()=>fixtureGrant());
    await page.evaluate(()=>fixtureUI.setSection("connection"));
    await expect(page.locator("#sourceDatabase")).toHaveValue("");
    await expect(page.locator("#approvedDatabase")).toBeEmpty();
    await expect(page.locator("#collectionWindow")).toBeDisabled();
    await expect(page.locator("#sourceDatabase")).toBeDisabled();
    assert.equal(await page.evaluate(()=>fixtureUI.canRefresh()),false);
    assert.equal(await page.evaluate(()=>fixtureReads),0);
    assert.equal(await page.evaluate(()=>fixtureWrites.length),0);
});

test("repeated withdrawal before a fresh status cannot erase the original safe preference draft", async t => {
    const page = await setup(t);
    await safeDraft(page);
    await page.evaluate(()=>{fixtureRevoke();fixtureGrant();fixtureRevoke();fixtureUI.withdrawAccess();fixtureGrant();});
    await fresh(page);
    await assertNoAlpha(page);
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#collectionCadence")).toHaveValue("15");
    await expect(page.locator("#saveCollection")).toBeEnabled();
    assert.equal(await page.evaluate(()=>fixtureUI.hasDraft()),true);
});

test("suggested and edited source paths are erased without retaining a private source draft", async t => {
    const page = await setup(t);
    await page.evaluate(()=>{
        const status=fixtureStatus();
        status.suggestedSource={...status.config,error:"SECRET_ALPHA_SUGGESTION"};
        status.config=null;
        fixtureUI.receive(status,fixtureApi.publicationToken());
    });
    await page.locator("#reviewSource").click();
    await page.locator("#sourceDatabase").fill("C:\\SECRET_ALPHA_EDITED\\data.db");
    await page.locator("#sourceDatabase").evaluate(node=>{node.defaultValue="SECRET_ALPHA_DEFAULT";node.title="SECRET_ALPHA_TITLE";});
    await page.evaluate(()=>{
        window.sourceAttrs=["value","title"].map(name=>document.getElementById("sourceDatabase").getAttributeNode(name));
        window.sourceAttrBefore=sourceAttrs.map(attr=>attr.value);
        fixtureRevoke();
    });
    await assertNoAlpha(page);
    assert.deepEqual(await page.evaluate(()=>sourceAttrBefore), ["SECRET_ALPHA_DEFAULT", "SECRET_ALPHA_TITLE"]);
    assert.deepEqual(await page.evaluate(()=>sourceAttrs.map(attr=>attr.value)), ["", ""]);
    assert.equal(await page.evaluate(()=>fixtureUI.hasDraft()),false);
    await page.evaluate(()=>fixtureGrant());
    await fresh(page);
    assert.deepEqual(await page.evaluate(()=>sourceAttrs.map(attr=>attr.value)), ["", ""]);
    await assertNoAlpha(page);
    await expect(page.locator("#sourceEditor")).toBeHidden();
    await expect(page.locator("#sourceDatabase")).toHaveValue("C:\\fixture\\SECRET_BETA\\data.db");
});

test("revoked recovery read cannot settle the original uncertain write", async t => {
    const page = await setup(t);
    await safeDraft(page);
    await page.locator("#saveCollection").click();
    await page.evaluate(()=>fixtureJobs[0].reject(new Error("Original write outcome unknown")));
    await expect(page.locator("#reloadSettings")).toBeEnabled();
    await page.locator("#reloadSettings").click();
    await page.evaluate(()=>{fixtureRevoke();fixtureGrant();});
    await fresh(page);
    await page.evaluate(()=>fixtureJobs[1].resolve(fixtureStatus("SECRET_ALPHA_OLD_RECOVERY",9)));
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    await assertNoAlpha(page);
    await fresh(page);
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await expect(page.locator("#settingsMessage")).toContainText("unconfirmed");
    await page.locator("#reloadSettings").click();
    await page.evaluate(()=>fixtureJobs[2].resolve(fixtureStatus("SECRET_BETA",2)));
    await expect(page.locator("#saveCollection")).toBeEnabled();
    assert.equal(await page.evaluate(()=>fixtureWrites.length),1);
});

test("current publication preserves normal preference save, pause state and completion focus", async t => {
    const page = await setup(t);
    await safeDraft(page);
    await page.locator("#saveCollection").click();
    assert.deepEqual(await page.evaluate(()=>fixtureWrites[0]), {
        endpoint:"/api/collection/configure",
        input:{appDbPath:"C:\\fixture\\SECRET_ALPHA\\data.db",sessionRoot:"C:\\fixture\\SECRET_ALPHA\\session-state",
            windowDays:7,pollSeconds:15,approved:true,enabled:false,expectedConfigVersion:1},
    });
    await page.evaluate(()=>{
        const saved=fixtureStatus("SECRET_ALPHA",2);
        saved.config.windowDays=7;saved.config.pollSeconds=15;
        fixtureJobs[0].resolve(saved);
    });
    await expect(page.locator("#settingsMessage")).toContainText("Preferences saved");
    await expect(page.locator("#settingsMessage")).toBeFocused();
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await expect(page.locator("#cancelPreferences")).toBeDisabled();
    assert.equal(await page.evaluate(()=>fixtureUI.canRefresh()),true);
    await expect(page.locator("#connectionStatus")).toHaveText("Paused");
});
