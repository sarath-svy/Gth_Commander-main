const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const { spawn, exec } = require('child_process');
const proxyRelay = require('./proxyRelay');

const app = express();
app.use(cors());
app.use(express.json());

// Serve the dashboard as the homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.use(express.static(__dirname));

// ==========================================
// FLEET STATE
// ==========================================
let fleetState = {
    isRunning: false,
    config: {},
    users: [],
    activeDrones: {},
    proxyPool: [],         // Available proxies (each tagged with .provider)
    burnedProxies: [],     // Rate-limited proxies
    proxyMode: 'none',     // legacy single-mode flag ('none'|'custom'|'nordvpn'|'mixed')
    droneNetwork: {},      // per-drone network type: { [droneId]: 'direct'|'nordvpn'|'custom'|… }
    droneCount: 0,         // number of drones actually launched this run (mix sum or maxBrowsers)
    automationStartAt: null, // ms timestamp: drones warm up but DON'T click/book until this time (null = act immediately)
    examLink: ""           // booking link, once the server's direct-IP hunter (or a drone) finds it
};

const SEED_PROFILE_PATH = path.resolve(__dirname, 'SeedProfile');
const EXTENSION_PATH = path.resolve(__dirname, 'Extension');
const CONFIG_FILE = path.resolve(__dirname, 'fleet-config.json');
const HISTORY_FILE = path.resolve(__dirname, 'booking-history.csv');
const BANNED_FILE = path.resolve(__dirname, 'banned-ips.json'); // PERSISTENT IP ban list

// ==========================================
// PERSISTENT IP BAN LIST (survives restarts, cleared only by the user)
// Goethe "blocked due to misuse" bans the exit IP for good — we record the proxy
// (by id = host:port) so it's NEVER handed out again, in this run or any future
// run, until the user removes it. Rate-limits (429) are NOT stored here — those
// are temporary and only burned for the current run.
// ==========================================
function loadBannedList() {
    try { if (fs.existsSync(BANNED_FILE)) return JSON.parse(fs.readFileSync(BANNED_FILE, 'utf8')); } catch (e) {}
    return [];
}
function saveBannedList(list) {
    try { fs.writeFileSync(BANNED_FILE, JSON.stringify(list, null, 2)); } catch (e) { console.error('Ban-list save failed:', e.message); }
}
function addPermanentBan(id, info) {
    if (!id) return;
    const list = loadBannedList();
    if (!list.some(b => b.id === id)) {
        list.push({ id, host: (info && info.host) || id, country: (info && info.country) || '', ip: (info && info.ip) || '', bannedAt: new Date().toISOString() });
        saveBannedList(list);
    }
}

// runtime feature settings (mirrored from config)
let autoRetryFailed = false;     // retry users that fail login (transient errors)
let scheduledTimer = null;       // pending scheduled-start timer
let heartbeatTimer = null;       // interval that checks for stuck drones
let examLinkPollerTimer = null;  // server-side direct-IP booking-link hunter
let examLinkRateBackoff = 0;     // backoff steps if the server IP gets rate-limited

// ==========================================
// CONFIG PERSISTENCE (survives restarts, shared across browsers)
// ==========================================
function saveConfigToDisk(payload) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2));
        return true;
    } catch (e) {
        console.error('Config save failed:', e.message);
        return false;
    }
}
function loadConfigFromDisk() {
    try {
        if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) { console.error('Config load failed:', e.message); }
    return null;
}

// ==========================================
// BLOCK BROWSER SIGN-IN / SYNC VIA REGISTRY POLICY
// Edge/Chrome auto-sign every fresh profile into the OS Microsoft account and
// sync them — that's why all windows showed the same user. Setting these
// machine policies under HKCU disables it cleanly for every launched window.
// ==========================================
function applySignInBlockPolicy(browserType) {
    const base = browserType === 'edge'
        ? 'HKCU\\Software\\Policies\\Microsoft\\Edge'
        : 'HKCU\\Software\\Policies\\Google\\Chrome';
    // BrowserSignin=0 (disable sign-in), SyncDisabled=1, BrowserGuestModeEnabled, etc.
    const cmds = [
        `reg add "${base}" /v BrowserSignin /t REG_DWORD /d 0 /f`,
        `reg add "${base}" /v SyncDisabled /t REG_DWORD /d 1 /f`,
        `reg add "${base}" /v RestoreOnStartup /t REG_DWORD /d 5 /f`
    ];
    if (browserType === 'edge') {
        cmds.push(`reg add "${base}" /v ImplicitSignInEnabled /t REG_DWORD /d 0 /f`);
        cmds.push(`reg add "${base}" /v NonRemovableProfileEnabled /t REG_DWORD /d 0 /f`);
        cmds.push(`reg add "${base}" /v ConfigureDoNotTrack /t REG_DWORD /d 1 /f`);
    }
    cmds.forEach(c => { try { exec(c, { shell: true }); } catch (e) {} });
}

// ==========================================
// SUPPRESS THE LOCAL NETWORK ACCESS PROMPT (Chrome/Edge v142+)
// Our content script on the goethe.de page calls http://127.0.0.1:3000. Since
// Chrome/Edge 142 (Oct 2025), a public site reaching localhost/private IPs is
// gated behind a one-time "<site> wants to access other apps and services on
// this device" permission. Each drone uses a FRESH temp profile, so the grant
// is never remembered and it re-prompts every launch, stalling the bot until
// someone clicks Allow.
// We pre-grant it for every origin via enterprise policy:
//   LocalNetworkAccessAllowedForUrls = ["*"]  (all origins allowed, no prompt)
//   LocalNetworkAccessRestrictionsEnabled = 1 (so the allowlist is enforced)
// (The matching launch flag --disable-features=LocalNetworkAccessChecks is a
// belt-and-suspenders backup added in launchDrone.)
function applyLocalNetworkAccessPolicy(browserType) {
    const base = browserType === 'edge'
        ? 'HKCU\\Software\\Policies\\Microsoft\\Edge'
        : 'HKCU\\Software\\Policies\\Google\\Chrome';
    const allowlist = JSON.stringify(['*']).replace(/"/g, '\\"');
    const cmds = [
        `reg add "${base}" /v LocalNetworkAccessAllowedForUrls /t REG_SZ /d "${allowlist}" /f`,
        `reg add "${base}" /v LocalNetworkAccessRestrictionsEnabled /t REG_DWORD /d 1 /f`
    ];
    cmds.forEach(c => { try { exec(c, { shell: true }); } catch (e) {} });
}

// ==========================================
// BOOKING HISTORY (CSV)
// ==========================================
function appendHistory(row) {
    try {
        if (!fs.existsSync(HISTORY_FILE)) {
            fs.writeFileSync(HISTORY_FILE, 'Timestamp,Email,Modules,Status,Drone,Proxy\n');
        }
        const line = [
            new Date().toISOString(),
            (row.email || '').replace(/,/g, ' '),
            (row.modules || '').replace(/,/g, '|'),
            row.status || '',
            row.drone || '',
            (row.proxy || '').replace(/,/g, ' ')
        ].join(',') + '\n';
        fs.appendFileSync(HISTORY_FILE, line);
    } catch (e) { console.error('History write failed:', e.message); }
}

// ==========================================
// SSE DASHBOARD STREAM
// ==========================================
let dashboardClients = [];

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    dashboardClients.push(res);
    req.on('close', () => { dashboardClients = dashboardClients.filter(c => c !== res); });
});

function pushToDashboard(action, payload) {
    const data = JSON.stringify({ action, ...payload });
    dashboardClients.forEach(client => {
        client.write(`data: ${data}\n\n`);
    });
}

function sysLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
    pushToDashboard('log', { message, type });
}

