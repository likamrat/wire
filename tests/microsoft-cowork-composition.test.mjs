import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCoworkComposition, COWORK_COMPOSITION_ENTRY } from "../lib/microsoft-cowork-composition.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { privateFixture } from "./helpers.mjs";

function fixture(guard = () => {}, onFailure) {
    let valid = true, installed;
    const elements = [], container = {}, shell = () => {}, bridge = () => {};
    const principal = { namespace: "m365.accountInfo.objectId", realm: "prod",
        tenantId: "invented-tenant", subjectId: "invented-user" };
    const host = { name: "coworker-host", version: "2.9.2",
        loaderHook: { registerPlugins: {}, applyPlugin(plugin) {
            installed = plugin;
            this.registerPlugins[plugin.name] = plugin;
        } } };
    const composition = createCoworkComposition({
        react: { createElement(type, props, child) {
            const element = { type, props, child };
            elements.push(element);
            return element;
        } },
        shell, bridge, container, principal, onFailure,
        assertCurrent() {
            if (!valid) throw Object.assign(new Error("NATIVE_SOURCE_CANCELLED"), { code: "NATIVE_SOURCE_CANCELLED" });
            return guard();
        },
    });
    const event = () => ({ expose: "./Coworker", remoteEntryExports: container,
        moduleInfo: { name: "coworker", entry: COWORK_COMPOSITION_ENTRY } });
    const props = { tenantId: principal.tenantId, userId: principal.subjectId };
    return { composition, host, event, props, elements, shell, bridge, principal,
        get plugin() { return installed; }, revoke() { valid = false; } };
}

test("native factory composition preserves the existing parent and passes host props without inspecting providers", () => {
    const f = fixture();
    f.composition.install(f.host);
    const factory = f.plugin.getModuleFactory(f.event()), module = factory();
    Object.defineProperty(f.props, "tokenProviders", { get() { assert.fail("Composition must not inspect provider values."); } });
    const rendered = module.FederatedCoworker(f.props);
    assert.equal(rendered.type, f.shell);
    assert.equal(rendered.props, f.props);
    assert.equal(rendered.child.type, f.bridge);
    assert.equal(f.elements.length, 2, "No replacement provider or React root is constructed.");
    assert.equal(module.HOST_LAUNCH_CONTRACT_VERSION, 1);
});

test("unrelated native exposures are untouched", () => {
    const f = fixture();
    f.composition.install(f.host);
    for (const event of [{ ...f.event(), expose: "./Customize" },
        { ...f.event(), moduleInfo: { ...f.event().moduleInfo, name: "another-native-remote" } }]) {
        assert.equal(f.plugin.getModuleFactory(event), undefined);
    }
    assert.deepEqual(f.elements, []);
});

test("target exposure requires the exact native container and source entry", () => {
    const f = fixture();
    f.composition.install(f.host);
    for (const event of [{ ...f.event(), remoteEntryExports: {} },
        { ...f.event(), moduleInfo: { name: "coworker", entry: COWORK_COMPOSITION_ENTRY + "?other-build" } }]) {
        assert.throws(() => f.plugin.getModuleFactory(event), { code: "NATIVE_COWORK_COMPOSITION_SOURCE" });
    }
});

test("native host account mismatch cannot mount the shell or bridge", () => {
    for (const change of [{ userId: "different-user" }, { tenantId: "different-tenant" }, { overrideRealm: "test" }]) {
        const failures = [], f = fixture(undefined, error => failures.push(error.code));
        f.composition.install(f.host);
        const Host = f.plugin.getModuleFactory(f.event())().FederatedCoworker;
        assert.throws(() => Host({ ...f.props, ...change }), { code: "NATIVE_COWORK_COMPOSITION_ACCOUNT" });
        assert.deepEqual(f.elements, []);
        assert.deepEqual(failures, ["NATIVE_COWORK_COMPOSITION_ACCOUNT"]);
        assert.throws(() => Host(f.props), { code: "NATIVE_COWORK_COMPOSITION_RETIRED" });
        assert.equal(failures.length, 1);
    }
    const f = fixture();
    f.composition.install(f.host);
    const Host = f.plugin.getModuleFactory(f.event())().FederatedCoworker;
    f.principal.subjectId = "different-user";
    assert.throws(() => Host({ ...f.props, userId: "different-user" }), { code: "NATIVE_COWORK_COMPOSITION_ACCOUNT" });
});

test("revocation fences selection, retained factories and retained components", () => {
    const f = fixture();
    f.composition.install(f.host);
    const factory = f.plugin.getModuleFactory(f.event()), Host = factory().FederatedCoworker;
    f.revoke();
    for (const work of [() => f.plugin.getModuleFactory(f.event()), factory, () => Host(f.props)]) {
        assert.throws(work, { code: "NATIVE_SOURCE_CANCELLED" });
    }
    assert.deepEqual(f.elements, []);
});

