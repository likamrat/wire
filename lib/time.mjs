// Shared with the browser as a self-contained factory; never reads the server's zone.
export function createTimeContext() {
    const dates = new Map(), midnights = new Map();
    const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
    const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
    function calendar(value) {
        if (typeof value !== "string" || !dayPattern.test(value) || value < "0001-01-01" || value > "9998-12-31") throw new RangeError("Choose a valid calendar date (YYYY-MM-DD).");
        const parsed = new Date(value + "T00:00:00Z");
        if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) throw new RangeError("Choose a real calendar date.");
        return value;
    }
    function instant(value) {
        if (typeof value !== "string" || !instantPattern.test(value)) throw new RangeError("Timestamps require an explicit UTC or numeric offset.");
        calendar(value.slice(0, 10));
        if (!Number.isFinite(Date.parse(value)) || Number(value.slice(11, 13)) > 23) throw new RangeError("Invalid timestamp.");
        return value;
    }
    function zone(value) {
        if (typeof value !== "string" || value.length > 100 || !(value === "UTC" || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))) throw new RangeError("Choose a valid IANA timezone, not a current UTC offset.");
        return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
    }
    function locale(value) {
        if (typeof value !== "string" || !value || value.length > 80 || !Intl.DateTimeFormat.supportedLocalesOf([value]).length) throw new RangeError("Choose a supported locale.");
        return Intl.getCanonicalLocales(value)[0];
    }
    function normalize(input) {
        if (input === undefined) return { timeZone: "UTC", locale: "en-US", timeZoneFallback: true, localeFallback: true };
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["timeZone", "locale", "timeZoneFallback", "localeFallback"].includes(k))) throw new RangeError("Invalid time context.");
        for (const k of ["timeZoneFallback", "localeFallback"]) if (input[k] !== undefined && typeof input[k] !== "boolean") throw new RangeError("Invalid time fallback flag.");
        const result = { timeZone: zone(input.timeZone), locale: locale(input.locale), timeZoneFallback: input.timeZoneFallback ?? false, localeFallback: input.localeFallback ?? false };
        if (result.timeZoneFallback && result.timeZone !== "UTC" || result.localeFallback && result.locale !== "en-US") throw new RangeError("Invalid time fallback context.");
        return result;
    }
    function detect() {
        let resolved;
        try { resolved = Intl.DateTimeFormat().resolvedOptions(); }
        catch { resolved = {}; }
        const result = normalize();
        try { result.timeZone = zone(resolved.timeZone); result.timeZoneFallback = false; } catch { /* Explicit UTC fallback is returned and displayed. */ }
        try { result.locale = locale(resolved.locale); result.localeFallback = false; } catch { /* Explicit en-US fallback is returned and displayed. */ }
        return result;
    }
    function resolve(preference = null, device = detect()) {
        return preference === null ? { ...device } : { ...device, timeZone: zone(preference), timeZoneFallback: false };
    }
    function displayLabel(context) {
        const name = zone(context.timeZone);
        if (name === "UTC") return context.timeZoneFallback ? "UTC (fallback)" : "UTC";
        if (name.startsWith("Etc/")) return name;
        return name.split("/").at(-1).replaceAll("_", " ") + " time";
    }
    function zoneChoices(device = detect(), preference = null) {
        const available = typeof Intl.supportedValuesOf === "function";
        const names = available ? Intl.supportedValuesOf("timeZone") : [];
        return {
            available,
            zones: [...new Set(["UTC", device.timeZone, ...(preference ? [preference] : []), ...names].map(zone))]
                .map(timeZone => ({ timeZone, label: `${displayLabel({ timeZone })} (${timeZone})` }))
                .sort((a, b) => a.label.localeCompare(b.label)),
        };
    }
    function day(value, timeZone) {
        instant(value);
        if (!dates.has(timeZone)) dates.set(timeZone, new Intl.DateTimeFormat("en-US", { timeZone: zone(timeZone), calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit" }));
        const parts = Object.fromEntries(dates.get(timeZone).formatToParts(new Date(value)).map(p => [p.type, p.value]));
        return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
    }
    function addDays(value, amount) {
        const date = new Date(calendar(value) + "T00:00:00Z");
        date.setUTCDate(date.getUTCDate() + amount);
        return calendar(date.toISOString().slice(0, 10));
    }
    function preset(value, timeZone, now = new Date().toISOString()) {
        if (["day", "week", "month"].includes(value)) {
            const from = bucketDate(now, value, timeZone);
            return { from, to: addDays(nextBucket(from, value), -1) };
        }
        if (!["7", "30"].includes(value)) return null;
        const to = day(now, timeZone);
        return { from: addDays(to, 1 - Number(value)), to };
    }
    function nextBucket(value, bucket) {
        if (bucket !== "month") return addDays(value, bucket === "week" ? 7 : 1);
        const date = new Date(calendar(value) + "T00:00:00Z");
        date.setUTCMonth(date.getUTCMonth() + 1, 1);
        return calendar(date.toISOString().slice(0, 10));
    }
    function bucketDate(value, bucket, timeZone) {
        const local = day(value, timeZone);
        if (bucket === "month") return local.slice(0, 7) + "-01";
        if (bucket === "week") return addDays(local, -(new Date(local + "T00:00:00Z").getUTCDay() + 6) % 7);
        return local;
    }
    function midnight(value, timeZone) {
        calendar(value);
        const key = timeZone + ":" + value;
        if (midnights.has(key)) return midnights.get(key);
        const anchor = Date.parse(value + "T00:00:00Z");
        let low = anchor - 3 * 86400000, high = anchor + 3 * 86400000;
        // Find the first instant of a civil date, including midnight gaps and skipped dates.
        // UTC arithmetic here only brackets the search, never advances a local calendar day.
        while (high - low > 1) {
            const middle = Math.floor((low + high) / 2);
            if (day(new Date(middle).toISOString(), timeZone) < value) low = middle;
            else high = middle;
        }
        const result = new Date(high).toISOString();
        if (midnights.size >= 2000) midnights.clear();
        midnights.set(key, result);
        return result;
    }
    function range(filters = {}, timeZone = "UTC") {
        zone(timeZone);
        const bound = (value, end) => value === undefined ? undefined : dayPattern.test(value) ? midnight(end ? addDays(value, 1) : calendar(value), timeZone) : instant(value);
        const from = bound(filters.from, false), to = bound(filters.to, true);
        const toExclusive = filters.to !== undefined && dayPattern.test(filters.to);
        if (filters.from && filters.to && dayPattern.test(filters.from) && dayPattern.test(filters.to) && filters.from > filters.to || from && to && Date.parse(from) > Date.parse(to)) throw new RangeError("Start date must not follow end date.");
        return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), toExclusive };
    }
    function formatDate(value, context, full = false) {
        if (!value) return "Date not recorded";
        const isDate = dayPattern.test(value);
        try { isDate ? calendar(value) : instant(value); } catch { return "Date not recorded"; }
        return new Intl.DateTimeFormat(context.locale, { timeZone: isDate ? "UTC" : context.timeZone, month: "short", day: "numeric", ...(full ? { year: "numeric" } : {}) }).format(new Date(isDate ? value + "T12:00:00Z" : value));
    }
    function formatTime(value, context) {
        if (!value) return "Time not recorded";
        try { instant(value); } catch { return "Time not recorded"; }
        return new Intl.DateTimeFormat(context.locale, { timeZone: context.timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset" }).format(new Date(value));
    }
    function formatMoment(value, context) {
        if (!value) return "Time not recorded";
        try { instant(value); } catch { return "Time not recorded"; }
        return new Intl.DateTimeFormat(context.locale, { timeZone: context.timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
    }
    function label(context) {
        return context.timeZone + (context.timeZoneFallback ? " (fallback: browser timezone unavailable)" : "");
    }
    function selection(input = { range: "capture" }) {
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["range", "from", "to"].includes(k)) || !["capture", "day", "week", "month", "7", "30", "custom"].includes(input.range)) throw new RangeError("Invalid report date selection.");
        for (const k of ["from", "to"]) if (input[k] !== undefined) dayPattern.test(input[k]) ? calendar(input[k]) : instant(input[k]);
        if (input.range === "capture" && (input.from !== undefined || input.to !== undefined) || ["day", "week", "month", "7", "30"].includes(input.range) && (!input.from || !input.to)) throw new RangeError("Report date selection requires matching calendar boundaries.");
        return { ...input };
    }
    return { normalize, detect, resolve, displayLabel, zoneChoices, zone, locale, calendar, instant, day, addDays, preset, nextBucket, bucketDate, midnight, range, formatDate, formatTime, formatMoment, label, selection };
}

export const time = createTimeContext();