// ==========================================
// SERVER-SIDE BOOKING-LINK HUNTER (direct IP)
// ==========================================
// Pull the server-rendered examButtonLink out of the exam page HTML.
function parseExamButtonLink(text) {
    if (!text) return "";
    const m = text.match(/examButtonLink['"]?\]?\s*=\s*["']([^"']*)["']/);
    return m ? m[1].trim() : "";
}

// Strip the params we inject (fleetDroneId, fleetSession, _cb) so the configured
// target URL never carries drone/session ids into the poller or a relaunch. Robust
// regardless of separator/order (defends against a previously-polluted saved URL).
function cleanExamUrl(raw) {
    if (!raw) return raw;
    try {
        const u = new URL(raw);
        ['fleetDroneId', 'fleetSession', '_cb'].forEach(p => u.searchParams.delete(p));
        return u.toString();
    } catch (e) {
        return String(raw).split(/[?&]fleetDroneId/)[0];
    }
}

// Poll the exam page from the server's DIRECT IP (no VPN/SOCKS) — faster and
// lower-latency than the drones' NordVPN proxies. The instant the booking link
// appears we store it in fleetState.examLink; every drone then picks it up from
// GET /api/exam-link and navigates. Self-stops once found or the fleet stops.
// If the server IP gets rate-limited it just backs off — the drones keep their
// own polling as a fallback, so the run is never blocked.
function startExamLinkPoller() {
    stopExamLinkPoller();
    examLinkRateBackoff = 0;
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
    const BURST_CALLS = 5;   // first 5 polls run at 1s, then ease to 2–3s
    let pollCount = 0;       // counts actual network polls (not holding ticks)
    let easedLogged = false;
    const tick = async () => {
        if (!fleetState.isRunning) return;     // fleet stopped
        if (fleetState.examLink) return;       // already have it (server or a drone)
        const url = cleanExamUrl(fleetState.config && fleetState.config.targetUrl);
        if (!url) { examLinkPollerTimer = setTimeout(tick, 1000); return; }
        // Hold until automation go-live (booking-open time) to avoid early hammering.
        if (fleetState.automationStartAt && Date.now() < fleetState.automationStartAt) {
            examLinkPollerTimer = setTimeout(tick, 1000);
            return;
        }
        pollCount++; // this is a real network poll
        const sep = url.includes('?') ? '&' : '?';
        const bust = `${url}${sep}_cb=${Date.now()}`;
        // Cadence: 1s for the first 5 calls, then ease to 2–3s. Rate-limit backoff overrides.
        let nextMs = pollCount < BURST_CALLS ? 1000 : (2000 + Math.floor(Math.random() * 1000));
        if (pollCount >= BURST_CALLS && !easedLogged) {
            easedLogged = true;
            sysLog("🛰️ Server link-hunter easing to 2–3s interval (first 5 calls done).", 'info');
        }
        const t0 = Date.now();
        let logMsg, logType = 'info';
        try {
            const r = await fetch(bust, { headers: {
                'User-Agent': UA,
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache, no-store, max-age=0',
                'Pragma': 'no-cache'
            }});
            const ms = Date.now() - t0;
            if (r.status === 429 || r.status === 503) {
                examLinkRateBackoff = Math.min(examLinkRateBackoff + 1, 6);
                nextMs = Math.min(30000, 2000 * Math.pow(2, examLinkRateBackoff - 1));
                logMsg = `🛰️ [Server poll #${pollCount}] direct IP → HTTP ${r.status} RATE-LIMITED (${ms}ms) — backing off ${Math.round(nextMs / 1000)}s (drones unaffected)`;
                logType = 'warn';
            } else if (r.ok) {
                examLinkRateBackoff = 0;
                const link = parseExamButtonLink(await r.text());
                if (link) {
                    fleetState.examLink = link;
                    sysLog(`🎯 SERVER (direct IP) GOT THE BOOKING LINK on poll #${pollCount} (${ms}ms) — pushing to all drones: ${link}`, 'success');
                    pushToDashboard('examLinkFound', { link, source: 'server' });
                    return; // self-stop: drones now pull it from /api/exam-link
                }
                logMsg = `🛰️ [Server poll #${pollCount}] direct IP → HTTP 200 (${ms}ms) — not open yet, next in ${Math.round(nextMs / 1000)}s`;
            } else {
                logMsg = `🛰️ [Server poll #${pollCount}] direct IP → HTTP ${r.status} (${ms}ms)`;
                logType = 'warn';
            }
        } catch (e) {
            logMsg = `🛰️ [Server poll #${pollCount}] direct IP → network error: ${e.message}`;
            logType = 'warn';
        }
        sysLog(logMsg, logType); // one log line PER server call, as requested
        examLinkPollerTimer = setTimeout(tick, nextMs);
    };
    sysLog("🛰️ Server link-hunter started (direct IP, 1s for first 5 calls → 2–3s) — racing the drones for the booking link.", 'info');
    // One-time: show which public IP the server is hunting from (your direct, no-VPN IP).
    (async () => {
        try {
            const ipr = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
            if (ipr.ok) sysLog(`🛰️ Server link-hunter direct IP: ${(await ipr.text()).trim()}`, 'info');
        } catch (e) {}
    })();
    examLinkPollerTimer = setTimeout(tick, 0);
}
function stopExamLinkPoller() {
    if (examLinkPollerTimer) { clearTimeout(examLinkPollerTimer); examLinkPollerTimer = null; }
}

// ==========================================
// PROXY MANAGEMENT
// ==========================================
function parseProxyList(rawText) {
    // Supports formats:
    // host:port
    // host:port:username:password
    // username:password@host:port
    // socks5://host:port
    // socks5://username:password@host:port
    const lines = rawText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const proxies = [];

    for (const line of lines) {
        let proxy = { host: '', port: '', username: '', password: '', protocol: 'http' };

        // Detect protocol prefix
        let cleanLine = line;
        if (line.startsWith('socks5://')) {
            proxy.protocol = 'socks5';
            cleanLine = line.replace('socks5://', '');
        } else if (line.startsWith('http://')) {
            proxy.protocol = 'http';
            cleanLine = line.replace('http://', '');
        } else if (line.startsWith('https://')) {
            proxy.protocol = 'https';
            cleanLine = line.replace('https://', '');
        }

        // Format: username:password@host:port
        if (cleanLine.includes('@')) {
            const [auth, server] = cleanLine.split('@');
            const [user, pass] = auth.split(':');
            const [host, port] = server.split(':');
            proxy.username = user;
            proxy.password = pass;
            proxy.host = host;
            proxy.port = port;
        }
        // Format: host:port:username:password
        else {
            const parts = cleanLine.split(':');
            if (parts.length === 4) {
                proxy.host = parts[0];
                proxy.port = parts[1];
                proxy.username = parts[2];
                proxy.password = parts[3];
            } else if (parts.length === 2) {
                proxy.host = parts[0];
                proxy.port = parts[1];
            } else {
                continue; // Skip invalid lines
            }
        }

        if (proxy.host && proxy.port) {
            proxy.id = `${proxy.host}:${proxy.port}`;
            proxy.burned = false;
            proxies.push(proxy);
        }
    }
    return proxies;
}

// Real NordVPN SOCKS5 servers (port 1080). As of 2025 NordVPN only offers
// SOCKS5 proxies in these three locations. Hostnames are the actual ones
// returned by the NordVPN API — the previous *.socks.nordhold.net pattern
// was invalid, which is why pages never loaded.
const NORDVPN_SOCKS_SERVERS = {
    nl: {
        name: 'Netherlands',
        hosts: [
            'socks-nl1.nordvpn.com', 'socks-nl2.nordvpn.com', 'socks-nl3.nordvpn.com',
            'socks-nl4.nordvpn.com', 'socks-nl5.nordvpn.com', 'socks-nl6.nordvpn.com',
            'socks-nl7.nordvpn.com', 'socks-nl8.nordvpn.com'
        ]
    },
    se: {
        name: 'Sweden',
        hosts: [
            'socks-se8.nordvpn.com', 'socks-se9.nordvpn.com', 'socks-se10.nordvpn.com',
            'socks-se11.nordvpn.com', 'socks-se12.nordvpn.com', 'socks-se13.nordvpn.com',
            'socks-se14.nordvpn.com', 'socks-se15.nordvpn.com', 'socks-se16.nordvpn.com',
            'socks-se17.nordvpn.com', 'socks-se18.nordvpn.com', 'socks-se19.nordvpn.com',
            'socks-se20.nordvpn.com', 'socks-se21.nordvpn.com', 'socks-se24.nordvpn.com'
        ]
    },
    us: {
        name: 'United States',
        hosts: [
            'socks-us28.nordvpn.com', 'socks-us29.nordvpn.com', 'socks-us30.nordvpn.com',
            'socks-us31.nordvpn.com', 'socks-us32.nordvpn.com', 'socks-us33.nordvpn.com',
            'socks-us34.nordvpn.com', 'socks-us35.nordvpn.com', 'socks-us36.nordvpn.com',
            'socks-us37.nordvpn.com', 'socks-us38.nordvpn.com', 'socks-us39.nordvpn.com',
            'socks-us40.nordvpn.com', 'socks-us41.nordvpn.com', 'socks-us42.nordvpn.com',
            'socks-us43.nordvpn.com', 'socks-us45.nordvpn.com', 'socks-us46.nordvpn.com',
            'socks-us47.nordvpn.com', 'socks-us48.nordvpn.com', 'socks-us49.nordvpn.com',
            'socks-us50.nordvpn.com', 'socks-us51.nordvpn.com', 'socks-us52.nordvpn.com',
            'socks-us53.nordvpn.com', 'socks-us55.nordvpn.com', 'socks-us56.nordvpn.com',
            'socks-us57.nordvpn.com', 'socks-us58.nordvpn.com', 'socks-us59.nordvpn.com',
            'socks-us60.nordvpn.com', 'socks-us61.nordvpn.com', 'socks-us62.nordvpn.com',
            'socks-us63.nordvpn.com', 'socks-us64.nordvpn.com', 'socks-us65.nordvpn.com',
            'socks-us66.nordvpn.com', 'socks-us67.nordvpn.com', 'socks-us68.nordvpn.com',
            'socks-us69.nordvpn.com', 'socks-us70.nordvpn.com', 'socks-us71.nordvpn.com',
            'socks-us72.nordvpn.com', 'socks-us73.nordvpn.com', 'socks-us74.nordvpn.com'
        ]
    }
};

function generateNordVPNProxies(username, password, countries) {
    const proxies = [];

    // If no valid country selected, default to all available
    let selected = (countries || []).filter(cc => NORDVPN_SOCKS_SERVERS[cc]);
    if (selected.length === 0) selected = Object.keys(NORDVPN_SOCKS_SERVERS);

    for (const cc of selected) {
        const info = NORDVPN_SOCKS_SERVERS[cc];
        for (const host of info.hosts) {
            proxies.push({
                id: `${host}:1080`,
                host: host,
                port: '1080',
                username: username,
                password: password,
                protocol: 'socks5',
                burned: false,
                country: info.name
            });
        }
    }

    // Shuffle to randomize which servers get used first
    for (let i = proxies.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [proxies[i], proxies[j]] = [proxies[j], proxies[i]];
    }

    return proxies;
}

// TCP-connect latency to one server (no SOCKS handshake needed). The RTT from
// here to the SOCKS server is the dominant per-request overhead, so lower = a
// faster site load. Returns ms, or Infinity if unreachable/timed out.
function probeLatency(host, port, timeoutMs = 4000) {
    return new Promise(resolve => {
        const t0 = Date.now();
        const sock = new net.Socket();
        let done = false;
        const finish = (ms) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(ms); };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(Date.now() - t0));
        sock.once('timeout', () => finish(Infinity));
        sock.once('error', () => finish(Infinity));
        try { sock.connect(parseInt(port), host); } catch (e) { finish(Infinity); }
    });
}

// Measure every proxy in the pool (parallel), sort fastest-first, and mark
// unreachable servers burned so getNextProxy skips them. Run at ignite so each
// drone is handed the fastest non-burned server of its provider.
async function rankProxyPoolByLatency() {
    const pool = fleetState.proxyPool;
    if (!pool.length) return;
    sysLog(`📶 Probing ${pool.length} proxy server(s) to pick the fastest…`, 'info');
    await Promise.all(pool.map(async p => {
        p.latency = await probeLatency(p.host, p.port);
        if (p.latency === Infinity) p.burned = true; // unreachable now → skip (still usable on later exhaustion reset)
    }));
    // Ascending latency → getNextProxy (which takes the first available) hands out
    // the fastest server of each provider first.
    pool.sort((a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity));
    fleetState.burnedProxies = pool.filter(p => p.burned).map(p => p.id);
    const reachable = pool.filter(p => p.latency !== Infinity);
    const fastest = reachable.slice(0, 3).map(p => `${p.host} ${Math.round(p.latency)}ms`).join(', ');
    sysLog(`📶 ${reachable.length}/${pool.length} servers reachable. Fastest: ${fastest || '(none!)'}`, reachable.length ? 'success' : 'error');
    broadcastProxyStats();
}

// Per-drone network assignment. A drone keeps its assigned network TYPE for its
// whole life (rotation picks another proxy of the SAME provider, never crosses
// networks). 'direct' drones use the ISP connection (no proxy).
function getNextProxy(droneId) {
    const networkType = fleetState.droneNetwork[droneId] || legacyNetworkType();
    if (networkType === 'direct') return null;

    // Pool restricted to THIS drone's provider — isolates one network from another.
    const providerPool = fleetState.proxyPool.filter(p => p.provider === networkType);
    if (providerPool.length === 0) return null;

    // Find an unburned proxy of this provider not currently used by another drone.
    const inUseProxies = new Set();
    for (const [id, drone] of Object.entries(fleetState.activeDrones)) {
        if (id !== String(droneId) && drone.proxy) inUseProxies.add(drone.proxy.id);
    }

    const byLatency = (a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity);
    const available = providerPool.filter(p => !p.burned && !inUseProxies.has(p.id)).sort(byLatency);
    if (available.length === 0) {
        // This provider's proxies are all burned/in-use — reset THIS provider's
        // burned flags (leave other providers untouched) and retry with the fastest.
        // EXCEPTION: never un-burn a permanently-banned IP (Goethe blocked it for
        // the whole run) or an unreachable one (latency === Infinity).
        sysLog(`⚠️ ${networkType} proxies exhausted! Resetting burned ${networkType} proxies...`, "warn");
        providerPool.forEach(p => { if (!p.permanentlyBanned && p.latency !== Infinity) p.burned = false; });
        fleetState.burnedProxies = fleetState.proxyPool.filter(p => p.burned).map(p => p.id);
        const retry = providerPool.filter(p => !p.burned && !inUseProxies.has(p.id)).sort(byLatency);
        return retry.length > 0 ? retry[0] : null;
    }
    return available[0]; // fastest unburned, not-in-use server of this provider
}

// Legacy fallback: when no per-drone plan exists, derive the type from proxyMode.
function legacyNetworkType() {
    if (fleetState.proxyMode === 'custom') return 'custom';
    if (fleetState.proxyMode === 'nordvpn') return 'nordvpn';
    return 'direct';
}

// Human-readable network label for a drone (logs + dashboard).
function networkLabel(droneId) {
    const t = fleetState.droneNetwork[droneId] || legacyNetworkType();
    if (t === 'direct') return 'Direct ISP';
    if (t === 'nordvpn') return 'NordVPN';
    if (t === 'custom') return 'Custom proxy';
    return t;
}

// Build the per-drone network plan + tagged proxy pool from body.networks
// (array of { type, count, nordvpn?, proxyList? }). Falls back to the legacy
// single-mode (proxyMode + maxBrowsers) when body.networks is absent.
// Returns the total number of drones to launch.
function buildNetworkPlan(body) {
    fleetState.proxyPool = [];
    fleetState.droneNetwork = {};
    fleetState.burnedProxies = [];

    let sources = Array.isArray(body.networks) ? body.networks.filter(s => s && s.type && (parseInt(s.count) || 0) > 0) : null;

    // Legacy fallback: one source from proxyMode spanning maxBrowsers drones.
    if (!sources || sources.length === 0) {
        const max = parseInt(body.config && body.config.maxBrowsers) || 1;
        const mode = body.proxyMode || 'none';
        sources = [{
            type: mode === 'none' ? 'direct' : mode,
            count: max,
            nordvpn: body.nordvpn,
            proxyList: body.proxyList
        }];
    }

    let droneId = 1;
    const summary = [];
    for (const src of sources) {
        const count = parseInt(src.count) || 0;
        for (let k = 0; k < count; k++) { fleetState.droneNetwork[droneId] = src.type; droneId++; }

        if (src.type === 'nordvpn' && src.nordvpn) {
            const ps = generateNordVPNProxies(src.nordvpn.username, src.nordvpn.password, src.nordvpn.countries || ['nl', 'se', 'us'])
                .map(p => ({ ...p, provider: 'nordvpn' }));
            fleetState.proxyPool.push(...ps);
        } else if (src.type === 'custom' && src.proxyList) {
            const ps = parseProxyList(src.proxyList).map(p => ({ ...p, provider: 'custom' }));
            fleetState.proxyPool.push(...ps);
        }
        summary.push(`${count}× ${src.type}`);
    }

    // Apply the PERSISTENT ban list — exclude IPs Goethe permanently blocked in a
    // previous run (stays excluded until the user clears them from the dashboard).
    const banned = new Set(loadBannedList().map(b => b.id));
    let bannedHit = 0;
    fleetState.proxyPool.forEach(p => {
        if (banned.has(p.id)) { p.burned = true; p.permanentlyBanned = true; bannedHit++; }
    });
    fleetState.burnedProxies = fleetState.proxyPool.filter(p => p.burned).map(p => p.id);

    const total = droneId - 1;
    fleetState.proxyMode = sources.length > 1 ? 'mixed' : (sources[0] ? (sources[0].type === 'direct' ? 'none' : sources[0].type) : 'none');
    sysLog(`🧭 Network plan: ${summary.join('  ·  ')}  →  ${total} drone(s), ${fleetState.proxyPool.length} proxies in pool${bannedHit ? ` (${bannedHit} excluded by persistent ban list)` : ''}`, 'info');
    return total;
}

function burnProxy(proxy) {
    if (!proxy) return;
    const found = fleetState.proxyPool.find(p => p.id === proxy.id);
    if (found) {
        found.burned = true;
        fleetState.burnedProxies.push(found.id);
        sysLog(`🔥 Proxy burned: ${proxy.id} (${fleetState.burnedProxies.length}/${fleetState.proxyPool.length} burned)`, 'warn');
    }
    broadcastProxyStats();
}

function broadcastProxyStats() {
    if (fleetState.proxyPool.length === 0) return; // nothing to report when all-direct
    pushToDashboard('proxyStats', {
        proxyStats: {
            total: fleetState.proxyPool.length,
            burned: fleetState.proxyPool.filter(p => p.burned).length,
            available: fleetState.proxyPool.filter(p => !p.burned).length
        }
    });
}

// ==========================================
// DRONE MANAGEMENT
// ==========================================
function buildProxyArg(proxy) {
    if (!proxy) return [];
    // Chrome accepts: --proxy-server="socks5://host:port" or --proxy-server="http://host:port"
    const proxyUrl = `${proxy.protocol}://${proxy.host}:${proxy.port}`;
    // Bypass the proxy for loopback so the drone's localhost API calls go DIRECT
    // (instant), while goethe traffic still goes through the proxy. NOTE: we must
    // NOT use the "<-loopback>" token — that SUBTRACTS the implicit loopback
    // bypass (i.e. forces localhost THROUGH the proxy), which is what caused the
    // 5–7s stall on the options page. Listing the loopback hosts bypasses them.
    return [
        `--proxy-server="${proxyUrl}"`,
        `--proxy-bypass-list="localhost;127.0.0.1"`
    ];
}

function assassinateDrone(droneId) {
    proxyRelay.stopRelay(droneId);
    const exeName = droneExeName();
    // The unique profile name still starts with this prefix, so the match works.
    const profileStr = `TempProfile_Drone_${droneId}__`;
    // Capture the profile path NOW (the drone entry may be deleted right after this call).
    const drone = fleetState.activeDrones[droneId];
    const profilePath = drone && drone.profilePath;
    const killCmd = `wmic process where "name='${exeName}' and commandline like '%${profileStr}%'" call terminate`;
    exec(killCmd, { shell: true }, (err) => {
        if (err && !err.message.includes('No Instance')) {
            // Fallback: try taskkill with window title matching
            exec(`taskkill /F /FI "WINDOWTITLE eq *Drone_${droneId}*"`, { shell: true });
        }
        // After the browser dies, delete this drone's unique profile folder
        if (profilePath) {
            setTimeout(() => {
                try {
                    if (fs.existsSync(profilePath)) fs.rmSync(profilePath, { recursive: true, force: true, maxRetries: 3 });
                } catch (e) { }
            }, 3000);
        }
    });
}

// Remove ALL leftover unique profile folders (used on stop / shutdown).
// Browsers may still be releasing file locks when this runs, so we retry
// a few times with a delay for any folders that resist deletion.
function purgeAllProfiles(attempt = 0) {
    let stubborn = [];
    try {
        const entries = fs.readdirSync(__dirname);
        for (const name of entries) {
            if (name.startsWith('TempProfile_Drone_')) {
                const full = path.join(__dirname, name);
                try {
                    fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 });
                } catch (e) {
                    if (fs.existsSync(full)) stubborn.push(full);
                }
            }
        }
    } catch (e) { }

    // Retry stubborn folders (locked by a browser still closing) up to 5 times
    if (stubborn.length > 0 && attempt < 5) {
        setTimeout(() => purgeAllProfiles(attempt + 1), 3000);
    }
}

