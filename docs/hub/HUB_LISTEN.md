# Hub listen addresses (`listenHosts`) and Desktop direct connect

AutoCline v1.2 §9. The Hub binds the addresses named in a config file — not a
constant in the source — and the Desktop sidecar connects to those addresses
**directly**. There is no SSH `-L` tunnel and no per-session localhost forward
(decision t848u).

## 1. Hub: `~/.config/cline/hub.json`

```json
{
  "port": 25463,
  "listenHosts": ["127.0.0.1", "100.101.163.69"],
  "listenUrls": [
    "ws://127.0.0.1:25463/hub",
    "ws://100.101.163.69:25463/hub"
  ]
}
```

| Key | Meaning |
|-----|---------|
| `listenHosts` (alias `hosts`) | Addresses to bind, in order. `127.0.0.1` must come first: it is the endpoint published in the discovery record. |
| `listenUrls` | Optional. Health-check/docs list. When `listenHosts` is absent the hosts are derived from these URLs. |
| `port` | Port shared by every bind. `--port` / `CLINE_HUB_PORT` still win when set explicitly. |
| `pathname` | Optional WebSocket path, default `/hub`. |

- An env override `CLINE_HUB_LISTEN_HOSTS=127.0.0.1,100.101.163.69` **replaces**
  the file list (it is never merged).
- A different file is selected with `CLINE_HUB_CONFIG=/path/hub.json` or
  `cline hub ensure --hub-config /path/hub.json`.
- Without any configuration the Hub keeps its historical loopback-only bind.

### Wildcards are refused

`0.0.0.0`, `::`, `[::]` and `*` fail startup with an explicit error — before a
daemon is spawned:

```
$ cline hub ensure --hosts 0.0.0.0,127.0.0.1
error: Refusing to bind Hub to wildcard address(es) 0.0.0.0 from hub ensure --hosts.
List concrete addresses instead (e.g. 127.0.0.1 and the host's Tailscale IP).
```

Authentication is unchanged: `/status` and `/drain` still require the Hub
token, and a WebSocket upgrade without the token is rejected — including on the
Tailscale address. Reaching the Hub over Tailscale is not authorization.

## 2. systemd

The unit ships in this directory (`docs/hub/cline-hub.service`). Its
`ExecStart` must **not** hardcode `--host`:

```ini
ExecStart=/bin/bash -lc 'set -e; cline hub ensure --hub-config /home/joe/.config/cline/hub.json; while true; do cline hub status | grep -q "\"running\":true"; sleep 20; done'
ExecStop=cline hub stop
```

Install and restart:

```bash
mkdir -p ~/.config/systemd/user
cp docs/hub/cline-hub.service ~/.config/systemd/user/cline-hub.service
systemctl --user daemon-reload
systemctl --user restart cline-hub
```

## 3. Verify both addresses are bound

```bash
ss -ltnp | grep 25463
# LISTEN 0 512 127.0.0.1:25463       0.0.0.0:* users:(("cline",pid=...,fd=32))
# LISTEN 0 512 100.101.163.69:25463  0.0.0.0:* users:(("cline",pid=...,fd=33))

curl -s http://127.0.0.1:25463/health
curl -s http://100.101.163.69:25463/health
# both: {"ok":true,"host":"127.0.0.1","port":25463,...}

cline hub status
# {"running":true,...,"listenUrls":["ws://127.0.0.1:25463/hub","ws://100.101.163.69:25463/hub"],
#  "listenHosts":["127.0.0.1","100.101.163.69"]}
```

Changing the list is a config edit plus `systemctl --user restart cline-hub`
(or `cline hub stop && cline hub ensure`); no rebuild is needed.

## 4. Desktop: `hubUrls`

`~/.cline/data/settings/remote-environments.json`:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "hp02",
      "name": "hp02",
      "host": "hp02",
      "hubUrls": [
        "ws://100.101.163.69:25463/hub",
        "ws://127.0.0.1:25463/hub"
      ],
      "createdAt": "2026-11-03T00:00:00.000Z",
      "updatedAt": "2026-11-03T00:00:00.000Z"
    }
  ]
}
```

- `hubUrls` is the **only** Hub connection path; the first URL is the one the
  session dials. The legacy single `hubUrl` is still read (after `hubUrls`).
- SSH fields (`host`, `user`, `port`, `identityFile`) remain: they are used for
  git/file operations on the remote host, never to build a Hub tunnel.
- A profile with no `hubUrls` is refused with an error naming the file, instead
  of falling back to an SSH tunnel.
- If the configured URL does not answer, connect fails and lists every URL it
  tried. Start the Hub (section 2), check `tailscale status`, or fix the URL.
- Place `ws://127.0.0.1:25463/hub` first **only** when the Desktop runs on the
  Hub host itself; on another machine the Hub's loopback bind is not reachable.
