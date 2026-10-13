# octopus-dash: plan

Status: design only. Nothing in this document is built. Written 2026-10-13.

## Goal

A configurable system dashboard that can be hosted on any machine and viewed
from any device over Tailscale. Hosts are Linux PCs, a Raspberry Pi (which is
both a collector and a kiosk viewer on its own screen), Windows, and macOS if it
is cheap. Phones are viewers only (see "Later / out of scope").

## What dash is today

- One Node process: Express plus `systeminformation`, no database, no accounts.
- `GET /api/stats` returns CPU load, cores, temperature, memory, disks, network
  interfaces (flagging the Tailscale one), uptime and OS info for the host it
  runs on. `/health` and `/api/build` exist for deploy verification.
- `public/index.html` is a single static page with inline CSS and JS. It polls
  `/api/stats` every 3 seconds and renders six fixed cards.
- It binds `0.0.0.0` and has no authentication. In Docker it mounts host
  `/proc` and `/sys` read-only and uses `pid: host`.
- One instance per device; `DEVICE_LABEL` names it.

Gaps relative to the goal: one host per page, fixed widgets, bound to every
interface, no per-process, GPU, container or Pi metrics, no config.

## Architecture

Two roles in one repo, deployable together or apart.

### Collector (per host)

A small read-only process that reports one machine.

**Runtime choice.** Node stays the default for consistency with the rest of the
estate and because `systeminformation` already covers Linux, Windows and macOS
with one API. Trade-offs:

| | Node + systeminformation | Go single binary |
|---|---|---|
| Idle RAM | roughly 50-80 MB | roughly 10-20 MB |
| Install on Pi | needs Node (apt or tarball) | copy one file |
| Windows | needs Node plus a service wrapper | one .exe, native service API |
| Metrics | broad, one library, some shell-outs | write or pick (gopsutil) per metric |
| Estate fit | same stack as everything else | new toolchain to maintain |

Recommendation: build the collector in Node first, keeping the JSON contract
(below) independent of the implementation. If idle memory on the Pi, or Windows
installation, proves painful, a Go collector can replace it without touching the
viewer. Node 22 also offers single executable applications, which is a possible
middle path for Windows, but it produces a large (~80 MB) binary and is not
tested here. This is a judgement, to be verified in phase 1 on real hardware.

**Light mode (for the Pi).** Sample on a timer into a cached snapshot instead of
per request, so N viewers cost one sample. Skip expensive calls unless a widget
asks for them (per-process and docker are opt-in via config). Avoid
`systeminformation` calls that spawn many subprocesses on a hot path.

**API (read-only, versioned).** All GET, all JSON.

- `GET /api/v1/summary`: hostname, label, OS, arch, uptime, load, memory, swap.
- `GET /api/v1/cpu`: overall and per-core load, frequency, temperature.
- `GET /api/v1/disks`: mounts with size and used; I/O rates where available.
- `GET /api/v1/net`: interfaces, addresses, rx/tx rates.
- `GET /api/v1/temps`: all sensors available.
- `GET /api/v1/gpu`: from `nvidia-smi --query-gpu=... --format=csv` when present
  (later AMD via sysfs, Intel via sysfs). Absent GPU returns an empty list.
- `GET /api/v1/processes`: top N by CPU or memory, with **name and PID only**.
- `GET /api/v1/containers`: Docker/Podman via the socket, when present.
- `GET /api/v1/pi`: Pi-only (see below).
- `GET /api/v1/capabilities`: which of the above this host can actually serve.
  The viewer uses it to offer only widgets that will work.
- `GET /health`, `GET /api/build`: as today.

Every field that may be unavailable is `null`, never `0`, and consumers must
tolerate it (the existing rule for temperature). The old `/api/stats` stays as
an alias until the viewer has moved.

**Binding.** Never `0.0.0.0`. Two supported modes:

1. **`tailscale serve`.** The collector binds `127.0.0.1` and `tailscale serve`
   publishes it to the tailnet over HTTPS with a real certificate. Preferred: no
   interface discovery, TLS for free, and it supplies identity headers.
2. **Direct bind** to the host's Tailscale address, found at startup by looking
   for the Tailscale interface. If none is found, refuse to start rather than
   fall back to every interface. A `BIND` setting may name an address
   explicitly, and the code rejects `0.0.0.0` and `::`.

Running in Docker complicates mode 2 (the container sees a bridge, not the
tailnet), so Docker uses `network_mode: host` with the same bind rule, or mode 1.

**Auth.** Layered, and each layer optional but the first is always on.

- **Network layer:** Tailscale ACLs decide which devices and users can reach the
  port at all. This is the primary control and should be documented with an
  example ACL.
- **Identity layer:** behind `tailscale serve`, requests carry
  `Tailscale-User-Login` and related headers. These are trustworthy **only**
  because the collector listens on loopback and nothing else can reach it; if the
  collector were ever reachable directly, any client could forge them. The
  alternative is calling the local `tailscaled` whois endpoint with the peer
  address, which also works for direct bind mode and does not rely on headers.
  Recommendation: use whois against the peer address in both modes (one code
  path, no forgeable headers), with an optional allowlist of logins.