// Resolve the browser executable to launch.
// A custom path (e.g. Chrome for Testing) wins; otherwise we look in the
// standard install locations. Spawning the exe directly is more reliable
// than `start chrome`, which can hand the URL to an already-running window
// that ignores our --load-extension flag.
// Auto-detect the CloakBrowser Chromium binary cached by `pip install
// cloakbrowser`. It lives under %USERPROFILE%\.cloakbrowser\chromium-*\.
// Also honors the CLOAKBROWSER_BINARY_PATH env var.
function findCloakBinary() {
    // 1) Explicit env override
    const envPath = process.env['CLOAKBROWSER_BINARY_PATH'];
    if (envPath && fs.existsSync(envPath)) return envPath;

    // 2) Default cache dir
    const home = process.env['USERPROFILE'] || process.env['HOME'] || '';
    const cacheDirs = [
        path.join(home, '.cloakbrowser'),
        process.env['CLOAKBROWSER_CACHE_DIR'] || ''
    ].filter(Boolean);

    const exeNames = ['chrome.exe', 'chromium.exe', 'Chromium.exe'];
    for (const dir of cacheDirs) {
        try {
            if (!fs.existsSync(dir)) continue;
            // Look one or two levels deep for the exe
            const stack = [dir];
            let depth = 0;
            while (stack.length && depth < 5000) {
                depth++;
                const cur = stack.pop();
                let entries = [];
                try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
                for (const ent of entries) {
                    const full = path.join(cur, ent.name);
                    if (ent.isFile() && exeNames.includes(ent.name)) return full;
                    if (ent.isDirectory()) stack.push(full);
                }
            }
        } catch (e) { }
    }
    return null;
}

