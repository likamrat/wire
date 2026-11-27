import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { platform, release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataDirFor, defaultDataDir } from "./paths.mjs";
import * as officialSource from "./update-source.mjs";
import { newerRelease } from "./wire-release.mjs";
import { armChild, assertClosedInstallation, assertLegacyClosed, canonicalStore, commitId, openLauncherJournal, privateError, stateDirectory, storeIdentity } from "./update-launch-state.mjs";
import { preserveSearch, validateArtifact } from "./update-launch-artifact.mjs";
import { spawnOwned } from "./update-launch-child.mjs";
import { DEFAULT_RUNTIME_PORT } from "./runtime-endpoint.mjs";

const day = 24 * 60 * 60 * 1000;
const stableCheckInterval = 5 * 60 * 1000;
const same = (left, right) => left?.commit === right?.commit && left?.slot === right?.slot;
const validPort = port => Number.isInteger(port) && port > 0 && port <= 65535;
const safeMessage = (error, fallback) => ["WIRE_LAUNCH", "WIRE_UPDATE_FAILED", "WIRE_UPDATE_MANUAL"].includes(error?.code)
    ? error.message : fallback;
const freshPrefs = () => ({ automatic: true, dismissed: null, lastAttempted: null, lastChecked: null, checked: null, error: null });

// Returns null only for a manual launch. An ambiguous journal is never an
// invitation to fall back to the original checkout and try opening the store.
export async function launchInstallation(root, args, { source = officialSource } = {}) {
    const qualifiedHost = platform() === "win32" || platform() === "linux" && /microsoft/i.test(release());
    let recoveryFile, legacyReview, legacy;
    const recoverSlot = args[0] === "--recover-active-slot";
    const installedLauncher = args[0] === "--start-installed";
    if (args[0] === "--supervise-legacy-update") {
        if (args.length !== 4 || args[2] !== "--port" || !/^[1-9]\d{0,4}$/.test(args[3]) || !validPort(Number(args[3]))
            || !qualifiedHost || source.channel !== "release") throw privateError("Use --supervise-legacy-update with the original operator's reviewed start record and original --port on the release channel.");
        legacy = await import("./update-legacy-supervision.mjs");
        legacyReview = await legacy.readLegacyStart(args[1], Number(args[3]), dataDirFor({ dataDir: process.env.WORKIQ_EVIDENCE_DATA_DIR || defaultDataDir() }));
        root = legacyReview.installation; args = args.slice(2);
    } else if (installedLauncher) {
        if (args.length !== 4 || !path.isAbsolute(args[1]) || args[2] !== "--port"
            || !/^[1-9]\d{0,4}$/.test(args[3]) || !validPort(Number(args[3])))
            throw privateError("Use --start-installed with the absolute original installation and its original --port.");
        root = args[1]; args = args.slice(2);
    } else if (recoverSlot) {
        if (args.length !== 5 || !path.isAbsolute(args[1]) || !path.isAbsolute(args[2])
            || args[3] !== "--port" || !/^[1-9]\d{0,4}$/.test(args[4]) || !validPort(Number(args[4]))) {
            throw privateError("Use --recover-active-slot with the absolute original installation, reviewed custody file and original --port.");
        }
        [, root, recoveryFile] = args;
        args = args.slice(3);
    } else if (args.includes("--recover-launch")) {
        if (args[0] !== "--recover-launch" || !path.isAbsolute(args[1] ?? "") || ![2, 4].includes(args.length)) {
            throw privateError("Use --recover-launch with the absolute reviewed custody file and the original --port.");
        }
        recoveryFile = args[1]; args = args.slice(2);
    }
    const normal = args.length === 0 || args.length === 2 && args[0] === "--port"
        && /^(?:0|[1-9]\d{0,4})$/.test(args[1]) && Number(args[1]) <= 65535;
    root = await realpath(root);
    let inspected;
    // Git plumbing overrides can point a command at another repository's
    // index, worktree or object database even when cwd is the right clone.
    if (normal && !Object.keys(process.env).some(k => /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(k))) {
        try { inspected = await source.inspectInstallation(root); } catch { /* Unmanaged unless there is an activation record. */ }
    }
    if (recoveryFile && (!qualifiedHost || !inspected)) throw privateError("Recovery requires the original clean official main installation on its native host.");
    if (installedLauncher && (!qualifiedHost || !inspected)) throw privateError("Starting the installed launcher requires the original clean official main installation on its native host.");
    if (legacyReview && !inspected) throw privateError("The reviewed original installation is no longer a clean official clone.");
    const directory = await stateDirectory(root, Boolean(inspected) && !recoveryFile && !installedLauncher && !legacyReview);
    if ((installedLauncher || legacyReview) && !directory) throw privateError("No original managed installation was found.");
    if (recoveryFile && !directory) throw privateError("No original managed installation journal was found.");
    if (!directory) return null;
    if (legacyReview) for (const name of ["installation.sqlite","child.sqlite"]) {
        const file = path.join(directory,name);
        if (await realpath(file) !== file || !(await lstat(file)).isFile()) throw privateError("The original installation journals were not found.");
    }
    const db = openLauncherJournal(directory);
    const port = args.length ? Number(args[1]) : DEFAULT_RUNTIME_PORT;
    const installation = { root, directory, db, inspected, port, qualifiedHost };
    if (legacyReview) {
        try {
            legacy.assertLegacySelection(legacyReview, db.get("activation"), db.get("preferences"), inspected);
            assertLegacyClosed(directory, legacyReview.closedChildId);
        } catch (error) { db.close(); throw error; }
        return runManagedInstallationV1(installation, { source, reviewedTarget: info => legacy.assertReviewedOffer(legacyReview, info),
            reviewedStore: legacyReview.store });
    }
    if (installedLauncher) {
        let run;
        try {
            const state = db.get("activation");
            if (state?.version !== 1 || state.base !== inspected.installed || state.transition !== null || !state.active?.slot
                || !commitId(state.active.commit) || state.active.release?.commit !== state.active.commit
                || typeof db.get("preferences")?.automatic !== "boolean")
                throw privateError("No settled installed release with existing update preferences was found. Nothing was started.");
            const slot = await validateArtifact({ root, directory, base: state.base, source }, state.active);
            run = (await import(pathToFileURL(path.join(slot, "lib", "update-launch.mjs")).href)).runManagedInstallationV1;
            if (typeof run !== "function") throw privateError("This installed release does not support starting its own launcher.");
        } catch (error) { db.close(); throw error; }
        // Keep the original installation lock across selection and startup. Only
        // the launcher module comes from its verified slot, never a second journal.
        return run(installation, { requireCleanStop: true });
    }
    return runManagedInstallationV1(installation, { source, recoveryFile, recoverSlot });
}

