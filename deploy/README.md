# Deploying the Bramble indexer to a Hetzner VPS

One-time setup to run the indexer 24/7 with auto-restart and HTTPS.

## 1. Create the server
In [Hetzner Cloud](https://console.hetzner.cloud): **New server** →
- Image: **Ubuntu 24.04**
- Type: **CX22** (2 vCPU / 4 GB) — enough for the in-RAM sql.js index
- Add your **SSH key**
- Create, and note the server's **IP**.

## 2. Connect and install Node + git
```bash
ssh root@YOUR_SERVER_IP
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git
```

## 3. Get the code
```bash
git clone https://github.com/YOU/bramble.git /opt/bramble
cd /opt/bramble/server
npm install
```
(No GitHub repo yet? You can `scp` the folder up instead, but git is easiest for updates.)

## 4. Run it as a service (auto-start, auto-restart)
```bash
cp /opt/bramble/deploy/bramble-indexer.service /etc/systemd/system/
systemctl enable --now bramble-indexer
systemctl status bramble-indexer        # should say "active (running)"
curl http://localhost:8787/api/health   # {"ok":true,...}
```
Logs: `journalctl -u bramble-indexer -f`
After a code update: `cd /opt/bramble && git pull && systemctl restart bramble-indexer`

## 5. HTTPS + a domain (recommended)
Point a domain's **A record** at the server IP, then:
```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Edit deploy/Caddyfile: replace indexer.example.com with your domain, then:
cp /opt/bramble/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```
Test: `https://indexer.yourdomain.com/api/health`

## 6. Firewall
```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```
Port 8787 stays internal — only Caddy talks to it.

## No domain yet? (quickest, unencrypted)
Skip Caddy, expose the indexer directly:
```bash
ufw allow 8787
```
and set the browser's `serverUrl` to `http://YOUR_SERVER_IP:8787`. Works, but
traffic is unencrypted — get a domain + HTTPS before a real launch.

## Controlling resource use (CPU / RAM / bandwidth)
The crawler is what uses resources; *serving searches* costs almost nothing.

- **Serve-only mode** — answer searches but stop crawling (near-zero bandwidth,
  flat RAM, idle CPU). Set `DISABLE_CRAWL=1` in the systemd unit's `Environment=`
  (or run `DISABLE_CRAWL=1 npm start`). Good once your index is big enough.
- **Throttle instead of stopping** — `CRAWL_BATCH_SIZE=4` and `CRAWL_DELAY=400`
  make it crawl gently.
- The index is stored on disk via better-sqlite3, so RAM stays flat as it grows.
  (If `npm install` can't find a prebuilt binary for better-sqlite3, install
  build tools: `apt-get install -y build-essential python3`.)

## Then
Set the browser client's default `serverUrl` to your indexer URL before packaging.