function resolveBrowserExe() {
    const custom = (fleetState.config.customBrowserPath || '').trim();
    // CloakBrowser engine: use the custom path if given, else auto-detect the
    // binary that `pip install cloakbrowser` cached under ~/.cloakbrowser.
    if (fleetState.config.browserType === 'cloak') {
        if (custom && fs.existsSync(custom)) return custom;
        const auto = findCloakBinary();
        if (auto) { sysLog(`🥷 Auto-detected CloakBrowser at: ${auto}`, 'info'); return auto; }
        sysLog(`❌ CloakBrowser selected but binary not found. Install it (pip install cloakbrowser && python -m cloakbrowser install) or paste its chrome.exe path in the dashboard.`, 'error');
        return null;
    }
    // A custom path only applies to the Chrome engine (e.g. Chrome for Testing).
    // Edge always uses the installed msedge.exe; cloak is handled above. Without
    // this guard, a leftover Cloak/Chrome path would hijack an Edge launch.
    if (custom && fleetState.config.browserType === 'chrome') {
        if (fs.existsSync(custom)) return custom;
        sysLog(`⚠️ Custom browser path not found: ${custom}. Falling back to installed browser.`, 'warn');
    }

    const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
    const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const LOCAL = process.env['LOCALAPPDATA'] || '';

    const candidates = fleetState.config.browserType === 'edge'
        ? [
            path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        ]
        : [
            path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            LOCAL ? path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
        ];

    for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
    }
    return null;
}

// Small deterministic string hash (for per-drone fingerprint seeds)
function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
    return h;
}

// The process name to kill for the current engine (cloak/chrome = chrome.exe).
function droneExeName() {
    return fleetState.config.browserType === 'edge' ? 'msedge.exe' : 'chrome.exe';
}

// Write a Preferences file into the fresh profile so the browser UI is English
// and pages are auto-translated to English (no manual "Translate" prompt).
function seedProfilePreferences(profilePath, droneId, sessionId) {
    try {
        const defaultDir = path.join(profilePath, 'Default');
        fs.ensureDirSync(defaultDir);
        const prefs = {
            intl: {
                accept_languages: 'en-US,en',
                selected_languages: 'en-US,en'
            },
            translate: { enabled: true },
            // Auto-translate ANY non-English page to English without prompting
            translate_allowlists: { de: 'en', fr: 'en', und: 'en' },
            translate_site_blacklist: [],
            translate_recent_target: 'en',
            browser: { has_seen_welcome_page: true },
            credentials_enable_service: false,
            profile: {
                name: `Drone ${droneId}`,
                exit_type: 'Normal',
                exited_cleanly: true,
                password_manager_enabled: false,
                default_content_setting_values: {}
            }
        };
        fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify(prefs));

        const localState = {
            intl: { accept_languages: 'en-US,en', app_locale: 'en-US' },
            profile: {
                info_cache: {
                    Default: { name: `Drone ${droneId}`, is_using_default_name: false }
                }
            }
        };
        fs.writeFileSync(path.join(profilePath, 'Local State'), JSON.stringify(localState));
    } catch (e) {
        sysLog(`⚠️ Could not seed profile preferences: ${e.message}`, 'warn');
    }
}

async function launchDrone(droneId) {
    if (!fleetState.isRunning) return;

    // UNIQUE profile + session per launch. Every browser gets its own fresh
    // profile folder (no shared cookies/cache/localStorage), and a respawned
    // drone also gets a brand-new one. This guarantees each window presents a
    // completely separate session to the Goethe site.
    const sessionId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const profileName = `TempProfile_Drone_${droneId}__${sessionId}`;
    const tempProfilePath = path.resolve(__dirname, profileName);

    try {
        // Path is unique, but clean defensively just in case
        if (fs.existsSync(tempProfilePath)) {
            try { fs.rmSync(tempProfilePath, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { }
        }

        // Copy seed profile or create empty
        if (fs.existsSync(SEED_PROFILE_PATH)) {
            await fs.copy(SEED_PROFILE_PATH, tempProfilePath);
        } else {
            fs.ensureDirSync(tempProfilePath);
        }

        // Seed the profile so the site is forced to English and auto-translated,
        // and so the locale matches. Written into the Default profile's Preferences.
        seedProfilePreferences(tempProfilePath, droneId, sessionId);

        // Get a WORKING proxy for this drone and start a local relay.
        // Chrome cannot authenticate SOCKS5 (NordVPN) or pass proxy passwords
        // via --proxy-server, so we route through a local password-free relay
        // that forwards to the real upstream proxy (auth handled in Node).
        const networkType = fleetState.droneNetwork[droneId] || legacyNetworkType();
        let proxy = null;
        let proxyArgs = [];
        if (networkType !== 'direct' && !proxyRelay.isAvailable()) {
            // No relay library — fall back to a plain --proxy-server (no SOCKS auth,
            // no health-check). Keeps the original behaviour for that environment.
            const cand = getNextProxy(droneId);
            if (cand) { proxy = cand; proxyArgs = buildProxyArg(cand); }
        } else if (networkType !== 'direct') {
            // VALIDATE the tunnel before committing: pick a server → start relay →
            // health-check it. If the upstream tunnel is dead (server down, or
            // NordVPN's concurrent-connection limit hit during a rotation storm),
            // burn it and try the next fastest. This stops a drone from launching
            // onto a broken proxy (the ERR_TUNNEL_CONNECTION_FAILED / Upstream Error).
            const MAX_ATTEMPTS = 4;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                const cand = getNextProxy(droneId);
                if (!cand) break; // none available right now
                let relayPort = null;
                try {
                    relayPort = await proxyRelay.startRelay(droneId, cand, (msg) => {
                        sysLog(`⚠️ Drone ${droneId} proxy error: ${msg}`, 'warn');
                    });
                } catch (e) { relayPort = null; }

                const ok = relayPort ? await proxyRelay.testRelay(relayPort) : false;
                if (ok) {
                    proxy = cand;
                    proxyArgs = [
                        `--proxy-server="http://127.0.0.1:${relayPort}"`,
                        // Bypass loopback so localhost API calls go DIRECT (instant).
                        `--proxy-bypass-list="localhost;127.0.0.1"`
                    ];
                    break;
                }
                // Dead tunnel → burn this server (temporary, not a permanent ban) and try the next.
                sysLog(`⚠️ Drone ${droneId}: ${cand.host} tunnel failed health-check — skipping to next server (${attempt}/${MAX_ATTEMPTS}).`, 'warn');
                burnProxy(cand);
                await proxyRelay.stopRelay(droneId);
            }

            if (!proxy) {
                // No working server right now (all dead / NordVPN connection limit).
                // Back off and retry instead of launching a broken or direct browser
                // (a direct launch would leak the real IP for a proxied drone).
                sysLog(`⏳ Drone ${droneId}: no working ${networkType} server available right now — retrying in 15s (lets connections free up).`, 'error');
                pushToDashboard('droneUpdate', { droneId, status: '⏳ No working proxy — retrying…', network: networkLabel(droneId), proxy: 'Rotating...', user: null });
                if (fleetState.isRunning) setTimeout(() => { if (fleetState.isRunning && !fleetState.activeDrones[droneId]) launchDrone(droneId); }, 15000);
                return;
            }
        }

        // Build target URL with drone ID + unique session id (from a CLEAN base).
        const cleanTarget = cleanExamUrl(fleetState.config.targetUrl);
        const separator = cleanTarget.includes('?') ? '&' : '?';
        const targetUrlWithId = `${cleanTarget}${separator}fleetDroneId=${droneId}&fleetSession=${sessionId}`;

        const browserExe = resolveBrowserExe();
        if (!browserExe) {
            const name = fleetState.config.browserType === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
            sysLog(`❌ Could not find ${name}. Install it or set a custom browser path.`, 'error');
            return;
        }

        // Warn if using real Chrome 137+, which can no longer load extensions via CLI.
        if (fleetState.config.browserType === 'chrome' && !fleetState.config.customBrowserPath) {
            const verMatch = (() => {
                try { return require('child_process').execSync(`wmic datafile where name="${browserExe.replace(/\\/g, '\\\\')}" get version /value`, { timeout: 4000 }).toString().match(/Version=(\d+)/); }
                catch (e) { return null; }
            })();
            const major = verMatch ? parseInt(verMatch[1]) : 0;
            if (major >= 137) {
                sysLog(`⚠️ Chrome v${major} cannot auto-load extensions (Google removed this in v137+). The bot will NOT run. Use Edge, or download "Chrome for Testing" and set its path.`, 'error');
            }
        }

        // CloakBrowser (Option B): pass a unique fingerprint seed per drone so
        // each window gets a genuinely different, consistent fingerprint at the
        // Chromium source level (canvas, WebGL/GPU, audio, fonts, screen, hw).
        // The seed is derived from the drone's session id, so it's unique per
        // drone but stable across that drone's relaunches. Other engines ignore
        // these flags harmlessly.
        const cloakArgs = [];
        if (fleetState.config.browserType === 'cloak') {
            // Seed range 10000-99999 matches CloakBrowser's own default range.
            const seed = 10000 + (Math.abs(hashString(sessionId)) % 90000);
            cloakArgs.push(`--fingerprint=${seed}`);
            cloakArgs.push(`--fingerprint-platform=windows`);
            sysLog(`🥷 Drone ${droneId} CloakBrowser fingerprint seed: ${seed}`, 'info');
        }

        // Args passed directly to the exe (no shell quoting needed).
        const browserArgs = [
            `--user-data-dir=${tempProfilePath}`,
            `--load-extension=${EXTENSION_PATH}`,
            `--disable-extensions-except=${EXTENSION_PATH}`,
            // Chrome 137-141 workaround (removed in 142+, harmless on Edge).
            // LocalNetworkAccessChecks: backup for the v142+ "access other apps
            // and services on this device" prompt our localhost calls trigger.
            `--disable-features=DisableLoadExtensionCommandLineSwitch,msImplicitSignin,msEdgeImplicitSignin,msEdgeIdentityFlows,EdgeOpenWithSignIn,AutofillEnableAccountWalletStorage,msEdgeWelcomePage,LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets`,
            // Stop the browser from auto signing-in to a Microsoft/Google
            // account and syncing — this is why every window showed the same
            // logged-in user. These force a clean, anonymous profile.
            `--disable-sync`,
            `--disable-signin-promo`,
            `--disable-signin-scoped-device-id`,
            `--no-service-autorun`,
            `--disable-account-consistency`,
            `--auth-server-allowlist=_`,
            // Force English UI + page translation to English
            `--lang=en-US`,
            `--accept-lang=en-US,en`,
            `--no-first-run`,
            `--no-default-browser-check`,
            `--disable-infobars`,
            `--disable-default-apps`,
            `--disable-popup-blocking`,
            // Suppress the "Turn off extensions in developer mode" warning dialog.
            `--test-type`,
            `--disable-extensions-file-access-check`,
            `--silent-debugger-extension-api`,
            ...cloakArgs,
            `--new-window`,
            ...proxyArgs.map(a => a.replace(/^(--[^=]+)="(.*)"$/, '$1=$2')),
            targetUrlWithId
        ];

        const child = spawn(browserExe, browserArgs, { detached: true, stdio: 'ignore' });
        child.on('error', (err) => {
            sysLog(`❌ Drone ${droneId} failed to launch: ${err.message}`, 'error');
        });
        child.unref();

        // Track drone state
        fleetState.activeDrones[droneId] = {
            assignedUserIndex: null,
            proxy: proxy,
            profilePath: tempProfilePath,
            sessionId: sessionId,
            launchedAt: Date.now(),
            status: 'launched'
        };

        const net = networkLabel(droneId);
        const proxyInfo = proxy ? ` via ${net} — ${proxy.protocol}://${proxy.host}:${proxy.port}${proxy.country ? ` (${proxy.country})` : ''}` : ` via ${net}`;
        sysLog(`🛸 Drone ${droneId} → ${net}${proxy ? `: ${proxy.host}:${proxy.port}${proxy.country ? ` (${proxy.country})` : ''}` : ''}`, 'success');
        pushToDashboard('droneUpdate', {
            droneId,
            status: '🟢 Launched',
            network: net,
            proxy: proxy ? `${proxy.host}:${proxy.port}` : 'Direct',
            user: null
        });

    } catch (err) {
        sysLog(`❌ Error launching Drone ${droneId}: ${err.message}`, 'error');
    }
}

// Bring one drone's window to the front and minimize the others (OS-level).
// ==========================================
// WINDOW DAEMON (persistent PowerShell for instant focus/minimize)
// Started once; commands piped to stdin so there's no per-call startup lag.
// ==========================================
let windowDaemon = null;
function startWindowDaemon() {
    try {
        const scriptPath = path.join(__dirname, 'windowDaemon.ps1');
        windowDaemon = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { shell: false });
        windowDaemon.on('error', () => { windowDaemon = null; });
        windowDaemon.on('exit', () => { windowDaemon = null; });
        windowDaemon.stdout && windowDaemon.stdout.on('data', () => {}); // drain
    } catch (e) { windowDaemon = null; }
}
function daemonSend(cmd) {
    if (!windowDaemon || !windowDaemon.stdin.writable) {
        startWindowDaemon();
        // tiny delay for the daemon to be ready, then send
        setTimeout(() => { try { windowDaemon && windowDaemon.stdin.write(cmd + '\n'); } catch (e) {} }, 1500);
        return;
    }
    try { windowDaemon.stdin.write(cmd + '\n'); } catch (e) {}
}

