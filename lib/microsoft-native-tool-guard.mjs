import { randomUUID } from "node:crypto";
import { COWORK_COMPOSITION_ENTRY, COWORK_COMPOSITION_MANIFEST } from "./microsoft-cowork-composition.mjs";
import { installNativeToolGuard } from "./microsoft-native-tool-transport.mjs";
import { protectNativeBrowserProtocol } from "./microsoft-native-browser-protocol.mjs";

export async function protectNativeToolTransport({ browser, assertOwner, onFailure, deadline, signal }) {
    const invalid = signal?.aborted ? "NATIVE_TOOL_GUARD_CANCELLED"
        : !Number.isSafeInteger(deadline) || deadline <= Date.now() ? "NATIVE_TOOL_GUARD_DEADLINE" : null;
    if (invalid) {
        const error = Object.assign(new Error(invalid), { code: invalid });
        onFailure(error);
        throw error;
    }
    const control = "__wireNativeToolGuard_" + randomUUID().replaceAll("-", ""), binding = control + "_notify";
    let failure = null, retired = false, protocolGuard;
    const closed = new Promise(resolve => browser.once("close", resolve));
    const fail = (code, publicCoworkScript) => {
        if (retired || failure) return;
        failure = Object.assign(new Error(code), { code });
        if (code === "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED" && typeof publicCoworkScript === "string"
            && /^coworker\.[a-f0-9]{8}\.js$/.test(publicCoworkScript)) failure.publicCoworkScript = publicCoworkScript;
        onFailure(failure);
    };
    const ownerCurrent = () => {
        assertOwner();
        if (failure || retired) throw failure ?? Object.assign(new Error("NATIVE_TOOL_GUARD_RETIRED"), { code: "NATIVE_TOOL_GUARD_RETIRED" });
    };
    const current = () => {
        ownerCurrent();
        protocolGuard?.assertCurrent();
    };
    void closed.then(() => {
        retired = true;
        protocolGuard?.retire();
    });
    let timer, abort;
    const stopped = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("NATIVE_TOOL_GUARD_DEADLINE"),
            { code: "NATIVE_TOOL_GUARD_DEADLINE" })), Math.max(0, deadline - Date.now()));
        abort = () => reject(Object.assign(new Error("NATIVE_TOOL_GUARD_CANCELLED"), { code: "NATIVE_TOOL_GUARD_CANCELLED" }));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
    });
    try {
        await Promise.race([(async () => {
            current();
            protocolGuard = await protectNativeBrowserProtocol({ context: browser, assertOwner: ownerCurrent,
                onFailure: reason => fail(reason.code) });
            current();
            await browser.exposeBinding(binding, async (source, value) => {
                if (!browser.pages().includes(source.page) || !source.frame
                    || !["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(new URL(source.frame.url()).origin)
                    || typeof value?.documentId !== "string" || !/^[a-f0-9-]{36}$/.test(value.documentId)) return { acknowledged: false };
                // Only our own immutable document marker is inspected. A queued
                // notification from the replaced Connect realm cannot adopt the reader realm.
                await Promise.resolve();
                try {
                    const matches = await source.frame.evaluate(({ control, documentId }) =>
                        Object.getOwnPropertyDescriptor(window, control)?.value?.documentId === documentId,
                    { control, documentId: value.documentId });
                    if (!matches) return { acknowledged: false };
                } catch {
                    if (!source.page.isClosed() && !source.frame.isDetached()) fail("NATIVE_TOOL_GUARD_DOCUMENT_UNQUALIFIED");
                    return { acknowledged: false };
                }
                if (value.kind === "failed") {
                    if (/^NATIVE_[A-Z_]{1,80}$/.test(value.code ?? "")) fail(value.code, value.publicCoworkScript);
                    return { acknowledged: true };
                }
                if (value.kind !== "ready") return { acknowledged: false };
                try {
                    current();
                    return { acknowledged: true };
                } catch { return { acknowledged: false }; }
            });
            current();
            await browser.addInitScript({ content: `(${installNativeToolGuard.toString()})(${JSON.stringify({
                control, binding, entry: COWORK_COMPOSITION_ENTRY, manifest: COWORK_COMPOSITION_MANIFEST,
            })});` });
            current();
        })(), stopped]);
    } catch (reason) {
        fail(reason?.code ?? "NATIVE_TOOL_GUARD_INSTALL_FAILED");
        throw reason;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
    }
    return Object.freeze({
        control, assertCurrent: current,
        retire() {
            retired = true;
            protocolGuard?.retire();
            // Never detach a Fetch fence from a live target, including on an
            // uncertain failRequest acknowledgement or failed context close.
            // The host separately requires proof that context close succeeded.
        },
    });
}
