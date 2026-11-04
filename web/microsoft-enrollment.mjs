export function mountMicrosoftEnrollment({ api, container, createState, onConnect, onChange }) {
    const state = createState(), events = new AbortController();
    const node = (tag, id, text) => {
        const element = document.createElement(tag);
        if (id) element.id = id;
        if (text) element.textContent = text;
        return element;
    };
    const form = node("form", "wireMicrosoftEnrollment");
    form.className = "wire-microsoft-enrollment"; form.noValidate = true; form.hidden = true;
    const prepare = node("button", "wireMicrosoftPrepare", "Connect Microsoft 365");
    prepare.type = "submit";
    const message = node("p", "wireMicrosoftEnrollmentMessage");
    message.className = "settings-help"; message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite");
    const recover = node("button", "wireMicrosoftEnrollmentRead", "Check connection");
    recover.type = "button"; recover.className = "quiet";
    form.append(prepare, message, recover); container.append(form);
    let token = null, generation = null, revision = 0, reading = null, again = false, disposed = false, error = "", gesture = null;
    const stamp = () => ({ token, revision });
    const synchronous = value => value !== null && value !== undefined && typeof value.then !== "function";
    function current(owner) {
        return !disposed && synchronous(owner.token) && owner.token === token && owner.revision === revision
            && api.isCurrent(owner.token) === true && !disposed && owner.token === token && owner.revision === revision;
    }
    function text(element, value) {
        if (element.textContent === value) return;
        for (const child of element.childNodes) if (child.nodeType === Node.TEXT_NODE) child.data = "";
        element.textContent = value;
    }
    function paint() {
        if (!current(stamp())) return;
        const model = state.view(generation);
        form.hidden = model.phase === "prepared" && !model.uncertain && !error;
        prepare.hidden = model.phase !== "available";
        prepare.disabled = Boolean(reading) || Boolean(error) || !model.canPrepare;
        text(prepare, model.pending ? "Connecting..." : "Connect Microsoft 365");
        const feedback = error || (model.uncertain
            ? model.phase === "prepared" ? "Earlier request unconfirmed."
                : "Connection request unconfirmed."
            : reading ? "Checking connection..."
            : model.phase === "unavailable" ? "Microsoft connection is unavailable." : "");
        text(message, feedback); message.hidden = !feedback;
        recover.hidden = model.phase === "prepared" || !error && !model.uncertain;
        recover.disabled = Boolean(reading) || model.pending;
        onChange();
    }
    function withdrawAccess() {
        revision++; token = null; generation = null; again = false; gesture = null; error = "";
        state.withdraw();
        text(message, ""); prepare.disabled = recover.disabled = true; form.hidden = true;
    }
    async function read() {
        const owner = stamp();
        if (!current(owner)) return;
        if (reading) { again ||= reading.owner.token !== owner.token || reading.owner.revision !== owner.revision; return reading.promise; }
        error = "";
        const request = { owner }; reading = request;
        request.promise = (async () => {
            try {
                paint();
                if (!current(owner)) return;
                const value = await api("/api/collection/microsoft/enrollment", {});
                if (!current(owner)) return;
                if (!state.receive(value, generation)) throw new Error("Connection setup changed.");
            } catch {
                if (current(owner)) error = "Connection details could not be read.";
            } finally {
                if (reading === request) reading = null;
                if (current(stamp())) paint();
                if (again && !disposed) { again = false; void read(); }
            }
        })();
        return request.promise;
    }
    const listen = (element, name, fn) => element.addEventListener(name, fn, { signal: events.signal });
    listen(prepare, "pointerdown", event => { if (event.button === 0) gesture = { ...stamp(), generation }; });
    listen(prepare, "pointercancel", () => { gesture = null; });
    listen(form, "keydown", event => {
        if (!["Enter", " "].includes(event.key)) return;
        if (event.repeat) { event.preventDefault(); return; }
        gesture = { ...stamp(), generation };
    });
    listen(form, "submit", event => {
        event.preventDefault();
        const owner = stamp(), original = gesture; gesture = null;
        if (!current(owner) || prepare.disabled || !prepare.checkVisibility() || !state.view(generation).canPrepare) return;
        if (original && (!current(original) || original.generation !== generation)) {
            error = "WIRE access changed."; paint(); return;
        }
        const intent = Object.freeze({ owner: api.controlToken(), publication: owner.token,
            generation, operationId: crypto.randomUUID() });
        if (api.isControlCurrent(intent.owner) !== true || !current(owner)) return;
        const command = state.begin(generation, crypto.randomUUID());
        error = ""; paint();
        void (async () => {
            try {
                if (!current(owner)) { state.failed(command, { rejected: true }); return; }
                const result = await api("/api/collection/microsoft/enroll", command);
                if (!current(owner) || api.isControlCurrent(intent.owner) !== true) { state.failed(command); return; }
                if (!state.completed(command, result, generation)) throw new Error("Preparation was retired.");
                paint();
                if (await onConnect(intent) !== true && current(owner)) {
                    error = "Sign-in did not start.";
                }
            } catch (failure) {
                state.failed(command, { rejected: failure.code === "request_rejected" && failure.outcome !== "unknown" });
                if (current(owner)) error = state.view(generation).uncertain
                    ? "Connection request unconfirmed."
                    : "The connection did not start.";
            } finally {
                if (current(stamp())) paint();
            }
        })();
    });
    listen(recover, "click", () => { if (!recover.disabled) void read(); });
    return {
        phase: () => state.view(generation).phase,
        connectionStarted() {
            if (state.view(generation).phase === "prepared" && !state.view(generation).uncertain) { error = ""; paint(); }
        },
        receiveAccess() {
            if (disposed) return;
            const access = api.accessState(), candidate = api.publicationToken();
            if (access.mode !== "enforced" || access.collectionMode !== "source-aware" || !access.readable
                || !synchronous(candidate) || !Number.isSafeInteger(access.state?.generation)) {
                withdrawAccess(); return;
            }
            if (token === candidate && generation === access.state.generation) return;
            withdrawAccess(); token = candidate; generation = access.state.generation;
            void read();
        },
        withdrawAccess,
        dispose() { withdrawAccess(); disposed = true; events.abort(); form.remove(); },
    };
}
