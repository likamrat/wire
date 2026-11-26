// Screen only. The standalone shell serializes this function.
export function modelDisplayName(id, names) {
    if (typeof id !== "string" || !id.trim()) return { label: "Model not recorded", missing: true };
    const name = names && Object.hasOwn(names, id) ? names[id] : null;
    return typeof name === "string" && name.trim() ? { label: name, recognized: true } : { label: id, recognized: false };
}
