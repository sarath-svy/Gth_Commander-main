const API_URL = "http://127.0.0.1:3000/api";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// While a drone holds during warm-up, refresh the page roughly every 2–3 min so
// the goethe session/cookies don't go stale on long waits. The jitter (random
// per page load) staggers drones so they don't all reload at the same instant.
const WARMUP_REFRESH_MS = 120000 + Math.floor(Math.random() * 60000);

// Return the CLEAN exam URL — strip the params WE inject (fleetDroneId,
// fleetSession, _cb) regardless of separator or order. The old split('&fleetDroneId')
// silently failed when the param used a '?' separator (no query string in the
// configured URL), leaving the drone/session ids glued onto every fetch + reload.
function cleanExamUrl(href) {
  try {
    const u = new URL(href, location.origin);
    ['fleetDroneId', 'fleetSession', '_cb'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch (e) {
    return String(href).split(/[?&]fleetDroneId/)[0]; // best-effort fallback
  }
}

// Force a FRESH (non-CDN-cached) load of the exam page. The Goethe page sits
// behind Akamai; a plain location.reload() can keep getting served a stale
// "not-open yet" copy for minutes after booking actually opens. A unique _cb
// param changes the edge cache key so we always pull the live origin state.
function refreshExamPage(state) {
  const base = (state && state.exam_base_url) || cleanExamUrl(window.location.href);
  const sep = base.includes('?') ? '&' : '?';
  window.location.href = base + sep + '_cb=' + Date.now();
}

// Pull the server-rendered examButtonLink out of any page-HTML text.
// Empty string => booking not open yet; a /coe?…&oid=… URL => open.
function parseExamButtonLink(text) {
  if (!text) return "";
  const m = text.match(/examButtonLink['"]?\]?\s*=\s*["']([^"']*)["']/);
  return m ? m[1].trim() : "";
}

// HTTP race path: fetch the exam page HTML directly (same-origin, so cookies
// ride along) with a cache-buster, and parse out the link. This gets the link
// WITHOUT waiting for a full page reload + content-script re-injection, so under
// high traffic it usually beats the rendered button.
// Returns { link, status, rateLimited }: link is "" until booking opens; a 429/
// 503 sets rateLimited so the caller can back off and rotate IP.
async function fetchExamLink(state) {
  const base = (state && state.exam_base_url) || cleanExamUrl(window.location.href);
  const sep = base.includes('?') ? '&' : '?';
  const url = base + sep + '_cb=' + Date.now();
  try {
    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (r.status === 429 || r.status === 503) return { link: "", status: r.status, rateLimited: true };
    if (!r.ok) return { link: "", status: r.status };
    return { link: parseExamButtonLink(await r.text()), status: 200 };
  } catch (e) {
    return { link: "", status: 0, error: true };
  }
}

// Consecutive HTTP 429/503 hits; drives exponential backoff + IP rotation.
let rateLimitStreak = 0;
// One-shot per page load: logs how long the page took to become actionable.
let navLogged = false;
// When this exam-page instance was first seen by the content script. Used to let
// Akamai's bot sensor validate the session before we navigate to /coe (which
// 403s on an unvalidated session). Resets to 0 on every page (re)load.
let examFirstSeenAt = 0;
const SESSION_SETTLE_MS = 2000;      // time-based settle when no cookie signal
const SESSION_SETTLE_MAX_MS = 5000;  // hard cap — never wait longer than this

// SMART session-ready check. Akamai's _abck bot cookie carries a status field
// that flips from "-1" (sensor not posted yet → /coe will 403) to "0" (validated
// → /coe works). We jump the INSTANT it reads "0". If _abck isn't readable (some
// configs) we fall back to a time-based settle, and a hard cap guarantees we
// never hang (the /coe retry net covers any residual edge case).
function coeSessionReady() {
  const elapsed = Date.now() - examFirstSeenAt;
  if (elapsed >= SESSION_SETTLE_MAX_MS) return true;       // cap
  const m = (document.cookie || '').match(/_abck=([^;]+)/);
  if (m) {
    const status = decodeURIComponent(m[1]).split('~')[1]; // 2nd field = validation status
    if (status === '0')  return true;                      // validated → go NOW
    if (status === '-1') return false;                     // not validated → keep waiting
  }
  return elapsed >= SESSION_SETTLE_MS;                      // no _abck signal → time settle
}

// ==========================================
// THE SURGICAL MODULE FINDER (Untouched)
// ==========================================
function findCheckboxByLabelText(moduleName) {
  const wrappers = document.querySelectorAll('.cs-input__field--exams');
  for (let wrapper of wrappers) {
      const textContent = wrapper.textContent.toLowerCase();
      if (textContent.includes(moduleName.toLowerCase())) {
          const checkbox = wrapper.querySelector('input[type="checkbox"]');
          if (!checkbox || checkbox.disabled) return null;
          if (textContent.includes('fully booked') || textContent.includes('ausgebucht')) return null;
          return checkbox;
      }
  }
  return null;
}

// XPATH HELPER (Untouched)
function getElementByXPath(path) {
  try {
      return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  } catch (e) {
      return null;
  }
}

// FORCE FILL: Deep native injection (Untouched)
async function forceFill(element, text) {
  element.focus();
  element.select();
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(element, text);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.blur();
}

// TYPE LIKE HUMAN: Bypass for masked fields (Untouched)
async function typeLikeHuman(element, text) {
  element.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(element, '');
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);
  
  for (let char of text) {
      setter.call(element, element.value + char);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(30);
  }
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.blur();
}

// MAXIMUM SPEED CLICK (Untouched)
function fastClick(element) {
  element.focus();
  element.click();
  ['mousedown', 'mouseup'].forEach(eventType => {
      element.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window }));
  });
}

// HUMAN DELAY CLICK (Untouched)
async function humanClick(element) {
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(500 + Math.random() * 300);
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await sleep(200 + Math.random() * 200);
  element.click();
}

// ==========================================
// COOKIE CONSENT AUTO-ACCEPT
// Clicks the "Accept All" button on the Goethe privacy/cookie banner.
// Works in any language by matching common button texts AND known selectors.
// Runs on every cycle until the banner is gone.
// ==========================================
function acceptCookieBanner() {
  // 1) Known Goethe / Usercentrics / common consent selectors
  const knownSelectors = [
    'button[data-testid="uc-accept-all-button"]',
    '#onetrust-accept-btn-handler',
    'button#accept-all',
    'button.cs-button--accept',
    'button[aria-label*="Accept" i]',
    'button[title*="Accept" i]'
  ];
  for (const sel of knownSelectors) {
    const btn = document.querySelector(sel);
    if (btn && btn.offsetParent !== null) { btn.click(); return true; }
  }

  // 2) Text-based fallback — matches "Accept All" in several languages
  const acceptTexts = [
    'accept all', 'accept all cookies', 'allow all', 'i accept', 'accept',
    'alle akzeptieren', 'alles akzeptieren', 'zustimmen',        // German
    'tout accepter', 'accepter tout',                            // French
    'aceptar todo'                                               // Spanish
  ];
  const buttons = Array.from(document.querySelectorAll('button, a[role="button"], div[role="button"]'));
  for (const b of buttons) {
    const txt = (b.textContent || '').trim().toLowerCase();
    if (!txt || b.offsetParent === null) continue;
    if (acceptTexts.includes(txt)) { b.click(); return true; }
  }
  // Looser contains-match as last resort (avoid "Deny"/"Settings")
  for (const b of buttons) {
    const txt = (b.textContent || '').trim().toLowerCase();
    if (!txt || b.offsetParent === null) continue;
    const isAccept = (txt.includes('accept') || txt.includes('akzeptier') || txt.includes('accepter'));
    const isReject = (txt.includes('deny') || txt.includes('reject') || txt.includes('setting') || txt.includes('ablehnen'));
    if (isAccept && !isReject) { b.click(); return true; }
  }
  return false;
}

// ==========================================
// SWARM BRAIN INJECTION (Replaces old popup storage)
// ==========================================
async function syncDroneState() {
   return new Promise((resolve) => {
       const match = window.location.href.match(/fleetDroneId=([^&]+)/);
       const urlDroneId = match ? match[1] : null;
       const sessMatch = window.location.href.match(/fleetSession=([^&]+)/);
       const urlSession = sessMatch ? sessMatch[1] : null;

       chrome.storage.local.get(null, (state) => {
           let newState = { ...state };
           if (urlDroneId && !state.fleetDroneId) {
               // First time this drone is launching
               newState.fleetDroneId = urlDroneId;
               newState.fleetSession = urlSession;
               newState.fleetUser = null;
               newState.fleetCC = null;
               newState.exam_base_url = cleanExamUrl(window.location.href);
               chrome.storage.local.set(newState, () => resolve(newState));
           } else {
               resolve(newState);
           }
       });
   });
}

async function reportStatus(droneId, message, page) {
   if (!droneId) return;
   try {
       await fetch(`${API_URL}/bot-status`, {
           method: 'POST', headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({ droneId, message, page: page || null })
       });
   } catch(e) {}
}

// Push a milestone into the dashboard's GLOBAL system log feed (sysLog), in
// addition to the per-drone status row. Use for meaningful events only — link
// acquired, rate-limited, IP rotation — NOT every poll (keeps the feed clean).
async function droneLog(droneId, message, type) {
   if (!droneId) return;
   try {
       await fetch(`${API_URL}/drone-log`, {
           method: 'POST', headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({ droneId, message, type: type || 'info' })
       });
   } catch(e) {}
}

// Pull the booking link the SERVER's direct-IP hunter found (fast path). The
// server is usually first because it polls over a direct, low-latency line
// while drones go through NordVPN SOCKS. Returns "" until the server has it.
async function fetchServerExamLink() {
   try {
       const r = await fetch(`${API_URL}/exam-link`, { cache: 'no-store' });
       if (!r.ok) return "";
       const j = await r.json();
       return (j && j.link) ? j.link : "";
   } catch (e) { return ""; }
}

// Share a link THIS drone found back to the server so every other drone uses it
// (and the server stops its own polling). "whoever gets it first wins."
async function reportFoundLink(droneId, link, via) {
   if (!droneId || !link) return;
   try {
       await fetch(`${API_URL}/found-link`, {
           method: 'POST', headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({ droneId, link, via: via || 'fetch' })
       });
   } catch (e) {}
}

// Has the scheduled automation-start time arrived? Drones warm up (load the
// page) immediately but only start clicking/booking once this returns live.
// Fail-open: any server/endpoint problem returns live so we never block.
async function checkGoLive() {
   try {
       const r = await fetch(`${API_URL}/go-status`);
       if (!r.ok) return { live: true };
       return await r.json();
   } catch (e) {
       return { live: true };
   }
}

// Per-drone bot control: is this drone paused (manually, or auto at a page), and
// which page is it configured to auto-pause at? Fail-open so a server hiccup
// never freezes a drone.
async function getDroneControl(droneId) {
   try {
       const r = await fetch(`${API_URL}/drone-control/${droneId}`);
       if (!r.ok) return { paused: false };
       return await r.json();
   } catch (e) {
       return { paused: false };
   }
}
async function requestPause(droneId, page, manual) {
   try {
       await fetch(`${API_URL}/pause-drone/${droneId}`, {
           method: 'POST', headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ page: page || null, manual: !!manual })
       });
   } catch (e) {}
}