export async function runManagedInstallationV1({ root, directory, db, inspected, port, qualifiedHost },
    { source = officialSource, recoveryFile, recoverSlot, requireCleanStop = false, reviewedTarget, reviewedStore }) {
    let child, healthy, busy, checking, checkingAutomatically, checkedThisLaunch = false, closing = false, stopPromise, phase, message = "";
    const finished = Promise.withResolvers();
    let state, prefs, supervisedOffer;
    let store, dataDir;
    const save = next => { db.put("activation", next); state = next; };
    const pref = values => { const next = { ...prefs, ...values }; db.put("preferences", next); prefs = next; };
    const checked = () => prefs.checked?.installed === state.active.commit && prefs.checked.channel === source.channel ? prefs.checked : null;
    const lastCheckUnconfirmed = () => prefs.offerUnconfirmed ?? (prefs.retryAt > 0);
    const nextAutoCheckAt = () => Math.max(prefs.retryAt ?? 0, checkedThisLaunch ? prefs.lastAttempted
        + (source.channel === "release" && (!prefs.error || prefs.retryAt) ? stableCheckInterval : day) : 0);
    const context = () => ({ root, directory, base: state.base, source });
    const status = () => {
        const saved = checked(), result = reviewedTarget && saved?.candidate !== supervisedOffer && saved?.candidate ? null : saved;
        const reason = prefs.error;
        const current = phase ?? (reason ? "error" : result ? result.candidate ? "available" : "current" : "unknown");
        return { supported: true, automatic: prefs.automatic, installed: state.active.commit,
            candidate: result?.candidate ?? null, lastChecked: prefs.lastChecked, nextAutoCheckAt: nextAutoCheckAt(),
            ...(current === "error" && prefs.retryAt > 0 && { retryAt: prefs.retryAt }),
            dismissed: result?.fingerprint && prefs.dismissed === result.fingerprint ? result.candidate : null,
            installedRelease: state.active.release ?? (!result?.candidate ? result?.release ?? null : null),
            availableRelease: result?.candidate ? result.release ?? null : null,
            ...(current === "error" && lastCheckUnconfirmed() && result?.candidate && result.release && { offerUnconfirmed: true }),
            phase: current, message: message || reason || result?.message || (current === "current" ? "Up to date."
                : current === "available" ? "Update available." : "Not checked yet."),
            ...(healthy && { clientEntry: healthy.clientEntry }) };
    };
    function check(auto) {
        if (busy) return status();
        if (checking) return checking;
        if (Date.now() < prefs.retryAt || auto && (!prefs.automatic || Date.now() < nextAutoCheckAt())) return status();
        checkedThisLaunch = true; checkingAutomatically = auto;
        pref({ lastAttempted: Date.now() });
        phase = "checking"; message = "Checking for updates…";
        checking = (async () => {
            try {
                const next = await source.checkMain(root, state.active.commit, { automatic: auto, lastCheck: checked(), installedRelease: state.active.release });
                if (reviewedTarget && next.candidate) reviewedTarget(next);
                if (next.installed !== state.active.commit || next.candidate !== null && !commitId(next.candidate)
                    || !/^[0-9a-f]{64}$/.test(next.fingerprint)) throw privateError("The available build could not be identified.");
                const previous = state.active.release;
                if (previous && next.release && !(previous.tag === next.release.tag && previous.commit === next.release.commit)
                    && !newerRelease(next.release.tag, previous.tag)) {
                    throw privateError(`The published version is not newer than the installed release ${previous.tag}. Nothing was installed.`);
                }
                pref({ checked: next, lastChecked: Date.now(), error: null, retryAt: null, offerUnconfirmed: false });
                if (reviewedTarget) supervisedOffer = next.candidate;
                if (next.release?.commit === state.active.commit && (next.release.tag !== previous?.tag || next.release.notes !== previous?.notes))
                    save({ ...state, active: { ...state.active, release: next.release } });
            } catch (error) {
                pref({ error: safeMessage(error, "Could not check for updates. Try again."), retryAt: error.retryAt ?? null,
                    offerUnconfirmed: Boolean(error.temporary && (!prefs.error || lastCheckUnconfirmed())) });
            } finally { phase = undefined; message = ""; checking = undefined; }
            return status();
        })();
        return checking;
    }
    function stillRunning(owner) {
        if (closing || owner !== child || !healthy) throw privateError("The requesting WIRE runtime is no longer active.");
    }
    // Never a data or update-control grant. Only a genuine browser panel gets
    // a signed, expiring receipt to observe the same installation after restart.
    const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
    let observerKey;
    function observerSeal(issuer, observer, expires) {
        if (!observerKey) {
            let key = db.get("update-observer-key");
            if (key === undefined) { key = randomBytes(32).toString("hex"); db.put("update-observer-key", key); }
            if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw privateError("The update observer key could not be verified.");
            observerKey = key;
        }
        return createHmac("sha256",Buffer.from(observerKey,"hex")).update(JSON.stringify([
            "release-observer-v1", root, store, port, source.channel, state.active.commit, healthy.clientEntry, issuer, observer, expires,
        ])).digest("hex");
    }
    function observerTicket(issuer, observer) {
        const expires = Date.now()+day;
        return {observer, expires, seal:observerSeal(issuer, observer, expires)};
    }
    async function request(owner, input) {
        stillRunning(owner);
        if (!qualifiedHost) return {
            supported: false, automatic: false, installed: state.active.commit, candidate: null, lastChecked: null, dismissed: null,
            phase: "manual", message: "In-app updates are available on Windows and WSL only.",
            clientEntry: healthy.clientEntry,
        };
        switch (input?.action) {
        case "status":
        case "auto-check": {
            const value = input.action === "status" ? status() : await check(true);
            if (!uuid(input.observer)) return value;
            stillRunning(owner);
            return {...value, discoveryTicket:observerTicket(healthy.runtimeId,input.observer)};
        }
        case "verify-discovery": {
            const { previousRuntime, observer, expires, seal } = input;
            if (!uuid(previousRuntime) || previousRuntime === healthy.runtimeId || !uuid(observer)
                || !Number.isSafeInteger(expires) || expires <= Date.now() || !/^[a-f0-9]{64}$/.test(seal)
                || !timingSafeEqual(Buffer.from(seal,"hex"),Buffer.from(observerSeal(previousRuntime,observer,expires),"hex"))) return { verified:false };
            return {verified:true, discoveryTicket:observerTicket(previousRuntime,observer)};
        }
        case "check":
            // A manual check must verify Git even if an automatic feed probe is in flight.
            if (checking && checkingAutomatically) { await checking; stillRunning(owner); }
            return check(false);
        case "preferences":
            if (typeof input.enabled !== "boolean") break;
            pref({ automatic: input.enabled }); return status();
        case "dismiss":
            if (busy || !input.candidate || input.candidate !== checked()?.candidate) break;
            pref({ dismissed: checked().fingerprint }); return status();
        case "apply": {
            const info = checked();
            if (busy || checking || prefs.error || !commitId(input.candidate) || input.candidate !== info?.candidate) break;
            if (reviewedTarget) {
                if (supervisedOffer !== input.candidate) throw privateError("Check the reviewed release in this running WIRE before choosing Update and restart.");
                reviewedTarget(info);
            }
            const previous = state.active;
            phase = "preparing"; message = "Preparing the selected build. WIRE is still running.";
            // Send the preparing response through the old generation before
            // starting the lengthy build/admission/stop sequence.
            busy = Promise.resolve().then(() => replace(owner, previous, info))
                .catch(error => {
                    pref({ error: safeMessage(error, "The update could not be completed. Check for updates and try again."),
                        retryAt: error.retryAt ?? null, offerUnconfirmed: Boolean(error.temporary) });
                }).finally(() => { busy = undefined; phase = undefined; message = ""; });
            return status();
        }
        }
        throw privateError("The selected update is no longer available or another update is in progress. Check again.");
    }
    async function start(ref, recovery) {
        const location = await validateArtifact(context(), ref);
        if (closing) throw privateError("The WIRE launcher is stopping.");
        const next = spawnOwned({ directory, location, commit: ref.commit, port, dataDir, store, recovery, request, onExit(owner, intentional) {
            if (!intentional && child === owner && healthy && !closing) {
                // External/unknown loss of the child does not grant restart.
                void stop(1);
            }
        } });
        child = next;
        const ready = await next.ready();
        const identity = await storeIdentity(dataDir);
        if (identity !== ready.store || store && identity !== store) throw privateError("The child did not confirm the original WIRE data directory.");
        store = identity;
        healthy = ready;
        port = healthy.port;
        console.log(`WIRE ready at http://127.0.0.1:${port}/`);
    }
    async function stopChild() {
        const owner = child;
        if (owner) {
            healthy = undefined;
            await owner.stop();
            if (owner === child) child = undefined;
        }
    }
    function stop(code = 0) {
        if (stopPromise) return stopPromise;
        closing = true;
        stopPromise = (async () => {
            try { await stopChild(); } catch { code = 1; }
            try { await checking; await busy; } catch { code = 1; }
            db.close();
            finished.resolve(code);
        })();
        return stopPromise;
    }
    async function replace(owner, previous, info) {
        const next = { commit: info.candidate, slot: randomUUID(), ...(info.release && { release: info.release }) };
        const destination = path.join(directory, next.slot);
        let journaled = false, asked = false, stoppingOld = false;
        await mkdir(destination, { mode: 0o700 });
        try {
            const staged = await source.stageMain(root, info, destination);
            if (staged.commit !== next.commit || staged.fingerprint !== info.fingerprint) throw privateError("The available build changed. Check again to confirm the new update.");
            const priorCode = await validateArtifact(context(), previous);
            await preserveSearch(priorCode, destination);
            await validateArtifact(context(), next);
            stillRunning(owner);
            if (store !== await storeIdentity(dataDir)) throw privateError("The selected WIRE data directory changed; the running app was not replaced.");
            const transition = { previous, next, store, port };
            save({ ...state, transition });
            journaled = true;
            asked = true;
            await owner.quiesce(next.commit);
            stillRunning(owner);
            phase = "restarting"; message = "Restarting WIRE at the same address.";
            stoppingOld = true;
            await stopChild();
            if (closing) return;
            if (store !== await storeIdentity(dataDir)) throw privateError("The original WIRE data directory is no longer selected.");
            save({ ...state, active: next });
            try {
                await start(next);
            } catch {
                // A failed health check is not a stop receipt. First establish
                // that our failed child released its writer, then revalidate.
                await stopChild();
                if (closing) return;
                if (store !== await storeIdentity(dataDir)) throw privateError("The original WIRE data directory is no longer selected.");
                await validateArtifact(context(), next);
                save({ ...state, active: previous });
                await start(previous);
                save({ ...state, transition: null });
                throw privateError("The new build did not pass its health check. The previous compatible build is running; your data was not restored or changed by rollback.");
            }
            if (closing) return;
            save({ ...state, transition: null });
            pref({ checked: { installed: next.commit, candidate: null, channel: info.channel, fingerprint: info.fingerprint,
                ...(info.notesRetryAt && { notesRetryAt: info.notesRetryAt }) },
                dismissed: null, error: null });
        } catch (error) {
            if (asked && !stoppingOld) {
                if (!closing) await owner.resume();
                save({ ...state, transition: null });
                journaled = false;
            }
            if (stoppingOld && state.transition && !closing) {
                // Do not discard the pending journal, kill a process, or try
                // another candidate on an uncertain close/rollback.
                console.error("WIRE update stopped without a verified handoff. Check the original launcher before restarting.");
                void stop(1);
            }
            throw error;
        } finally {
            if (!journaled) await rm(destination, { recursive: true, force: true }).catch(() => {});
        }
    }
    try {
        state = db.get("activation");
        if (!inspected) {
            if (state !== undefined && !(state?.version === 1 && commitId(state.base) && state.transition === null
                && state.active?.slot === null && state.active.commit === state.base)) {
                throw privateError("This installation has an active build or unresolved activation. Start the normal launcher with the original checkout and options.");
            }
            // Even an ineligible, now dirty checkout cannot start over an
            // abandoned or still-live managed child after a launcher crash.
            armChild(directory);
            db.close(); return null;
        }
        if (!commitId(inspected.installed)) throw privateError("The installed commit is unknown.");
        if (recoverSlot && (state?.version !== 1 || state.base !== inspected.installed || state.transition !== null
            || !state.active?.slot || !commitId(state.active.commit) || state.active.commit === state.base)) {
            throw privateError("Active-slot recovery requires the unchanged original checkout and a settled active slot. Nothing was restarted.");
        }
        if (recoveryFile && !recoverSlot && (state?.version !== 1 || !commitId(state.base) || state.transition !== null
            || state.active?.slot !== null || state.active.commit !== state.base)) {
            throw privateError("Crash recovery requires an existing base checkout with no active slot or interrupted update.");
        }
        if (state === undefined) save({ version: 1, base: inspected.installed, active: { commit: inspected.installed, slot: null }, transition: null });
        if (state.version !== 1 || !commitId(state.base)) throw privateError("The WIRE update journal is not compatible.");
        if (!qualifiedHost && (state.transition || state.active?.slot !== null)) {
            throw privateError("This installation has a managed activation. Recover its original Windows or WSL launcher before using another host.");
        }
        prefs = db.get("preferences") ?? freshPrefs();
        dataDir = dataDirFor({ dataDir: await canonicalStore(dataDirFor({ dataDir: process.env.WORKIQ_EVIDENCE_DATA_DIR || defaultDataDir() })) });
        store = await storeIdentity(dataDir).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
        if (reviewedStore && store !== reviewedStore) throw privateError("The reviewed store changed before ordinary startup. No runtime was started.");
        if (requireCleanStop) assertClosedInstallation(directory, state.active.commit, store, port);
        let recovery;
        if (recoveryFile) {
            const { readRecovery } = await import("./update-launch-recovery.mjs");
            recovery = await readRecovery(recoveryFile, { root, installed: inspected.installed, base: state.base, store, port,
                ...(recoverSlot && { active: state.active }) });
        }
        if (state.base !== inspected.installed) {
            // A manual main update can supersede a healthy activation, never
            // an interrupted one or one with an unknown writer/compatibility.
            if (state.transition || state.active.slot !== null) throw privateError("The original checkout changed after activation. Review the installation before restarting.");
            const rebased = { ...state, base: inspected.installed, active: { commit: inspected.installed, slot: null } };
            if (recovery) state = rebased; // Refusals must leave the old activation intact.
            else {
                save(rebased);
                pref({ checked: null, dismissed: null, lastChecked: null, error: null });
            }
        }
        if (state.transition !== null) {
            const tx = state.transition;
            if (!store || !validPort(tx.port) || (port !== 0 && port !== tx.port) || tx.store !== store
                || !same(state.active, tx.previous) && !same(state.active, tx.next)) throw privateError("Use the interrupted launcher's original port and data folder. Nothing was restarted.");
            port = tx.port;
            if (same(state.active, tx.next)) await validateArtifact(context(), tx.next);
            await validateArtifact(context(), tx.previous);
            armChild(directory); // Fence a late fork before changing the pointer on recovery.
            save({ ...state, active: tx.previous });
            await start(tx.previous);
            save({ ...state, transition: null });
            pref({ checked: null, error: "Recovered the previous compatible build after an interrupted update." });
        } else {
            await start(state.active, recovery);
            if (recovery && !recoverSlot) {
                save(state);
                pref({ checked: null, dismissed: null, lastChecked: null, error: null });
            }
        }
        return { stop: () => stop(), finished: finished.promise };
    } catch (error) {
        try { await stopChild(); } finally { db.close(); }
        throw error;
    }
}
