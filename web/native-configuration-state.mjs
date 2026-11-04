// Serialized with Settings; this model carries offered intent, never backend authority.
export function createNativeConfigurationState() {
    const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const surfaces = ["chat", "cowork"];
    const blockerCodes = ["NATIVE_CONFIGURATION_ACCOUNT_REQUIRED", "NATIVE_CONFIGURATION_IDENTITY_REQUIRED",
        "NATIVE_CONFIGURATION_ACCESS_UNAVAILABLE"];
    const values = value => exact(value, ["surfaces", "windowDays"])
        && Array.isArray(value.surfaces) && value.surfaces.length > 0
        && new Set(value.surfaces).size === value.surfaces.length
        && value.surfaces.every(surface => surfaces.includes(surface))
        && Number.isSafeInteger(value.windowDays) && value.windowDays >= 1 && value.windowDays <= 90;
    const canonical = value => ({ surfaces: surfaces.filter(surface => value.surfaces.includes(surface)), windowDays: value.windowDays });
    function decode(value) {
        if (!exact(value, ["schemaVersion", "kind", "generation", "authorizationRevision", "intent", "available",
            "expectedRevision", "supportedSurfaces", "values", "basis", "blockers",
            ...(value?.schemaVersion === 2 ? ["globalRevision"] : [])])
            || ![1, 2].includes(value.schemaVersion) || value.kind !== "native-configuration-offer"
            || value.schemaVersion === 2 && value.globalRevision !== null
                && (!integer(value.globalRevision) || value.globalRevision === 0)
            || !integer(value.generation) || !integer(value.authorizationRevision)
            || !["enable", "save"].includes(value.intent) || typeof value.available !== "boolean"
            || value.expectedRevision !== null && (!integer(value.expectedRevision) || value.expectedRevision === 0)
            || JSON.stringify(value.supportedSurfaces) !== JSON.stringify(surfaces) || !values(value.values)
            || !["committed-native", "native-defaults"].includes(value.basis)
            || (value.basis === "native-defaults") !== (value.expectedRevision === null)
            || value.basis === "native-defaults" && (value.values.windowDays !== 30 || value.values.surfaces.length !== 2)
            || value.intent === "save" && value.expectedRevision === null
            || !Array.isArray(value.blockers) || new Set(value.blockers).size !== value.blockers.length
            || value.blockers.length > 1 || value.blockers.some(code => !blockerCodes.includes(code))
            || value.blockers.length === 1 && (value.intent === "save"
                ? value.blockers[0] !== "NATIVE_CONFIGURATION_ACCESS_UNAVAILABLE"
                : value.blockers[0] === "NATIVE_CONFIGURATION_ACCESS_UNAVAILABLE")
            || value.available !== (value.blockers.length === 0)) {
            throw new TypeError("Microsoft collection configuration offer is invalid.");
        }
        return { ...structuredClone(value), values: canonical(value.values) };
    }
    let latest = null, baseline = null, draft = null, stale = false;
    const dirty = () => Boolean(baseline && JSON.stringify(draft) !== JSON.stringify(baseline.values));
    const basis = value => JSON.stringify([value.schemaVersion, value.globalRevision, value.generation, value.authorizationRevision, value.expectedRevision,
        value.intent, value.basis, value.values, value.supportedSurfaces]);
    function cancel() {
        baseline = latest ? structuredClone(latest) : null;
        draft = latest ? structuredClone(latest.values) : null;
        stale = false;
    }
    function view(observed) {
        const current = Boolean(latest && observed && integer(observed.authorizationRevision)
            && latest.generation === observed.generation && latest.authorizationRevision >= observed.authorizationRevision);
        const changed = dirty(), present = Boolean(latest || baseline);
        return { present, intent: baseline?.intent ?? null, values: draft ? structuredClone(draft) : null,
            dirty: changed, stale, needsRead: present && !current, basis: baseline?.basis ?? null,
            blockers: [...(latest?.blockers ?? [])], valid: Boolean(values(draft)),
            validation: !draft ? "" : !draft.surfaces.length ? "Select at least one Microsoft source."
                : !values(draft) ? "Choose a history window from 1 to 90 days." : "",
            canEdit: Boolean(current && latest.available && !stale),
            canSubmit: Boolean(current && latest.available && !stale && values(draft) && (baseline.intent === "enable" || changed)) };
    }
    return {
        decode,
        receive(value) {
            if (value === undefined) {
                const keep = dirty() || stale;
                latest = null;
                if (keep) stale = true;
                else cancel();
                return true;
            }
            let next;
            try { next = decode(value); }
            catch (error) {
                latest = null;
                stale ||= dirty();
                throw error;
            }
            if (latest && (next.generation < latest.generation
                || next.generation === latest.generation && next.authorizationRevision < latest.authorizationRevision)) return false;
            const keep = dirty() || stale;
            latest = next;
            if (keep) stale ||= basis(next) !== basis(baseline);
            else cancel();
            return true;
        },
        edit(value) {
            if (!baseline || !exact(value, ["surfaces", "windowDays"]) || typeof value.windowDays !== "number"
                || !Array.isArray(value.surfaces) || new Set(value.surfaces).size !== value.surfaces.length
                || value.surfaces.some(surface => !surfaces.includes(surface))) {
                throw new TypeError("Microsoft configuration edits have unsupported fields.");
            }
            draft = canonical(value);
        },
        view, cancel,
        withdraw() { latest = null; cancel(); },
        command(observed) {
            if (!view(observed).canSubmit) throw new Error("Current Microsoft configuration is required before saving.");
            return { schemaVersion: baseline.schemaVersion, intent: baseline.intent, generation: baseline.generation,
                authorizationRevision: baseline.authorizationRevision,
                ...(baseline.schemaVersion === 2 ? { globalRevision: baseline.globalRevision } : {}),
                expectedRevision: baseline.expectedRevision,
                surfaces: [...draft.surfaces], windowDays: draft.windowDays };
        },
    };
}
