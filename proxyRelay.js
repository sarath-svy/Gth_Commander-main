// ==========================================
// LOCAL PROXY RELAY
// ==========================================
// Chrome's --proxy-server flag CANNOT authenticate SOCKS5 proxies
// (which is exactly what NordVPN requires), and cannot pass
// username:password for HTTP proxies either.
//
// Solution: for each drone we spin up a local, password-free HTTP
// proxy (via the 'proxy-chain' package) that listens on 127.0.0.1.
// Chrome connects to this local relay; the relay forwards all traffic
// to the real upstream proxy (NordVPN / custom) doing the auth here in
// Node.js. This works uniformly for HTTP and SOCKS5, with or without auth.
// ==========================================

const http = require('http');

let ProxyChain = null;
try {
    ProxyChain = require('proxy-chain');
} catch (e) {
    console.warn("[ProxyRelay] 'proxy-chain' not installed. Run: npm install");
}

// droneId -> { server, port, upstreamUrl }
const relays = {};

function buildUpstreamUrl(proxy) {
    // proxy = { protocol, host, port, username, password }
    let scheme = (proxy.protocol || 'http').toLowerCase();
    // For SOCKS, use socks5h so DNS is resolved by the proxy (remote DNS).
    // Resolving goethe.de locally and sending the IP can fail or leak DNS —
    // socks5h fixes the common "proxy connects but page never loads" issue.
    if (scheme === 'socks' || scheme === 'socks5') scheme = 'socks5h';
    let auth = '';
    if (proxy.username) {
        auth = `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`;
    }
    return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

// Starts a local relay for a drone. Returns the local port Chrome should use,
// or null if relay couldn't start (caller should then fall back to direct/no-proxy).
// onError(message) is called when an upstream request fails (e.g. bad NordVPN creds).
async function startRelay(droneId, proxy, onError) {
    if (!ProxyChain || !proxy) return null;

    // Ensure any previous relay for this drone is gone
    await stopRelay(droneId);

    const upstreamUrl = buildUpstreamUrl(proxy);

    const server = new ProxyChain.Server({
        port: 0, // 0 = let the OS pick a free port
        host: '127.0.0.1',
        prepareRequestFunction: () => ({ upstreamProxyUrl: upstreamUrl })
    });

    // Surface upstream failures (e.g. 597 Auth Failed = wrong NordVPN creds)
    server.on('requestFailed', ({ error }) => {
        if (onError && error) onError(error.message || String(error));
    });

    await server.listen();
    const port = server.port;
    relays[droneId] = { server, port, upstreamUrl };
    return port;
}

async function stopRelay(droneId) {
    const relay = relays[droneId];
    if (relay && relay.server) {
        try { await relay.server.close(true); } catch (e) {}
    }
    delete relays[droneId];
}

async function stopAllRelays() {
    const ids = Object.keys(relays);
    for (const id of ids) {
        await stopRelay(id);
    }
}

// Health-check a relay's UPSTREAM tunnel by fetching a tiny endpoint THROUGH it.
// Success proves the SOCKS server actually forwards traffic; failure means the
// tunnel is dead (server down / unreachable / NordVPN connection limit hit) — so
// the caller can skip that server instead of launching a drone onto a broken
// proxy (the ERR_TUNNEL_CONNECTION_FAILED / "Upstream Error" symptom). Uses a
// neutral generate_204 (NOT goethe), so it only tests connectivity, not the site.
function testRelay(port, timeoutMs = 6000) {
    return new Promise(resolve => {
        let settled = false;
        const done = (ok) => { if (settled) return; settled = true; try { req.destroy(); } catch (e) {} resolve(ok); };
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: 'GET',
            // Absolute URI → the relay proxies this request to its upstream.
            path: 'http://www.gstatic.com/generate_204',
            headers: { Host: 'www.gstatic.com', 'Connection': 'close' }
        }, (res) => { res.resume(); done(res.statusCode > 0 && res.statusCode < 500); });
        req.setTimeout(timeoutMs, () => done(false));
        req.on('error', () => done(false));
        req.end();
    });
}

function isAvailable() {
    return ProxyChain !== null;
}

module.exports = { startRelay, stopRelay, stopAllRelays, isAvailable, testRelay };