// ==========================================
// KEEP-AWAKE (prevent PC sleep / screen-lock while the swarm runs)
// A small PowerShell guard holds Windows' execution-state flag. Killing it (on
// stop or server exit) auto-restores the user's normal sleep behaviour — no
// global power settings are touched.
// ==========================================
let keepAwakeProc = null;
function preventSleep() {
    if (keepAwakeProc) return; // already on
    try {
        const scriptPath = path.join(__dirname, 'keepAwake.ps1');
        keepAwakeProc = spawn('powershell',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ParentPid', String(process.pid)],
            { shell: false, stdio: 'ignore' });
        keepAwakeProc.on('error', () => { keepAwakeProc = null; });
        keepAwakeProc.on('exit', () => { keepAwakeProc = null; });
        sysLog('☕ Keep-awake ON — PC won’t sleep or lock while the swarm runs.', 'info');
    } catch (e) { keepAwakeProc = null; }
}
function allowSleep() {
    if (!keepAwakeProc) return;
    try { keepAwakeProc.kill(); } catch (e) {}
    keepAwakeProc = null;
    sysLog('💤 Keep-awake OFF — normal sleep/lock behaviour restored.', 'info');
}

// Bring one drone's window to the front and minimize the others (instant).
function focusDroneWindows(focusId) {
    const exeName = droneExeName();
    daemonSend(`FOCUS ${exeName} ${focusId}`);
}

function checkFleetComplete() {
    const allDone = fleetState.users.length > 0 && fleetState.users.every(u => u.status === 'Complete' || u.status === 'Failed');
    if (allDone) {
        sysLog("🏆 ALL USERS PROCESSED! Fleet mission complete.", "success");
        pushToDashboard('fleetFinished', {});
        fleetState.isRunning = false;
        stopHeartbeat();
    }
}

// ==========================================
// DRONE HEALTH / HEARTBEAT
// Flags a drone as "stuck" if its page/status hasn't changed for N minutes,
// then restarts it automatically.
// ==========================================
const STUCK_LIMIT_MS = 4 * 60 * 1000; // 4 minutes with no change = stuck

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (!fleetState.isRunning) return;
        const now = Date.now();
        for (const [id, drone] of Object.entries(fleetState.activeDrones)) {
            // Don't disturb a drone waiting on a human (OTP / payment)
            if (drone.page === 'payment') continue;
            const last = drone.lastChangeAt || drone.launchedAt || now;
            if (now - last > STUCK_LIMIT_MS) {
                sysLog(`🩺 Drone ${id} looks stuck (no change for ${Math.round((now-last)/60000)} min). Restarting...`, 'warn');
                pushToDashboard('droneUpdate', { droneId: id, status: '🩺 Stuck — restarting', proxy: drone.proxy ? `${drone.proxy.host}:${drone.proxy.port}` : 'Direct', user: null });
                const wasUser = drone.assignedUserIndex;
                if (wasUser !== null && wasUser !== undefined && fleetState.users[wasUser] && fleetState.users[wasUser].status.startsWith('Running')) {
                    fleetState.users[wasUser].status = 'Queued';
                    pushToDashboard('updateUser', { index: wasUser, status: '⏳ Queued', color: '#334155' });
                }
                assassinateDrone(id);
                delete fleetState.activeDrones[id];
                setTimeout(() => { if (fleetState.isRunning) launchDrone(id); }, 4000);
            }
        }
    }, 30000); // check every 30s
}
function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ==========================================
// API ROUTES
// ==========================================

// Core swarm-launch routine (shared by /api/start and the scheduler)
async function igniteSwarm(body) {
    fleetState.isRunning = true;
    fleetState.config = body.config;
    // Defensive: ensure the configured target URL never carries injected params
    // (fleetDroneId/fleetSession/_cb) — keeps the poller + every drone on the
    // correct page even if a polluted URL was saved from an earlier build.
    if (fleetState.config) fleetState.config.targetUrl = cleanExamUrl(fleetState.config.targetUrl);
    fleetState.users = body.users.map(u => ({ ...u, status: 'Queued' }));
    autoRetryFailed = !!(body.config && body.config.autoRetry);

    // Build the per-drone network plan (counts per source) + tagged proxy pool.
    // Backward compatible: falls back to legacy single proxyMode if no networks.
    const planned = buildNetworkPlan(body);

    // Two-phase launch: browsers open NOW (warm up + sit on the landing page),
    // but the drones don't start clicking/booking until automationStartAt.
    // null/past time = act immediately (original behaviour).
    const autoAt = body.automationStartAt ? new Date(body.automationStartAt).getTime() : null;
    fleetState.automationStartAt = (autoAt && autoAt > Date.now()) ? autoAt : null;
    if (fleetState.automationStartAt) {
        const secs = Math.round((fleetState.automationStartAt - Date.now()) / 1000);
        sysLog(`⏳ Drones will warm up and HOLD; automation starts at ${new Date(fleetState.automationStartAt).toLocaleString()} (in ~${secs}s).`, 'info');
        setTimeout(() => {
            if (fleetState.isRunning) {
                sysLog('🚦 GO! Automation start time reached — drones are now booking.', 'success');
                pushToDashboard('automationLive', { startAt: fleetState.automationStartAt });
            }
        }, fleetState.automationStartAt - Date.now());
    }

    // Block Microsoft/Google auto sign-in + sync for this browser type
    applySignInBlockPolicy(fleetState.config.browserType || 'edge');
    // Stop the "wants to access other apps and services" Local Network Access
    // prompt (v142+) from stalling the flow when the content script calls localhost.
    applyLocalNetworkAccessPolicy(fleetState.config.browserType || 'edge');

    sysLog("🔥 SWARM IGNITION ACTIVATED", "warn");
    preventSleep(); // keep the PC awake for the whole run
    broadcastProxyStats();
    startHeartbeat();
    fleetState.examLink = "";   // clear any stale link from a previous run
    startExamLinkPoller();      // server's fast direct-IP hunt for the booking link

    // Rank proxy servers fastest-first (and drop unreachable) BEFORE launching, so
    // every drone is handed the fastest non-burned server of its provider.
    await rankProxyPoolByLatency();

    const maxBrowsers = planned > 0 ? planned : (parseInt(fleetState.config.maxBrowsers) || 2);
    fleetState.droneCount = maxBrowsers; // single source of truth for how many drones exist
    for (let i = 1; i <= maxBrowsers; i++) {
        await launchDrone(i);
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return { drones: maxBrowsers, proxies: fleetState.proxyPool.length };
}

// --- START FLEET ---
app.post('/api/start', async (req, res) => {
    if (fleetState.isRunning) return res.status(400).json({ error: "Fleet already running" });
    const result = await igniteSwarm(req.body);
    res.json({ status: "success", ...result });
});

// --- EXAM LINK (drones pull the booking link found by the server's direct-IP
// hunter; "" until found). This is the fast path: the server usually beats the
// VPN-proxied drones to the link and hands it to all of them at once. ---
app.get('/api/exam-link', (req, res) => {
    res.json({ link: fleetState.examLink || "" });
});

// --- FOUND LINK (a drone got the booking link first and shares it with the
// fleet). First valid link wins; we store it, stop the server's own hunt, and
// every other drone picks it up from /api/exam-link. ---
app.post('/api/found-link', (req, res) => {
    const { droneId, link, via } = req.body || {};
    if (link && !fleetState.examLink && /^https?:\/\//.test(link)) {
        fleetState.examLink = link;
        stopExamLinkPoller(); // we have it — stop hammering Goethe from the server too
        sysLog(`🎯 Drone ${droneId} got the booking link first (${via || 'fetch'}) — sharing to all drones: ${link}`, 'success');
        pushToDashboard('examLinkFound', { link, source: `drone ${droneId}` });
    }
    res.json({ status: "ok", link: fleetState.examLink || "" });
});

// --- GO STATUS (extension polls this to know if it may start booking yet) ---
// Fail-open by design: if automationStartAt is unset, drones act immediately.
app.get('/api/go-status', (req, res) => {
    const startAt = fleetState.automationStartAt || null;
    const live = !startAt || Date.now() >= startAt;
    res.json({
        live,
        startAt,
        startLabel: startAt ? new Date(startAt).toLocaleTimeString() : null
    });
});

// --- SCHEDULED START (arm the swarm to launch at a specific time) ---
app.post('/api/schedule-start', (req, res) => {
    const { startAt } = req.body; // ISO timestamp or ms-from-now
    if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }
    if (!startAt) { sysLog('⏰ Scheduled start cleared.', 'info'); return res.json({ status: 'cleared' }); }

    const target = new Date(startAt).getTime();
    const delay = target - Date.now();
    if (isNaN(target) || delay <= 0) return res.status(400).json({ error: 'Start time must be in the future' });

    const pending = req.body; // contains config/users/proxy
    scheduledTimer = setTimeout(async () => {
        scheduledTimer = null;
        if (fleetState.isRunning) { sysLog('⏰ Scheduled time hit but fleet already running.', 'warn'); return; }
        sysLog('⏰ Scheduled time reached — igniting swarm!', 'success');
        await igniteSwarm(pending);
    }, delay);

    const mins = Math.round(delay / 60000);
    sysLog(`⏰ Swarm scheduled to launch at ${new Date(target).toLocaleString()} (in ~${mins} min).`, 'info');
    pushToDashboard('scheduled', { startAt: target });
    res.json({ status: 'scheduled', startAt: target });
});

