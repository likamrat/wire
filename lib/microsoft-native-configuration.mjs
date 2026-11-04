import { link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { BoardError } from "./store.mjs";
import { nativeValueHasCredentials } from "./native-read-model.mjs";

const configurations = new WeakSet();
const enrollmentPolicies = new WeakSet();
export const MICROSOFT_DEVICE_CHECK_ORIGIN = "https://fpt.dfp.microsoft.com";
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const exact = (value, fields) => value && !Array.isArray(value) && typeof value === "object"
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const text = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
const accountLabel = value => text(value, 160) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const privatePath = value => {
    if (!text(value, 4096) || !path.isAbsolute(value) || /^[/\\]{2}/.test(value)) return false;
    const relative = path.relative(process.cwd(), path.resolve(value));
    return path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep);
};
function invalid() {
    throw Object.assign(new BoardError("The private Microsoft source configuration is missing, changed or invalid.", 422),
        { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
}
async function readConfiguration(file) {
    const handle = await open(file, "r");
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > 16384) invalid();
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
            const result = await handle.read(buffer, length, buffer.length - length, null);
            if (!result.bytesRead) break;
            length += result.bytesRead;
        }
        const after = await handle.stat();
        if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) invalid();
        const bytes = buffer.subarray(0, length);
        return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), sha256: sha256(bytes) };
    } finally { await handle.close(); }
}

