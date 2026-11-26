import { randomUUID } from "node:crypto";
import { BoardError } from "./store.mjs";
import pkg from "../package.json" with { type: "json" };

const actions = new Set(["status", "auto-check", "check", "dismiss", "preferences", "apply"]);
export const updateConflict = message => Object.assign(new BoardError(message, 409), { code: "wire_update_blocked" });
const quiesceReasons = Object.freeze({
    "handoff-ended": "The update is no longer active.",
    "runtime-not-ready": "WIRE is not ready to restart.",
    "unfinished-settings": "Save or cancel the unfinished Settings edit before updating.",
    "unfinished-report": "Finish or discard the open report before updating.",
    "unconfirmed-operation": "Finish the pending WIRE operation or check its original result before updating.",
    "unconfirmed-view": "WIRE could not confirm that every active view preserved its work.",
    "report-review": "Finish or discard the prepared report before updating.",
    "request-active": "A WIRE operation is still running. Let it finish before updating.",
    "collection-status": "WIRE is still reading Collection status. Let the read finish before updating.",
    "collection-change": "A collection change or manual check is still running. Check its original result before updating.",
    "collection-busy": "Collection or recovery is still running. Finish it and click Update again.",
    "read-interrupted": "Access or activity changed while WIRE waited for Collection status. Check open views again.",
    unknown: "WIRE is busy or access changed. Finish the current operation, then try updating again.",
});

export function quiesceRefusal(reason, legacyMessage) {
    // Older children returned only an error string. Match known text exactly;
    // never publish an arbitrary exception or a path from another build.
    const key = typeof reason === "string" && Object.hasOwn(quiesceReasons, reason) ? reason
        : Object.keys(quiesceReasons).find(key => quiesceReasons[key] === legacyMessage) ?? "unknown";
    return { reason: key, error: quiesceReasons[key] };
}
export const quiesceConflict = reason => updateConflict(quiesceReasons[reason]);

export function validateUpdateRequest(input) {
    const action = input?.action;
    if (!actions.has(action)) throw new BoardError("Unknown app update action.", 422);
    const key = action === "preferences" ? "enabled" : ["apply", "dismiss"].includes(action) ? "candidate" : null;
    if (Object.keys(input).length !== (key ? 2 : 1) || key && !Object.hasOwn(input, key)
        || key === "enabled" && typeof input.enabled !== "boolean"
        || key === "candidate" && (typeof input.candidate !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.candidate))) {
        throw new BoardError("The update request does not match the selected action.", 422);
    }
}

export function createUpdateBridge({ quiesce, resume, channel = process }) {
    const pending = new Map();
    const managed = channel.connected === true && channel.env?.WIRE_UPDATE_LAUNCHER === "1";
    function receive(message) {
        if (message?.type === "wire-update-quiesce") {
            const reply = (ok, cause) => {
                if (channel.connected) channel.send({ type: "wire-update-quiesced", id: message.id, ok,
                    ...(!ok && quiesceRefusal(undefined, cause?.message)) });
            };
            try {
                const drain = quiesce();
                if (typeof drain?.then === "function") void drain.then(() => reply(true), error => reply(false, error));
                else reply(true);
            } catch (error) { reply(false, error); }
        } else if (message?.type === "wire-update-resume") resume();
        else if (message?.type === "wire-update-response") {
            const waiter = pending.get(message.id);
            if (waiter) message.error ? waiter.reject(updateConflict(message.error)) : waiter.resolve(message.value);
        }
    }
    function disconnect() {
        for (const waiter of pending.values()) waiter.reject(updateConflict("The update launcher disconnected. Read the current status; do not repeat Update."));
    }
    if (managed) { channel.on("message", receive); channel.on("disconnect", disconnect); }
    return {
        managed,
        build: managed ? channel.env.WIRE_UPDATE_BUILD : null,
        async request(request) {
            if (!managed) {
                if (request.action !== "status") throw updateConflict("Start a clean main installation with npm start to use app updates.");
                return { supported: false, automatic: false, installed: null, packageVersion: pkg.version, candidate: null, lastChecked: null, dismissed: null,
                    phase: "manual", message: "Updates are managed manually." };
            }
            if (!channel.connected) throw updateConflict("The update launcher is unavailable.");
            const id = randomUUID();
            let timeout;
            try {
                const status = await new Promise((resolve, reject) => {
                    pending.set(id, { resolve, reject });
                    timeout = setTimeout(() => reject(updateConflict("The launcher has not confirmed the result. Read the current update status.")), 95000);
                    channel.send({ type: "wire-update-request", id, request }, error => {
                        if (error) reject(updateConflict("Could not contact the WIRE launcher."));
                    });
                });
                // The launcher stays in the original clone; the child owns the running package version.
                return { ...status, packageVersion: pkg.version };
            } finally { clearTimeout(timeout); pending.delete(id); }
        },
        close() {
            if (managed) { channel.off("message", receive); channel.off("disconnect", disconnect); }
            disconnect();
        },
    };
}