// --- STOP FLEET ---
app.post('/api/stop', (req, res) => {
    sysLog("🚨 EMERGENCY KILL SWITCH ENGAGED! Destroying swarm...", "error");
    fleetState.isRunning = false;
    fleetState.automationStartAt = null;
    fleetState.examLink = "";
    stopHeartbeat();
    stopExamLinkPoller();
    allowSleep(); // restore normal sleep/lock behaviour
    if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }

    // Kill EVERY launched drone — not just 1..maxBrowsers. With a network mix the
    // fleet can be larger than maxBrowsers (e.g. 2 direct + 4 NordVPN = 6), and the
    // NordVPN drones are the higher-numbered ones; the old maxBrowsers loop left
    // them running. Use the union of: actually-tracked drones + the full planned
    // count + a safety ceiling — so nothing survives the kill switch.
    const idsToKill = new Set(Object.keys(fleetState.activeDrones).map(Number));
    const planned = fleetState.droneCount || parseInt(fleetState.config.maxBrowsers) || 0;
    const ceiling = Math.max(planned, 20); // safety: also sweep a generous range
    for (let i = 1; i <= ceiling; i++) idsToKill.add(i);
    idsToKill.forEach(id => assassinateDrone(id));

    proxyRelay.stopAllRelays();
    fleetState.activeDrones = {};
    fleetState.droneNetwork = {};
    fleetState.droneCount = 0;
    fleetState.users.forEach(u => {
        if (u.status.includes('Running') || u.status === 'OTP_Wait') u.status = 'Queued';
    });

    pushToDashboard('fleetStopped', {});
    res.json({ status: "success" });

    // Cleanup temp profiles after browsers close
    setTimeout(() => {
        sysLog("🧹 Cleaning temporary drone profiles...", "warn");
        purgeAllProfiles();
        sysLog("✨ All temporary profiles deleted. System clean.", "success");
    }, 5000);
});

// --- GRAB USER (Extension calls this when it finds an opening) ---
// The extension passes ?avail=reading,writing — the modules ACTUALLY available
// on the options page right now. We only assign a queued user whose request can
// be satisfied by those modules (respecting their Partial Booking setting).
app.get('/api/grab-user/:droneId', (req, res) => {
    const { droneId } = req.params;

    // Parse the modules currently available on the page
    const availParam = (req.query.avail || '').toString().toLowerCase();
    const availableModules = availParam ? availParam.split(',').map(s => s.trim()).filter(Boolean) : [];

    // Helper: can this user be booked with the currently available modules?
    function userMatches(u) {
        const wanted = u.modules || [];
        if (wanted.length === 0) return false;
        const present = wanted.filter(m => availableModules.includes(m));
        if (present.length === 0) return false;          // none of their modules are open
        if (u.partial) return true;                      // partial OK -> any overlap works
        return present.length === wanted.length;         // strict -> ALL must be open
    }

    // If the extension told us what's available, match accordingly.
    // Otherwise (no avail info) fall back to the first queued user.
    let userIndex = -1;
    if (availableModules.length > 0) {
        userIndex = fleetState.users.findIndex(u => u.status === 'Queued' && userMatches(u));
    } else {
        userIndex = fleetState.users.findIndex(u => u.status === 'Queued');
    }

    if (userIndex === -1) {
        // Are there ANY queued users at all?
        const queuedExist = fleetState.users.some(u => u.status === 'Queued');
        if (queuedExist && availableModules.length > 0) {
            // Users remain, but none match what's available for this slot
            sysLog(`Drone ${droneId}: No queued user matches available modules [${availableModules.join(', ') || 'none'}].`, 'warn');
            return res.json({ available: false, reason: 'no_match' });
        }
        sysLog(`Drone ${droneId}: Queue empty, no users available.`, 'warn');
        checkFleetComplete();
        return res.json({ available: false, reason: 'empty' });
    }

    fleetState.users[userIndex].status = `Running (Drone ${droneId})`;
    if (fleetState.activeDrones[droneId]) {
        fleetState.activeDrones[droneId].assignedUserIndex = userIndex;
        fleetState.activeDrones[droneId].noUser = false; // got a user — clear the holding flag
    }

    sysLog(`🎯 Drone ${droneId} assigned: ${fleetState.users[userIndex].email}`, 'success');
    pushToDashboard('updateUser', { index: userIndex, status: `Running (Drone ${droneId})`, color: 'var(--primary)', email: fleetState.users[userIndex].email, droneId: droneId });

    res.json({
        available: true,
        userIndex: userIndex,
        user: fleetState.users[userIndex],
        creditCard: fleetState.config.creditCard,
        mainUrl: fleetState.config.targetUrl,
        proxyAuth: fleetState.activeDrones[droneId]?.proxy ? {
            username: fleetState.activeDrones[droneId].proxy.username,
            password: fleetState.activeDrones[droneId].proxy.password
        } : null
    });
});

// --- PROXY AUTH (Extension background worker fetches credentials for HTTP proxy auth) ---
app.get('/api/proxy-auth/:droneId', (req, res) => {
    const { droneId } = req.params;
    const drone = fleetState.activeDrones[droneId];
    if (drone && drone.proxy && drone.proxy.username) {
        return res.json({
            hasAuth: true,
            username: drone.proxy.username,
            password: drone.proxy.password,
            host: drone.proxy.host,
            port: drone.proxy.port,
            protocol: drone.proxy.protocol
        });
    }
    res.json({ hasAuth: false });
});

// --- BOT STATUS (Extension reports page state) ---
app.post('/api/bot-status', (req, res) => {
    const { droneId, message, page } = req.body;
    const drone = fleetState.activeDrones[droneId];
    let email = null;
    if (drone) {
        if (drone.status !== message || drone.page !== (page || null)) {
            drone.lastChangeAt = Date.now(); // heartbeat: page/status changed
        }
        drone.status = message;
        drone.page = page || null;
        if (drone.assignedUserIndex !== null && fleetState.users[drone.assignedUserIndex]) {
            email = fleetState.users[drone.assignedUserIndex].email;
        }
    }
    pushToDashboard('botUpdate', { droneId, message, page: page || null, email });

    // AUTO-SPOTLIGHT: if the user configured a page to auto-focus on (e.g.
    // 'payment' or 'options'), bring this drone to the front automatically the
    // moment it reaches that page — so you can act without hunting for it.
    if (page && fleetState.config.autoFocusPage && page === fleetState.config.autoFocusPage) {
        if (drone && drone._lastFocusedPage !== page) {
            drone._lastFocusedPage = page;
            focusDroneWindows(droneId);
            sysLog(`🔍 Auto-spotlight: Drone ${droneId} reached '${page}' — brought to front.`, 'info');
        }
    }
    res.json({ status: "ok" });
});

// --- DRONE LOG (Extension pushes a milestone into the GLOBAL system log feed) ---
// Lets a drone surface noteworthy events (got the booking link, rate-limited,
// rotating IP) in the main dashboard log — not just its own status row.
app.post('/api/drone-log', (req, res) => {
    const { droneId, message, type } = req.body || {};
    const t = ['info', 'warn', 'error', 'success'].includes(type) ? type : 'info';
    sysLog(`Drone ${droneId}: ${message}`, t);
    res.json({ status: "ok" });
});

// --- LOGIN FAILED (Extension detected bad credentials) ---
// Marks the user as Failed so NO other drone reuses these credentials,
// then frees this drone to hunt for a different queued user.
app.post('/api/login-failed', (req, res) => {
    const { droneId } = req.body;
    const drone = fleetState.activeDrones[droneId];
    if (drone && drone.assignedUserIndex !== null) {
        const uIdx = drone.assignedUserIndex;
        const u = fleetState.users[uIdx];
        const email = u ? u.email : `user ${uIdx}`;

        // Track per-user login attempts for the auto-retry feature
        u.loginAttempts = (u.loginAttempts || 0) + 1;
        const MAX_RETRY = 2;

        if (autoRetryFailed && u.loginAttempts < MAX_RETRY) {
            // Transient failure tolerated — requeue and try again (maybe diff slot/IP)
            u.status = 'Queued';
            sysLog(`🔁 Drone ${droneId}: Login failed for ${email} (attempt ${u.loginAttempts}/${MAX_RETRY}). Auto-retry ON — requeued.`, 'warn');
            pushToDashboard('updateUser', { index: uIdx, status: `🔁 Retry ${u.loginAttempts}/${MAX_RETRY}`, color: 'var(--accent)' });
        } else {
            // Give up on this user — mark Failed so no drone reuses the credentials
            u.status = 'Failed';
            sysLog(`🔐 Drone ${droneId}: LOGIN FAILED for ${email}. Marked Failed (won't retry).`, 'error');
            pushToDashboard('updateUser', { index: uIdx, status: '🔐 Login Failed', color: 'var(--danger)' });
            appendHistory({ email: email, modules: (u.modules || []).join('|'), status: 'Login Failed', drone: droneId, proxy: drone.proxy ? `${drone.proxy.host}:${drone.proxy.port}` : 'Direct' });
        }

        drone.assignedUserIndex = null;

        // Relaunch this drone fresh so it grabs a DIFFERENT queued user
        const hasMore = fleetState.users.some(u => u.status === 'Queued');
        if (hasMore && fleetState.isRunning) {
            assassinateDrone(droneId);
            setTimeout(() => launchDrone(droneId), 3000);
        } else {
            assassinateDrone(droneId);
            delete fleetState.activeDrones[droneId];
            checkFleetComplete();
        }
    }
    res.json({ status: "ok" });
});