export async function readMicrosoftNativeConfiguration(file) {
    try {
        if (!privatePath(path.resolve(file))) invalid();
        const { value } = await readConfiguration(file);
        if (value?.schemaVersion === 3) {
            if (!exact(value, ["schemaVersion", "expectedAccount", "deviceRiskOrigin"])
                || !accountLabel(value.expectedAccount) || value.deviceRiskOrigin !== MICROSOFT_DEVICE_CHECK_ORIGIN
                || nativeValueHasCredentials(value)) invalid();
            const policy = Object.freeze({ mode: "native-enrollment-policy", expectedAccount: value.expectedAccount,
                deviceRiskOrigin: value.deviceRiskOrigin });
            enrollmentPolicies.add(policy);
            return policy;
        }
        if ([2, 4].includes(value?.schemaVersion)) {
            const unbound = value.schemaVersion === 4;
            const deviceRiskOrigin = Object.hasOwn(value, "deviceRiskOrigin") ? URL.parse(value.deviceRiskOrigin) : null;
            if (nativeValueHasCredentials(value) || !exact(value, ["schemaVersion", ...(unbound ? [] : ["expectedAccount"]),
                "profileDirectory", "profileOwnerSessionId", "ownerLockPath",
                ...(Object.hasOwn(value, "deviceRiskOrigin") ? ["deviceRiskOrigin"] : [])])
                || !unbound && !accountLabel(value.expectedAccount) || !guid.test(value.profileOwnerSessionId)
                || !privatePath(value.profileDirectory) || !privatePath(value.ownerLockPath)
                || Object.hasOwn(value, "deviceRiskOrigin") && (!text(value.deviceRiskOrigin, 512)
                    || deviceRiskOrigin?.protocol !== "https:" || deviceRiskOrigin.origin !== value.deviceRiskOrigin
                    || !deviceRiskOrigin.hostname.endsWith(".microsoft.com") || deviceRiskOrigin.port)
                || path.basename(value.ownerLockPath) !== "native-owner.lock") invalid();
            const configuration = Object.freeze({ mode: "native-ui-history",
                ...(unbound ? {} : { expectedAccount: value.expectedAccount }),
                profileDirectory: path.resolve(value.profileDirectory), profileOwnerSessionId: value.profileOwnerSessionId,
                ownerLockPath: path.resolve(value.ownerLockPath),
                ...(deviceRiskOrigin ? { deviceRiskOrigin: deviceRiskOrigin.origin } : {}) });
            configurations.add(configuration);
            return configuration;
        }
        if (nativeValueHasCredentials(value)
            || !exact(value, ["schemaVersion", "targetMetadataPath", "targetMetadataSha256",
            "profileDirectory", "profileOwnerSessionId", "ownerLockPath"]) || value.schemaVersion !== 1
            || !/^[a-f0-9]{64}$/.test(value.targetMetadataSha256)
            || !guid.test(value.profileOwnerSessionId)
            || ["targetMetadataPath", "profileDirectory", "ownerLockPath"].some(key => !privatePath(value[key]))
            || path.basename(value.ownerLockPath) !== "native-owner.lock") invalid();
        const { value: target, sha256: targetHash } = await readConfiguration(value.targetMetadataPath);
        if (targetHash !== value.targetMetadataSha256 || nativeValueHasCredentials(target)
            || !exact(target, ["schemaVersion", "expectedAccount", "expectedTenant", "expectedSubject",
                "chatPath", "coworkFragment", "coworkThreadId"]) || target.schemaVersion !== 1
            || !accountLabel(target.expectedAccount)
            || !guid.test(target.expectedTenant) || !guid.test(target.expectedSubject)
            || !text(target.chatPath, 2070) || !/^\/chat\/conversation\/[^/?#\\\s]{1,2048}$/.test(target.chatPath)
            || new URL(target.chatPath, "https://copilot.cloud.microsoft").pathname !== target.chatPath
            || !text(target.coworkFragment, 1024) || !/^[A-Za-z0-9%:-]+$/.test(target.coworkFragment)
            || !text(target.coworkThreadId, 1024) || /\s/.test(target.coworkThreadId)) invalid();
        const parts = decodeURIComponent(target.coworkFragment).split(":");
        if (parts.length !== 3 || parts.some(part => !guid.test(part))
            || parts[0] !== target.expectedTenant || parts[1] !== target.expectedSubject) invalid();
        const configuration = Object.freeze({
            target: Object.freeze({ ...target }),
            targetMetadataSha256: targetHash,
            profileDirectory: path.resolve(value.profileDirectory),
            profileOwnerSessionId: value.profileOwnerSessionId,
            ownerLockPath: path.resolve(value.ownerLockPath),
        });
        configurations.add(configuration);
        return configuration;
    } catch { invalid(); }
}

export const isMicrosoftNativeConfiguration = value => configurations.has(value);
export const isMicrosoftNativeEnrollmentPolicy = value => enrollmentPolicies.has(value);

export async function prepareMicrosoftNativeConfiguration(context, expectedAccount, admission, enrollmentPolicy = null) {
    if (expectedAccount !== undefined && !accountLabel(expectedAccount) || !privatePath(context?.dataDir)
        || typeof admission?.check !== "function" || typeof admission.dispatched !== "function"
        || enrollmentPolicy !== null && (!isMicrosoftNativeEnrollmentPolicy(enrollmentPolicy)
            || expectedAccount === undefined
            || enrollmentPolicy.expectedAccount.toLowerCase() !== expectedAccount.toLowerCase())) invalid();
    const directory = await realpath(context.dataDir);
    if (!privatePath(directory)) invalid();
    const root = path.join(directory, "microsoft-native");
    const file = path.join(directory, "microsoft-source.json");
    admission.check();
    // Exclusive custody creation also fences interrupted preparation. Never adopt an existing profile.
    admission.dispatched();
    await mkdir(root, { mode: 0o700 });
    const value = { schemaVersion: expectedAccount === undefined ? 4 : 2,
        ...(expectedAccount === undefined ? {} : { expectedAccount }), profileDirectory: path.join(root, "profile"),
        profileOwnerSessionId: randomUUID(), ownerLockPath: path.join(root, "native-owner.lock"),
        ...(enrollmentPolicy ? { deviceRiskOrigin: enrollmentPolicy.deviceRiskOrigin } : {}) };
    const write = async (target, value) => {
        admission.check();
        const handle = await open(target, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
        finally { await handle.close(); }
    };
    await mkdir(value.profileDirectory, { mode: 0o700 });
    await write(path.join(root, "profile-owner.json"), { sessionId: value.profileOwnerSessionId, profile: "profile" });
    const staged = path.join(root, "source-preparation.json");
    await write(staged, value);
    admission.check();
    // Hard-link publication is atomic and refuses an existing file, including another owner's configuration.
    await link(staged, file);
    await unlink(staged);
    admission.check();
    return readMicrosoftNativeConfiguration(file);
}
