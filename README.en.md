# dsh-plugin-remote-access

[中文](README.md) · **English**

Expose this machine's DSH web GUI to a chosen network range — typically a Tailscale
tailnet — so you can drive the agent from your phone.

This is an entry point, not a full translation. The [Chinese README](README.md) is the
reference documentation and is considerably more detailed; sections below link to it where
the detail matters.

- **License:** MIT
- **Requires:** DSH `0.2.1-rc.1` or newer (`engines.dsh`), Node 18+
- **Never binds `0.0.0.0`** — see [Security](#security)

## What it does

DSH binds its web GUI to loopback. This plugin reverse-proxies that GUI on addresses inside
a CIDR range you choose, so a phone on the same network (or tailnet) gets the **real** UI —
model picker, context meter, settings, approvals — instead of a reimplementation.

| | |
|---|---|
| Listen addresses | only local addresses inside `allowCidrs` |
| Peers outside `allowCidrs` | `403`, no exceptions |
| Entry | tokenized URL, or a 4–12 character access code |
| Phone layout | applies to remote pages only; the desktop UI is untouched |
| Caching | big static assets are cached on the phone; no body is stored on the host |
| Config | one file per Windows user — the plugin never reads or writes the shared profile |

## Install

Requires DSH 0.2.1+. **Restart DSH once after installing** (the host half is read at boot).

```powershell
dsh plugin --profile desktop add dsh-plugin-remote-access
```

Or from the plugin page: *Settings → Plugins → Add plugin* and enter
`dsh-plugin-remote-access` (npm), `github:Mzy123l/dsh-plugin-remote-access` (latest code),
or an absolute local path.

## Configure

Settings → **Remote access**. The ten common fields:

| Field | Default | Meaning |
|---|---|---|
| Enabled | on | turning it off stops the listener; no need to uninstall |
| Allowed network ranges | `100.64.0.0/10` | the only security boundary, and what `listen=auto` uses to pick a bind address |
| Excluded network ranges | empty | exceptions; an address that fails the access code is added here automatically |
| Port | `0` | 0 = OS-assigned; pin it if you want a bookmarkable URL |
| Connection limit | `64` | browsers keep several keep-alive connections; do not set this too low |
| Log level | `info` | `silent` / `info` / `debug` |
| Access code | empty | 4–12 digits or letters; set it and you never copy a token |
| Remote UI layout | `auto` | `phone` / `desktop` / `auto` — remote pages only |
| Notify the phone when the model asks | on | Android app only |
| Notify the phone when a turn ends | on | Android app only |

Configuration lives **only** in `$DSH_HOME/remote-access-config.json` (one file per Windows
user). The plugin does not read or write `cordis.patch.yml`, so several users sharing one
profile keep separate ports. If the port is busy the plugin moves to a free one and
remembers it.

**If your phone is not on Tailscale**, the default allowlist matches nothing and the plugin
will not listen on your LAN. Set `allowCidrs` to your subnet, e.g. `192.168.1.0/24`.

## Get in

1. Open `http://127.0.0.1:<port>/` on the computer. This console is loopback-only by design.
2. Copy the tokenized URL from `$DSH_HOME/remote-access-url.txt`, or set an access code and
   open the bare address on the phone.
3. Enter the access code once; the browser keeps a cookie for 30 days.

The token rotates on every DSH start, so an old URL stops working. The access code survives
restarts.

## Security

Read the [Security boundaries](README.md#安全边界) section in the Chinese README before
widening `allowCidrs`.

- The plugin only listens on local addresses inside `allowCidrs`, and refuses peers outside it.
- Without an access code, DSH's own token/cookie still applies — the plugin does not lower
  DSH's authentication.
- **With an access code, do not treat it as a second factor.** Network range + code are then
  the whole credential; the plugin attaches DSH's token server-side and the browser never
  sees it.
- One wrong access code immediately blocks that address (written to `denyCidrs`). Remove the
  entry to unblock — *Settings → Remote access → Excluded network ranges*.
- `allowCidrs` written too wide hands out shell access on this machine. Prefer a Tailscale
  ACL over a public range, and do not enable `tailscale funnel`.

## Phone layout

`Remote UI layout` turns the desktop three-column UI into something usable at 390px: the
sidebar becomes a drawer over full-width content, settings become a vertical stack with a
horizontally scrolling nav, the composer toolbar wraps so the model name is not truncated,
and touch targets grow. It is keyed on the page being remote, not on viewport width — a
desktop window resized to 390px does not change.

Known limitation: DSH itself allocates no track for the right sidebar below 300px available
width, so file/terminal panels still cannot open on a phone. This plugin only overrides CSS;
it does not change DSH's layout calculation.

## Android app (optional)

A companion shell is published in [Releases](https://github.com/Mzy123l/dsh-plugin-remote-access/releases/latest)
(source in [`android/`](android/)). It is a WebView with an address page and a background
foreground-service watcher that raises a status-bar notification when the model asks a
question — or when a turn ends — while the desktop window is hidden and you are not looking
at the app.

The app is not always the same version as the plugin: the shell is only rebuilt when its own
code changes.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `dsh web authentication required` | the token is stale — DSH rotates it on every start. Use the current URL from the status file, or set an access code and open the bare address. |
| Phone gets `403` | its address is in *Excluded network ranges*. Delete the entry. |
| Nothing listens on the LAN | `allowCidrs` does not cover your subnet. |
| Settings save does nothing | `node tools/check-config-schema.mjs` checks the two hard prerequisites. |
| Big assets re-download every visit | check *Settings → Remote access → Cache* on the phone for the `304` counter; if absent the host half is outdated — update and restart DSH. |
| Enter key does not send on the phone | intended: Enter inserts a newline, only the send button sends. Turn off "Enter inserts a newline on the phone". |

## Development

```bash
node --check index.js
node tools/test-remote-access.mjs   # host half, fake upstream
node tools/test-client.mjs          # client half, minimal React host stub
node tools/check-config-schema.mjs  # config schema against the real Schemastery
node tools/check-dsh-compat.mjs     # engines.dsh against DSH's own compat evaluator
```

The host runs Electron's bundled Node 24, whose stream error paths differ from Node 22;
running the suites under both is worthwhile.

## Related

- [deepseek-ai/deepseek-harness#4558](https://github.com/deepseek-ai/deepseek-harness/discussions/4558) —
  a plugin-facing locale API. If it lands, this plugin's `<html lang>` sniffing can go away.