// --- RELEASE USER (Extension: assigned user no longer bookable on this slot) ---
// The user is still valid — availability just changed after assignment. Put
// them back in the queue and let this drone keep hunting (it retreats itself).
app.post('/api/release-user/:droneId', (req, res) => {
    const { droneId } = req.params;
    const drone = fleetState.activeDrones[droneId];
    if (drone && drone.assignedUserIndex !== null) {
        const uIdx = drone.assignedUserIndex;
        const email = fleetState.users[uIdx] ? fleetState.users[uIdx].email : `user ${uIdx}`;
        fleetState.users[uIdx].status = 'Queued';
        drone.assignedUserIndex = null;
        sysLog(`↩️ Drone ${droneId}: Released ${email} back to queue (modules changed). Re-hunting...`, 'warn');
        pushToDashboard('updateUser', { index: uIdx, status: '⏳ Queued', color: '#334155' });
        pushToDashboard('droneUpdate', { droneId, status: '🔄 Re-hunting...', proxy: drone.proxy ? `${drone.proxy.host}:${drone.proxy.port}` : 'Direct', user: null });
    }
    res.json({ status: "ok" });
});

// --- NO MATCH (Extension found an opening but no queued user wants these modules) ---
// We KEEP the drone alive (browser stays open) and just notify on the dashboard
// that it has no valid user to continue. The extension keeps re-checking, so if a
// matching user is added/freed, this drone picks it up automatically.
app.post('/api/no-match/:droneId', (req, res) => {
    const { droneId } = req.params;
    const drone = fleetState.activeDrones[droneId];

    // The extension re-checks every few seconds; only log/notify on the FIRST
    // time so we don't flood the activity log.
    const firstTime = !(drone && drone.noUser);
    if (drone) { drone.noUser = true; drone.status = 'no_user'; drone.lastChangeAt = Date.now(); }
    if (firstTime) {
        sysLog(`⚠️ Drone ${droneId}: opening found, but no queued user matches its modules. Holding the drone (browser kept open).`, 'warn');
        pushToDashboard('droneUpdate', { droneId, status: '⚠️ No valid user for these modules — holding', proxy: drone && drone.proxy ? `${drone.proxy.host}:${drone.proxy.port}` : 'Direct', user: null, noUser: true });
    }

    res.json({ status: "ok", hold: true });
});

// ==========================================
// PER-DRONE BOT CONTROL (pause / resume)
// A drone can be paused two ways: MANUALLY from the dashboard (Stop Bot), or
// AUTOMATICALLY when it reaches the page set in config.pauseAtPage (e.g. payment)
// — then it waits for a human to press Continue. The extension polls
// /drone-control to decide whether to act.
// ==========================================
app.get('/api/drone-control/:droneId', (req, res) => {
    const drone = fleetState.activeDrones[req.params.droneId];
    res.json({
        paused: !!(drone && drone.paused),
        pausedPage: (drone && drone.pausedPage) || null,
        resumedPage: (drone && drone.resumedPage) || null,
        pauseAtPage: fleetState.config.pauseAtPage || ''
    });
});

app.post('/api/pause-drone/:droneId', (req, res) => {
    const { droneId } = req.params;
    const { page, manual } = req.body || {};
    const drone = fleetState.activeDrones[droneId];
    if (drone) { drone.paused = true; drone.pausedPage = page || null; drone.pausedManual = !!manual; }
    const why = manual ? 'manually stopped' : (page ? `auto-paused at ${page}` : 'paused');
    sysLog(`⏸ Drone ${droneId} ${why} — waiting for Continue.`, 'warn');
    pushToDashboard('dronePaused', { droneId, page: page || null, manual: !!manual });
    res.json({ status: "ok" });
});

app.post('/api/resume-drone/:droneId', (req, res) => {
    const { droneId } = req.params;
    const drone = fleetState.activeDrones[droneId];
    if (drone) {
        // For an auto-pause at a page, remember it's cleared so it won't instantly
        // re-pause on that same page; manual pauses don't set a resume marker.
        if (!drone.pausedManual && drone.pausedPage) drone.resumedPage = drone.pausedPage;
        drone.paused = false; drone.pausedPage = null; drone.pausedManual = false;
    }
    sysLog(`▶ Drone ${droneId} resumed.`, 'success');
    pushToDashboard('droneResumed', { droneId });
    res.json({ status: "ok" });
});

// --- REPORT 429 (Extension detected rate limit OR a permanent IP ban) ---
app.post('/api/report-429', (req, res) => {
    const { droneId, banned, bannedIp } = req.body;
    sysLog(banned
        ? `🚫 Drone ${droneId}: IP permanently BANNED by Goethe${bannedIp ? ` (${bannedIp})` : ''}. Saving to ban list & rotating...`
        : `🛑 Drone ${droneId} hit 429 Rate Limit! Burning for this run only (reverts next run) & rotating...`, 'error');

    const droneData = fleetState.activeDrones[droneId];

    // Release user back to queue
    if (droneData && droneData.assignedUserIndex !== null) {
        const uIdx = droneData.assignedUserIndex;
        fleetState.users[uIdx].status = 'Queued';
        sysLog(`↩️ Releasing ${fleetState.users[uIdx].email} back to queue.`, 'warn');
        pushToDashboard('updateUser', { index: uIdx, status: '⏳ Queued', color: '#334155' });
    }

    // Burn the proxy. A permanent ban also sets permanentlyBanned AND is saved to
    // the persistent ban file so it's excluded in this and all future runs (until
    // the user clears it). A 429 (banned=false) is NOT persisted — temporary only.
    if (droneData && droneData.proxy) {
        burnProxy(droneData.proxy);
        if (banned) {
            const p = fleetState.proxyPool.find(x => x.id === droneData.proxy.id);
            if (p) p.permanentlyBanned = true;
            addPermanentBan(droneData.proxy.id, { host: droneData.proxy.host, country: droneData.proxy.country, ip: bannedIp });
            pushToDashboard('banUpdate', {}); // tell the dashboard to refresh its ban list
        }
    }

    // Kill the drone browser
    assassinateDrone(droneId);
    delete fleetState.activeDrones[droneId];

    pushToDashboard('droneUpdate', { droneId, status: '🔥 Burned — Respawning...', proxy: 'Rotating...', user: null });

    // Wait for browser to close, then relaunch with new proxy. Jittered (5–10s)
    // so a mass rate-limit doesn't respawn every drone at once (which would burst
    // past NordVPN's concurrent-connection limit and cause tunnel failures).
    setTimeout(() => {
        if (fleetState.isRunning) {
            launchDrone(droneId);
        }
    }, 5000 + Math.floor(Math.random() * 5000));

    res.json({ status: "ok" });
});

// --- PROXY / NETWORK FAILURE (Extension or background watchdog detected a dead proxy) ---
// A NordVPN/SOCKS server dropped the connection (the login redirect burst is
// where this usually bites). The user's credentials are FINE — only the proxy
// is bad. Requeue the user, burn this proxy so the next pick differs, and
// respawn the drone on a fresh server. Self-healing IP rotation.
app.post('/api/proxy-failed/:droneId', (req, res) => {
    const { droneId } = req.params;
    const reason = (req.body && req.body.reason) || 'network error';
    const drone = fleetState.activeDrones[droneId];
    if (!drone) return res.json({ status: "ok" }); // already handled/respawning

    sysLog(`📡 Drone ${droneId} network/proxy failure (${reason}).`, 'error');

    // Release the assigned user back to the queue — their login is valid.
    if (drone.assignedUserIndex !== null && drone.assignedUserIndex !== undefined) {
        const uIdx = drone.assignedUserIndex;
        const u = fleetState.users[uIdx];
        if (u && (u.status.startsWith('Running') || u.status === 'OTP_Wait')) {
            u.status = 'Queued';
            sysLog(`↩️ Releasing ${u.email} back to queue (proxy failed, not the user).`, 'warn');
            pushToDashboard('updateUser', { index: uIdx, status: '⏳ Queued', color: '#334155' });
        }
    }

    // Burn the failing proxy so getNextProxy() hands out a DIFFERENT server OF THE
    // SAME PROVIDER. A 'direct' drone has no proxy → nothing to burn (failure stays
    // isolated to this drone; it just retries on the ISP connection).
    if (drone.proxy) {
        burnProxy(drone.proxy);
        sysLog(`🔄 Drone ${droneId} (${networkLabel(droneId)}): rotating to a different ${drone.proxy.provider || 'proxy'} server...`, 'warn');
    }

    assassinateDrone(droneId);
    delete fleetState.activeDrones[droneId];
    pushToDashboard('droneUpdate', { droneId, status: '📡 Network error — rotating IP...', proxy: 'Rotating...', user: null });

    // Wait for the browser/relay to close, then relaunch on a fresh proxy.
    // Jittered (5–10s) so a simultaneous mass-failure doesn't respawn all drones
    // at the same instant (which would burst NordVPN's concurrent-connection limit).
    if (fleetState.isRunning) {
        setTimeout(() => { if (fleetState.isRunning) launchDrone(droneId); }, 5000 + Math.floor(Math.random() * 5000));
    }
    res.json({ status: "ok" });
});

