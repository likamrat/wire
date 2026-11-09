import { createHash } from "node:crypto";

const plain = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const stamp = value => typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;

export function reportSaveContentHash(manifest) {
    if (!plain(manifest) || typeof manifest.bundleId !== "string" || !hash(manifest.snapshotHash)
        || !["none", "masked", "original"].includes(manifest.promptMode)
        || !Array.isArray(manifest.formats) || !manifest.formats.length || !plain(manifest.files)) {
        throw new TypeError("The prepared report has no valid save binding.");
    }
    const files = Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b));
    if (!files.length || files.some(([, file]) => !exact(file, ["sha256", "bytes"])
        || !hash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1)) {
        throw new TypeError("The prepared report file inventory is invalid.");
    }
    return createHash("sha256").update(JSON.stringify([
        manifest.kind ?? "report", manifest.bundleId, manifest.snapshotHash, manifest.promptMode, manifest.formats, files,
        manifest.savePolicy ?? null,
    ])).digest("hex");
}

export function hasReportSaveAuthorization(privacy) {
    if (!plain(privacy)) return false;
    if (privacy.reviewerConfirmed === true) return privacy.localSave === undefined;
    const consent = privacy.localSave;
    return privacy.reviewerConfirmed === false && privacy.reviewerIdentityVerified === false
        && exact(consent, ["version", "method", "contentHash", "keepChatDetailsConfirmed", "confirmedAt"])
        && consent.version === 1 && consent.method === "explicit-local-save"
        && hash(consent.contentHash) && typeof consent.keepChatDetailsConfirmed === "boolean"
        && stamp(consent.confirmedAt) && privacy.confirmedAt === consent.confirmedAt;
}

export function reportSaveAuthorizationSummary(privacy) {
    if (!hasReportSaveAuthorization(privacy)) throw new TypeError("Local report saving was not confirmed.");
    return {
        reviewerConfirmed: privacy.reviewerConfirmed, reviewerIdentityVerified: false,
        confirmedAt: privacy.confirmedAt,
        ...(privacy.localSave ? { localSave: {
            version: privacy.localSave.version, method: privacy.localSave.method,
            contentHash: privacy.localSave.contentHash, keepChatDetailsConfirmed: privacy.localSave.keepChatDetailsConfirmed,
            confirmedAt: privacy.localSave.confirmedAt,
        } } : {}),
    };
}

export function assertReportSaveAuthorization(manifest, registration) {
    if (!hasReportSaveAuthorization(manifest?.privacyReview)) throw new TypeError("Local report saving was not confirmed.");
    const consent = manifest.privacyReview.localSave;
    if (consent ? manifest.savePolicy !== "local-save-v1" : manifest.savePolicy !== undefined) {
        throw new TypeError("The saved report uses an unsupported save policy.");
    }
    if (consent && (consent.contentHash !== reportSaveContentHash(manifest)
        || consent.keepChatDetailsConfirmed !== (manifest.promptMode === "original"))) {
        throw new TypeError("Save confirmation no longer matches the report's contents.");
    }
    if (registration && (consent || registration.privacyReview?.localSave)
        && JSON.stringify(reportSaveAuthorizationSummary(registration.privacyReview))
        !== JSON.stringify(reportSaveAuthorizationSummary(manifest.privacyReview))) {
        throw new TypeError("The saved report's confirmation differs from its manifest.");
    }
    return true;
}

export function reportLocalSaveRequest(manifest) {
    return { version: 1, bundleId: manifest.bundleId, contentHash: reportSaveContentHash(manifest) };
}

export function confirmReportLocalSave(manifest, request, confirmedAt = new Date().toISOString()) {
    if (!exact(request, ["version", "bundleId", "contentHash", "keepChatDetailsConfirmed"])
        || request.version !== 1 || request.bundleId !== manifest.bundleId
        || request.contentHash !== reportSaveContentHash(manifest) || !stamp(confirmedAt)
        || typeof request.keepChatDetailsConfirmed !== "boolean"
        || request.keepChatDetailsConfirmed !== (manifest.promptMode === "original")) {
        throw new TypeError(manifest.promptMode === "original"
            ? "Choose whether to hide your chat details or save them before continuing."
            : "The report changed. Save its current preview instead.");
    }
    const { reviewChannel, localSave, ...scan } = manifest.privacyReview;
    return {
        ...scan, reviewerConfirmed: false, reviewerIdentityVerified: false, confirmedAt,
        localSave: {
            version: 1, method: "explicit-local-save", contentHash: request.contentHash,
            keepChatDetailsConfirmed: request.keepChatDetailsConfirmed, confirmedAt,
        },
    };
}
