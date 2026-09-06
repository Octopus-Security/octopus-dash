'use strict';

const express = require('express');
const si = require('systeminformation');
const path = require('path');
const { BUILD, STARTED_AT } = require('./build');

const app = express();
const PORT = process.env.PORT || 7000;
const DEVICE_LABEL = process.env.DEVICE_LABEL || '';

// ── Liveness and deploy verification ─────────────────────────────────────────
//
// Portainer polls and reports back to nobody, so without a value that moves
// when the code moves, a deploy that never landed and one that landed without
// helping look identical from outside. The stamp covers public/index.html,
// which IS the client here — the page carries its CSS and JS inline — so a UI
// change moves it too. `unknown` is never `current`.
app.get('/health', (_req, res) => res.json({ ok: true, service: 'octopus-dash' }));
app.get('/api/build', (_req, res) => res.json({
  ok: true,
  service: 'octopus-dash',
  build: BUILD,
  startedAt: STARTED_AT,
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', async (req, res) => {
  try {
    const [cpu, mem, disks, nets, time, os, temp] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkInterfaces(),
      si.time(),
      si.osInfo(),
      si.cpuTemperature().catch(() => ({ main: null })),
    ]);

    // Filter to relevant disks (skip tmpfs, overlay, etc.)
    const skipFs = ['tmpfs', 'overlay', 'devtmpfs', 'squashfs', 'efivarfs', 'devfs'];
    const filteredDisks = disks.filter(d =>
      !skipFs.includes(d.type) &&
      d.size > 0 &&
      !d.mount.startsWith('/snap/')
    );

    // Filter network interfaces — skip loopback and docker bridges
    const filteredNets = (Array.isArray(nets) ? nets : [nets]).filter(n =>
      n && n.ip4 && !n.internal && !n.iface.startsWith('br-') && !n.iface.startsWith('veth')
    ).map(n => ({
      iface: n.iface,
      ip4: n.ip4,
      tailscale: n.ip4.startsWith('100.'),
    }));

    res.json({
      hostname: os.hostname,
      label: DEVICE_LABEL || os.hostname,
      platform: os.platform,
      distro: os.distro,
      arch: os.arch,
      uptime: time.uptime,
      cpu: {
        load: Math.round(cpu.currentLoad),
        cores: cpu.cpus ? cpu.cpus.length : null,
        temp: temp.main ? Math.round(temp.main) : null,
      },
      mem: {
        total: mem.total,
        used: mem.used,
        pct: Math.round((mem.used / mem.total) * 100),
      },
      disks: filteredDisks.map(d => ({
        mount: d.mount,
        fs: d.type,
        total: d.size,
        used: d.used,
        pct: Math.round(d.use),
      })),
      nets: filteredNets,
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`octopus-dash running on :${PORT}`);
});
