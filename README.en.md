# dsh-plugin-remote-access

[中文](README.md) · **English**

A plugin for **DeepSeek Harness (DSH) desktop**: it exposes this machine's DSH web GUI
**only to a network range you choose** (Tailscale's `100.64.0.0/10` by default), so your
phone or another computer can drive the same agent.

- **Never binds `0.0.0.0`** — it listens only on local addresses inside the allowlist;
  peers outside it get `403`.
- **Nothing hard-coded** — network ranges, bind address, port, upstream and status file are
  all configuration.
- **Two ways in** — copy the tokenized URL, or set an access code and type it once on the
  phone (then 30 days password-free).
- **Phone UI is usable** — the layout is handed to DSH's own `dsh-client-ui-layout`, so the
  sidebar becomes a modal drawer and the right panel a fullscreen overlay, exactly as DSH
  does on narrow viewports. The plugin adds gestures, the Android back key, and its own
  composer bar on top of that baseline.
- **Phone-only appearance** — theme and font size are stored in this plugin's config and
  projected onto remote pages only; the desktop settings document is never written.
- **DSH 0.2.1+** — `engines.dsh = ^0.2.1-rc.1`; the upstream origin is read from
  `webServer.getOrigin()`, so the system-assigned port and native HTTPS are followed.
- **Edit in the settings page** — saving hot-reloads the listener in place; no DSH restart.
- **One config source** — only this user's `$DSH_HOME/remote-access-config.json`. The plugin
  **never reads or writes** the shared profile's `cordis.patch.yml`; the settings page uses
  its own `/__remote_access__/config` endpoint. Several Windows users sharing one profile
  each keep their own port, and a busy port falls back to a free one and is remembered.
- **Failures are visible** — a self-diagnosis file is written either way.

## Install

Three ways; pick one. **Restart DSH once afterwards.**

> **Version requirement**: this release targets **DSH 0.2.1+**
> (`engines.dsh = ^0.2.1-rc.1`, covering `0.2.1-rc.1`, `0.2.1-rc.2` and later 0.2.x).
> For DSH 0.2.0 and older, use `1.3.8`.

> **Where to get it**: [GitHub Releases](https://github.com/Mzy123l/dsh-plugin-remote-access/releases)
> (per-version notes and APKs) · [npm](https://www.npmjs.com/package/dsh-plugin-remote-access)
> (`latest` is the current version) · [Changelog](README.md#更新日志).

**① Plugin page (recommended)** — DSH → *Settings → Plugins → Add plugin*, then enter:

| Enter | Installs from |
|---|---|
| `dsh-plugin-remote-access` | npm (published since 1.2.0; fastest) |
| `github:Mzy123l/dsh-plugin-remote-access` | GitHub (latest code) |
| an absolute local path | your own clone / download |

> ⚠️ Two older npm names — `dsh-remote-access-cidr` (ours, frozen at 1.0.0) and
> `dsh-remote-access` (someone else's package) — must not be used. The current name is
> `dsh-plugin-remote-access`.

> 📛 **Renamed in 1.2.0**: `dsh-remote-access-cidr` → `dsh-plugin-remote-access`. Bundle
> rows load by **package name**, so an install from the old name does not follow along:
> remove the old entry under *Settings → Plugins*, then add it again by the new name.
> Removing may also drop the `config:` block of the `id: remote-access-cidr` row in the
> profile's `cordis.patch.yml` (ranges, code, UI settings live there) — copy it first if you
> want to keep the values.

> ⚠️ **1.4.1 id migration (important)**: DSH 0.2.1 ships its own loader row
> `id: remote-access` (`@deepseek-ai/dsh-api-remote-access`). Plugin 1.4.0 used the same id,
> and the collision stopped the official `remoteAccess` service from mounting, which made
> the desktop shell fail at startup with `desktop welcome: Web request failed`. Since 1.4.1
> the plugin row and settings namespace are **`remote-access-cidr`**. After upgrading, move
> the old `config:` block from `id: remote-access` to `id: remote-access-cidr`, or re-enter
> the values in the settings page.

**② Command line** (equivalent; the profile write lock is held while DSH runs):

```powershell
dsh plugin --profile desktop add dsh-plugin-remote-access
# latest repo code:  dsh plugin --profile desktop add github:Mzy123l/dsh-plugin-remote-access
# if the CLI rejects both, pass an absolute local path
```

**③ Fetch the source from GitHub** — if you want the code on disk first:

```powershell
irm https://raw.githubusercontent.com/Mzy123l/dsh-plugin-remote-access/main/install.ps1 | iex
```

The script only **puts the code in a fixed directory** (default
`%LOCALAPPDATA%\dsh-plugins\dsh-plugin-remote-access`); installation is still done by DSH
(point the plugin page at that directory). Behind a proxy:

```powershell
$s = irm https://raw.githubusercontent.com/Mzy123l/dsh-plugin-remote-access/main/install.ps1
& ([scriptblock]::Create($s)) -Proxy http://127.0.0.1:7890
```

> Why not one step: DSH's plugin installation (writing the profile's `package.json` /
> `cordis.patch.yml`, running the package manager) must be done by DSH itself — the plugin
> page, or an agent using the `plugin_manager` tool. Hand-editing the profile breaks it.

Parameter changes hot-reload. Code changes differ: `client.js` (browser half) is re-fetched
on **page refresh**; `index.js` (host half, including **new config fields**) needs a
**DSH restart**.

## Android app (optional)

If you would rather not type an address in a mobile browser, use the companion shell:

**[Download the latest APK](https://github.com/Mzy123l/dsh-plugin-remote-access/releases/latest)**
([all releases](https://github.com/Mzy123l/dsh-plugin-remote-access/releases) · source in
[`android/`](android/) · notes in [`android/README.md`](android/README.md))

> The link points at Releases rather than a fixed filename: APKs are named
> `dsh-plugin-remote-access-<version>.apk` and the name changes with every bump.

> **APK and plugin versions differ.** The APK is only rebuilt when the shell code changes.
> The current plugin is **1.6.0**; the APK is still **1.4.1** (`versionCode` 16) — those
> releases only touched the host and web halves, so the APK does not need reinstalling.

The app is called **DSH**; its icon is the blue mascot (adaptive icon, works on round and
square launchers).

- **The address page is the first screen**: enter `IP or hostname:port` (**no scheme**,
  e.g. `100.64.0.3:19388`); one checkbox toggles HTTPS.
- On failure it **falls back to the address page**; the small capsule on the left of the
  page always has *Settings* — **recoverable even offline**.
- **The back key is fully owned by the shell**: close the drawer / right panel / settings
  dialog, then page-back, then **send the app to the background** (not exit — the background
  is what lets the notification watcher run; swipe it away from recents to really exit).
  See [`android/README.md`](android/README.md).
- **Model questions and finished turns pop from the top of the screen** (heads-up, like a
  message). A foreground service watches while the app is backgrounded and fires only when
  the **desktop DSH window is not visible** (tray / minimised / page closed) **and** you are
  not looking at the app. See [Phone notifications](#phone-notifications).
- The page is still the real DSH from the desktop: phone layout, theme and font size all
  come from this plugin's config.
- Permissions: only `INTERNET` / `ACCESS_NETWORK_STATE` / `POST_NOTIFICATIONS` /
  `FOREGROUND_SERVICE(_SPECIAL_USE)`. Self-signed (`CN=DSH Remote`); same-signature updates
  install over the top.

Installing requires allowing "install unknown apps". The desktop side is still this plugin
listening (port `19388` by default); the app only wraps the page.

## Phone notifications

Two notifications, **each with its own switch and its own channel** (under *Settings →
Remote access → Phone notifications*):

| Notification | When it fires | Switch | Channel |
|---|---|---|---|
| **Model question** | the model asks you to choose (`ask_user_question`, plan review included) and **nobody answers** | `notifyOnChoice` | "Model question" |
| **Turn finished** | the turn **completed**, or **ended abnormally** (malformed model output / out of balance or quota / network down / rate limited / credentials expired / context too long / server error …) | `notifyOnFinish` | "Task finished" |

Both share one trigger: the **desktop DSH window is not visible** (tray / minimised / page
closed, reported by the desktop page itself with a 25 s heartbeat) **and** you are not
looking at the phone. Then it pops a heads-up banner — it rings, vibrates, and drops into the
status bar after a few seconds. Tapping it returns to DSH.

### Banner doesn't appear on Chinese ROMs

MIUI / HyperOS / EMUI / ColorOS and friends need extra steps: allow *Notifications* for the
app, allow *Floating notifications* / *Lock screen notifications*, turn off battery
optimisation for the app, and in recents **lock** the app so the system does not kill the
foreground service. The settings page has a self-check line that reports what the phone
actually reported (notification permission, channel importance, banner suppression).

## Usage

### Option 1: set an access code (recommended)

*Settings → Remote access → Access code*, enter 4–12 digits or letters, save. Then open the
bare address on the phone (e.g. `http://100.64.0.5:19388/`) and type the code once. The
browser keeps a cookie for 30 days.

### Option 2: use the tokenized URL

Without an access code, open the URL from `$DSH_HOME/remote-access-url.txt`, which looks like
`http://100.64.0.5:19388/?token=...`. The token **rotates on every DSH start**, so an old URL
stops working.

### Status file

`$DSH_HOME/remote-access-url.txt` (path configurable via `urlFile`, `off` disables it) holds
the current URLs, the unlocked peers, cache counters, traffic accounting and the effective
config. It contains the access token — **treat it as shell access to this machine**.

## Configuration

### Per-user config (the only source, since 1.5.0)

`$DSH_HOME/remote-access-config.json` — one file per Windows user. The plugin never reads or
writes the shared profile. Deleting the file rebuilds it from defaults on the next start.

### Fields you can change in the settings page

| Field | Default | Meaning |
|---|---|---|
| Port | `0` | 0 = OS-assigned; pin it for a bookmarkable URL |
| Allowed network ranges | `100.64.0.0/10` | the only security boundary; with `listen=auto` it also picks the bind address |
| Excluded network ranges | empty | exceptions; an address that fails the access code lands here automatically — delete to unblock |
| Connection limit | `64` | browsers keep several keep-alive connections; do not set it too low |
| Log level | `info` | `silent` / `info` / `debug` |
| Access code | empty | 4–12 digits or letters |
| Notify on question | on | Android app only |
| Notify on turn end | on | Android app only |
| Notify only when the window is hidden | on | Android app only |
| Enter inserts a newline on the phone | on | only the send button sends; Ctrl/Cmd+Enter still sends, and IME composition is always let through |
| Theme / font size / work steps / code view / performance | factory | projected onto remote pages only |

### Access code rules

4–12 digits or letters; no spaces or symbols. **One wrong entry immediately blocks that
address** (written to `denyCidrs`) — remove the entry under *Excluded network ranges* to
unblock.

### The same page on the phone

Everything above can be edited from the phone as well: *Settings → Remote access* works on
remote pages too, and saving applies immediately.

### Other parameters (config file only)

`listen` (`auto` or explicit addresses), `allowWebSocket`, `upstream` (`auto` or an explicit
`http(s)://host:port`), `rewriteHost`, `forwardClientHeaders`, `timeoutMs`, `urlFile`,
`printUrl`, `cacheEnabled` / `cacheTtlMinutes` / `cacheProbe` / `cacheOverrideNoStore` /
`cacheFullRange`, and the UI projection fields.

## Choosing a workspace directory on the phone

The plugin's bundle patch pins DSH's directory picker to the **in-app browser** backend
(`dsh-host-directory-picker-browse`) instead of the OS dialog, because a native chooser opens
on the **host's** screen and a phone would wait forever.

Since DSH 0.2.2 that pin needs one more step, which this plugin performs automatically: the
auto chooser mounts its `native` backend early during boot, that backend registers the
`directoryPicker` service name, the `browse` backend then fails with
`service "directoryPicker" has been registered at <NativeDirectoryPicker>` and never retries.
The plugin notices the failed entry once boot settles and re-mounts `browse`, after which
`directoryPickerController` activates and the phone can list directories.

### Why you only see "Home" at first

The browser starts at the home directory. Use the breadcrumb or *Edit path* to jump to
another drive; on Windows `D:\` style paths are accepted.

## Phone layout

Layout is **delegated to DSH's own `@deepseek-ai/dsh-client-ui-layout`**. Below 768 px DSH
already renders the sidebar as a modal drawer and the right panel as a fullscreen overlay,
so this plugin does **not** override grid tracks, does not build its own scrim, and does not
reposition the sidebar. That was the source of a long list of rendering bugs.

What the plugin adds on top of the official baseline:

| Piece | What it does |
|---|---|
| **Gestures** | swipe left to open the right panel, swipe right to open the drawer; while either overlay is open, a swipe in the opposite direction closes it. Edge-started swipes need 56 px; mid-content swipes need 72 px and a steeper angle. |
| **Back key** | for the Android shell: official overlays → right panel → left drawer → global panel, exposed as `window.__dshRaBack`. |
| **Composer bar** | the plugin's own rules: the toolbar wraps so the model name is not truncated, the right-hand group is pushed right, and the input font is 15 px with a 21 px line height. |
| **Official whale** | the top-left opener button keeps DSH's own button (same `data-sidebar-opener`, same handler) but its icon is replaced with the official whale mark. |
| **Safe areas** | `env(safe-area-inset-*)` padding on the columns, drawer and right panel. |
| **Settings page** | stacked vertically with a horizontally scrolling nav on phones. |
| **Body padding** | 28 px on each side, so text does not run to the edges. |

Everything above is keyed on the page being **remote**, not on viewport width — a desktop
window resized to 390 px does not change.

### Tapping a session in the drawer

On a phone the left workspace list *is* the drawer: tapping a session switches to it, but the
drawer stays on top of the content, so selecting a session used to take two taps. The plugin
closes the drawer for you, using the same path as the scrim and the gestures.

It also suppresses the focus DSH puts into the composer on session switch (which pops the
soft keyboard and covers half the screen) for a 400 ms window — tapping the composer yourself
still works normally.

### Enter inserts a newline on the phone

DSH sends on a bare Enter. On a phone that is rarely what you want, so the plugin intercepts
Enter in the main composer (capture phase, before Lexical sees it) and inserts a line break
instead. The send button is unaffected; Ctrl/Cmd+Enter still sends; IME composition and the
60 ms right after it are always let through.

Turn it off with *Enter inserts a newline on the phone*.

## Custom CSS (remote pages only)

Put rules in `$DSH_HOME/remote-access-custom.css`. Remote pages fetch them from
`/__remote_access__/custom.css` (behind the access gate, `no-store`) and inject a `<style>`;
**local pages never request it**, so the desktop UI stays untouched. The file missing is not
an error — nothing is injected.

## Caching (big assets stop re-transferring)

Remote pages cache static assets on the phone. Where the upstream sends no cache headers,
this plugin supplies a freshness window plus a weak validator, so repeat visits stop
re-transferring wallpapers and similar files. **No response body is ever stored on the host.**

Defaults: 10-minute freshness (SWR 12 h), content-addressed assets pinned for a year,
`no-store` large media taken over, whole-file `Range` treated as complete. All of it is
configurable and self-reported on *Settings → Remote access → Cache*.

## Why animated wallpapers often look static

The wallpaper engine renders through an iframe; on a phone WebView the iframe can be
throttled or dropped to a low opacity when the page is backgrounded or composited
differently. This is the wallpaper plugin's behaviour, not something this plugin changes —
the plugin deliberately **does not touch any `--we-*` variable or `data-we-*` attribute**,
because doing so previously blanked the wallpaper entirely.

## Security boundaries

Read this before widening `allowCidrs`.

- The plugin listens only on local addresses inside `allowCidrs` and refuses peers outside it.
- Without an access code, DSH's own token/cookie still applies — the plugin does not lower
  DSH's authentication.
- **With an access code, do not treat it as a second factor.** Network range + code are then
  the whole credential; the plugin attaches DSH's token server-side and the browser never
  sees it.
- One wrong access code immediately blocks that address (written to `denyCidrs`).
- `allowCidrs` written too wide hands out shell access on this machine. Prefer a Tailscale ACL
  over a public range, and do not enable `tailscale funnel`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `dsh web authentication required` | the token is stale — DSH rotates it on every start. Use the current URL from the status file, or set an access code and open the bare address. |
| Phone gets `403` | its address is in *Excluded network ranges*. Delete the entry. |
| Nothing listens on the LAN | `allowCidrs` does not cover your subnet. |
| Settings save does nothing | `node tools/check-config-schema.mjs` checks the two hard prerequisites. |
| Big assets re-download every visit | check *Settings → Remote access → Cache* on the phone for the `304` counter; if absent the host half is outdated — update and restart DSH. |
| Enter key does not send on the phone | intended: Enter inserts a newline. Turn off *Enter inserts a newline on the phone*. |
| Swipe does nothing | the swipe must be mostly horizontal (|dx| > |dy| × 1.25 from an edge, × 1.8 mid-content) and at least 56/72 px. Content with its own horizontal scrolling is excluded on purpose. |
| "Select workspace directory" shows `directoryPickerController is unavailable` | the browse backend failed to mount; the plugin re-mounts it ~2.5 s after boot. If it persists, restart DSH once. |
| Wallpaper looks flat or missing | that is the wallpaper plugin, not this one — see [above](#why-animated-wallpapers-often-look-static). |

## Development

```bash
node --check index.js
node --check client.js
node tools/test-remote-access.mjs   # host half, fake upstream
node tools/test-client.mjs          # client half, minimal React host stub
node tools/test-i18n.mjs            # locale dictionaries and language normalisation
node tools/check-config-schema.mjs  # config schema against the real Schemastery
node tools/check-dsh-compat.mjs     # engines.dsh against DSH's own compat evaluator
```

The host runs Electron's bundled Node 24, whose stream error paths differ from Node 22;
running the suites under both is worthwhile.

### Localisation

The settings page follows DSH's UI language and supports all eight languages DSH can switch
to — `zh` / `en` / `ja` / `es` / `fr` / `de` / `ru` / `pt` (the list mirrors
`@deepseek-ai/dsh-client-locale/locale/`). Dictionaries live in `client.js` as `DICTS`, keyed
by the Chinese source string; a missing entry falls back to the Chinese text rather than
rendering blank. Language changes apply live, without a page reload: the plugin subscribes to
the locale service, listens for `locale/change`, and finally watches `<html lang>` as a
fallback.

Inline diagnostic strings (cache counters, notification state) remain bilingual zh/en.

## Related

- [deepseek-ai/deepseek-harness#4558](https://github.com/deepseek-ai/deepseek-harness/discussions/4558) —
  a plugin-facing locale API. If it lands, this plugin's `<html lang>` sniffing can go away.
