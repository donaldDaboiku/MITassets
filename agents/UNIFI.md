# UniFi → heartbeat poller

The MIT Asset browser cannot see Wi‑Fi clients. A **UDM / UDM Pro Max** already lists them. This poller reads UniFi and POSTs the same heartbeat the laptop agent uses.

Run it on **one always-on host on the LAN** (IT PC, NAS). Do **not** put the UniFi API key in the PWA.

| Script | Notes |
|--------|--------|
| `unifi-heartbeat-poller.ps1` | Preferred (Windows). Optional cloud lookup so only inventory MACs are posted. |
| `unifi-heartbeat-poller.sh` | Minimal curl; posts every client MAC. Prefer PowerShell for production. |

## Setup

1. UniFi Network → **Control Plane → Integrations** → create an API key.  
2. Copy the heartbeat URL + secret from MIT Asset **Settings → Network Presence**.  
3. On each laptop asset, set **MAC address** (same format UniFi shows).  
4. Edit the poller: UDM IP, API key, heartbeat URL/secret.  
5. Optional (recommended): set `$SupabaseUrl` + `$SupabaseAnonKey` so phones/IoT are skipped.  
6. Task Scheduler / cron every **5 minutes**.  
7. In MIT Asset: enable presence → **Pull heartbeats now**.

Off-site laptops still need `windows-heartbeat.ps1` — UniFi only sees devices on **this** network.