// --- OTP WAIT (Extension reached payment OTP stage) ---
app.post('/api/otp-wait', (req, res) => {
    const { droneId } = req.body;
    const droneData = fleetState.activeDrones[droneId];
    if (droneData && droneData.assignedUserIndex !== null) {
        const uIdx = droneData.assignedUserIndex;
        const u = fleetState.users[uIdx];
        // Pay button was clicked → mark BOOKED right away. Keep the browser
        // ALIVE so the user can finish the bank OTP / 3D-Secure manually.
        // The drone is "parked" (not recycled) until the user kills it.
        u.status = 'Booked';
        droneData.parked = true;
        sysLog(`🏆 ${u.email} — PAY CLICKED, marked BOOKED. Browser parked for OTP. Drone ${droneId} won't recycle.`, 'success');
        pushToDashboard('updateUser', { index: uIdx, status: '🏆 Booked (finish OTP)', color: 'var(--success)', requireAction: true });
        pushToDashboard('droneUpdate', { droneId, status: '🅿️ Parked — complete OTP, then Kill', proxy: droneData.proxy ? `${droneData.proxy.host}:${droneData.proxy.port}` : 'Direct', user: u.email, parked: true });
        appendHistory({ email: u.email, modules: (u.modules || []).join('|'), status: 'Booked (pay clicked)', drone: droneId, proxy: droneData.proxy ? `${droneData.proxy.host}:${droneData.proxy.port}` : 'Direct' });
    }
    res.json({ status: "ok" });
});

// --- KILL DRONE (user manually closes a parked/any drone) ---
// If the drone was parked after a booking, recycle it to the next queued user.
app.post('/api/kill-drone/:droneId', (req, res) => {
    const { droneId } = req.params;
    const drone = fleetState.activeDrones[droneId];
    const wasParked = drone && drone.parked;

    sysLog(`🗙 Drone ${droneId} killed by user.`, 'warn');
    assassinateDrone(droneId);
    delete fleetState.activeDrones[droneId];
    pushToDashboard('droneUpdate', { droneId, status: '💤 Killed', proxy: 'Direct', user: null });

    // If it had finished a booking, spin a fresh drone for remaining users
    const hasMore = fleetState.users.some(u => u.status === 'Queued');
    if (wasParked && hasMore && fleetState.isRunning) {
        sysLog(`♻️ Recycling Drone ${droneId} for the next queued user...`, 'info');
        setTimeout(() => { if (fleetState.isRunning) launchDrone(droneId); }, 3000);
    } else {
        checkFleetComplete();
    }
    res.json({ status: "ok" });
});

// --- START SINGLE DRONE (add one more drone WITHOUT affecting the others) ---
app.post('/api/start-drone/:droneId', async (req, res) => {
    if (!fleetState.isRunning) return res.status(400).json({ error: 'Fleet is not running' });
    const { droneId } = req.params;
    if (fleetState.activeDrones[droneId]) return res.status(400).json({ error: 'That drone is already active' });

    // Assign this manual drone's network. If a type is given (mix mode), use it;
    // otherwise it inherits the legacy single-mode network automatically.
    const reqNet = ((req.body && req.body.network) || '').toString().toLowerCase();
    if (['direct', 'nordvpn', 'custom'].includes(reqNet)) {
        fleetState.droneNetwork[droneId] = reqNet;
        if (reqNet !== 'direct' && !fleetState.proxyPool.some(p => p.provider === reqNet)) {
            sysLog(`⚠️ Drone ${droneId}: no '${reqNet}' proxies in this run's pool — it will run Direct.`, 'warn');
        }
    }
    // Keep the launched-drone count current so the kill switch covers this drone.
    fleetState.droneCount = Math.max(fleetState.droneCount || 0, parseInt(droneId) || 0);
    sysLog(`➕ Manually starting Drone ${droneId} → ${networkLabel(droneId)} (others unaffected)...`, 'info');
    await launchDrone(droneId);
    res.json({ status: 'ok' });
});

// --- MARK COMPLETE (Dashboard or Extension confirms booking) ---
app.post('/api/mark-complete', (req, res) => {
    const { droneId, userIndex } = req.body;
    const uIdx = userIndex !== undefined ? userIndex : (fleetState.activeDrones[droneId]?.assignedUserIndex);

    if (uIdx !== undefined && uIdx !== null && fleetState.users[uIdx]) {
        fleetState.users[uIdx].status = 'Complete';
        sysLog(`✅ ${fleetState.users[uIdx].email} — BOOKING CONFIRMED!`, 'success');
        pushToDashboard('updateUser', { index: uIdx, status: '🏆 Booked!', color: 'var(--success)' });
        appendHistory({ email: fleetState.users[uIdx].email, modules: (fleetState.users[uIdx].modules || []).join('|'), status: 'Confirmed (OTP done)', drone: droneId || '', proxy: '' });

        // Free the drone to pick up next user
        if (droneId && fleetState.activeDrones[droneId]) {
            fleetState.activeDrones[droneId].assignedUserIndex = null;

            // Relaunch drone for next user if queue has more
            const hasMore = fleetState.users.some(u => u.status === 'Queued');
            if (hasMore && fleetState.isRunning) {
                assassinateDrone(droneId);
                setTimeout(() => launchDrone(droneId), 3000);
            } else {
                checkFleetComplete();
            }
        } else {
            checkFleetComplete();
        }
    }
    res.json({ status: "success" });
});

// --- MARK FAILED ---
app.post('/api/mark-failed', (req, res) => {
    const { droneId, userIndex, reason } = req.body;
    const uIdx = userIndex !== undefined ? userIndex : (fleetState.activeDrones[droneId]?.assignedUserIndex);

    if (uIdx !== undefined && uIdx !== null && fleetState.users[uIdx]) {
        fleetState.users[uIdx].status = 'Failed';
        sysLog(`❌ ${fleetState.users[uIdx].email} — FAILED: ${reason || 'Unknown'}`, 'error');
        pushToDashboard('updateUser', { index: uIdx, status: `❌ Failed: ${reason}`, color: 'var(--danger)' });

        if (droneId && fleetState.activeDrones[droneId]) {
            fleetState.activeDrones[droneId].assignedUserIndex = null;
            const hasMore = fleetState.users.some(u => u.status === 'Queued');
            if (hasMore && fleetState.isRunning) {
                assassinateDrone(droneId);
                setTimeout(() => launchDrone(droneId), 3000);
            } else {
                checkFleetComplete();
            }
        }
    }
    res.json({ status: "success" });
});

// --- FOCUS DRONE (bring one drone window to front, minimize the rest) ---
app.post('/api/focus-drone/:droneId', (req, res) => {
    const { droneId } = req.params;
    focusDroneWindows(droneId);
    sysLog(`🔍 Spotlight: Drone ${droneId} to front, others minimized.`, 'info');
    res.json({ status: "ok" });
});

// --- RESTORE ALL (un-minimize every drone window) ---
app.post('/api/restore-all', (req, res) => {
    const exeName = droneExeName();
    daemonSend(`RESTORE ${exeName}`);
    sysLog(`🪟 Restored all drone windows.`, 'info');
    res.json({ status: "ok" });
});

// --- SAVE CONFIG TO SERVER (survives restarts, shared across browsers) ---
app.post('/api/save-config', (req, res) => {
    const ok = saveConfigToDisk(req.body);
    if (ok) sysLog('💾 Configuration saved to server (fleet-config.json).', 'success');
    res.json({ status: ok ? 'ok' : 'error' });
});

// --- LOAD CONFIG FROM SERVER ---
app.get('/api/load-config', (req, res) => {
    const cfg = loadConfigFromDisk();
    res.json({ found: !!cfg, config: cfg || null });
});

// --- PERSISTENT BAN LIST: view + manual removal ---
app.get('/api/banned-list', (req, res) => {
    res.json({ banned: loadBannedList() });
});
app.post('/api/banned-remove', (req, res) => {
    const { id, all } = req.body || {};
    let list = loadBannedList();
    if (all) {
        list = [];
        sysLog('🧹 Cleared the entire persistent IP ban list (manual).', 'warn');
    } else if (id) {
        list = list.filter(b => b.id !== id);
        sysLog(`🧹 Removed ${id} from the persistent IP ban list (manual).`, 'info');
        // Also un-ban it in the current run's pool so it can be used again now.
        const p = fleetState.proxyPool.find(x => x.id === id);
        if (p) { p.permanentlyBanned = false; p.burned = false; }
        fleetState.burnedProxies = fleetState.proxyPool.filter(x => x.burned).map(x => x.id);
    }
    saveBannedList(list);
    broadcastProxyStats();
    res.json({ status: 'ok', banned: list });
});

// --- DOWNLOAD BOOKING HISTORY (CSV) ---
app.get('/api/history', (req, res) => {
    if (!fs.existsSync(HISTORY_FILE)) {
        return res.status(404).send('No booking history yet.');
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="booking-history.csv"');
    res.send(fs.readFileSync(HISTORY_FILE, 'utf8'));
});

// --- DETECT CLOAKBROWSER (find the cached binary path) ---
app.get('/api/detect-cloak', (req, res) => {
    const p = findCloakBinary();
    res.json({ found: !!p, path: p || '' });
});

// --- GET FLEET STATUS (for polling if SSE disconnects) ---
app.get('/api/status', (req, res) => {
    res.json({
        isRunning: fleetState.isRunning,
        users: fleetState.users.map(u => ({ email: u.email, status: u.status })),
        drones: Object.entries(fleetState.activeDrones).map(([id, d]) => ({
            id,
            status: d.status,
            network: networkLabel(id),
            proxy: d.proxy ? `${d.proxy.host}:${d.proxy.port}` : 'Direct',
            user: d.assignedUserIndex !== null ? fleetState.users[d.assignedUserIndex]?.email : null
        })),
        proxyStats: {
            total: fleetState.proxyPool.length,
            burned: fleetState.burnedProxies.length,
            available: fleetState.proxyPool.filter(p => !p.burned).length
        }
    });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = 3000;

// Clean up any stale profile folders left over from a previous run/crash.
purgeAllProfiles();

// Start the persistent window daemon (instant focus/minimize)
startWindowDaemon();

app.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  📡 Goethe Fleet Commander — Online`);
    console.log(`  🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`  ⚠️  DO NOT use Live Server — open the URL above directly`);
    console.log(`${'='.repeat(50)}\n`);
});

// Release the keep-awake guard if the server is closed (Ctrl+C / kill), so the
// PC isn't left awake. The guard also self-exits via its parent-PID watchdog.
['SIGINT', 'SIGTERM', 'exit'].forEach(sig => {
    process.on(sig, () => { try { allowSleep(); } catch (e) {} if (sig !== 'exit') process.exit(0); });
});