test("retirement never falls through to mounting the original Cowork app", () => {
    const f = fixture();
    f.composition.install(f.host);
    const factory = f.plugin.getModuleFactory(f.event()), Host = factory().FederatedCoworker;
    f.composition.retire();
    for (const work of [() => f.plugin.getModuleFactory(f.event()), factory, () => Host(f.props)]) {
        assert.throws(work, { code: "NATIVE_COWORK_COMPOSITION_RETIRED" });
    }
    assert.equal(f.host.loaderHook.registerPlugins[f.plugin.name], f.plugin);
});

test("unknown runtime, duplicate installation and partial installation fail explicitly", () => {
    for (const change of [{ name: "another-host" }, { version: "unreviewed" }]) {
        const f = fixture();
        assert.throws(() => f.composition.install({ ...f.host, ...change }), { code: "NATIVE_COWORK_COMPOSITION_HOST" });
    }
    const f = fixture();
    f.composition.install(f.host);
    assert.throws(() => f.composition.install(f.host), { code: "NATIVE_COWORK_COMPOSITION_HOST" });
    const g = fixture(), error = new Error("invented-registration-failure");
    g.host.loaderHook.applyPlugin = () => { throw error; };
    assert.throws(() => g.composition.install(g.host), actual => actual === error);
    assert.throws(() => g.composition.install(g.host), { code: "NATIVE_COWORK_COMPOSITION_RETIRED" });
});

test("composition never treats an asynchronous guard as current authorization", () => {
    for (const guard of [() => true, async () => {}, async () => { throw new Error("invented-rejection"); }]) {
        const f = fixture(guard);
        assert.throws(() => f.composition.install(f.host), { code: "NATIVE_COWORK_COMPOSITION_GUARD" });
        assert.equal(f.plugin, undefined);
    }
});

test("a post-registration guard failure permanently retires the abandoned factory", () => {
    let valid = true, registered, retainedFactory, retainedHost;
    const f = fixture(() => {
        if (!valid) throw new Error("invented-revocation");
    });
    f.host.loaderHook.applyPlugin = plugin => {
        registered = plugin;
        retainedFactory = plugin.getModuleFactory(f.event());
        retainedHost = retainedFactory().FederatedCoworker;
        valid = false;
    };
    assert.throws(() => f.composition.install(f.host), /invented-revocation/);
    valid = true;
    assert.throws(() => registered.getModuleFactory(f.event()), { code: "NATIVE_COWORK_COMPOSITION_RETIRED" });
    assert.throws(() => f.composition.factoryFor(f.event()), { code: "NATIVE_COWORK_COMPOSITION_RETIRED" });
    assert.throws(() => retainedFactory(), { code: "NATIVE_COWORK_COMPOSITION_RETIRED" });
    assert.throws(() => retainedHost({}), { code: "NATIVE_COWORK_COMPOSITION_RETIRED" });
});

for (const action of ["pause", "logout", "close"]) {
    test(`the existing Microsoft lifecycle fences an invented native composition after ${action}`, async t => {
        const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, []);
        const transport = createMicrosoftNativeReadTransport({
            async open() {},
            async verifyAccount() {
                return { tenantId: "invented-tenant", subjectId: "invented-user", knownAccountMatched: true,
                    evidence: { kind: "native-account-metadata", issuer: "https://example.invalid",
                        namespace: "m365.accountInfo.objectId", realm: "prod", observedAt: new Date().toISOString() } };
            },
            async stop() { return { processExited: true, profileReleased: true }; },
        });
        const lifecycle = await createMicrosoftSession(context, {
            transport, collection: { paused: false, windowDays: 30 },
        });
        let unsubscribe;
        t.after(async () => {
            unsubscribe?.();
            await lifecycle.close();
            for (const work of cleanup) await work();
        });
        const command = async action => lifecycle.command("invented-composition-owner", {
            action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
            ...(action === "microsoft-connect" ? { replace: false } : {}),
        }, () => true);
        for (const action of ["wire-sign-in", "microsoft-connect"]) assert.equal((await command(action)).outcome, "completed");
        const lease = await lifecycle.lease("microsoft-read");
        await lifecycle.assertLease(lease);
        let authorization;
        unsubscribe = lifecycle.subscribeAuthorizationChange(event => { authorization = event; });
        const revision = authorization.revision;
        const f = fixture(() => {
            if (!authorization.microsoftAcquisition || authorization.generation !== lease.generation
                || authorization.revision !== revision) {
                throw Object.assign(new Error("NATIVE_SOURCE_CANCELLED"), { code: "NATIVE_SOURCE_CANCELLED" });
            }
        });
        f.composition.install(f.host);
        const factory = f.plugin.getModuleFactory(f.event()), Host = factory().FederatedCoworker;
        Host(f.props);
        if (action === "pause") await lifecycle.updateCollection({ paused: true, windowDays: 30 });
        else if (action === "logout") await command("wire-sign-out");
        else await lifecycle.close();
        for (const work of [() => f.plugin.getModuleFactory(f.event()), factory, () => Host(f.props)]) {
            assert.throws(work, { code: "NATIVE_SOURCE_CANCELLED" });
        }
        assert.equal(f.elements.length, 2);
    });
}