// Detect which logical page we're on (for the dashboard page-status highlight)
function detectPage() {
   const url = window.location.href.toLowerCase();
   if (url.includes('paymentiq') || url.includes('cashier')) return 'payment';
   if (url.includes('wicket')) return 'wicket';
   if (url.includes('options')) return 'options';
   if (url.includes('login')) return 'login';
   if (url.includes('summary')) return 'summary';
   if (url.includes('voucher') || url.includes('psp-selection') || url.includes('oska-acc')) return 'voucher';
   if (url.includes('selection')) return 'selection';
   if (url.includes('examid')) return 'landing';
   return 'other';
}

// ==========================================
// MASTER LOOP
// ==========================================
async function runAutomationCycle() {
  try {
      const state = await syncDroneState();
      
      if (!state.fleetDroneId) return; // If there is no drone ID, this browser wasn't launched by the Swarm. Ignore it.

      // =========================================================
      // EXAM-ID FAST PATH — owns the landing page entirely, BEFORE the page-load
      // wait. No "Select modules" button, no reload: the drone races (a) the
      // server-distributed link and (b) its own direct fetch, and navigates to the
      // selection page the instant EITHER yields the link. Gated to examId so the
      // booking flow (coe/options/payment) is never disturbed.
      // =========================================================
      if (window.location.href.toLowerCase().includes('examid')) {

          // 1) QUEUE COOLDOWN — after a wicket/queue hit we MUST wait before
          //    retrying (anti-rate-limit). Survives the navigation via storage.
          if (state.wicket_timeout) {
              if (Date.now() < state.wicket_timeout) {
                  const left = Math.ceil((state.wicket_timeout - Date.now()) / 1000);
                  reportStatus(state.fleetDroneId, `⏳ Queue cooldown — retry in ${left}s`, 'wicket');
                  setTimeout(runAutomationCycle, 1000);
                  return;
              }
              await chrome.storage.local.remove('wicket_timeout'); // expired → clear, then retry
              droneLog(state.fleetDroneId, "↩️ Queue cooldown done — retrying", 'info');
          }

          // Fresh attempt from the exam page → clear any /coe 403-retry counter.
          if (state.coe_forbidden_tries) { await chrome.storage.local.remove('coe_forbidden_tries'); }

          // Mark when we first landed on this exam-page instance (for the session
          // settle gate before /coe). Set once per page load.
          if (examFirstSeenAt === 0) examFirstSeenAt = Date.now();

          // 2) GO-LIVE GATE — hold until booking-open time (no early hammering).
          const go = await checkGoLive();
          if (!go.live) {
              const msUntilGo = go.startAt ? (go.startAt - Date.now()) : Infinity;
              if (performance.now() >= WARMUP_REFRESH_MS && msUntilGo > 20000) {
                  reportStatus(state.fleetDroneId, "🔄 Warm-up refresh — keeping session fresh…", 'landing');
                  refreshExamPage(state);
                  return;
              }
              reportStatus(state.fleetDroneId, `🕒 Warmed up — holding for start (${go.startLabel || 'scheduled'})`, 'landing');
              setTimeout(runAutomationCycle, 1000);
              return;
          }

          // 3) MANUAL PAUSE — respect a dashboard pause.
          if (window.self === window.top) {
              const ctrl = await getDroneControl(state.fleetDroneId);
              if (ctrl.paused) {
                  reportStatus(state.fleetDroneId, "⏸ Paused — press Continue on the dashboard", 'landing');
                  setTimeout(runAutomationCycle, 1200);
                  return;
              }
          }

          // SESSION GATE — don't navigate to /coe until Akamai has validated the
          // session (else /coe 403s). Smart: jumps the instant the _abck cookie
          // flips to validated; warm-up satisfies it long before go-live (0 delay).
          const sessionSettled = coeSessionReady();

          // 4) RACE — server link (instant, localhost) first, then this drone's own
          //    direct fetch. Navigate the moment either yields the selection link.
          const serverLink = await fetchServerExamLink();
          if (serverLink) {
              if (!sessionSettled) {
                  reportStatus(state.fleetDroneId, "⏳ Link ready — validating session before selection…", 'landing');
                  setTimeout(runAutomationCycle, 200);
                  return;
              }
              rateLimitStreak = 0;
              reportStatus(state.fleetDroneId, "🟢 Selection link (shared) — navigating…", 'landing');
              droneLog(state.fleetDroneId, "🎯 [Shared] Using link from server/other drone — navigating", 'success');
              window.location.href = serverLink;
              return;
          }
          const res = await fetchExamLink(state);
          droneLog(state.fleetDroneId,
              `🌐 [HTTP fetch] examId page → HTTP ${res.status || 'ERR'}` +
              (res.link ? ' — LINK FOUND' : (res.rateLimited ? ' rate-limited' : ' not open yet')),
              res.rateLimited ? 'warn' : 'info');
          if (res.link) {
              reportFoundLink(state.fleetDroneId, res.link, 'http'); // share to the fleet (others benefit even while we settle)
              if (!sessionSettled) {
                  reportStatus(state.fleetDroneId, "⏳ Link ready — validating session before selection…", 'landing');
                  setTimeout(runAutomationCycle, 200);
                  return;
              }
              rateLimitStreak = 0;
              reportStatus(state.fleetDroneId, "🟢 Selection link (HTTP) — navigating…", 'landing');
              droneLog(state.fleetDroneId, "🎯 [HTTP] This drone fetched the link first — sharing + navigating", 'success');
              window.location.href = res.link;
              return;
          }

          // 5) RATE LIMIT (429/503) — back off; rotate IP after repeated hits.
          if (res.rateLimited) {
              rateLimitStreak++;
              const ROTATE_AFTER = 3;
              if (rateLimitStreak >= ROTATE_AFTER) {
                  reportStatus(state.fleetDroneId, "📡 Rate-limited — rotating IP...", 'landing');
                  droneLog(state.fleetDroneId, `🔁 Rate-limited ${rateLimitStreak}× (HTTP ${res.status}) — rotating IP`, 'warn');
                  try {
                      await fetch(`${API_URL}/proxy-failed/${state.fleetDroneId}`, {
                          method: 'POST', headers: {'Content-Type': 'application/json'},
                          body: JSON.stringify({ reason: `rate-limited HTTP ${res.status}` })
                      });
                  } catch (e) {}
                  rateLimitStreak = 0;
                  return; // server burns proxy + respawns this drone
              }
              const backoffMs = Math.min(60000, 8000 * Math.pow(2, rateLimitStreak - 1)) + Math.floor(Math.random() * 3000);
              const backoffSec = Math.round(backoffMs / 1000);
              reportStatus(state.fleetDroneId, `⚠️ Rate-limited — retry in ${backoffSec}s`, 'landing');
              droneLog(state.fleetDroneId, `⚠️ Rate-limited (HTTP ${res.status}) — backing off ${backoffSec}s (${rateLimitStreak}/${ROTATE_AFTER})`, 'warn');
              setTimeout(runAutomationCycle, backoffMs);
              return;
          }

          // 6) NOT OPEN YET — re-poll every 3–6s (no reload; tab stays warm).
          rateLimitStreak = 0;
          const waitMs = 3000 + Math.floor(Math.random() * 3000);
          reportStatus(state.fleetDroneId, `🕒 No slot yet — re-checking in ${Math.round(waitMs / 1000)}s (HTTP + shared)`, 'landing');
          setTimeout(runAutomationCycle, waitMs);
          return;
      }

      // Tag the window title with "Drone N" so the window daemon can locate this
      // exact window to Focus (bring to front + minimize others) and auto-spotlight.
      // Re-asserted each cycle because the site keeps overwriting document.title.
      if (window.self === window.top) {
          const tag = 'Drone ' + state.fleetDroneId;
          if (document.title.indexOf(tag) !== 0) {
              document.title = tag + ' — ' + (document.title || 'Goethe');
          }
      }

      // Act as soon as the DOM is parsed ('interactive') — do NOT wait for the full
      // 'load' event ('complete'). On a VPN, one slow/hanging sub-resource (tracker,
      // font, image) can delay 'load' by its ~30s timeout, which would stall the
      // drone on the page even though all the elements it needs are already present.
      // The state handlers below poll for their own elements, so acting at
      // 'interactive' is safe and removes that 30s navigation stall.
      if (document.readyState === 'loading') {
          setTimeout(runAutomationCycle, 100);
          return;
      }

      // INSTRUMENTATION: log (once per page load) how long this page took to become
      // actionable + its readyState, so the navigation timing is visible on the dashboard.
      if (!navLogged) {
          navLogged = true;
          droneLog(state.fleetDroneId, `⏱️ [nav] '${detectPage()}' actionable in ${Math.round(performance.now())}ms (readyState=${document.readyState})`, 'info');
      }

      // COOKIE BANNER: always try to dismiss the privacy/consent popup first.
      // It can appear on any page and blocks clicks underneath it.
      acceptCookieBanner();

      const currentUrl = window.location.href.toLowerCase();

      // ---------------------------------------------------------
      // WARM-UP GATE: if a scheduled automation-start time is set, the drone
      // has loaded the page (warm: proxy connected, session live, cookies
      // dismissed) but must HOLD — no clicking, grabbing or booking — until
      // the server says GO. Without a scheduled time this is a no-op.
      // ---------------------------------------------------------
      const go = await checkGoLive();
      if (!go.live) {
          // Keep the session fresh on long holds: reload once this page has been
          // sitting past the (jittered) refresh window — but NOT in the final 20s
          // before go-time, so the drone is settled and ready to fire instantly.
          const msUntilGo = go.startAt ? (go.startAt - Date.now()) : Infinity;
          if (performance.now() >= WARMUP_REFRESH_MS && msUntilGo > 20000) {
              reportStatus(state.fleetDroneId, "🔄 Warm-up refresh — keeping session fresh…", detectPage());
              refreshExamPage(state);
              return;
          }
          reportStatus(state.fleetDroneId, `🕒 Warmed up — holding for automation start (${go.startLabel || 'scheduled'})`, detectPage());
          setTimeout(runAutomationCycle, 1000);
          return;
      }

      // ---------------------------------------------------------
      // PAUSE GATE (top frame): hold this drone if it was manually stopped from
      // the dashboard, or auto-pause it the moment it reaches the configured
      // page (config.pauseAtPage). It then waits for Continue. Payment is also
      // guarded again right before the Pay click below (iframe-safe).
      // ---------------------------------------------------------
      if (window.self === window.top) {
          const ctrl = await getDroneControl(state.fleetDroneId);
          const pg = detectPage();
          if (ctrl.pauseAtPage && pg === ctrl.pauseAtPage && ctrl.resumedPage !== pg && !ctrl.paused) {
              await requestPause(state.fleetDroneId, pg, false);
              ctrl.paused = true;
          }
          if (ctrl.paused) {
              reportStatus(state.fleetDroneId, "⏸ Paused — press Continue on the dashboard", pg);
              setTimeout(runAutomationCycle, 1200);
              return;
          }
      }

      // ---------------------------------------------------------
      // DOM SNIFFER 1: CREDIT CARD FIELDS (Inner Iframe) - UNTOUCHED
      // ---------------------------------------------------------
      const ccNumInput = document.querySelector('input[name="ccnumber"], input[name="pan"], input[type="tel"]');
      const ccCvvInput = document.querySelector('input[name="cvv"], input[name="cvc"]');
      
      if (ccNumInput && ccCvvInput && state.fleetCC) {
          if (!state.iframe_filled && !window.isFillingCC) {
              window.isFillingCC = true; 
              console.log("💳 [CC Iframe] Ghost DOM detected! Waiting 3s for the payment iframe to fully render...");
              reportStatus(state.fleetDroneId, "💳 Payment Page: Injecting CC Data...", 'payment');
              
              // CRITICAL: keep this generous. The PaymentIQ iframe needs time to
              // fully paint its card fields before we inject. The slot is already
              // secured at this point, so this wait costs nothing and prevents
              // the card fill from failing on a half-rendered form.
              await sleep(3000);
              
              const freshCcName = document.querySelector('input[name="chname"], input[name="cardholderName"], input[autocomplete="cc-name"]');
              const freshCcNum = document.querySelector('input[name="ccnumber"], input[name="pan"], input[type="tel"]');
              const freshCcCvv = document.querySelector('input[name="cvv"], input[name="cvc"]');
              const freshCcExp = document.querySelector('input[name="ccexp"], input[name="exp-date"], input[autocomplete="cc-exp"], input[name="expiry"], input[placeholder*="MM"]');
              
              if (freshCcNum && freshCcCvv) {
                  console.log("💳 [CC Iframe] UI settled. Injecting card data now...");
                  if (freshCcName && state.fleetCC.name) await forceFill(freshCcName, state.fleetCC.name);
                  if (freshCcNum && state.fleetCC.num) await forceFill(freshCcNum, state.fleetCC.num);
                  if (freshCcCvv && state.fleetCC.cvv) await forceFill(freshCcCvv, state.fleetCC.cvv);
                  if (freshCcExp && state.fleetCC.exp) await typeLikeHuman(freshCcExp, state.fleetCC.exp);
                  
                  await chrome.storage.local.set({ iframe_filled: true });
                  console.log("✅ [CC Iframe] Card data injected.");
              } else {
                  window.isFillingCC = false;
              }
          }
          setTimeout(runAutomationCycle, 1500);
          return;
      }

      // ---------------------------------------------------------
      // DOM SNIFFER 2: THE PAY BUTTON (Outer Cashier Iframe) - UNTOUCHED
      // ---------------------------------------------------------
      let payBtn = document.querySelector('button.submit-button') ||
                   document.querySelector('button.cashier-button') ||
                   getElementByXPath('/html/body/div/div/section/div[2]/div[3]/button');

      if (!payBtn) {
          const allBtns = Array.from(document.querySelectorAll('button'));
          payBtn = allBtns.find(b => b.textContent.trim().toLowerCase() === 'pay');
      }
      
      if (payBtn) {
          if (payBtn.disabled || payBtn.getAttribute('disabled') === 'disabled') {
              console.log("⏳ [Cashier Iframe] Pay button is disabled. Waiting for gateway...");
              setTimeout(runAutomationCycle, 1000);
              return;
          }

          // PAUSE GATE (payment): if this drone was stopped, or "pause at payment"
          // is set, HOLD here before clicking Pay until Continue is pressed.
          const payCtrl = await getDroneControl(state.fleetDroneId);
          if (payCtrl.paused || (payCtrl.pauseAtPage === 'payment' && payCtrl.resumedPage !== 'payment')) {
              if (!payCtrl.paused) await requestPause(state.fleetDroneId, 'payment', false);
              reportStatus(state.fleetDroneId, "⏸ Paused before Pay — press Continue on the dashboard", 'payment');
              setTimeout(runAutomationCycle, 1500);
              return;
          }

          if (state.iframe_filled && !state.pay_clicked && !window.isClickingPay) {
              window.isClickingPay = true;
              console.log("✅ [Cashier Iframe] Bridge confirmed. Initiating final click sequence...");
              
              await chrome.storage.local.set({ pay_clicked: true });
              
              payBtn.style.border = "4px solid #2dd4bf";
              payBtn.style.backgroundColor = "#2dd4bf";
              payBtn.style.color = "black";
              payBtn.textContent = "BOT CLICKING!";
              reportStatus(state.fleetDroneId, "🚀 CLICKING PAY BUTTON!", 'payment');
              
              // Give the gateway a moment to register the injected CC data
              // before clicking Pay (prevents an empty/invalid submission).
              await sleep(1500);
              payBtn.click();
              console.log("🚀 PAY BUTTON CLICKED!");
              
              // SWARM: Notify the dashboard we hit OTP
              await fetch(`${API_URL}/otp-wait`, {
                  method: 'POST', headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({ droneId: state.fleetDroneId })
              });

              return;
          } else if (!state.iframe_filled) {
              payBtn.style.border = "2px dashed orange";
              console.log("⏳ [Cashier Iframe] Waiting for inner CC frame to finish filling details...");
              setTimeout(runAutomationCycle, 1000);
          }
          return;
      }

      // ---------------------------------------------------------
      // IFRAME KILL-SWITCH - UNTOUCHED
      // ---------------------------------------------------------
      if (window.self !== window.top) {
          if (currentUrl.includes('paymentiq') || currentUrl.includes('cashier')) {
              setTimeout(runAutomationCycle, 1000);
          }
          return;
      }

      // --- STATE: WICKET QUEUE (RETREAT) ---
      if (currentUrl.includes('wicket')) {
          console.log("🛑 [State: Wicket] Rate limiter queue hit! Retreating...");
          reportStatus(state.fleetDroneId, "⚠️ Wicket Queue! Retreating...", 'wicket');

          // Original randomized penalty: 7-12s before re-attempting (evades ban).
          const penaltyWaitTime = 7000 + (Math.random() * 5000);
          await chrome.storage.local.set({ wicket_timeout: Date.now() + penaltyWaitTime });

          window.location.href = state.exam_base_url || "/";
          return;
      }
      // (Queue cooldown is enforced by the EXAM-ID FAST PATH at the top of the
      // cycle, which holds on the exam page until wicket_timeout expires before
      // re-attempting — so there's no standalone penalty-sleep here anymore.)

      // --- STATE: ACTUAL RATE LIMIT / BLOCK (BURN & ROTATE IP) ---
      // Compute page text only here (it's an expensive reflow, so we avoid
      // doing it every cycle). Detects 429 rate-limits AND 403 Forbidden.
      const pageText = (document.body.innerText || '').toLowerCase();

      // PERMANENT IP BAN — Goethe blocks the exit IP itself ("Your IP address …
      // has been blocked due to misuse."). Reloading is POINTLESS (the IP is dead);
      // we must burn this proxy and rotate to a fresh IP immediately, with NO retry.
      const isBannedIp = pageText.includes("blocked due to misuse") ||
                         pageText.includes("has been blocked") ||
                         (pageText.includes("your ip address") && pageText.includes("blocked"));

      const isHardBlocked = isBannedIp ||
                            pageText.includes("too many requests") ||
                            pageText.includes("permanently blocked") ||
                            pageText.includes("access denied") ||
                            pageText.includes("http status 429") ||
                            pageText.includes("http status 403") ||
                            pageText.includes("403 forbidden") ||
                            pageText.includes("your request was forbidden") ||
                            pageText.includes("request was forbidden by the server") ||
                            (pageText.includes("forbidden") && pageText.length < 400); // short "Forbidden" error page

      if (isHardBlocked && !currentUrl.includes('wicket')) {
          // TRANSIENT /coe 403 (NOT a ban): Akamai's FIRST hit on the selection page
          // often returns "Forbidden", then succeeds on a retry within the SAME IP/
          // session — like clicking "Select modules", getting Forbidden, and it
          // working on the 2nd click. So on /coe we RELOAD a few times first.
          // A banned-IP page skips this entirely (reloading can't fix a dead IP).
          if (!isBannedIp && currentUrl.includes('/coe')) {
              const tries = (state.coe_forbidden_tries || 0) + 1;
              const MAX_COE_RETRIES = 4;
              if (tries <= MAX_COE_RETRIES) {
                  await chrome.storage.local.set({ coe_forbidden_tries: tries });
                  reportStatus(state.fleetDroneId, `🔁 Selection 403 — retrying (${tries}/${MAX_COE_RETRIES})…`, 'selection');
                  droneLog(state.fleetDroneId, `🔁 /coe transient 403 — retry ${tries}/${MAX_COE_RETRIES} (same IP, like a 2nd click)`, 'warn');
                  await sleep(600 + Math.floor(Math.random() * 1200)); // brief human-like pause
                  window.location.reload(); // re-hit the SAME /coe link
                  return;
              }
              await chrome.storage.local.remove('coe_forbidden_tries'); // exhausted → real block
          }
          await chrome.storage.local.remove('coe_forbidden_tries');
          // Parse the banned IP from the page so the server can record it.
          let bannedIp = null;
          if (isBannedIp) {
              const m = (document.body.innerText || '').match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
              bannedIp = m ? m[0] : null;
              reportStatus(state.fleetDroneId, "🚫 IP banned by Goethe — saving to ban list & rotating...", 'wicket');
              droneLog(state.fleetDroneId, `🚫 IP permanently banned${bannedIp ? ` (${bannedIp})` : ''} — added to persistent ban list, rotating (no retry)`, 'error');
          } else {
              reportStatus(state.fleetDroneId, "🔥 Rate-limited (429) — burning for this run & rotating...", 'wicket');
          }
          await fetch(`${API_URL}/report-429`, {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ droneId: state.fleetDroneId, banned: isBannedIp, bannedIp })
          });
          return;
      }

      // --- STATE: BROWSER-LEVEL NETWORK / PROXY ERROR PAGE ---
      // A flaky NordVPN/SOCKS server that drops the connection mid-flow shows a
      // "no network connection" / "site can't be reached" page. This is NOT a
      // login failure and NOT a rate-limit — it's a dead proxy. Burn it and
      // rotate to a different server instead of blaming the user's credentials.
      // (True chrome-error:// pages are caught by background.js; this catches
      // HTML error pages served with a 200 by a CDN/relay.)
      const looksOffline = pageText.includes('no network connection') ||
                           pageText.includes('no internet') ||
                           pageText.includes("site can’t be reached") ||
                           pageText.includes("site can't be reached") ||
                           pageText.includes('took too long to respond') ||
                           pageText.includes('err_proxy_connection_failed') ||
                           pageText.includes('err_tunnel_connection_failed') ||
                           pageText.includes('err_socks_connection_failed') ||
                           pageText.includes('err_connection_reset') ||
                           pageText.includes('err_connection_closed') ||
                           pageText.includes('err_connection_timed_out') ||
                           pageText.includes('err_timed_out') ||
                           pageText.includes('err_name_not_resolved') ||
                           pageText.includes('err_internet_disconnected');
      if (looksOffline) {
          reportStatus(state.fleetDroneId, "📡 Network/proxy error — rotating IP...", 'wicket');
          try {
              await fetch(`${API_URL}/proxy-failed/${state.fleetDroneId}`, {
                  method: 'POST', headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({ reason: 'offline error page' })
              });
          } catch (e) {}
          return; // server burns the proxy and respawns this drone on a new one
      }

      // (The examId LANDING page is fully handled by the EXAM-ID FAST PATH at the
      // top of this cycle — server-link + own-fetch race, no button, no reload.
      // Execution only reaches here on the booking-flow pages below.)

      // --- STATE: OPTIONS (MODULE CHECKBOXES) ---
      if (currentUrl.includes('options')) {
          const checkboxes = document.querySelectorAll('input[type="checkbox"]');
          const continueBtn = document.querySelector('button.cs-button--arrow_next');

          if (checkboxes.length === 0 || !continueBtn) {
              // Checkboxes not painted yet — poll quickly (was 500ms)
              setTimeout(runAutomationCycle, 150);
              return;
          }

          // Scan availability ONCE and cache it (avoids 3x repeated DOM scans)
          const allModules = ['reading', 'writing', 'speaking', 'listening'];
          const boxByModule = {};
          const availableNow = [];
          for (const m of allModules) {
              const cb = findCheckboxByLabelText(m);
              if (cb) { boxByModule[m] = cb; availableNow.push(m); }
          }

          // SWARM: no user yet → match one to what's available, then select IMMEDIATELY
          if (!state.fleetUser) {
              if (availableNow.length === 0) {
                  reportStatus(state.fleetDroneId, "❌ No modules available on this slot.", 'options');
                  setTimeout(() => { window.location.href = state.exam_base_url || "/"; }, 800);
                  return;
              }
              reportStatus(state.fleetDroneId, `🎯 Opening [${availableNow.join(', ')}]! Matching user...`, 'options');
              try {
                  const res = await fetch(`${API_URL}/grab-user/${state.fleetDroneId}?avail=${encodeURIComponent(availableNow.join(','))}`);
                  const data = await res.json();
                  if (data.available) {
                      // Store the user, then fall straight through to selection in THIS pass —
                      // no full-loop restart, no 500ms wait.
                      state.fleetUser = data.user;
                      state.fleetCC = data.creditCard;
                      window.loginFailReported = false;
                      chrome.storage.local.set({ fleetUser: data.user, fleetCC: data.creditCard, login_attempted: false });
                  } else if (data.reason === 'no_match') {
                      // Don't kill the drone — keep the browser open, notify the
                      // dashboard, and keep re-checking so it picks up a user if one
                      // is added/freed that matches these modules.
                      reportStatus(state.fleetDroneId, "⚠️ No valid user for these modules — holding (will retry)", 'options');
                      await fetch(`${API_URL}/no-match/${state.fleetDroneId}`, { method: 'POST' });
                      setTimeout(runAutomationCycle, 8000);
                      return;
                  } else {
                      reportStatus(state.fleetDroneId, "💤 Holding: Queue empty.", 'options');
                      setTimeout(runAutomationCycle, 2000);
                      return;
                  }
              } catch(e) { setTimeout(runAutomationCycle, 800); return; }
          }

          // We have a user — decide using the cached scan (no re-scanning)
          const desiredModules = state.fleetUser.modules || [];
          const presentDesired = desiredModules.filter(m => boxByModule[m]);
          const missingCount = desiredModules.length - presentDesired.length;

          if (presentDesired.length === 0) {
              reportStatus(state.fleetDroneId, "❌ Modules sold out since assignment. Releasing user.", 'options');
              await fetch(`${API_URL}/release-user/${state.fleetDroneId}`, { method: 'POST' });
              await chrome.storage.local.set({ fleetUser: null, fleetCC: null, login_attempted: false });
              setTimeout(() => { window.location.href = state.exam_base_url || "/"; }, 800);
              return;
          }
          if (missingCount > 0 && !state.fleetUser.partial) {
              reportStatus(state.fleetDroneId, "❌ Missing modules & Partial OFF. Releasing user.", 'options');
              await fetch(`${API_URL}/release-user/${state.fleetDroneId}`, { method: 'POST' });
              await chrome.storage.local.set({ fleetUser: null, fleetCC: null, login_attempted: false });
              setTimeout(() => { window.location.href = state.exam_base_url || "/"; }, 800);
              return;
          }

          // Tick desired, untick others — using the cached checkbox references
          for (const m of allModules) {
              const cb = boxByModule[m];
              if (!cb) continue;
              const want = desiredModules.includes(m);
              if (want && !cb.checked) fastClick(cb);
              else if (!want && cb.checked) fastClick(cb);
          }

          reportStatus(state.fleetDroneId, `✅ Selected [${presentDesired.join(', ')}] — continuing`, 'options');
          fastClick(continueBtn);
          setTimeout(runAutomationCycle, 250);
          return;
      }

      // --- STATE: SELECTION - UNTOUCHED ---
      if (currentUrl.includes('selection') && !currentUrl.includes('psp-selection')) {
          const bookForMyselfBtn = Array.from(document.querySelectorAll('button, a, div[role="button"]'))
                                       .find(el => el.textContent.toLowerCase().includes('book for myself'));
          if (bookForMyselfBtn) {
              fastClick(bookForMyselfBtn);
              setTimeout(runAutomationCycle, 250);
          } else setTimeout(runAutomationCycle, 200);
          return;
      }

      // --- STATE: LOGIN (with failure detection) ---
      if (currentUrl.includes('login') && state.fleetUser) {
          // If we already submitted once and we're STILL on the login page,
          // the credentials were rejected. Report failure and STOP (no retry).
          if (state.login_attempted && !window.loginFailReported) {
              // Look for an error message OR simply the fact we're back on login
              // Only treat this as a credential failure on EXPLICIT error text or
              // the site's own specific error element. The previous broad
              // [class*="error"] match fired on benign pages (and on proxy error
              // pages), wrongly burning good users — removed on purpose.
              const errText = document.body.innerText.toLowerCase();
              const looksFailed = errText.includes('incorrect') || errText.includes('invalid') ||
                                  errText.includes('wrong') || errText.includes('falsch') ||
                                  errText.includes('not correct') || errText.includes('try again') ||
                                  errText.includes('ungültig') || errText.includes('anmeldung fehlgeschlagen') ||
                                  document.querySelector('.cs-message--error');
              if (looksFailed) {
                  window.loginFailReported = true;
                  console.log("🔐 [State: Login] LOGIN FAILED. Reporting and stopping for this user.");
                  reportStatus(state.fleetDroneId, "🔐 Login FAILED — releasing user", 'login');
                  await fetch(`${API_URL}/login-failed`, {
                      method: 'POST', headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ droneId: state.fleetDroneId })
                  });
                  return; // Stop. Server will respawn this drone for a different user.
              }
          }

          reportStatus(state.fleetDroneId, `🔑 Login Page: ${state.fleetUser.email}`, 'login');
          const emailInput = document.querySelector('input[type="email"]') || document.querySelector('input[name="email"]');
          const passwordInput = document.querySelector('input[type="password"]');
          const loginBtn = document.querySelector('button[type="submit"]') || document.querySelector('input[type="submit"]');

          if (emailInput && passwordInput && loginBtn) {
              if (!state.login_attempted) {
                  emailInput.value = state.fleetUser.email;
                  emailInput.dispatchEvent(new Event("input", { bubbles: true }));
                  passwordInput.value = state.fleetUser.pass;
                  passwordInput.dispatchEvent(new Event("input", { bubbles: true }));

                  await chrome.storage.local.set({ login_attempted: true });
                  fastClick(loginBtn);
                  setTimeout(runAutomationCycle, 1500);
              } else {
                  // Submitted but no clear error yet — wait, then re-check
                  setTimeout(runAutomationCycle, 800);
              }
          } else setTimeout(runAutomationCycle, 500);
          return;
      }

      // --- STATE: VOUCHER / PSP - UNTOUCHED ---
      if (currentUrl.includes('voucher') || currentUrl.includes('psp-selection') || currentUrl.includes('oska-acc')) {
          const continueBtn = document.querySelector('button.cs-button--arrow_next');
          if (continueBtn) {
              fastClick(continueBtn);
              setTimeout(runAutomationCycle, 250);
          } else setTimeout(runAutomationCycle, 200);
          return;
      }

      // --- STATE: SUMMARY - UNTOUCHED ---
      if (currentUrl.includes('summary')) {
          const orderBtn = Array.from(document.querySelectorAll('button.cs-button--arrow_next'))
                               .find(b => b.textContent.includes('Order')) || document.querySelector('#GbOqxNTGvcLDigEGGERI');
          if (orderBtn) {
              fastClick(orderBtn);
              setTimeout(runAutomationCycle, 800);
          } else setTimeout(runAutomationCycle, 250);
          return;
      }

      // Fallback polling (Quiet state)
      setTimeout(runAutomationCycle, 1000);
      
  } catch (error) {
      console.error("⚠️ [Engine Alert] GoetheGrabber recovered from an error:", error);
      setTimeout(runAutomationCycle, 1000);
  }
}

// Start the loop automatically!
runAutomationCycle();