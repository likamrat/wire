export type PublicationSnapshot<T> =
    | Readonly<{ status: "unavailable"; version: number }>
    | Readonly<{ status: "ready"; version: number; authority: object; value: T }>;

export function createPublicationStore<T>(isCurrent: (authority: object) => boolean) {
    let snapshot: PublicationSnapshot<T> = Object.freeze({ status: "unavailable", version: 0 });
    let failed = false;
    const listeners = new Set<() => void>();
    function notify() {
        const failures: unknown[] = [];
        for (const listener of listeners) {
            try { listener(); } catch (error) { failures.push(error); }
        }
        if (!failures.length) return;
        failed = true;
        snapshot = Object.freeze({ status: "unavailable", version: snapshot.version + 1 });
        for (const listener of listeners) {
            try { listener(); } catch (error) { failures.push(error); }
        }
        throw new AggregateError(failures, "WIRE presentation could not publish safely. Reload this panel.");
    }
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        publish(authority: object | null, value: T) {
            const version = snapshot.version;
            if (failed || !authority || isCurrent(authority) !== true || snapshot.version !== version) return false;
            const published = Object.freeze({ status: "ready" as const, version: version + 1, authority, value });
            snapshot = published;
            notify();
            return snapshot === published;
        },
        withdraw() {
            snapshot = Object.freeze({ status: "unavailable", version: snapshot.version + 1 });
            notify();
        },
    };
}
