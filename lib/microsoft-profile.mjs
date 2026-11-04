export function microsoftProfileView(presentation, now = Date.now()) {
    if (presentation !== null && (!presentation || presentation.source !== "microsoft-native-principal"
        || typeof presentation.email !== "string" || presentation.email.length > 160
        || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(presentation.email)
        || !Number.isSafeInteger(presentation.generation) || presentation.generation < 0
        || !Number.isFinite(Date.parse(presentation.observedAt)))) {
        throw new TypeError("Microsoft account presentation is invalid.");
    }
    const verified = presentation !== null, generation = verified ? `microsoft:${presentation.generation}` : "microsoft:unavailable";
    return {
        schemaVersion: 1, provider: "microsoft", generation,
        identity: { state: verified ? "verified" : "unavailable", reason: verified ? null : "microsoft-profile-unavailable",
            source: verified ? "microsoft-native-principal" : "unavailable", generation,
            checkedAt: now, expiresAt: now + 15000 },
        displayName: { value: null, source: "unavailable", freshness: "unavailable" },
        email: { value: presentation?.email ?? null, source: verified ? presentation.source : "unavailable",
            freshness: verified ? "current" : "unavailable" },
        avatar: { state: "unavailable", reason: "photo-not-observed", url: null, expiresAt: null },
        fallback: verified ? { kind: "initials", text: [...presentation.email][0].toUpperCase(), source: "verified-email" }
            : { kind: "neutral", text: null, source: "unavailable" },
        issues: [],
    };
}
