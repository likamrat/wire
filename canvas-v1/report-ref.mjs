import { createHmac } from "node:crypto";

export const reportContextRef = (key, kind, value) => value == null ? null
    : `${kind}-${createHmac("sha256", key).update(`${kind}:${value}`).digest("hex").slice(0, 16)}`;
