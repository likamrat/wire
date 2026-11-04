const error = code => Object.assign(new Error(code), { code });

// Browser-target Fetch covers first requests from future popups and OOP frames;
// page events and renderer bindings arrive too late to provide that boundary.
export async function protectNativeBrowserProtocol({ context, assertOwner, onFailure }) {
    const browser = context.browser();
    if (!browser || browser.contexts().length !== 1 || browser.contexts()[0] !== context) {
        throw error("NATIVE_TOOL_GUARD_BROWSER_NOT_EXCLUSIVE");
    }
    assertOwner();
    const protocol = await browser.newBrowserCDPSession();
    let failure = null, retired = false, closed = false;
    const fail = code => {
        if (retired || closed || failure) return;
        failure = error(code);
        onFailure(failure);
    };
    const current = () => {
        assertOwner();
        if (failure || retired || closed) throw failure ?? error("NATIVE_TOOL_GUARD_RETIRED");
    };
    protocol.on("Fetch.requestPaused", event => {
        fail("NATIVE_CLIENT_TOOL_PROTOCOL_DENIED");
        void protocol.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {
            console.error("[workiq-native] client-tool denial acknowledgement unconfirmed");
        });
    });
    protocol.on("close", () => fail("NATIVE_TOOL_GUARD_PROTOCOL_LOST"));
    context.once("close", () => {
        closed = true;
        // Never release a paused request by detaching while the owner can run.
        void Promise.resolve().then(() => protocol.detach()).catch(() => {
            if (browser.isConnected()) console.error("[workiq-native] browser fence cleanup acknowledgement unconfirmed");
        });
    });
    try {
        current();
        await protocol.send("Fetch.enable", { patterns: [
            { urlPattern: "*/v1/conversations/*/client-tool-*", requestStage: "Request" },
        ] });
        current();
    } catch (reason) { fail("NATIVE_TOOL_GUARD_PROTOCOL_UNAVAILABLE"); throw failure ?? reason; }
    return Object.freeze({
        assertCurrent: current,
        retire() { retired = true; },
    });
}
