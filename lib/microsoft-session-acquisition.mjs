import { acquireChatClient } from "./microsoft-chat-acquisition.mjs";
import { acquireCoworkClient } from "./microsoft-cowork-acquisition.mjs";
import { attachNativeBackfill, nativeBackfillFor } from "./native-backfill-state.mjs";
import { NATIVE_READ_LIMITS } from "./native-read-model.mjs";

export async function acquireMicrosoftSession(options) {
    if (!Array.isArray(options.collection?.surfaces) || !options.collection.surfaces.length
        || new Set(options.collection.surfaces).size !== options.collection.surfaces.length
        || options.collection.surfaces.some(surface => !["chat", "cowork"].includes(surface))) {
        throw Object.assign(new Error("NATIVE_CLIENT_SOURCE_SCOPE"), { code: "NATIVE_CLIENT_SOURCE_SCOPE" });
    }
    const surfaces = [...options.collection.surfaces].sort(), result = [], now = options.now ?? Date.now();
    const limits = surfaces.length === 1 ? NATIVE_READ_LIMITS : {
        bytes: Math.floor((NATIVE_READ_LIMITS.bytes - 2) / surfaces.length),
        records: Math.floor(NATIVE_READ_LIMITS.records / surfaces.length),
    };
    let progress = options.previousBackfill;
    for (const surface of surfaces) {
        const acquire = surface === "chat" ? acquireChatClient : acquireCoworkClient;
        const records = await acquire({ ...options, reader: options.reader.forSurface(surface), limits, previousBackfill: progress, now });
        progress = nativeBackfillFor(records);
        result.push(...records);
    }
    for (const surface of surfaces) await options.reader.forSurface(surface).assertCurrent();
    await options.lifecycle.assertLease(options.lease);
    return attachNativeBackfill(result, progress);
}
