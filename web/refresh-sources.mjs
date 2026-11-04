// Pure policy for the two existing source operations; no dispatch or retry authority.
export function createRefreshSources() {
    const names = Object.freeze(["github", "microsoft"]);
    function basis(status, source) {
        if (source === "github") return {
            generation: status.generation, configVersion: status.github.status.configVersion,
        };
        const native = status.microsoft.status;
        return {
            generation: status.generation, accountRef: native.accountRef,
            configurationRevision: native.configuration?.configurationRevision,
            privacyRevision: native.configuration?.privacyRevision,
            globalRevision: status.global.revision,
        };
    }
    function reason(view, source) {
        if (!view.current || !view.status) return "status unavailable";
        if (source === "github") return view.status.github.status.config?.approved ? "unavailable" : "not connected";
        const native = view.status.microsoft.status;
        if (view.status.global.paused || native.configuration?.settings.paused) return "paused";
        return native.configured ? "unavailable" : "not enabled";
    }
    function capture(view) {
        if (!view.current || !view.status) throw new Error("Read current source status before refreshing.");
        // These are independent owned copies, so withdrawal can erase held references.
        return Object.fromEntries(names.map(source => {
            const admitted = view.actions[source].includes("collect-now");
            return [source, {
                admitted, reason: admitted ? "" : reason(view, source),
                expectedBasis: admitted ? basis(view.status, source) : null,
            }];
        }));
    }
    function admission(plan, source, view) {
        if (!names.includes(source)) throw new TypeError("Unknown Refresh source.");
        if (!plan[source].admitted) return { allowed: false, reason: plan[source].reason };
        if (!view.current || !view.status || !view.actions[source].includes("collect-now")) {
            return { allowed: false, reason: reason(view, source) };
        }
        if (JSON.stringify(plan[source].expectedBasis) !== JSON.stringify(basis(view.status, source))) {
            return { allowed: false, reason: "settings or access changed" };
        }
        return { allowed: true, reason: "" };
    }
    function describe(branches) {
        const messages = [], contexts = [], coverage = [];
        let recovery = false, waiting = false, problem = false;
        for (const source of names) {
            const label = source === "github" ? "GitHub" : "Microsoft";
            const branch = branches[source], result = branch.result;
            if (branch.state === "retired") continue;
            let text;
            if (branch.state === "skipped") text = `not checked (${branch.reason})`;
            else if (branch.state === "superseded") {
                text = source === "github" ? "check finished; settings changed" : "activity saved; settings changed";
                problem = true;
                if (source === "microsoft" && result?.nativeReceipt?.quality === "source-qualified-partial") coverage.push("Microsoft: partial history.");
            }
            else if (branch.state === "queued") text = "waiting";
            else if (branch.state === "running") text = source === "github" ? "checking history" : "collecting activity";
            else if (!result) { text = "result unconfirmed"; recovery = problem = true; }
            else if (result.sourceUnknown || result.sourceBlocked || result.readFailed
                || result.phase === "error" && !result.sourceFailure) {
                text = result.check ? "checked; view not updated"
                    : result.nativeReceipt?.status === "committed" ? "saved; view not verified"
                    : result.nativeReceipt?.status === "pending" ? "still pending" : "result unconfirmed";
                recovery = problem = true;
                if (result.context) contexts.push(`${label}: ${result.context}`);
            } else if (result.sourceFailure) {
                text = "history check failed"; problem = true;
                if (result.context) contexts.push(`${label}: ${result.context}`);
            } else if (result.phase === "waiting" || result.phase === "applying") {
                text = source === "github" ? "checked; view waiting" : "saved; view waiting"; waiting = true;
            } else if (source === "github" && result.check) {
                const { added, updated } = result.check.changes;
                const counts = [added ? `${added.toLocaleString()} new` : "", updated ? `${updated.toLocaleString()} updated` : ""].filter(Boolean);
                text = counts.length ? `${counts.join(", ")} activity record${added + updated === 1 ? "" : "s"}` : "no additional activity";
                if (result.context) contexts.push(`GitHub: ${result.context}`);
                if (result.check.outcome === "partial") coverage.push("GitHub: incomplete history.");
            } else if (source === "microsoft" && result.nativeReceipt?.status === "committed" && result.phase === "complete") {
                text = "activity saved";
                if (result.nativeReceipt.quality === "source-qualified-partial") coverage.push("Microsoft: partial history.");
            } else { text = "result unconfirmed"; recovery = problem = true; }
            messages.push(`${label}: ${text}.`);
        }
        return { message: messages.join(" "), context: contexts.join(" "), coverage: coverage.join(" "), recovery, waiting, problem };
    }
    return { names, capture, admission, describe };
}
