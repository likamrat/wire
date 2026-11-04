# GitHub profile boundary

The default account entry is neutral. WIRE has a host snapshot bridge and
profile presenter, but its Node runtime cannot yet verify which GitHub account
the desktop selected. Reloading an extension or logging in through `gh` does
not supply that proof. Profile absence never blocks approved local GitHub history.

## Required host integration

`extension.mjs` retains its existing `joinSession()` result and registers
`wire_github_account_snapshot` through `createCopilotAccountBridge`.
The tool accepts `{}` only and checks the invoking session before and after
the read. It creates no SDK client/model session, reads no credentials and
does not open a canvas or connect to WIRE.

The snapshot reader must:

1. Read the joined host's active account.
2. Check session auth for conflicts, using credential-free user auth.
3. Read the active account again and report only a matching active `githubDotCom` user.

Environment, CLI, explicit-token, conflicting and non-GitHub sources cannot
be promoted. A session observation alone does not verify desktop selection.

| Boundary | Limit / effect |
| --- | --- |
| In-flight read | One coalesced operation; 1.8-second deadline |
| Presentation lease | At most 15 seconds from read start |
| Handle, selection or account change | Rotate generation, including same-login reselection |
| Hung or late RPC | Cannot install identity or start later work |
| Projection | Memory-only opaque selection IDs; no raw auth/status/roster responses, email, quota or credentials |

A qualified host must establish both the desktop/session relationship and a
trusted runtime initialization or separately reviewed transport. Only then can
trusted backend code supply:

```js
githubProfile: {
    copilot: { binding: "copilot-app", readSnapshot }
}
```

The binding string is a precondition, not proof by itself. A qualified bridge
also pins its expected existing session. Browser/canvas capabilities cannot
register identity producers or submit a login, callback address or snapshot as
authority. Normal `scripts/start.mjs` supplies no such callback.

Host lifecycle/reconciliation declarations do not establish that an agent has
an available authorized operator facility. A future host proof needs explicit
scope, current source and owned cleanup/restoration. Do not use hidden native
APIs, account setters, token reads, another CLI process or a broad extension
reload as a workaround.

## Backend profile reads

`createGitHubProfile` is lazy and separate from collection. Its `read`,
`image`, `invalidate` and `close` operations retain current identity, generation
and bounded work. Without qualified binding it returns
`account-match-unavailable` and makes no public requests.

The capability-protected `/api/profile/github` endpoint accepts no account or
URL input. Its version-1 response keeps identity state/lease, display-name
source/freshness, avatar ticket, fallback and sanitized issues distinct.
Initials come only from a verified handle; a neutral fallback is not a
personal name or missing-photo diagnosis.

Only a qualified github.com user triggers a public lookup. Returned login,
user type and numeric ID must match. Requests send no authorization, cookies,
referrer, private context or email permission.

| Resource | Bound |
| --- | --- |
| Profile JSON | 32 KiB; combined public lookup deadline five seconds |
| Avatar | Approved user-specific path, bounded redirects, numeric size/version fields; PNG/JPEG up to 256 KiB and 512-pixel dimensions |
| Cache | Atomic provider/host/login key; six-hour freshness |
| Failed public read | Matching cached data up to seven days, labeled cached; 15-minute failure backoff |
| Avatar ticket | Same-origin, panel-bound, one per owner within the panel limit; at most 60 seconds |

Revalidate identity even for cached presentation. Corrupt/unknown identity
cannot expose a cache; it is not evidence, source configuration or report data.

Avatar delivery rechecks owner, generation, expiry and retained access, with
no-store/nosniff/same-origin protections. No remote/data/blob substitution or
unbounded image retry is supported.

## Presenter and withdrawal

The ordinary client reads through `createAccountProfile` and passes the original
shared publication token to `mountAccountSettingsPresentation`.
The presenter requires the real access/publication/control API; omission is not
a preview or unbound fallback. Only literal synchronous current checks admit.

| Presentation state | Read behavior |
| --- | --- |
| Visible and verified | Reread before the earliest lease/ticket/15-second bound and on focus |
| Heartbeat | Does not refetch |
| Hidden, signed out or withdrawn | Stop reading |
| Identity unavailable | No indefinite polling |
| Current read failure | Offer a deliberate read-only retry |

Withdrawal scrubs actual held name/handle/initial/image Text/Attr values,
retires image callbacks and timers, and preserves only unrelated original
gate-operation recovery. Reentrant callbacks recheck the original owner before
paint; late images cannot replace newer identity.

The footer keeps one Account target and the independent Settings target.
Long names can truncate in that compact footer but wrap in the menu.
Local WIRE sign-in/out changes the local gate, not GitHub or Microsoft login.

In source-aware incubation, Microsoft profile presentation belongs only in
Settings through its separately qualified retained lease. Its observed matched
UPN is not the typed expectation or a substitute for the GitHub footer.
Names/photos without a qualified producer remain unavailable. This source is
not enabled by the Copilot-only release.

Existing profile, account-snapshot/bridge, account-profile and account-gate
tests use invented identities and injected public responses. They establish
the exercised implementation and withdrawal, not live desktop-account binding.
