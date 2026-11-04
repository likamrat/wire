import { BoardError, exclusiveBoard } from "./store.mjs";

export function copilotStoreRefusal() {
    return Object.assign(new BoardError(
        "This store requires its matched Microsoft protected-state runtime. The Copilot-only release cannot open it. No migration, reset or source activation was performed.", 503),
    { code: "WIRE_COPILOT_STORE_INCOMPATIBLE" });
}

export function assertCopilotState(state) {
    if (state.nativeRetention !== undefined || state.nativeReportPolicy !== undefined
        || [4, 5, 7].includes(state.stateVersion)) throw copilotStoreRefusal();
}

export async function assertCopilotStore(context) {
    try {
        return await exclusiveBoard(context, state => { assertCopilotState(state); return true; }, { readOnly: true });
    } catch (error) {
        if (error instanceof BoardError && error.status === 404) return false;
        throw error;
    }
}

export function assertReleasedRequest(policy, route, input) {
    if (policy !== "copilot-only") return;
    if (route.startsWith("/api/collection/microsoft/")
        || route === "/api/access/command" && input?.action?.startsWith?.("microsoft-")
        || route === "/api/canvas" && typeof input?.action === "string" && /microsoft/i.test(input.action)) {
        throw Object.assign(new BoardError("Microsoft collection is not available in this release. No action was started.", 403),
            { code: "WIRE_SOURCE_NOT_RELEASED" });
    }
}
