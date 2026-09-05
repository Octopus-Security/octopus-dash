# octopus-dash

A per-device system dashboard: CPU load, memory, disks, network interfaces,
uptime, OS and temperature, read live from the machine it runs on.

Express plus `systeminformation`, and a static page in `public/`. There is no
database and no accounts — it reports the host it is on and nothing else.

## Endpoints

| Route | What it returns |
|---|---|
| `/` | the dashboard page |
| `/api/stats` | the current readings, as JSON |

## One instance per device

That is the whole design. `DEVICE_LABEL` is what names the machine in the UI, so
**two devices running this with the same label are indistinguishable** in
anything that collects from them. Set it per host.

`PORT` defaults to 7000.

## Temperature is often unavailable

`systeminformation` returns nulls for temperature on hardware that exposes no
sensor to the container, and inside Docker that is common. It is a missing
reading, not a failure — the page should keep rendering, and anything consuming
`/api/stats` needs to tolerate a null rather than treat it as zero degrees.

## Running it

```sh
npm start
npm test
```
