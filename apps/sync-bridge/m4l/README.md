RemoteDJ OSC Stub (Max for Live)

- Open `RemoteDJ-OSC-Stub.maxpat` in Max or Max for Live.
- Click the message boxes to send OSC:
  - `/remote-dj/preset "Neon Keys"`
  - `/remote-dj/param/set "filter_cutoff" 0.72`
- The sync bridge listens on `udp://127.0.0.1:9123` by default. Configure
  `DAW_BRIDGE_OSC_HOST` and `DAW_BRIDGE_OSC_PORT` in `apps/sync-bridge/.env` to change it.

Note: This is a tiny stub for wiring. Replace the message boxes with Live UI controls
(dials/sliders) when building a real M4L device.
