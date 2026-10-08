import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { chatCopy } from "../lib/chat-copy.mjs";
import { createPeriodFlow } from "../web/period-flow.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { createControlHelp } from "../lib/control-help.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { time } from "../lib/time.mjs";
import { fixture } from "./helpers.mjs";

const timeContext = time.normalize({ timeZone: "America/Los_Angeles", locale: "en-US" });

test("authored source-chat copy has no legacy session phrases on key surfaces", async () => {
    const files = [
        "lib/render.mjs", "web/client.mjs", "web/settings.mjs", "web/period-flow.mjs",
        "web/report-journey.mjs", "lib/control-help.mjs", "lib/collection-status.mjs",
        "lib/product-report.mjs", "lib/export.mjs", "lib/runtime-client.mjs", "lib/server.mjs",
    ];
    // Technical tokens (sessionId, session-state, source-session-and-tool-call,
    // routes, CSS classes) are contracts. This guard targets authored phrases,
    // not dynamic names, original evidence, raw diagnostics or historical exports.
    const legacy = /\b(?:Copilot sessions?|source[- ]sessions?|local sessions?|saved session history|sessions? (?:analysis|results|names?|requests)|(?:this|another|one|a|to|eligible|unavailable|unscoped|affected|new|matching|recorded) sessions?)(?![-\w])/i;
    for (const file of files) {
        const source = await readFile(new URL("../" + file, import.meta.url), "utf8");
        assert.doesNotMatch(source, legacy, file);
    }
    const shell = await readFile(new URL("../lib/render.mjs", import.meta.url), "utf8");
    assert.match(shell, /aria-label="Copilot chat analysis"/);
    assert.match(shell, /GitHub Copilot chat/);
    assert.match(shell, /Find a Copilot chat or request/);
    const settings = await readFile(new URL("../web/settings.mjs", import.meta.url), "utf8");
    assert.match(settings, /Chat history folder/);
    assert.match(settings, /Contains recorded events \(session-state\)/);
    assert.match(settings, /Report disclosure is separate/);
    const client = await readFile(new URL("../web/client.mjs", import.meta.url), "utf8");
    assert.match(client, /"session", "request", "page"/, "Route keys remain compatible");
    const server = await readFile(new URL("../lib/server.mjs", import.meta.url), "utf8");
    assert.match(server, /"\/api\/session"/);
    assert.match(server, /code: "session_expired"/);
});

test("zero, one, many and unavailable chat counts preserve canonical source/request keys", () => {
    const describe = createPeriodFlow(time);
    for (const total of [0, 1, 3]) {
        const rows = Array.from({ length: total }, (_, i) => ({ sourceSessionId: `chat-${i}`, scenarioId: `request-${i}` }));
        const result = describe({ rows: rows.flatMap(row => [row, row]), filters: {}, coverage: {}, timeContext });
        assert.equal(result.sessions, total);
        assert.equal(result.requests, total);
        assert.equal(chatCopy.count(total), `${total} Copilot chat${total === 1 ? "" : "s"}`);
        assert.equal(chatCopy.count(total, true), `${total} GitHub Copilot chat${total === 1 ? "" : "s"}`);
        assert.match(result.summary, new RegExp(`^${total} Copilot chats? / ${total} request groups? with ${total * 2} Work IQ tool calls\\.$`));
        if (total) assert.match(result.next, /^All retained dates/);
    }
    assert.equal(chatCopy.count(undefined), "Copilot chat count unavailable");
    assert.equal(chatCopy.count(-1), "Copilot chat count unavailable");
    const unlinked = describe({ rows: [{ scenarioId: "unlinked" }], filters: {}, coverage: {}, timeContext });
    assert.equal(unlinked.sessions, 0);
    assert.equal(unlinked.requests, 1);
    const focused = describe({ rows: [{ sourceSessionId: "one", scenarioId: "request" }], filters: {}, coverage: {}, timeContext, session: true });
    assert.match(focused.summary, /^This Copilot chat: 1 request group with 1 Work IQ tool call/);
    assert.match(focused.next, /Groups follow recorded messages/);
});

