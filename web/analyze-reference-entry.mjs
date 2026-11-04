// Own the entry only; its caller owns the reference content and lifecycle.
export function mountAnalyzeReferenceEntry({ host, trigger, openReference }) {
    const open = () => { if (!host.hidden && trigger.checkVisibility()) openReference(); };
    trigger.addEventListener("click", open);
    return {
        show: available => { host.hidden = !available; },
        dispose: () => trigger.removeEventListener("click", open),
    };
}
