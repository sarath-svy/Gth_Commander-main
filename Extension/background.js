// ==========================================
// PROXY-FAILURE WATCHDOG (Background Service Worker)
// ==========================================
// When a NordVPN/SOCKS server drops a connection mid-navigation (very common
// during the login redirect burst), Chrome shows its own "no network
// connection" error page at chrome-error://. Content scripts CANNOT run on
// that page, so content.js goes blind and the drone dies silently.
//
// This worker listens for those browser-level navigation errors and tells the
// server to BURN the dead proxy and RESPAWN the drone on a fresh server —
// turning a silent dead-end into a self-healing IP rotation.
// ==========================================

const API_URL = "http://127.0.0.1:3000/api";

// Errors that mean "this proxy/network path is dead" → rotate to a new server.
// Explicit allowlist on purpose: we must NOT react to net::ERR_ABORTED or
// net::ERR_BLOCKED_BY_* which fire constantly during normal navigation.
const PROXY_ERRORS = new Set([
  'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_TUNNEL_CONNECTION_FAILED',
  'net::ERR_SOCKS_CONNECTION_FAILED',
  'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
  'net::ERR_PROXY_AUTH_UNSUPPORTED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_CONNECTION_FAILED',
  'net::ERR_CONNECTION_ABORTED',
  'net::ERR_TIMED_OUT',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_NAME_RESOLUTION_FAILED',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_ADDRESS_UNREACHABLE'
]);

function isTargetUrl(url) {
  return !!url && (url.includes('goethe.de') || url.includes('paymentiq.io'));
}

// Debounce: each drone is its own browser instance, so this guards against a
// single failure firing twice (worker re-fires nothing after respawn — fresh
// instance resets this).
let lastReport = 0;
async function reportProxyFailure(reason) {
  const now = Date.now();
  if (now - lastReport < 8000) return;
  lastReport = now;
  try {
    const { fleetDroneId } = await chrome.storage.local.get('fleetDroneId');
    if (!fleetDroneId) return; // not a swarm-launched browser
    await fetch(`${API_URL}/proxy-failed/${fleetDroneId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
  } catch (e) { /* server unreachable — nothing we can do */ }
}

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;      // main-frame navigations only
  if (!isTargetUrl(details.url)) return;  // ignore API/loopback/other tabs
  if (PROXY_ERRORS.has(details.error)) {
    reportProxyFailure(details.error);
  }
});
