import { renderHtmlShell } from "../lib/render.mjs";
import { mountAccountSettingsPresentation } from "../web/account-settings-presentation.mjs";
import { accountSettingsStyles } from "../web/account-settings-styles.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { mountCollectionSettings } from "../web/settings.mjs";
import { mountThemeControl } from "../web/theme-control.mjs";
import { createSelectControls } from "../web/select-control.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hostPin = "9476c3f5c38cf251bb12d5fdc99a3ee75b9c0ab7";
let bundle;
function shellBundle() {
    if (bundle) return bundle;
    const pin = process.env.WIRE_ACCOUNT_RENDERER_PIN, nonce = "account-presentation-fixture";
    if (!pin) return bundle = { source: "current-worktree", html: renderHtmlShell("a".repeat(64), nonce),
        ux: createEvidenceUX.toString(), icons: uxIcons, collection: mountCollectionSettings.toString(),
        theme: mountThemeControl.toString(), selects: createSelectControls.toString() };
    if (pin !== hostPin) throw new Error("Only the coordinator's released immutable host pin is supported.");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const loader = `
import {registerHooks} from "node:module";
import {execFileSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import path from "node:path";
const root=${JSON.stringify(root)},pin=${JSON.stringify(pin)};
const local=url=>url.startsWith("file:")&&["lib","web"].some(name=>path.relative(root,fileURLToPath(url)).startsWith(name+path.sep));
registerHooks({resolve(specifier,context,next) {
    if(specifier.startsWith(".")||specifier.startsWith("file:")) {
        const url=new URL(specifier,context.parentURL).href;
        if(local(url))return {url,shortCircuit:true};
    }
    return next(specifier,context);
},load(url,context,next) {
    if(!url.startsWith("file:"))return next(url,context);
    const relative=path.relative(root,fileURLToPath(url));
    if(!["lib","web"].some(name=>relative.startsWith(name+path.sep)))return next(url,context);
    return {format:"module",source:execFileSync("git",["show",pin+":"+relative.split(path.sep).join("/")],{cwd:root,encoding:"utf8"}),shortCircuit:true};
}});
const load=name=>import(pathToFileURL(path.join(root,name)).href);
const {renderHtmlShell}=await load("lib\\\\render.mjs");
const {createEvidenceUX}=await load("web\\\\ux.mjs");
const {uxIcons}=await load("web\\\\ux-icons.mjs");
const {mountCollectionSettings}=await load("web\\\\settings.mjs");
const {mountThemeControl}=await load("web\\\\theme-control.mjs");
const {createSelectControls}=await load("web\\\\select-control.mjs");
console.log(JSON.stringify({source:pin,html:renderHtmlShell("a".repeat(64),${JSON.stringify(nonce)}),
    ux:createEvidenceUX.toString(),icons:uxIcons,collection:mountCollectionSettings.toString(),
    theme:mountThemeControl.toString(),selects:createSelectControls.toString()}));`;
    return bundle = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", loader], {
        cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    }));
}

export const unavailableGitHubProfile = {
    schemaVersion: 1, provider: "github", generation: "fixture-unbound",
    identity: { state: "unavailable", reason: "account-match-unavailable", host: null, login: null },
    displayName: { value: null, source: "unavailable", freshness: "unavailable" },
    avatar: { state: "unavailable", reason: "identity-unavailable", url: null, expiresAt: null },
    fallback: { kind: "neutral", text: null, source: "unavailable" }, issues: [],
};
export const verifiedGitHubProfile = {
    ...unavailableGitHubProfile, generation: "fixture-riley",
    identity: { state: "verified", reason: null, host: "github.com", login: "riley-chen" },
    displayName: { value: "Riley Chen", source: "github-public-profile", freshness: "current" },
    avatar: { state: "unavailable", reason: "avatar-missing", url: null, expiresAt: null },
    fallback: { kind: "initials", text: "R", source: "verified-login" },
};
export function presentationFixture(state = null, profile = unavailableGitHubProfile) {
    const surface = { access: state === "connected" ? "verified-synthetic" : "not-verified", qualification: "production-unqualified" };
    return { github: { phase: "ready", profile }, lifecycle: state ? {
        stage: "synthetic-only", generation: 1, wire: "signed-in", collection: "enabled",
        microsoft: { state, reason: state === "unavailable" ? "hooks-unqualified" : null, partition: null,
            surfaces: { chat: { ...surface }, cowork: { ...surface } } },
        authorization: { retained: true, githubAcquisition: true, microsoftAcquisition: false, microsoftPartition: null },
        actions: ["wire-sign-out"],
    } : null };
}

