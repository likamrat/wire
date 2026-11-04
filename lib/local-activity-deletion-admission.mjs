import { isNativeMicrosoftSession } from "./microsoft-session.mjs";
import { BoardError } from "./store.mjs";

const guards = new WeakMap();
const fail = () => { throw Object.assign(new BoardError("A current local activity-deletion request is required.", 403),
    { code: "LOCAL_ACTIVITY_DELETION_ADMISSION_REQUIRED" }); };
function synchronous(work) {
    const result = work();
    if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {}); fail();
    }
    if (result !== undefined && result !== true) fail();
}

export async function createLocalActivityDeletionAdmission(context, lifecycle, request, assertInstance, assertCustody) {
    if (!isNativeMicrosoftSession(lifecycle, context) || typeof assertInstance !== "function" || typeof assertCustody !== "function"
        || !request || typeof request.owner !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(request.owner)
        || typeof request.check !== "function" || typeof request.dispatched !== "function") fail();
    const owner = request.owner;
    const check = () => {
        synchronous(assertInstance);
        if (request.owner !== owner || !isNativeMicrosoftSession(lifecycle, context)) fail();
        synchronous(() => request.check());
    };
    check();
    const lease = await lifecycle.lease("retained");
    check();
    const guard = Object.freeze({});
    guards.set(guard, { context, lifecycle, lease, owner, check, custody: async () => {
        check(); await assertCustody(); check();
    }, dispatched: () => {
        check(); synchronous(() => request.dispatched());
    } });
    return guard;
}

export function isLocalActivityDeletionAdmission(guard, context, owner) {
    const held = guards.get(guard);
    return Boolean(held && held.context === context && held.owner === owner);
}

export async function admitLocalActivityDeletion(guard, context, owner, work) {
    if (!isLocalActivityDeletionAdmission(guard, context, owner) || typeof work !== "function") fail();
    const held = guards.get(guard);
    held.check();
    const result = await held.lifecycle.admit(held.lease, async () => {
        let active = true;
        const check = () => { if (!active) fail(); held.check(); };
        try {
            check();
            const custody = async () => { check(); await held.custody(); check(); };
            await custody();
            const value = await work(Object.freeze({ check, custody, dispatched: () => { check(); held.dispatched(); } }));
            check();
            return { value };
        } catch (error) { return { error }; }
        finally { active = false; }
    });
    if (Object.hasOwn(result, "error")) throw result.error;
    return result.value;
}
