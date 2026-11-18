import { Component, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { createPublicationStore, type PublicationSnapshot } from "./publication-store.ts";

type Card = Readonly<{ key: string; node: HTMLElement }>;
type View = Readonly<{ epoch: number; cards: readonly Card[]; pager: Card }>;
type Options = {
    root: HTMLElement;
    pager: HTMLElement;
    isCurrent: (authority: object) => boolean;
    release: (node: HTMLElement) => void;
    onError: (message: string) => void;
    render?: (content: ReactNode) => void;
};
type Stage = {
    host: HTMLDivElement;
    pager: HTMLDivElement;
    controller: AbortController;
    authority: object;
    identity: object | null;
    scope: string;
    epoch: number;
    retired: boolean;
    nodes: HTMLElement[];
};

function erase(node: HTMLElement) {
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) text.textContent = "";
    for (const element of [node, ...node.querySelectorAll("*")]) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            element.value = "";
        }
        for (const attribute of [...element.attributes]) {
            const geometry = element.namespaceURI === "http://www.w3.org/2000/svg"
                && ["width", "height", "viewBox", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "offset"].includes(attribute.name);
            if (!geometry) attribute.value = "";
            element.removeAttributeNode(attribute);
        }
    }
    node.replaceChildren();
    node.remove();
}

class ActivityBoundary extends Component<{ children: ReactNode; onFailure: (error: unknown) => void }, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    override componentDidCatch(error: unknown) { this.props.onFailure(error); }
    override render() { return this.state.failed ? null : this.props.children; }
}

export function mountReactActivity({ root, pager, isCurrent, release, onError, render }: Options) {
    const store = createPublicationStore<View>(isCurrent), stages = new Set<Stage>();
    const failureMessage = "Recorded activity could not be displayed safely. Reload this panel.";
    let epoch = 0, accepted: Stage | null = null, failed = false;
    function retire(stage: Stage) {
        stage.retired = true;
        const nodes = new Set([...stage.nodes, ...stage.host.children, stage.pager]);
        for (const node of nodes) for (const link of [node, ...node.querySelectorAll("a[href]")]) {
            const href = link.getAttributeNode("href");
            if (href) { href.value = ""; link.removeAttributeNode(href); }
        }
        stage.controller.abort();
        stage.identity = null; stage.scope = "";
        stages.delete(stage);
        stage.nodes = [];
        const failures: unknown[] = [];
        for (const node of nodes) {
            if (!(node instanceof HTMLElement)) continue;
            try { release(node); } catch (error) { failures.push(error); }
            try { erase(node); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Recorded activity could not be cleared safely.");
    }
    function withdrawAccess() {
        epoch++; accepted = null;
        const failures: unknown[] = [];
        try { store.withdraw(); } catch (error) { failures.push(error); }
        for (const stage of [...stages]) {
            try { retire(stage); } catch (error) { failures.push(error); }
        }
        if (failures.length) {
            failed = true;
            throw new AggregateError(failures, "Recorded activity clearance failed. Reload this panel.");
        }
    }
    function current(snapshot: PublicationSnapshot<View>) {
        return !failed && snapshot.status === "ready" && store.getSnapshot() === snapshot
            && isCurrent(snapshot.authority) === true && store.getSnapshot() === snapshot;
    }
    function CardSlot({ card, snapshot }: { card: Card; snapshot: PublicationSnapshot<View> }) {
        const host = useRef<HTMLDivElement>(null);
        useLayoutEffect(() => {
            if (!host.current || !current(snapshot)) return;
            host.current.append(card.node);
            if (!current(snapshot)) {
                release(card.node); erase(card.node);
            }
            return () => { card.node.remove(); };
        }, [card, snapshot]);
        return <div ref={host} className="frontend-record-slot" />;
    }
    function ActivityList() {
        const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
        if (snapshot.status !== "ready") return null;
        return <>
            <div className="frontend-records" key={snapshot.value.epoch}>
                {snapshot.value.cards.map(card => <CardSlot key={card.key} card={card} snapshot={snapshot} />)}
            </div>
            {createPortal(<CardSlot card={snapshot.value.pager} snapshot={snapshot} />, pager, String(snapshot.value.epoch))}
        </>;
    }
    function failure(error: unknown) {
        failed = true;
        console.error("WIRE activity presentation failed.", error);
        try { withdrawAccess(); }
        finally { onError(failureMessage); }
    }
    const content = <ActivityBoundary onFailure={failure}><ActivityList /></ActivityBoundary>;
    if (render) render(content);
    else {
        const reactRoot = createRoot(root, { onUncaughtError: failure });
        flushSync(() => reactRoot.render(content));
    }
    return {
        retain(authority: object | null, identity: object, scope: string) {
            const previous = accepted;
            return Boolean(!failed && authority && previous && !previous.retired && previous.authority === authority
                && previous.identity === identity && previous.scope === scope && isCurrent(authority) === true
                && accepted === previous && !previous.retired);
        },
        begin(authority: object | null, identity: object, scope: string) {
            if (failed) { onError(failureMessage); return null; }
            const generation = epoch;
            if (!authority || isCurrent(authority) !== true || epoch !== generation) return null;
            const stage: Stage = { host: root.ownerDocument.createElement("div"), pager: root.ownerDocument.createElement("div"),
                controller: new AbortController(),
                authority, identity, scope, epoch, retired: false, nodes: [] };
            stage.pager.id = "frontendActivityPager";
            stage.pager.className = "pager";
            stages.add(stage);
            let committed = false;
            return {
                host: stage.host,
                pager: stage.pager,
                signal: stage.controller.signal,
                commit() {
                    if (stage.retired || epoch !== stage.epoch || isCurrent(authority) !== true || stage.retired) {
                        retire(stage); return false;
                    }
                    stage.nodes = [...stage.host.children].map(node => {
                        if (!(node instanceof HTMLElement)) throw new TypeError("Activity rows must be owned HTML presentations.");
                        return node;
                    });
                    const cards = Object.freeze(stage.nodes.map((node, index) => Object.freeze({
                        key: node.dataset.viewKey ?? `status:${index}`, node,
                    })));
                    stage.nodes.push(stage.pager);
                    const previous = accepted;
                    accepted = stage;
                    try {
                        if (previous) retire(previous);
                        flushSync(() => {
                            committed = store.publish(authority, Object.freeze({ epoch: stage.epoch, cards,
                                pager: Object.freeze({ key: "pager", node: stage.pager }) }));
                        });
                        if (!committed || stage.retired || accepted !== stage) {
                            retire(stage); return false;
                        }
                        return true;
                    } catch (error) {
                        failed = true;
                        try { withdrawAccess(); }
                        catch (clearance) { throw new AggregateError([error, clearance], "Activity publication and clearance failed."); }
                        throw error;
                    }
                },
                discard() {
                    if (!committed || stage.retired) retire(stage);
                },
            };
        },
        withdrawAccess,
    };
}
