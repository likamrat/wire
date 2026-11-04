// Mounted beneath Microsoft's original providers. References never leave this
// realm or become inputs to a replacement provider/auth client.
export function createNativeProviderLifetime({ react, principal, getRouter, useStore, useQueryClient,
    useRuntime, useAccount, assertOwner, onMounted, onRetire }) {
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    if (![getRouter, useStore, useQueryClient, useRuntime, useAccount, assertOwner, onMounted, onRetire,
        react?.useRef, react?.useLayoutEffect].every(value => typeof value === "function")) fail("NATIVE_PROVIDER_CONTRACT_INVALID");
    let mounted = null, retired = false;
    const retire = (code = "NATIVE_PROVIDER_RETIRED") => {
        if (retired) return;
        retired = true;
        mounted = null;
        onRetire(code);
    };
    const validate = snapshot => {
        if (retired) fail("NATIVE_PROVIDER_RETIRED");
        if (assertOwner() !== undefined) fail("NATIVE_PROVIDER_GUARD_INVALID");
        if (!snapshot || !snapshot.runtime || !snapshot.account) fail("NATIVE_PROVIDER_UNMOUNTED");
        const router = getRouter();
        if (router !== snapshot.router || router?.options?.context?.store !== snapshot.store
            || router?.options?.context?.queryClient !== snapshot.queryClient) fail("NATIVE_PROVIDER_REPLACED");
        const account = snapshot.account, environment = account.environment;
        if (account.accountType !== "AAD" || account.tenantId !== principal.tenantId || account.objectId !== principal.subjectId
            || typeof environment !== "string" || !["prod", "production"].includes(environment.trim().toLowerCase())) {
            fail("NATIVE_PROVIDER_ACCOUNT_CHANGED");
        }
    };
    const Boundary = props => {
        let store, queryClient, runtime, account;
        try { store = useStore(); queryClient = useQueryClient(); runtime = useRuntime(); account = useAccount(); }
        catch {
            retire("NATIVE_PROVIDER_CONTEXT_MISSING");
            fail("NATIVE_PROVIDER_CONTEXT_MISSING");
        }
        const identity = react.useRef(null);
        if (!identity.current) identity.current = {};
        const snapshot = { store, queryClient, runtime, account, router: getRouter(), identity: identity.current };
        try { validate(snapshot); }
        catch (error) { retire(error.code ?? "NATIVE_PROVIDER_UNQUALIFIED"); throw error; }
        react.useLayoutEffect(() => {
            try {
                validate(snapshot);
                if (mounted && mounted.identity !== identity.current) fail("NATIVE_PROVIDER_DUPLICATE");
                mounted = snapshot;
                onMounted();
            } catch (error) {
                retire(error.code ?? "NATIVE_PROVIDER_UNQUALIFIED");
                throw error;
            }
            return () => {
                if (mounted?.identity === identity.current) retire("NATIVE_PROVIDER_DISPOSED");
            };
        }, [store, queryClient, runtime, account]);
        return props.children ?? null;
    };
    return Object.freeze({
        Boundary,
        get mounted() { return !retired && mounted !== null; },
        assertCurrent() {
            try { validate(mounted); }
            catch (error) { retire(error.code ?? "NATIVE_PROVIDER_UNQUALIFIED"); throw error; }
        },
        retire,
    });
}
