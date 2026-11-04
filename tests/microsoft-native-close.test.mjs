import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { chromium } from "playwright";
import { closeNativeBrowserContext } from "../lib/microsoft-native-host.mjs";

test("native context close releases retirement that depends on the browser stopping", async () => {
    const stopped = Promise.withResolvers(), events = [];
    const closing = closeNativeBrowserContext({
        async close() {
            events.push("close");
            stopped.resolve();
        },
    }, async () => {
        events.push("retire");
        await stopped.promise;
        events.push("retired");
    });
    await closing;
    assert.deepEqual(events, ["retire", "close", "retired"]);
});

test("native close starts despite unsettled retirement and never reports incomplete cleanup as released", async () => {
    const retirement = Promise.withResolvers();
    let closeCalls = 0, finished = false;
    const closing = closeNativeBrowserContext({ async close() { closeCalls++; } }, () => retirement.promise);
    void closing.then(() => { finished = true; });
    await setImmediate();
    assert.equal(closeCalls, 1);
    assert.equal(finished, false);
    retirement.resolve();
    await closing;
    assert.equal(finished, true);
});

for (const failure of ["retire", "close", "both"]) {
    test(`native context shutdown preserves ${failure} failure without skipping the other cleanup`, async () => {
        const retirementError = new Error("invented-retirement-failure");
        const closeError = new Error("invented-close-failure");
        let closes = 0, retirements = 0;
        await assert.rejects(closeNativeBrowserContext({
            close() {
                closes++;
                if (failure !== "retire") throw closeError;
            },
        }, () => {
            retirements++;
            if (failure !== "close") throw retirementError;
        }), error => error === (failure === "retire" ? retirementError : closeError));
        assert.equal(closes, 1);
        assert.equal(retirements, 1);
    });
}

test("native shutdown without a created context still waits for retirement", async () => {
    let retired = false;
    await closeNativeBrowserContext(null, () => { retired = true; });
    assert.equal(retired, true);
});

test("closing only the owned offline context ends an ignored-signal browser wait", { timeout: 15000 }, async t => {
    const browser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true,
        args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"] });
    t.after(() => browser.close());
    const owned = await browser.newContext({ offline: true, serviceWorkers: "block" });
    const sibling = await browser.newContext({ offline: true, serviceWorkers: "block" });
    const page = await owned.newPage(), otherPage = await sibling.newPage();
    const started = Promise.withResolvers();
    await page.exposeFunction("inventedWaitStarted", () => started.resolve());
    let accepted = false, revoked = false, readError;
    const waiting = page.evaluate(async () => {
        await window.inventedWaitStarted();
        return new Promise(() => {});
    }).then(() => { if (!revoked) accepted = true; }, error => { readError = error; });
    await started.promise;
    await new Promise((resolve, reject) => {
        setTimeout(() => {
            revoked = true;
            closeNativeBrowserContext(owned, () => waiting).then(resolve, reject);
        }, 25);
    });
    assert.equal(accepted, false);
    assert.match(readError?.message ?? "", /closed/i);
    assert.equal(page.isClosed(), true);
    assert.equal(otherPage.isClosed(), false);
    assert.equal(await otherPage.evaluate(() => 2 + 2), 4);
});
