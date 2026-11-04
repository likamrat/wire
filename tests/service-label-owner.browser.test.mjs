import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme } from "./helpers.mjs";
import { callInvestigationRecords } from "./call-investigation-fixture.mjs";

test("non-tool reader fields own service labels and availability-only identities have no leading indent", async t => {
    const record = callInvestigationRecords()[1];
    record.toolCalls = [record.toolCalls[10]];
    record.graphActivities = [record.graphActivities[0], record.graphActivities.at(-1)].map((row, index) => ({
        ...row, activityId: "label-owner-graph-" + index, workload: "Unknown",
        endpoint: { ...row.endpoint, path: "/unrecognized/target", label: "GET v1.0 /unrecognized/target" },
    }));
    record.httpRecords = [record.httpRecords[0]];
    record.httpRecords[0].responsePath = { path: "/unrecognized/target", query: [] };
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const before = await loadBoardState(context), errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw Error("No providers in label-owner proof."); },
            readSource() { throw Error("No source reads in label-owner proof."); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" });
    let projection = "missing";
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        if (url.pathname === "/") {
            const response = await route.fetch(), html = await response.text();
            const seam = "function recordedCategory(rows, layer, options = {})";
            assert.equal(html.split(seam).length, 2);
            return route.fulfill({ response, body: html.replace(seam, `window.serviceIdentityProbe = serviceIdentity;\n    ${seam}`) });
        }
        if (url.pathname === "/api/snapshot" && projection !== "missing") {
            const response = await route.fetch(), data = await response.json();
            for (const layer of ["direct-request", "code-reference", "http"]) {
                if (projection === "unavailable") delete data.requestActivity[layer];
                else for (const row of data.requestActivity[layer]) {
                    // Exercise canonical service availability projections without changing recorded outcomes.
                    assert.ok(row.serviceAssociation.gaps.length);
                    row.serviceAssociation.services = ["Files"];
                    row.serviceAssociation.status = projection === "known" ? "identified" : "partial";
                    if (projection === "known") row.serviceAssociation.gaps = [];
                }
            }
            return route.fulfill({ response, json: data });
        }
        return route.continue();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const action of cleanup) await action(); }
    });
    const settle = async () => {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
            .every(animation => animation.playState !== "running"));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const proof = process.env.WIRE_LABEL_OWNER_PROOFS, observations = [], violations = [];
    if (proof) await mkdir(proof, { recursive: true });
    for (const state of ["missing", "known", "partial", "unavailable"]) {
        projection = state;
        await page.goto(runtime.url + "#request?" + new URLSearchParams({ request: record.scenarioId, origin: "analyze" }));
        if (state !== "missing") await page.reload();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await settle();
        const facts = page.locator("#requestContent .reader-call-row > .reader-fields");
        await expect(facts).toHaveCount(3);
        const fields = await facts.evaluateAll(nodes => nodes.map(node => ({
            kind: node.closest(".reader-call-row").querySelector(".reader-record-name").textContent,
            label: node.querySelector("dt").textContent,
            value: node.querySelector("dd").innerText.replace(/\s+/g, " ").trim(),
            nestedLabels: node.querySelector("dd").querySelectorAll(".recorded-category-label").length,
        })));
        assert.deepEqual(fields.map(field => field.kind).sort(), ["Direct Graph request site", "Explicit HTTP recorder", "Graph code reference"]);
        for (const field of fields) {
            assert.equal(field.label, field.kind === "Graph code reference" ? "Referenced service" : "Service");
            const expected = state === "known" ? "Files" : state === "missing" ? "Not shown"
                : state === "partial" ? "Files Details incomplete" : "Evidence unavailable";
            if (field.value !== expected || field.nestedLabels) violations.push({ state, ...field, expected });
        }
        observations.push({ state, fields });
        await expect(page.locator("#requestContent .reader-call-services [data-service=Files]")).toHaveCount(1);
        await expect(page.locator("#requestContent .reader-call-services .service-availability")).toHaveCount(0);
        await expect(page.locator("#requestContent")).toContainText("Code reference only; execution is not established.");
        if (state === "missing") {
            const spacing = await page.evaluate(() => {
                const host = document.createElement("div");
                host.style.cssText = "position:fixed;top:0;left:0;font-size:14px";
                document.body.append(host);
                const cases = [undefined, [{ workload: "Unknown" }], [{ workload: "Files" }, { workload: "Unknown" }]];
                const margins = cases.map(rows => {
                    host.replaceChildren(window.serviceIdentityProbe(rows, "http"));
                    return parseFloat(getComputedStyle(host.querySelector(".service-availability")).marginInlineStart);
                });
                host.remove();
                return margins;
            });
            if (spacing[0] !== 0 || spacing[1] !== 0 || spacing[2] !== 7) {
                violations.push({ state, identityMargins: spacing, expected: [0, 0, 7] });
            }
            observations.push({ identityMargins: spacing });
        }
        if (proof) for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme); await settle();
            await facts.first().evaluate(node => node.scrollIntoView({ block: "start" })); await settle();
            await page.screenshot({ path: path.join(proof, `${state}-${theme}.png`) });
        }
    }
    if (proof) await writeFile(path.join(proof, "observations.json"), JSON.stringify({ observations, violations }, null, 2));
    assert.deepEqual(violations, []);
});
