# GitHub profile boundary

The default account entry is neutral. WIRE has a source-level existing-host
snapshot bridge and an integrated presenter, but no qualified facility binding
the desktop-selected GitHub account to its separate Node runtime.
Reloading an extension or logging in through `gh` does not supply that proof.
Profile absence never blocks already-approved local GitHub history.

## Required host integration

`extension.mjs` retains its existing `joinSession()` result and registers
`wire_github_account_snapshot` through `createCopilotAccountBridge`.
The tool accepts `{}` only and checks the invoking session before and after
the read. It creates no SDK client/model session, reads no credentials and
does not open a canvas or connect to WIRE.

The snapshot reader obtains the joined host's active account, checks session
auth for conflicts, then reads active account again. An observed active
`githubDotCom` user with matching credential-free user auth can be reported;
environment, CLI, explicit-token, conflicting and non-GitHub sources cannot
be promoted. A session observation is not independently verified desktop
selection.

Read ownership is bounded: one coalesced in-flight operation, a 1.8-second
deadline and at most a 15-second presentation lease from read start. Handle,
selection or account changes rotate WIRE's generation, including same-login
reselection. A hung or late RPC cannot install identity or start later work.
Opaque selection IDs remain memory-only; raw auth/status/account-roster
responses, email, quota and credentials are not forwarded.

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

Only a qualified github.com user triggers an unauthenticated public profile
lookup. The returned login/user type/numeric ID must match. Avatar requests
are limited to that user's approved GitHub avatar path, bounded redirects,
numeric size/version query fields, 256 KiB and PNG/JPEG dimensions up to 512.
Profile JSON is bounded to 32 KiB and combined public lookup to five seconds.
No authorization, cookies, referrer, private context or email permission is sent.

One atomic private cache is keyed to provider/host/login. Freshness is six
hours; a failed public read may use matching stale data for up to seven days,
explicitly marked cached, with 15-minute failure backoff. Identity is still
revalidated. Corruption or unknown identity cannot expose a cached profile.
This presentation cache is not evidence, source configuration or report data.

Avatar tickets are same-origin, panel-bound, one per owner within the panel
limit, and valid for at most 60 seconds. Delivery rechecks owner, generation,
expiry and retained access with no-store/nosniff/same-origin protections.
Remote/data/blob URL substitution and unbounded image retry are not supported.

## Presenter and withdrawal

The ordinary client reads through `createAccountProfile` and passes the original
shared publication token to `mountAccountSettingsPresentation`.
The presenter requires the real access/publication/control API; omission is not
a preview or unbound fallback. Only literal synchronous current checks admit.

Visible verified presentation rereads before the earliest lease/ticket/15-second
bound and on focus. Heartbeats do not refetch. Hidden, signed-out or withdrawn
owners stop reading; unavailable identity does not poll indefinitely.
Current read failures offer a deliberate read-only retry.

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
