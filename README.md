# octopus-dash

A per-device system dashboard: CPU load, memory, disks, network interfaces,
uptime, OS and temperature, read live from the machine it runs on. One instance
runs on each device and is viewed from a browser on the same private network.

Express plus `systeminformation`, and a single static page in `public/`. There
is no database and no accounts: it reports the host it is on and nothing else.
`PLAN.md` is a design for a multi-host, configurable version; **none of it is
built yet**.

## Run it

```sh
npm install        # public packages only
npm start          # http://localhost:7000
npm test           # node --test test/*.test.js
```

`PORT` defaults to 7000; `DEVICE_LABEL` names the machine in the UI (falls back
to the hostname). In Docker the compose uses `pid: host` and read-only host
`/proc` and `/sys` mounts so the readings are the host's, not the container's.
`octopus-dash.service` is a systemd unit for running it bare on a small device.

## Map

| Path | What belongs there |
|---|---|
| `index.js` | The whole server: `/health`, `/api/build`, static `public/`, and `/api/stats` (gathers the `systeminformation` calls, filters disks and interfaces, shapes the JSON) |
| `public/index.html` | The whole client: inline CSS and JS, polls `/api/stats` every 3 s and renders fixed cards |
| `public/favicon.svg` | Icon |
| `build.js` | Build stamp, a hash of the shipped files including `public/index.html` |
| `Dockerfile`, `docker-compose.yml` | Container build and stack (port, env, host mounts) |
| `octopus-dash.service` | systemd unit for a non-Docker install |
| `PLAN.md` | Design for the next version (collector/viewer roles, widgets, config). Not built |
| `test/boots.test.js` | Spawns `index.js` and checks it starts |
| `test/build-stamp.test.js` | The stamp is content-derived |
| `test/env-wiring.test.js` | Every `process.env.X` the code reads is passed in the compose |

## Adding things

- **A new reading (a metric):** add the `si.*` call to the `Promise.all` in the
  `/api/stats` handler in `index.js` (with `.catch` returning nulls if the
  hardware may not have it, as temperature does), add its field to the JSON,
  then render it in `public/index.html` where the cards are built. Anything that
  can be missing must render as "unavailable", never as zero. Prove with
  `npm start` and `curl localhost:7000/api/stats`.
- **A new filter rule (disks or interfaces):** the `skipFs` list and the
  interface filter live in the same handler.
- **A new env var:** read it in `index.js`, add it to `environment:` in
  `docker-compose.yml` (and `Environment=` in `octopus-dash.service` if the
  systemd install needs it), run `npm test`: `env-wiring.test.js` fails when
  the compose does not pass it.
- **A new route:** add it in `index.js` above `express.static` if it must win
  over a file of the same name, add a row below, and `npm test` (the boot test
  proves the file still loads).
- **Anything in `PLAN.md`:** read it first; it already decides the
  architecture and what is out of scope.

## Routes

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/` | GET | none | the dashboard page (`public/index.html`) |
| `/api/stats` | GET | none | the current readings, as JSON |
| `/health` | GET | none | `{ ok, service }` liveness |
| `/api/build` | GET | none | build stamp and start time |

There is no authentication: bind it only to a private interface (the compose
does this), never to a public one.

## One instance per device

That is the whole design. `DEVICE_LABEL` is what names the machine in the UI, so
**two devices running this with the same label are indistinguishable** in
anything that collects from them. Set it per host.

## Temperature is often unavailable

`systeminformation` returns nulls for temperature on hardware that exposes no
sensor to the container, and inside Docker that is common. It is a missing
reading, not a failure: the page keeps rendering, and anything consuming
`/api/stats` needs to tolerate a null rather than treat it as zero degrees.