// Explicit visual-only seam: synthetic publication, no command or receipt implementation.
function createSyntheticPresentationApi() {
    const owner = Object.freeze({});
    let token = Object.freeze({}), epoch = 0;
    let status = {
        schemaVersion: 1, mode: "enforced", runtimeId: "00000000-0000-4000-8000-000000000072",
        stage: "private-fixture", authorizationRevision: 0, generation: 0,
        wire: "signed-in", retained: true, collection: "enabled", actions: [],
        maxWaitMs: 1000, freshnessMs: 5000,
        enforcement: { backendReads: "generation-fenced", acquisition: "writer-integration-pending",
            accountPartitions: "native-provenance-unqualified", clientClearance: "not-integrated" },
    };
    const api = async (path, input) => {
        if (path !== "/api/access/status" || input !== undefined) throw new Error("Visual fixture operations are disabled.");
        return structuredClone(status);
    };
    api.accessState = () => ({
        mode: "enforced", runtimeId: status.runtimeId, readable: status.retained, epoch, reason: "current",
        state: { schemaVersion: 1, runtimeId: status.runtimeId, generation: status.generation,
            authorizationRevision: status.authorizationRevision, wire: status.wire,
            retained: status.retained, collection: status.collection },
    });
    api.publicationToken = () => token;
    api.isCurrent = value => value !== null && value === token && status.retained;
    api.controlToken = () => owner;
    api.isControlCurrent = value => value === owner;
    api.setScenario = (wire, collection) => {
        if (!["signed-in", "signed-out"].includes(wire) || !["enabled", "paused"].includes(collection)) {
            throw new Error("Invalid synthetic presentation scenario.");
        }
        if (wire === status.wire && collection === status.collection) return;
        const retained = wire === "signed-in";
        if (retained !== status.retained) { epoch++; token = retained ? Object.freeze({}) : null; }
        status = { ...status, wire, collection, retained,
            generation: status.generation + 1, authorizationRevision: status.authorizationRevision + 1 };
    };
    return api;
}

// Uses the actual shell and Settings owner, with no production client, runtime or source.
export function renderAccountSettingsFixture() {
    const nonce = "account-presentation-fixture";
    const shell = shellBundle();
    let html = shell.html;
    if (!html.includes('id="wireAccountEntry" hidden') || !html.includes('id="microsoftConnectionHost" hidden')) {
        throw new Error("The actual renderer does not yet contain the coordinator-owned hosts. Explicitly use the released renderer pin for staging.");
    }
    html = html.slice(0, html.lastIndexOf(`<script nonce="${nonce}">`)) + "</body></html>";
    html = html.replace(/<link rel="icon"[^>]*>/, "");
    html = html.replace("</head>", `<style>${accountSettingsStyles}</style></head>`);
    const script = `
const ux = (${shell.ux})(${JSON.stringify(shell.icons).replaceAll("<", "\\u003c")});
const $ = id => document.getElementById(id);
$("loading").hidden = true; $("workspace").hidden = false; $("workspace").setAttribute("aria-busy", "false");
for (const child of $("workspace").children) child.hidden = child.id !== "settingsView" && !child.classList.contains("page-heading");
$("settingsView").hidden = false; $("pageTitle").textContent = "Settings";
$("pageIntro").hidden = true;
$("pagePrimaryActions").hidden = true;
for (const section of document.querySelectorAll("[data-settings-section]")) section.hidden = section.dataset.settingsSection !== "connection";
$("settingsCategoryNav").innerHTML = '<a href="#settings?section=connection" aria-current="page">Connection &amp; updates</a>';
for (const link of document.querySelectorAll(".primary-navigation [data-nav]")) link.prepend(ux.icon("navigation-" + link.dataset.nav));
$("navigationToggle").replaceChildren(ux.icon("menu"));
const accountSlot = $("wireAccountEntry"), connectionSlot = $("microsoftConnectionHost");
if (!accountSlot || !connectionSlot) throw new Error("The coordinator's real shell host pin is required.");
mountNavigation(ux);
(${shell.theme})(evidenceTheme, ux);
evidenceTheme.setPreference("light");
window.fixtureWrites = [];
window.fixtureApi = (${createSyntheticPresentationApi.toString()})();
window.fixtureCollection = (${shell.collection})({
    api: fixtureApi, ux, write: async (url, value) => { window.fixtureWrites.push({url, value}); throw new Error("Fixture writes are disabled."); },
    read: async () => { throw new Error("Fixture reads are disabled."); }, invalidate() {}, onDraftChange() {}
});
fixtureCollection.receive({configVersion: 1, connected: true, config: {
    approved: true, enabled: true, appDbPath: "C:\\\\synthetic\\\\data.db", sessionRoot: "C:\\\\synthetic\\\\chats", windowDays: 30, pollSeconds: 15
}}, fixtureApi.publicationToken());
fixtureCollection.setSection("connection");
(${shell.selects})(ux);
window.fixturePresentation = (${mountAccountSettingsPresentation.toString()})({api: fixtureApi, ux, accountSlot, connectionSlot});
window.fixtureReceive = snapshot => {
    fixtureApi.setScenario(snapshot.lifecycle?.wire ?? "signed-in", snapshot.lifecycle?.collection ?? "enabled");
    if (!fixtureApi.accessState().readable) fixturePresentation.withdrawAccess();
    fixturePresentation.receiveAccess(fixtureApi.accessState());
    const originalToken = fixtureApi.publicationToken();
    return fixturePresentation.receive(snapshot, originalToken);
};
fixtureReceive(${JSON.stringify(presentationFixture()).replaceAll("<", "\\u003c")});
document.body.dataset.accountFixtureReady = "true";
document.body.dataset.accountShellSource = ${JSON.stringify(shell.source)};
`;
    return html.replace("</body>", `<script nonce="${nonce}">${script}</script></body>`);
}