test("diagnostic names remain verbatim while fallback and help labels identify chats", () => {
    const model = createCollectionStatus();
    const sources = [{ sessionId: "one", name: "Original session title", eligible: true }, { sessionId: "two", eligible: true }];
    const cursors = sources.map(source => ({ sessionId: source.sessionId, error: "Original session error", errorCode: "ENOENT" }));
    const before = structuredClone({ sources, cursors });
    const { issues, summary } = model.coverage(sources, cursors);
    assert.equal(issues[0].name, "Original session title");
    assert.equal(issues[1].name, "Copilot chat name not recorded");
    assert.equal(summary.unavailable, 2);
    assert.equal(model.dispositions["unmapped-workspace-session"], "Copilot chats without a verified workspace link");
    assert.deepEqual({ sources, cursors }, before);
    assert.equal(model.view({ config: {}, discovery: {}, lastCheckedAt: "now", historyCoverage: { eligible: 0 } }).label, "No local Copilot chats to collect");
    const help = createControlHelp(serviceCategories);
    assert.match(help.facts["Copilot chat ID"], /GitHub Copilot chat.*sourceSessionId/);
    assert.match(help.fields.activitySearch, /GitHub Copilot chat names/);
});

test("new HTML, PDF, JSON and Markdown use chat wording without rewriting original session text or schemas", { timeout: 60000 }, async () => {
    const source = fixture("terminology-report");
    const original = "Please inspect the session from 2026-09-30T23:45:00Z.\nKeep sessionId and this session wording exactly.";
    source.sourceSessionName = "Historical session title";
    source.userPrompt.text = original;
    source.followUpPrompts = [];
    const before = structuredClone(source);
    const bundle = await buildSanitizedBundle([source], "a".repeat(64), {
        promptMode: "original", formats: ["html", "pdf", "json", "markdown"], timeContext,
        dateSelection: { range: "custom", from: "2026-09-30", to: "2026-09-30" },
    });
    const snapshot = JSON.parse(bundle.files["product-report.json"]);
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    assert.equal(snapshot.schemaVersion, 3);
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(snapshot.records[0].prompts[0].text, original);
    assert.match(snapshot.records[0].sourceSessionId, /^session-[a-f0-9]{16}$/);
    assert.equal(snapshot.coverage.distinctSourceSessions, 1);
    assert.equal(snapshot.coverage.unscopedSessions, 0);
    assert.equal(Object.hasOwn(snapshot.coverage, "distinctSourceChats"), false);
    assert.equal(Object.hasOwn(snapshot.records[0], "sourceChatId"), false);
    assert.equal(snapshot.timeContext.timeZone, "America/Los_Angeles");
    assert.equal(snapshot.dateRange.from, "2026-09-30T07:00:00.000Z");
    assert.equal(snapshot.dateRange.to, "2026-10-01T07:00:00.000Z");
    assert.match(manifest.transformations.localHistory, /GitHub Copilot chat history/);
    assert.match(snapshot.limits.join(" "), /GitHub Copilot chat history/);
    const task = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    const pdf = await task.promise;
    const pages = [];
    try {
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i), viewport = page.getViewport({ scale: 1 });
            const { items } = await page.getTextContent();
            for (const item of items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1);
            }
            pages.push(items.map(item => item.str || "").join(" "));
        }
    } finally { await task.destroy(); }
    for (const text of [bundle.files["product-report.html"], bundle.files["product-report.md"], pages.join(" ")]) {
        assert.match(text, /1 GitHub Copilot chat/);
        assert.doesNotMatch(text, /source sessions|unscoped sessions|1 GitHub Copilot chats/);
        assert.match(text, /inspect the session from 2026-09-30T23:45:00Z/);
        assert.match(text, /Keep sessionId and this session wording exactly/);
        assert.match(text, /America\/Los_Angeles/);
    }
    assert.deepEqual(source, before);
    assert.equal(bundle.privacy.reviewerConfirmed, false);
    if (process.env.WORKIQ_CHAT_PROOFS) {
        const folder = path.join(process.env.WORKIQ_CHAT_PROOFS, "new-reports");
        await mkdir(folder, { recursive: true });
        for (const [name, bytes] of Object.entries(bundle.files)) await writeFile(path.join(folder, name), bytes);
    }
});
