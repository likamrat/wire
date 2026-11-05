// Serialized by the shared mount. Source acquisition remains outside this owner.
export function mountAccountSettingsPresentation({ api, ux, accountSlot, connectionSlot, createNativeConnectionState, refreshProfile, refreshMicrosoftProfile, mountEnrollment, placeMicrosoftCollection, onConnectionChange }) {
    if (typeof api !== "function"
        || ["accessState", "publicationToken", "isCurrent", "controlToken", "isControlCurrent"].some(name => typeof api[name] !== "function")) {
        throw new TypeError("WIRE account actions require the shared access and original-owner interfaces.");
    }
    if (!(accountSlot instanceof HTMLElement) || !(connectionSlot instanceof HTMLElement)
        || accountSlot.childElementCount || connectionSlot.childElementCount || document.getElementById("wireAccountTrigger")) {
        throw new TypeError("Account presentation requires empty hosts and a single mounted instance.");
    }
    const abort = new AbortController(), signal = abort.signal;
    const copilotOnly = api.accessState().collectionMode === "copilot-only";
    const hidden = [accountSlot.hidden, connectionSlot.hidden];
    const synchronousToken = token => token !== null && token !== undefined && typeof token.then !== "function";
    const publicationCurrent = token => synchronousToken(token) && api.isCurrent(token) === true;
    const controlCurrent = token => synchronousToken(token) && api.isControlCurrent(token) === true;
    function clearText(element) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) walker.currentNode.data = "";
    }
    function setText(element, text) {
        if (element.textContent !== text) { clearText(element); element.textContent = text; }
    }
    function clearAttribute(element, name) {
        const attribute = element.getAttributeNode(name);
        if (attribute) { attribute.value = ""; element.removeAttribute(name); }
    }
    function clearImage(image) {
        for (const name of ["src", "alt", "title"]) clearAttribute(image, name);
    }
    function clearAvatar(element) {
        for (const image of element.querySelectorAll("img")) clearImage(image);
        clearText(element); element.replaceChildren();
    }
    const node = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    const button = (id, text) => {
        const element = node("button", "", text);
        element.id = id; element.type = "button";
        return element;
    };
    const avatar = () => {
        const element = node("span", "wire-account-avatar");
        element.setAttribute("aria-hidden", "true");
        return element;
    };
    const trigger = button("wireAccountTrigger", "");
    trigger.className = "wire-account-trigger";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", "wireAccountMenu");
    const triggerAvatar = avatar(), triggerName = node("span"), triggerDetail = node("small");
    const triggerCopy = node("span", "wire-account-copy");
    triggerCopy.append(triggerName, triggerDetail);
    trigger.append(triggerAvatar, triggerCopy, ux.icon("chevron"));
    const entry = node("div", "wire-account-entry");
    entry.append(trigger); accountSlot.append(entry);
    accountSlot.classList.add("wire-account-slot");

    const menu = node("div", "wire-account-menu");
    menu.id = "wireAccountMenu";
    menu.setAttribute("popover", "auto"); menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "WIRE account"); menu.tabIndex = -1;
    const identity = node("div", "wire-account-identity"), menuAvatar = avatar();
    const identityCopy = node("div"), menuName = node("p"), menuDetail = node("small");
    identityCopy.append(menuName, menuDetail); identity.append(menuAvatar, identityCopy);
    const profileMessage = node("p", "wire-account-profile-message");
    profileMessage.id = "wireAccountProfileMessage"; profileMessage.hidden = true;
    const profileRetry = typeof refreshProfile === "function" ? button("wireAccountProfileRetry", "Read profile again") : null;
    if (profileRetry) { profileRetry.className = "wire-account-action"; profileRetry.setAttribute("role", "menuitem"); profileRetry.hidden = true; }
    const gate = button("wireAccountGate", "Sign out of this instance");
    gate.className = "wire-account-action";
    gate.setAttribute("role", "menuitem"); gate.disabled = true;
    const gateScope = node("p", "wire-connection-effect");
    gateScope.id = "wireAccountGateScope";
    const gateMessage = node("p", "wire-account-error");
    gateMessage.id = "wireAccountGateMessage"; gateMessage.hidden = true;
    gateMessage.setAttribute("role", "status"); gateMessage.setAttribute("aria-live", "polite");
    gateMessage.setAttribute("aria-atomic", "true");
    menu.append(identity, profileMessage);
    if (profileRetry) menu.append(profileRetry);
    menu.append(gate, gateScope, gateMessage);
    document.body.append(menu);

    const section = node("section", "settings-group wire-microsoft-connection");
    section.id = "wireMicrosoftConnection"; section.tabIndex = -1;
    section.setAttribute("aria-labelledby", "wireMicrosoftTitle");
    const row = node("div", "wire-connection-row"), copy = node("div");
    const heading = node("h3", "", "Microsoft 365");
    heading.id = "wireMicrosoftTitle";
    const status = node("p"), explanation = node("p", "wire-connection-effect");
    status.id = "wireMicrosoftStatus"; status.setAttribute("role", "status");
    const connectionSummary = node("div", "wire-connection-summary"), connectionAccount = node("p", "wire-connection-account");
    connectionAccount.id = "wireMicrosoftAccount"; connectionAccount.hidden = true;
    connectionSummary.append(status, connectionAccount);
    const connectionProfileError = node("p", "wire-connection-account");
    connectionProfileError.id = "wireMicrosoftProfileError"; connectionProfileError.hidden = true;
    connectionProfileError.setAttribute("role", "status");
    connectionProfileError.append(document.createTextNode("Work account details could not be read. "));
    const connectionProfileRetry = typeof refreshMicrosoftProfile === "function" ? button("wireMicrosoftProfileRetry", "Read again") : null;
    if (connectionProfileRetry) connectionProfileError.append(connectionProfileRetry);
    const action = button("wireMicrosoftAction", "Connect Microsoft 365");
    action.disabled = true;
    copy.append(heading, connectionSummary, connectionProfileError, explanation); row.append(copy, action);
    section.append(row);
    if (!copilotOnly) connectionSlot.append(section);
    const restoreCollection = !copilotOnly && typeof placeMicrosoftCollection === "function" ? placeMicrosoftCollection(section) : null;
    accountSlot.hidden = connectionSlot.hidden = true;

    let disposed = false, changing = false, imageRevision = 0, imageKey = null, imageFailed = false, timers = [];
    let current = null, profileToken = null, imageEvents = null, presentationRevision = 0;
    let microsoftProfile = null, microsoftProfileToken = null, microsoftProfileTimer;
    let accessView = null, accessKey = "", accessOwner = null, controlStatus = null, statusOwner = null, statusRead = null;
    let statusAgain = false, statusError = false, gateError = "", actionBusy = false, pendingGate = null;
    let activation = null;
    let nativeState = null, nativeActivation = null, nativePresented = false;
    let nativeResultRead = null;
    const enrollment = !copilotOnly && typeof mountEnrollment === "function"
        ? mountEnrollment({ api, container: section, onConnect: continuePreparedConnection, onChange: paintNativeConnection }) : null;
    if (enrollment) row.append(section.querySelector("#wireMicrosoftEnrollment"));
    const presentationActive = revision => !disposed && revision === presentationRevision;
    const listen = (target, event, listener, options = {}) => target.addEventListener(event, listener, { ...options, signal });
    function close(restore = false) {
        if (!menu.matches(":popover-open")) return;
        menu.hidePopover();
        if (restore && trigger.checkVisibility()) ux.restoreFocus(trigger);
    }
    function position() {
        const box = trigger.getBoundingClientRect();
        menu.style.left = Math.max(12, Math.min(box.left, innerWidth - menu.offsetWidth - 12)) + "px";
        menu.style.top = Math.max(12, Math.min(box.top - menu.offsetHeight - 8, innerHeight - menu.offsetHeight - 12)) + "px";
    }
    listen(menu, "beforetoggle", () => { changing = true; });
    listen(menu, "toggle", () => {
        changing = false;
        trigger.setAttribute("aria-expanded", String(menu.matches(":popover-open")));
    });
    listen(trigger, "click", () => {
        if (!trigger.checkVisibility()) return;
        if (menu.matches(":popover-open")) { close(true); return; }
        const parent = trigger.closest("dialog[open]") || document.body;
        if (menu.parentElement !== parent) parent.append(menu);
        ux.hideTooltip(); menu.showPopover(); position();
        trigger.setAttribute("aria-expanded", "true");
        (gate.disabled ? menu : gate).focus({ preventScroll: true });
    });
    listen(window, "keydown", event => {
        if (!menu.matches(":popover-open")) return;
        if (event.key === "Escape") {
            event.preventDefault(); event.stopImmediatePropagation(); close(true);
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled && item.checkVisibility());
            const index = items.indexOf(document.activeElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
            (items[next] || menu).focus({ preventScroll: true });
        }
    }, { capture: true });
    listen(document, "focusin", event => {
        if (menu.matches(":popover-open") && event.target !== trigger && !menu.contains(event.target)) close();
    });
    listen(window, "resize", () => close());
    listen(document, "close", event => {
        if (event.target instanceof HTMLDialogElement && event.target.contains(menu)) close();
    }, { capture: true });
    const navigation = new MutationObserver(() => close());
    navigation.observe(document.documentElement, { attributes: true, attributeFilter: ["data-navigation"] });
    ux.tooltip(trigger, () => !changing && !menu.matches(":popover-open")
        && document.documentElement.dataset.navigation === "collapsed" && matchMedia("(min-width:700px)").matches
        ? trigger.getAttribute("aria-label") : "", { placement: "right", tone: "contrast" });
    if (profileRetry) listen(profileRetry, "click", () => {
        if (!profileRetry.disabled && profileRetry.checkVisibility()) void refreshProfile();
    });
    if (connectionProfileRetry) listen(connectionProfileRetry, "click", () => {
        if (!connectionProfileRetry.disabled && connectionProfileRetry.checkVisibility()) void refreshMicrosoftProfile();
    });

    function clearTimers() {
        for (const timer of timers) clearTimeout(timer);
        timers = [];
    }
    function later(time, callback) {
        if (!Number.isFinite(time)) return;
        timers.push(setTimeout(callback, Math.max(0, Math.min(time - Date.now(), 2147483647))));
    }
    function retireImages() {
        imageEvents?.abort(); imageEvents = null; imageRevision++;
        for (const slot of [triggerAvatar, menuAvatar]) for (const image of slot.querySelectorAll("img")) {
            clearImage(image);
        }
        imageKey = null; imageFailed = false;
    }
    function paintProfile() {
        if (disposed) return;
        paintMicrosoftProfile();
        if (disposed) return;
        const presentation = presentationRevision;
        const hasControlStatus = statusCurrent();
        if (!presentationActive(presentation)) return;
        const token = profileToken;
        if (current !== null) {
            const allowed = publicationCurrent(token);
            if (!presentationActive(presentation)) return;
            if (!allowed) { withdrawAccess(); return; }
        }
        const github = current?.github || { phase: "unavailable", profile: null };
        const profile = github.profile;
        const leased = profile?.identity.expiresAt;
        const wireHidden = (hasControlStatus ? controlStatus.wire : accessView?.state?.wire) === "signed-out";
        const verified = !wireHidden && github.phase === "ready" && profile?.identity.state === "verified"
            && (leased === undefined || leased > Date.now());
        const appProfile = profile?.identity.source === "copilot-app-profile";
        const nextImageKey = verified && profile.avatar.url && profile.avatar.expiresAt > Date.now()
            ? JSON.stringify([profile.generation, profile.identity.generation, profile.avatar.url]) : null;
        const imageChanged = nextImageKey !== imageKey;
        if (imageChanged) { retireImages(); imageKey = nextImageKey; }
        const revision = imageRevision;
        let name = "Local WIRE access", detail = hasControlStatus ? "This instance" : "Checking access";
        let fallback = "";
        if (verified) {
            name = profile.displayName.value || profile.identity.login;
            detail = "@" + profile.identity.login;
            fallback = profile.fallback.kind === "initials" ? profile.fallback.text : "";
        } else if (wireHidden) {
            name = "Local WIRE access";
            detail = "Signed out";
        } else if (github.phase === "loading") {
            detail = "Checking profile";
        }
        setText(triggerName, verified ? name : "Account"); setText(menuName, name);
        setText(triggerDetail, detail); setText(menuDetail, verified && appProfile ? "GitHub profile: " + detail : detail);
        menuDetail.hidden = !verified && detail === "This instance";
        const needsRead = github.phase === "error" || verified === false
            && (profile?.identity.reason === "account-snapshot-expired" || profile?.issues?.length > 0);
        const profileHelp = !wireHidden && needsRead ? "GitHub profile could not be read." : "";
        setText(profileMessage, profileHelp); profileMessage.hidden = !profileHelp;
        if (profileRetry) {
            profileRetry.hidden = wireHidden || !needsRead;
            profileRetry.disabled = !accessView?.readable;
        }
        const label = `${verified && appProfile ? "Copilot app profile" : "WIRE account"}: ${name}, ${detail}`;
        if (trigger.getAttribute("aria-label") !== label) {
            clearAttribute(trigger, "aria-label"); trigger.setAttribute("aria-label", label);
        }
        const fallbackAvatar = element => {
            clearAvatar(element);
            if (fallback) element.textContent = fallback;
            else element.append(ux.icon("account"));
        };
        if (!imageKey || imageChanged || imageFailed) for (const element of [triggerAvatar, menuAvatar]) fallbackAvatar(element);
        if (imageKey && imageChanged) {
            imageEvents = new AbortController();
            for (const element of [triggerAvatar, menuAvatar]) {
                const image = node("img");
                image.alt = ""; image.width = image.height = 32;
                image.addEventListener("error", () => {
                    const callbackPresentation = presentationRevision;
                    if (disposed || revision !== imageRevision) return;
                    if (!publicationCurrent(token) || !presentationActive(callbackPresentation) || revision !== imageRevision) return;
                    imageFailed = true;
                    for (const slot of [triggerAvatar, menuAvatar]) fallbackAvatar(slot);
                    console.warn("GitHub profile image unavailable; using its verified fallback.");
                }, { once: true, signal: imageEvents.signal });
                clearAvatar(element);
                image.src = profile.avatar.url; element.append(image);
            }
        }
        if (menu.matches(":popover-open")) position();
    }
    function paintMicrosoftProfile() {
        const presentation = presentationRevision;
        const allowed = microsoftProfile !== null && publicationCurrent(microsoftProfileToken);
        if (!presentationActive(presentation)) return;
        const connected = accessView?.readable && accessView.state?.wire === "signed-in"
            && accessView.state?.microsoft?.state === "connected";
        const profile = microsoftProfile?.profile;
        const email = allowed && connected && microsoftProfile.phase === "ready"
            && profile?.identity.state === "verified" && profile.identity.expiresAt > Date.now() ? profile.email.value : "";
        setText(connectionAccount, email); connectionAccount.hidden = !email;
        connectionProfileError.hidden = !(allowed && connected && microsoftProfile.phase === "error");
        if (connectionProfileRetry) connectionProfileRetry.disabled = connectionProfileError.hidden;
    }
    function validateProfile(value, provider = "github") {
        if (!value || !["loading", "ready", "error", "unavailable"].includes(value.phase)) throw new TypeError("Invalid local account read state.");
        if (value.phase !== "ready") {
            if (value.profile != null) throw new TypeError("Only a completed profile read can supply profile data.");
            return;
        }
        const p = value.profile;
        if (p?.schemaVersion !== 1 || p.provider !== provider || typeof p.generation !== "string"
            || !["verified", "unavailable", "signed-out"].includes(p.identity?.state)
            || !p.displayName || !p.avatar || !p.fallback || !Array.isArray(p.issues)) throw new TypeError("Expected a supported account profile response.");
        if (p.provider === "microsoft") {
            const verified = p.identity.state === "verified", email = p.email?.value;
            if (!p.email || p.displayName.value !== null || p.avatar.url !== null
                || !["verified", "unavailable"].includes(p.identity.state)
                || !Number.isFinite(p.identity.checkedAt) || !Number.isFinite(p.identity.expiresAt)
                || p.identity.expiresAt <= p.identity.checkedAt || p.identity.expiresAt - p.identity.checkedAt > 15000
                || verified && (p.identity.source !== "microsoft-native-principal" || p.email.source !== "microsoft-native-principal"
                    || typeof email !== "string" || email.length > 160 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email)
                    || p.fallback.kind !== "initials" || p.fallback.source !== "verified-email" || p.fallback.text !== [...email][0].toUpperCase())
                || !verified && (email !== null || p.fallback.kind !== "neutral" || p.fallback.text !== null)) {
                throw new TypeError("Microsoft presentation requires a matched observed email and no invented name or photo.");
            }
            return;
        }
        const loginPattern = p.identity.source === "copilot-app-profile" ? /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/ : /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
        if (p.identity.state === "verified" && (p.identity.host !== "github.com"
            || typeof p.identity.login !== "string" || !loginPattern.test(p.identity.login))) throw new TypeError("Verified GitHub identity requires its supported host and login.");
        if (p.refreshAt !== undefined && !Number.isFinite(p.refreshAt)) throw new TypeError("Profile refresh must be an epoch timestamp.");
        if (p.displayName.value !== null && typeof p.displayName.value !== "string") throw new TypeError("Public profile name must be text or null.");
        if (p.identity.expiresAt !== undefined && !Number.isFinite(p.identity.expiresAt)) throw new TypeError("Profile lease must be an epoch timestamp.");
        if (p.avatar.url !== null && (typeof p.avatar.url !== "string"
            || !/^\/api\/profile\/github\/avatar\/[a-f0-9]{64}$/.test(p.avatar.url)
            || !Number.isFinite(p.avatar.expiresAt))) throw new TypeError("Avatar must use the returned same-origin profile image route and expiry.");
        if (p.fallback.kind === "initials" && (p.identity.state !== "verified"
            || p.fallback.source !== "verified-login" || p.fallback.text !== p.identity.login[0].toUpperCase())) throw new TypeError("Initials must come from the verified GitHub login.");
    }
    const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    function validControlStatus(value, view) {
        return exact(value, ["schemaVersion", "mode", "runtimeId", "stage", "authorizationRevision", "generation",
            "wire", "retained", "collection", "actions", "maxWaitMs", "freshnessMs", "enforcement",
            ...(value && Object.hasOwn(value, "microsoft") ? ["microsoft"] : []),
            ...(value && Object.hasOwn(value, "collectionMode") ? ["collectionMode"] : [])])
            && value.schemaVersion === 1 && value.mode === "enforced" && ["private-fixture", "native-read-only", "copilot-only"].includes(value.stage)
            && value.collectionMode === view.collectionMode
            && (!Object.hasOwn(value, "collectionMode") || ["source-aware", "copilot-only"].includes(value.collectionMode))
            && value.runtimeId === view.runtimeId && integer(value.authorizationRevision) && integer(value.generation)
            && ["signed-in", "signed-out"].includes(value.wire) && typeof value.retained === "boolean"
            && ["enabled", "paused"].includes(value.collection) && value.maxWaitMs === 1000 && value.freshnessMs === 5000
            && Array.isArray(value.actions) && value.actions.length <= 2
            && new Set(value.actions).size === value.actions.length
            && value.actions.every(action => ["wire-sign-in", "wire-sign-out"].includes(action))
            && exact(value.enforcement, ["backendReads", "acquisition", "accountPartitions", "clientClearance"])
            && value.enforcement.backendReads === "generation-fenced"
            && (!Object.hasOwn(value, "microsoft") || value.stage === "native-read-only"
                && typeof api.decodeMicrosoftConnection === "function" && Boolean(api.decodeMicrosoftConnection(value.microsoft)));
    }
    function sameMicrosoft(a, b) {
        if (a === undefined || b === undefined) return a === b;
        return a.state === b.state && a.reason === b.reason && a.actions.length === b.actions.length
            && a.actions.every(action => b.actions.includes(action));
    }
    function matchesObservation(value, view) {
        const observed = view.state;
        return !observed || value.authorizationRevision >= observed.authorizationRevision && value.generation >= observed.generation
            && (value.authorizationRevision !== observed.authorizationRevision
                || ["generation", "wire", "retained", "collection"].every(key => value[key] === observed[key])
                    && sameMicrosoft(value.microsoft, observed.microsoft));
    }
    function statusCurrent() {
        const value = controlStatus, view = accessView, owner = statusOwner;
        return value && view?.mode === "enforced" && view.state && controlCurrent(owner)
            && !disposed && value === controlStatus && view === accessView && owner === statusOwner
            && value.runtimeId === view.runtimeId && matchesObservation(value, view);
    }
    function paintGate() {
        if (disposed) return;
        const presentation = presentationRevision, view = accessView, value = controlStatus, operation = pendingGate;
        const available = view?.mode === "enforced";
        let text = value?.wire === "signed-out" ? "Sign in to WIRE" : "Sign out of this instance";
        let disabled = true, feedback = gateError;
        if (operation) {
            const word = operation.action === "wire-sign-in" ? "sign-in" : "sign-out";
            text = operation.inFlight ? (operation.action === "wire-sign-in" ? "Signing in..." : "Signing out...")
                : `Check ${word}`;
            const owned = controlCurrent(operation.owner);
            disabled = !available || actionBusy || operation.inFlight || !owned;
            if (!owned) feedback = `The ${word} result is unconfirmed. Reopen WIRE.`;
        } else if (actionBusy) {
            text = "Checking WIRE access...";
        } else if (statusError) {
            text = "Check connection";
            disabled = !available || !controlCurrent(api.controlToken());
            feedback ||= "WIRE access could not be read.";
        } else if (statusCurrent()) {
            const action = controlStatus.wire === "signed-out" ? "wire-sign-in" : "wire-sign-out";
            disabled = !controlStatus.actions.includes(action);
        }
        if (!controlCurrent(api.controlToken()) || !pendingGate && ["suspended", "clearance-failed"].includes(accessView?.reason)) disabled = true;
        if (!presentationActive(presentation) || view !== accessView || value !== controlStatus || operation !== pendingGate) return;
        accountSlot.hidden = !available;
        connectionSlot.hidden = copilotOnly || !available || !view.readable
            && !(view.reason === "generation-changed" && view.state?.wire === "signed-in");
        gate.textContent = text; gate.disabled = disabled;
        gateScope.hidden = value?.wire === "signed-out";
        gateScope.textContent = gateScope.hidden ? ""
            : "Stops collection and hides saved activity. Does not delete data or sign out of GitHub or Copilot.";
        if (gateScope.hidden) gate.removeAttribute("aria-describedby");
        else gate.setAttribute("aria-describedby", gateScope.id);
        gateMessage.textContent = feedback; gateMessage.hidden = !feedback;
        if (menu.matches(":popover-open")) position();
        paintNativeConnection();
    }
    async function refreshControlStatus() {
        if (disposed || accessView?.mode !== "enforced") return null;
        if (statusRead) { statusAgain = true; return statusRead; }
        const owner = api.controlToken();
        if (!controlCurrent(owner)) { controlStatus = null; paintGate(); return null; }
        statusAgain = false;
        statusRead = (async () => {
            try {
                const value = await api("/api/access/status");
                if (disposed || !controlCurrent(owner)) return null;
                const view = api.accessState();
                if (view.mode !== "enforced" || !validControlStatus(value, view)) throw new Error("Invalid WIRE access status.");
                if (!matchesObservation(value, view)) { statusAgain = true; return null; }
                accessView = view;
                controlStatus = Object.hasOwn(value, "microsoft")
                    ? { ...value, microsoft: api.decodeMicrosoftConnection(value.microsoft) } : value;
                statusOwner = owner; statusError = false; statusAgain = false;
                if (!value.retained && current) withdrawAccess();
                paintProfile();
                return controlStatus;
            } catch {
                if (!disposed && controlCurrent(owner)) { controlStatus = null; statusOwner = null; statusError = true; }
                return null;
            } finally {
                if (!disposed) paintGate();
            }
        })();
        try { return await statusRead; }
        finally {
            statusRead = null;
            if (!disposed && statusAgain) { statusAgain = false; void refreshControlStatus(); }
            recoverNativeResult();
        }
    }
    function acceptReceipt(value, operation) {
        if (!exact(value, ["operationId", "action", "generation", "outcome", "reason", "revocation"])
            || value.operationId !== operation.id || value.action !== operation.action || !integer(value.generation) || value.generation <= operation.generation
            || !["pending", "completed", "failed", "cancelled", "ambiguous"].includes(value.outcome)
            || value.reason !== null && (typeof value.reason !== "string" || !/^[a-z][a-z0-9-]{0,80}$/.test(value.reason))
            || value.revocation !== null && (!exact(value.revocation, ["scope", "partition"])
                || value.revocation.scope !== "wire" || value.revocation.partition !== null)
            || operation.action === "wire-sign-in" && value.revocation !== null
            || operation.action === "wire-sign-out" && value.revocation === null
            || value.outcome === "completed" && value.reason !== null) {
            throw new Error("The original WIRE action receipt could not be verified.");
        }
        if (["pending", "ambiguous"].includes(value.outcome)) {
            gateError = "Result still unconfirmed.";
            return false;
        }
        pendingGate = null;
        gateError = value.outcome === "completed" ? ""
            : operation.action === "wire-sign-in" ? "Sign in could not be completed." : "Sign out could not be completed.";
        return true;
    }
    function captureAction() {
        if (gate.disabled || !gate.checkVisibility()) return null;
        if (pendingGate) return { kind: "receipt", id: pendingGate.id, owner: pendingGate.owner };
        if (!statusCurrent() || statusError) return { kind: "status", owner: api.controlToken() };
        return { kind: "command", action: controlStatus.wire === "signed-out" ? "wire-sign-in" : "wire-sign-out",
            generation: controlStatus.generation, owner: api.controlToken() };
    }
    async function runGate(expected) {
        if (disposed || gate.disabled || !gate.checkVisibility() || actionBusy) return;
        if (!expected || expected.kind === "receipt" && pendingGate?.id !== expected.id
            || expected.kind !== "receipt" && pendingGate) return;
        const view = api.accessState();
        if (view.mode !== "enforced") return;
        accessView = view;
        if (!pendingGate && ["suspended", "clearance-failed"].includes(view.reason)) { paintGate(); return; }
        actionBusy = true;
        const recovering = pendingGate;
        const intent = expected.kind === "command" ? expected.action : null;
        const owner = expected.owner;
        gateError = ""; paintGate();
        let operation = recovering;
        try {
            if (!controlCurrent(owner)) return;
            if (recovering) {
                recovering.inFlight = true; paintGate();
                const receipt = await api("/api/access/receipt", { schemaVersion: 1, operationId: recovering.id }, { controlToken: owner });
                if (disposed || pendingGate !== recovering || !controlCurrent(owner)) return;
                if (receipt === null) {
                    gateError = "Result unconfirmed.";
                } else acceptReceipt(receipt, recovering);
                await refreshControlStatus();
                return;
            }
            const latest = await refreshControlStatus();
            if (disposed || !latest || !controlCurrent(owner) || !intent) return;
            if (!latest.actions.includes(intent) || expected.generation !== latest.generation
                || (intent === "wire-sign-in") !== (latest.wire === "signed-out")) {
                gateError = "WIRE access changed.";
                return;
            }
            operation = { id: crypto.randomUUID(), action: intent, generation: latest.generation, owner, inFlight: true };
            pendingGate = operation; paintGate();
            const receipt = await api("/api/access/command", {
                schemaVersion: 1, action: intent, operationId: operation.id, generation: operation.generation,
            }, { controlToken: owner });
            if (disposed || pendingGate !== operation || !controlCurrent(owner)) return;
            acceptReceipt(receipt, operation);
            await refreshControlStatus();
        } catch (error) {
            if (disposed) return;
            if (operation && pendingGate === operation) {
                if (!recovering && error.code === "request_rejected" && error.outcome !== "unknown") {
                    pendingGate = null; gateError = "The action did not start.";
                } else {
                    gateError = "Result unconfirmed.";
                }
            } else {
                statusError = true;
            }
        } finally {
            if (operation) operation.inFlight = false;
            actionBusy = false;
            if (!disposed) paintGate();
        }
    }
    listen(gate, "pointerdown", event => { if (event.button === 0) activation = captureAction(); });
    listen(gate, "pointercancel", () => { activation = null; });
    listen(gate, "keydown", event => {
        if (!["Enter", " "].includes(event.key)) return;
        if (event.repeat) { event.preventDefault(); return; }
        activation = captureAction();
    });
    listen(gate, "click", event => {
        const expected = activation || captureAction();
        activation = null;
        if (event.detail > 1) return;
        void runGate(expected);
    });
    function nativeControlStatus() {
        return statusCurrent() && controlStatus.microsoft ? controlStatus : null;
    }
    function ensureNativeState() {
        if (nativeState) return nativeState;
        if (typeof createNativeConnectionState !== "function" || typeof api.decodeMicrosoftReceipt !== "function") {
            throw new TypeError("Native connection controls require their operation-state and receipt interfaces.");
        }
        nativeState = createNativeConnectionState({ isOwnerCurrent: controlCurrent, decodeReceipt: api.decodeMicrosoftReceipt });
        return nativeState;
    }
    function connectionReason(reason, wire) {
        return reason === "signed-out" && wire === "signed-in" ? "" : reasonText[reason];
    }
    function unavailableConnectionFeedback() {
        if (disposed || !nativeState) return "";
        const model = nativeState.snapshot(null, api.controlToken());
        if (model.error?.code === "failed") return reasonText[model.error.reason] || "The Microsoft connection action could not be completed.";
        if (model.pending.some(item => item.action === "microsoft-connect")) return "Microsoft sign-in result is unconfirmed.";
        return model.pending.length ? "Microsoft connection result is unconfirmed." : "";
    }
    function paintNativeConnection() {
        if (disposed) return false;
        const presentation = presentationRevision, view = accessView, owner = api.controlToken();
        const accepted = nativeControlStatus(), ms = accepted?.microsoft ?? view?.state?.microsoft;
        if (enrollment?.phase() === "available" && (!nativeState || nativeState.snapshot(null, owner).pending.length === 0)) {
            setText(status, "Not connected"); setText(explanation, ""); explanation.hidden = true;
            action.hidden = true; action.disabled = true; nativePresented = true;
            return true;
        }
        if (!ms && (!nativeState || nativeState.snapshot(null, owner).pending.length === 0)) {
            const setup = enrollment?.phase();
            if (setup === "available" || setup === "prepared") {
                setText(status, "Not connected"); setText(explanation, ""); explanation.hidden = true;
                action.hidden = setup === "available";
                setText(action, statusError ? "Read connection" : "Connect Microsoft 365");
                action.disabled = !statusError || !view?.readable || !controlCurrent(owner); nativePresented = true;
                return true;
            }
            action.hidden = false;
            if (nativePresented) {
                setText(status, states.unavailable[0]); setText(action, states.unavailable[2]);
                setText(explanation, ""); explanation.hidden = true; action.disabled = true;
                nativePresented = false;
            }
            return false;
        }
        action.hidden = false;
        const model = ensureNativeState().snapshot(accepted, owner);
        const available = view?.mode === "enforced" && view.readable && controlCurrent(owner)
            && !["suspended", "clearance-failed"].includes(view.reason);
        const intent = model.intent, working = model.pending.find(item => item.action !== "microsoft-connect") ?? model.pending[0];
        let label = ms?.state === "connected" ? "Reconnect Microsoft 365" : states[ms?.state || "unavailable"][2];
        if (intent?.kind === "receipt") label = "Check connection result";
        else if (intent?.action === "microsoft-cancel") label = "Cancel sign-in";
        else if (intent?.action === "microsoft-recover") label = "Recover connection";
        else if (model.phase === "working") label = working?.action === "microsoft-cancel" ? "Cancelling sign-in..."
            : working?.action === "microsoft-recover" ? "Recovering connection..." : "Signing in...";
        else if (model.phase === "owner-lost") label = "Connection result unavailable";
        else if (!intent && statusError && !model.pending.length) label = "Read connection";
        const messages = {
            changed: "The connection changed.",
            "not-started": "The connection did not start.",
            unconfirmed: "Connection result unconfirmed.",
        };
        const pendingGuidance = accepted?.microsoft.state === "signing-in" && intent?.action === "microsoft-cancel"
            ? "Continue in the Microsoft sign-in window." : "";
        const feedback = model.phase === "owner-lost"
            ? "Connection result unconfirmed. Reopen WIRE."
            : model.error?.code === "failed" ? connectionReason(model.error.reason, accepted?.wire ?? view?.state?.wire)
                || "The Microsoft connection action could not be completed."
            : pendingGuidance || messages[model.error?.code] || (model.phase === "unconfirmed" ? messages.unconfirmed : "")
                || (statusError ? "Connection details could not be read." : "")
                || (ms?.reason ? connectionReason(ms.reason, accepted?.wire ?? view?.state?.wire)
                    : "");
        if (!presentationActive(presentation) || view !== accessView) return true;
        nativePresented = true;
        setText(status, ms ? states[ms.state][0] : "Connection result unconfirmed");
        setText(action, label);
        setText(explanation, feedback || ""); explanation.hidden = !feedback;
        action.disabled = !available || actionBusy || !intent && !(statusError && !model.pending.length);
        return true;
    }
    function captureNativeAction() {
        if (disposed || action.disabled || !action.checkVisibility()) return null;
        const owner = api.controlToken();
        if (!nativeState) return statusError ? { kind: "status", owner } : null;
        const model = nativeState.snapshot(nativeControlStatus(), owner);
        return model.intent || (statusError && !model.pending.length ? { kind: "status", owner } : null);
    }
    function recoverNativeResult() {
        if (disposed || !nativeState || document.visibilityState !== "visible" || !accessView?.readable) return;
        const owner = api.controlToken(), publication = api.publicationToken(), accepted = nativeControlStatus();
        if (!accepted || !publicationCurrent(publication) || accepted.wire !== "signed-in"
            || accepted.microsoft.actions.includes("microsoft-cancel")
            || accepted.microsoft.reason === "cancelled"
            || !accepted.microsoft.actions.includes("microsoft-connect")
                && !(accepted.microsoft.state === "recovery-required" && accepted.microsoft.reason === "cleanup-failed"
                    && accepted.microsoft.actions.includes("microsoft-recover"))) return;
        const model = nativeState.snapshot(accepted, owner), operation = model.pending[0];
        if (!operation) { nativeResultRead = null; return; }
        if (model.phase !== "unconfirmed" || model.pending.length !== 1 || operation.action !== "microsoft-connect"
            || model.intent?.kind !== "receipt" || operation.owner !== owner || accepted.generation <= operation.generation) return;
        const key = JSON.stringify([operation.id, accepted.generation, accepted.microsoft.state, accepted.microsoft.reason]);
        if (nativeResultRead === key || action.disabled || !action.checkVisibility()) return;
        const current = () => !disposed && controlCurrent(owner) && publicationCurrent(publication)
            && nativeControlStatus()?.generation === accepted.generation
            && sameMicrosoft(nativeControlStatus()?.microsoft, accepted.microsoft);
        nativeResultRead = key;
        void runNativeAction(model.intent, undefined, current);
    }
    async function continuePreparedConnection(intent) {
        const valid = () => !disposed && controlCurrent(intent.owner) && api.controlToken() === intent.owner
            && publicationCurrent(intent.publication) && api.accessState().state?.wire === "signed-in"
            && api.accessState().state?.generation === intent.generation;
        if (!valid()) return false;
        const latest = await refreshControlStatus();
        if (!valid() || latest?.generation !== intent.generation || !latest.microsoft?.actions.includes("microsoft-connect")) return false;
        return await runNativeAction({ kind: "command", action: "microsoft-connect", generation: intent.generation,
            owner: intent.owner }, intent.operationId, valid) === true;
    }
    async function runNativeAction(expected, operationId, continuationCurrent = () => true) {
        if (!expected || disposed || action.disabled || !action.checkVisibility() || actionBusy || !controlCurrent(expected.owner)) return;
        let operation = null;
        try {
            if (expected.kind === "status") { await refreshControlStatus(); return; }
            if (expected.kind === "command") await refreshControlStatus();
            if (disposed || !controlCurrent(expected.owner)) return;
            const status = nativeControlStatus(), owner = api.controlToken();
            if (continuationCurrent() !== true) return;
            operation = nativeState.begin(expected, status, owner,
                expected.kind === "command" ? operationId ?? crypto.randomUUID() : undefined);
            if (!operation) return;
            if (operation.action === "microsoft-connect") enrollment?.connectionStarted();
            paintNativeConnection();
            if (continuationCurrent() !== true) {
                nativeState.failed(operation, { rejected: true });
                return false;
            }
            const value = await api(expected.kind === "receipt" ? "/api/access/receipt" : "/api/access/command",
                expected.kind === "receipt" ? { schemaVersion: 1, operationId: operation.id }
                    : { schemaVersion: 1, action: operation.action, operationId: operation.id, generation: operation.generation },
                { controlToken: operation.owner });
            if (disposed || !controlCurrent(operation.owner)) return;
            if (expected.kind === "receipt" && continuationCurrent() !== true) return;
            nativeState.received(operation, value);
            await refreshControlStatus();
        } catch (error) {
            if (disposed) return;
            if (operation) nativeState.failed(operation, {
                rejected: expected.kind === "command" && error.code === "request_rejected" && error.outcome !== "unknown",
            });
            else statusError = true;
        } finally {
            if (operation) nativeState?.finished(operation);
            if (!disposed) { paintGate(); onConnectionChange?.(); }
            recoverNativeResult();
        }
        return Boolean(operation);
    }
    listen(action, "pointerdown", event => { if (event.button === 0) nativeActivation = captureNativeAction(); });
    listen(action, "pointercancel", () => { nativeActivation = null; });
    listen(action, "keydown", event => {
        if (!["Enter", " "].includes(event.key)) return;
        if (event.repeat) { event.preventDefault(); return; }
        nativeActivation = captureNativeAction();
    });
    listen(action, "click", event => {
        const expected = nativeActivation || captureNativeAction();
        nativeActivation = null;
        if (event.detail > 1) return;
        void runNativeAction(expected);
    });
    function withdrawAccess() {
        if (disposed) return;
        enrollment?.withdrawAccess();
        const presentation = ++presentationRevision;
        const hadPrivatePresentation = current !== null || profileToken !== null || imageKey !== null || microsoftProfile !== null;
        current = null; profileToken = null;
        microsoftProfile = null; microsoftProfileToken = null; clearTimeout(microsoftProfileTimer);
        clearTimers(); retireImages();
        setText(status, ""); setText(explanation, ""); explanation.hidden = true;
        setText(action, "Connect Microsoft 365");
        action.disabled = true; connectionSlot.hidden = true;
        gate.disabled = true;
        paintProfile();
        if (hadPrivatePresentation && presentationActive(presentation)) {
            ux.hideTooltip();
            if (presentationActive(presentation)) close();
        }
    }
    function receiveAccess() {
        if (disposed) return;
        const presentation = presentationRevision;
        const value = api.accessState(), owner = api.controlToken();
        if (!presentationActive(presentation)) return;
        const key = JSON.stringify([value.mode, value.runtimeId, value.epoch, value.reason,
            value.state?.authorizationRevision, value.state?.generation, value.state?.wire]);
        const changed = key !== accessKey || owner !== accessOwner;
        accessKey = key; accessOwner = owner; accessView = value;
        enrollment?.receiveAccess();
        if (value.mode !== "enforced") {
            controlStatus = null; statusOwner = null; statusError = false;
            withdrawAccess(); paintGate(); return;
        }
        const ownerLost = statusOwner && !controlCurrent(statusOwner);
        if (!presentationActive(presentation)) return;
        if (ownerLost || controlStatus && !matchesObservation(controlStatus, value)) {
            controlStatus = null; statusOwner = null;
        }
        if (!current && value.readable) {
            setText(status, states.unavailable[0]);
            setText(explanation, ""); explanation.hidden = true;
        }
        paintProfile();
        if (!presentationActive(presentation)) return;
        paintGate();
        if (!presentationActive(presentation)) return;
        if (changed && controlCurrent(owner) && presentationActive(presentation) && value.state
            && !["suspended", "clearance-failed"].includes(value.reason)) void refreshControlStatus();
        recoverNativeResult();
    }
    const states = {
        unavailable: ["Unavailable", "", "Connect Microsoft 365"],
        disconnected: ["Not connected", "", "Connect Microsoft 365"],
        "signing-in": ["Waiting for Microsoft sign-in", "", "Cancel sign-in"],
        handoff: ["Finishing connection", "", "Cancel sign-in"],
        connected: ["Connected", "", "Use another account"],
        "reconnect-required": ["Not connected", "", "Connect Microsoft 365"],
        "recovery-required": ["Connection needs recovery", "Connection result unconfirmed.", "Review recovery"],
    };
    const reasonText = {
        "hooks-unqualified": "",
        "browser-unavailable": "Microsoft Edge is unavailable.",
        "browser-policy-blocked": "Your organization has blocked Microsoft Edge.",
        "profile-contention": "Finish sign-in in the other WIRE window.",
        "wrong-account": "A different Microsoft account was selected.",
        "access-refused": "Microsoft access was denied.",
        "window-closed": "The sign-in window closed.",
        cancelled: "Sign-in was cancelled.",
        "timed-out": "Microsoft sign-in timed out.",
        "cleanup-failed": "The sign-in window could not close.",
        "restart-required": "The connection was interrupted by a restart.",
        "storage-failed": "The connection could not be saved.",
        "state-invalid": "Connection state is unavailable.",
        "transport-failed": "Microsoft could not connect.",
        "signed-out": "Sign in to WIRE to continue.",
        "stale-generation": "The connection changed.",
        busy: "Another connection operation is in progress.",
        "invalid-request": "The connection operation was not accepted.",
        "receipt-limit": "The operation history needs recovery before another connection can start.",
        "operation-conflict": "A previous operation has not been reconciled.",
        "session-closed": "The connection owner has closed.",
        "lease-invalid": "The connection could not be verified.",
        "operation-owner": "This connection result belongs to another WIRE window.",
        "reentrant-call": "Another connection operation must finish first.",
        "authorization-listener-failed": "WIRE access could not be updated safely.",
        "admission-failed": "Current WIRE access could not be verified.",
        "command-unauthorized": "This connection action is no longer available.",
        "account-metadata-unavailable": "The configured Microsoft account could not be verified.",
        "stale-collection-control": "Collection settings changed. Read current settings.",
    };
    function validateLifecycle(lifecycle) {
        if (lifecycle === null) return;
        const ms = lifecycle?.microsoft;
        if (lifecycle?.stage !== "synthetic-only" || !Number.isSafeInteger(lifecycle.generation)
            || !["signed-in", "signed-out"].includes(lifecycle.wire)
            || !["paused", "enabled"].includes(lifecycle.collection)
            || !ms || !Object.hasOwn(states, ms.state) || ms.reason !== null && !Object.hasOwn(reasonText, ms.reason)
            || !["chat", "cowork"].every(surface => ["not-verified", "verified-synthetic"].includes(ms.surfaces?.[surface]?.access)
                && ms.surfaces[surface].qualification === "production-unqualified")) {
            throw new TypeError("Expected the staged synthetic lifecycle status projection.");
        }
    }
    function receive(snapshot, publicationToken) {
        if (disposed) throw new Error("Account presentation was disposed.");
        if (publicationToken === undefined) throw new TypeError("Profile delivery requires its original publication token.");
        const startingRevision = presentationRevision;
        if (!publicationCurrent(publicationToken) || !presentationActive(startingRevision)) return false;
        const access = api.accessState();
        if (!presentationActive(startingRevision) || access.mode !== "enforced") return false;
        const delivery = structuredClone(snapshot);
        if (!presentationActive(startingRevision)) return false;
        validateProfile(delivery?.github);
        validateLifecycle(delivery.lifecycle);
        const previousIdentity = current?.github.profile?.email?.value ?? current?.github.profile?.identity.login;
        const nextIdentity = delivery.github.profile?.email?.value ?? delivery.github.profile?.identity.login;
        if (current && (previousIdentity && nextIdentity && previousIdentity !== nextIdentity
            || current.lifecycle?.wire !== delivery.lifecycle?.wire)) close(true);
        if (!presentationActive(startingRevision)) return false;
        clearTimers();
        const presentation = ++presentationRevision;
        current = delivery;
        profileToken = publicationToken;
        paintProfile();
        if (!presentationActive(presentation)) return false;
        if (!paintNativeConnection()) {
            const lifecycle = delivery.lifecycle, ms = lifecycle?.microsoft;
            const state = ms?.state || "unavailable";
            const [label, help, actionLabel] = states[state];
            setText(status, label); setText(action, actionLabel); action.disabled = true;
            setText(explanation, ms?.reason ? connectionReason(ms.reason, lifecycle.wire) : help);
            explanation.hidden = !explanation.textContent;
        }
        const profile = delivery.github.profile;
        if (profile?.identity.expiresAt > Date.now()) later(profile.identity.expiresAt, paintProfile);
        if (profile?.avatar.expiresAt > Date.now()) later(profile.avatar.expiresAt, paintProfile);
        paintGate();
        return presentationActive(presentation);
    }
    function receiveMicrosoft(snapshot, publicationToken) {
        if (disposed) throw new Error("Account presentation was disposed.");
        if (publicationToken === undefined) throw new TypeError("Profile delivery requires its original publication token.");
        const startingRevision = presentationRevision;
        if (!publicationCurrent(publicationToken) || !presentationActive(startingRevision)) return false;
        const access = api.accessState();
        if (!presentationActive(startingRevision) || access.mode !== "enforced" || access.collectionMode !== "source-aware") return false;
        const delivery = structuredClone(snapshot);
        if (!presentationActive(startingRevision)) return false;
        validateProfile(delivery, "microsoft");
        clearTimeout(microsoftProfileTimer);
        microsoftProfile = delivery; microsoftProfileToken = publicationToken;
        paintMicrosoftProfile();
        if (!presentationActive(startingRevision)) return false;
        const expiresAt = delivery.profile?.identity.expiresAt;
        if (expiresAt > Date.now()) microsoftProfileTimer = setTimeout(paintMicrosoftProfile, expiresAt - Date.now());
        return true;
    }
    listen(window, "focus", paintProfile);
    listen(document, "visibilitychange", paintProfile);
    paintProfile(); paintGate();
    return {
        receive, receiveMicrosoft, receiveAccess, withdrawAccess, unavailableConnectionFeedback,
        dispose() {
            if (disposed) return;
            withdrawAccess(); close(); disposed = true;
            nativeState?.dispose(); nativeState = null; nativeActivation = null; nativeResultRead = null;
            enrollment?.dispose();
            restoreCollection?.();
            controlStatus = null; statusOwner = null; pendingGate = null; accessView = null; accessOwner = null; activation = null;
            abort.abort(); navigation.disconnect(); ux.hideTooltip();
            menu.remove(); entry.remove(); section.remove(); accountSlot.classList.remove("wire-account-slot");
            [accountSlot.hidden, connectionSlot.hidden] = hidden;
        },
    };
}