- **Token layer:** an optional shared bearer token for cases where Tailscale
  identity is not enough (shared machines, a viewer served from another origin).
  Compared in constant time, stored in a file or env var, never logged.

**Security rules.**

- Read-only. No endpoint takes a command, a path, or any input that reaches a
  shell. No command execution, ever. A test should fail the build if a route
  other than GET exists.
- External tools (`nvidia-smi`, `vcgencmd`) are run with fixed argument arrays,
  never with strings built from requests.
- Process list redacts command-line arguments (only the executable name is
  returned), since arguments often hold secrets. Docker output omits environment
  variables and mounts.
- Rate limiting per peer (for example 20 requests per second burst, 5 sustained)
  plus a cap on response size and on concurrent requests. Cached snapshots mean
  limiting cannot be used to make the host do more work.
- CORS is off by default; the viewer is either served by the collector (same
  origin) or an allowlisted origin is configured.
- Docker socket access, if enabled, should go through a read-only socket proxy,
  because the raw socket is root-equivalent. Off by default.

### Viewer

The dashboard UI. It can be served by any collector (same origin, no CORS) or
hosted separately, and it works from any browser, including a phone's.

- **Hosts:** a list of configured collectors (name plus URL, optional token). A
  host picker or an all-hosts overview.
- **Widgets per host:** choose which, reorder, resize. Initial set: CPU, memory,
  disks, network, uptime, temperatures, GPU, top processes, containers, Pi health.
- **Config:** a single JSON document (hosts, per-host widget layout, theme,
  refresh interval, kiosk options). Stored in `localStorage` and, optionally,
  fetched from a `config.json` next to the viewer so a kiosk can be provisioned
  from a file. Export and import from the UI. Tokens in the config are
  treated as secrets and the export asks before including them.
- **Responsive:** phone, tablet and desktop layouts. The first step (already
  in this branch) makes the current page fluid and usable at small sizes.
  Breakpoints follow the estate kit's planned set: 480, 768, 1024, 1280. The
  viewer will adopt the shared component kit once its layout release lands;
  until then it stays self-contained.
- **Wall/kiosk mode:** `?kiosk=1` or a config flag. No chrome, large type,
  optional rotation through hosts every N seconds, burn-in mitigation (slow
  pixel shift or dimming at night), and a wake-lock request where supported.
- **Resilience:** a host that is unreachable shows a stale marker and last-seen
  time rather than blanking the page; polling backs off.
- **Transport:** polling to begin with (simple, cache friendly). Server-sent
  events are a later optimisation.

## Platform matrix

| Platform | Role | How stats are collected | Service |
|---|---|---|---|
| Linux (x64, arm64) | collector and viewer | `systeminformation` over `/proc`, `/sys`; `nvidia-smi` for GPU | systemd unit |
| Raspberry Pi | collector and kiosk viewer | as Linux, plus `vcgencmd` | systemd units |
| Windows | collector | `systeminformation` (WMI/PowerShell under the hood); GPU via `nvidia-smi`; temperatures often unavailable without a helper | service wrapper |
| macOS | collector | `systeminformation`; temperatures and fans mostly unavailable without privileged tools | launchd agent |

**Windows.** `systeminformation` works but shells out to PowerShell and WMI, which
is slow on first call and heavier than on Linux; the cache-and-sample design
matters here. CPU temperature is frequently not exposed. Running as a service:
either `node-windows` or NSSM wrapping Node, or a Go binary using the native
service API, which is the cleaner answer and the main argument for Go on this
platform. Run as a low-privilege service account. Tailscale on Windows works the
same way, so `tailscale serve` applies.

**macOS.** Cheap to support because `systeminformation` already handles it.
Install as a launchd user agent. Treat sensor data as best effort. No special
work planned beyond a plist and a documented install.

### Raspberry Pi as a first-class target

ARM64 Linux (Raspberry Pi OS, 64-bit). The same collector, run in light mode.

- **Load:** target low idle RAM and CPU: cached sampling, optional modules off,
  poll no faster than every 2 seconds. A Pi Zero 2 or Pi 3 with 512 MB to 1 GB is
  the worst case to test; this is where the Go option is reconsidered if Node is
  too heavy.
- **Pi-specific metrics** (`/api/v1/pi`, present only when detected):
  - SoC temperature: `vcgencmd measure_temp`, with `/sys/class/thermal` as the
    fallback.
  - Throttling: `vcgencmd get_throttled` decoded into named flags (under-voltage
    now/ever, frequency capped, throttled, soft temperature limit). Show as a
    clear "healthy / was throttled / throttled now" badge.
  - Clock: `vcgencmd measure_clock arm`; core voltage optional.
  - Storage: SD card or SSD usage, root filesystem, and (optionally) SD wear
    caveat: cards do not report health, so only capacity and I/O errors in
    `dmesg`-free ways. No promise of wear estimation.
  - Fan state if a fan is present.
  - `vcgencmd` needs the `video` group; the service user is added to it rather
    than running as root.
