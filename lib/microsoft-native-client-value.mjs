// Shared by the two in-realm readers; counts each copied occurrence, not aliases.
export function createNativeClientValueCopier(fail) {
    let bytes = 0;
    return value => {
        let nodes = 0, characters = 0;
        const own = (value, key) => {
            const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor) return undefined;
            if (!Object.hasOwn(descriptor, "value")) fail("ACCESSOR");
            return descriptor.value;
        };
        const visit = (value, depth) => {
            if (++nodes > 40000 || depth > 32) fail("RESPONSE_LIMIT");
            if (value === null || typeof value === "boolean") return value;
            if (typeof value === "number" && Number.isFinite(value)) return value;
            if (typeof value === "string") {
                characters += value.length;
                if (characters > 2 * 1024 * 1024) fail("RESPONSE_LIMIT");
                return value;
            }
            if (!value || typeof value !== "object") fail("RESPONSE_INVALID");
            if (Array.isArray(value)) {
                if (value.length > 4096) fail("RESPONSE_LIMIT");
                return Array.from({ length: value.length }, (_, index) => visit(own(value, String(index)), depth + 1));
            }
            const result = {};
            for (const key of Object.keys(value)) {
                if (["__proto__", "constructor", "prototype"].includes(key)) fail("RESPONSE_INVALID");
                characters += key.length;
                const item = own(value, key);
                if (item !== undefined) result[key] = visit(item, depth + 1);
            }
            return result;
        };
        const result = visit(value, 0);
        const size = new TextEncoder().encode(JSON.stringify(result)).length;
        bytes += size;
        if (size > 2 * 1024 * 1024 || bytes > 12 * 1024 * 1024) fail("RESPONSE_LIMIT");
        return result;
    };
}