- **Kiosk mode (the Pi's own screen).**
  - Display stack: current Raspberry Pi OS uses Wayland with labwc (older
    releases used wayfire; both are supported targets). Simplest route is
    Chromium with `--kiosk --noerrdialogs --disable-infobars --ozone-platform=wayland`
    pointing at the local viewer. `cage` (a single-application Wayland
    compositor) is the lighter, more locked-down alternative and does not need a
    desktop at all, so it is the recommended option for a dedicated panel, with
    labwc as the documented fallback.
  - Autostart: a systemd user or system unit starts the kiosk after the
    collector, with `Restart=always`. Auto-login to a minimal session is only
    needed for the labwc route.
  - No cursor: hide it (cage `-d`/ unclutter-style option, or a transparent
    cursor theme under labwc).
  - Screen blanking: configurable. Defaults to always-on for a status panel, with
    an optional schedule (blank overnight) via `wlr-randr` or the DPMS
    equivalent, driven by a config value.
  - **Small screens:** the kiosk layout must read well at 800x480 (common 7-inch
    panels), in both landscape and portrait, up to 1080p. In this branch the
    existing page already gets a compact fixed-fit 3x2 layout at 800x480
    landscape and a scrolling single column in portrait. The kiosk work will
    replace the fixed card set with a layout that picks widgets and font sizes
    by available area, with a minimum text size (about 14 px at arm's length)
    and orientation-specific defaults: landscape = grid, portrait = a stacked
    list sized to fill the height. Rotation is set with the panel's
    transform in the compositor, not in the page.
  - Touch: the panel may be a touchscreen, so tap targets stay at least 40 px.
- **Setup:** one install script (to be written) that creates a dedicated user,
  installs the collector, writes a config, and enables:
  - `octopus-dash-collector.service`: runs the collector, binds as per the rules
    above, hardened (`NoNewPrivileges`, `ProtectSystem`, `ProtectHome`,
    `PrivateTmp`, restricted address families, memory limit).
  - `octopus-dash-kiosk.service`: starts cage or the labwc session with
    Chromium in kiosk mode, `After=` and `Wants=` the collector.
  The existing `octopus-dash.service` in the repo is a template for the first
  one and should be updated to match.

## Phases

1. **Linux collector, Raspberry Pi, and the viewer.** Same OS family, so the Pi
   goes here. Collector with the v1 API, light mode, capabilities, binding and
   auth rules, redaction, rate limiting, tests. Pi metrics and the two systemd
   units. Viewer with host list, widget choose/order/resize, JSON config with
   export/import, kiosk mode, responsive down to 800x480 and phone width.
   Acceptance: runs on an x64 Linux box and a Pi, viewable over the tailnet from
   both, kiosk survives a reboot, idle footprint measured and recorded.
2. **Windows (and macOS if cheap).** Service install, measured performance, a
   decision on Node versus Go made on data from phase 1 and this phase.
3. **Alerts and history (optional).** Short in-memory ring buffer for sparklines
   first. Longer history in a small local store (SQLite) with a retention cap.
   Threshold alerts delivered by the viewer or a webhook; nothing is sent
   anywhere by default.

## Later / out of scope

- Hosting dash on a phone (Android via Termux, iOS) was considered and deferred.
  Phones remain fully supported as viewers through the responsive page.

## Open questions for the owner

1. **Node or Go for the collector?** Plan is Node first, Go only if the Pi or
   Windows proves it necessary. Acceptable, or is a single binary a hard
   requirement for the Pi and Windows?
2. **Which Pi models and which screen?** Model and RAM (Zero 2, 3, 4, 5), screen
   size and resolution, touch or not, landscape or portrait. This sets the
   performance budget and the default kiosk layout.
3. **Raspberry Pi OS release and compositor?** Current (labwc) or older (wayfire)
   or Lite with no desktop (cage suits this best).
4. **`tailscale serve` or direct bind as the default?** The plan prefers
   `tailscale serve`. Are HTTPS certificates and MagicDNS enabled on the tailnet?
5. **Who may view what?** Is the tailnet ACL enough, or should the collector
   also enforce a login allowlist, or a token?
6. **Should the viewer have a central "hub" mode?** Browsers fetch each
   collector directly (needs CORS or a token), or one instance proxies the others
   (one place for config and tokens, but a viewer that holds credentials).
7. **Where should config live by default?** Browser `localStorage` only, or a
   file on the host that all viewers share?
8. **Docker and process detail:** is it acceptable to give a collector read access
   to the Docker socket via a read-only proxy, and is a process list (names only)
   wanted at all on shared machines?
9. **GPU scope:** NVIDIA only for now, or AMD and Intel too?
10. **Windows temperatures:** acceptable to show none, or worth a helper such as
    LibreHardwareMonitor?
11. **macOS:** is it a real target, or only if it costs nothing?
12. **Alerts:** where should they go, if anywhere (browser notification, webhook,
    existing messaging)?
13. **Retiring the existing Docker deployment:** keep the current container
    (host `/proc` mounts, bound to all interfaces) running until the collector
    replaces it, or change the binding first as a quick hardening step?
