const API_URL = "http://127.0.0.1:3000/api";
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
               newState.exam_base_url = window.location.href.split('&fleetDroneId')[0];
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

      if (document.readyState !== 'complete') {
          setTimeout(runAutomationCycle, 500);
          return;
      }

      // COOKIE BANNER: always try to dismiss the privacy/consent popup first.
      // It can appear on any page and blocks clicks underneath it.
      acceptCookieBanner();

      const currentUrl = window.location.href.toLowerCase();

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

      if (state.wicket_timeout && Date.now() < state.wicket_timeout) {
          const remainingSleep = state.wicket_timeout - Date.now();
          console.log(`⏳ [State: Penalty] Waiting ${Math.round(remainingSleep/1000)} seconds to evade ban...`);
          reportStatus(state.fleetDroneId, `⏳ Waiting ${Math.round(remainingSleep/1000)}s...`);
          await sleep(remainingSleep);
          await chrome.storage.local.remove("wicket_timeout");
      }

      // --- STATE: ACTUAL RATE LIMIT / BLOCK (BURN & ROTATE IP) ---
      // Compute page text only here (it's an expensive reflow, so we avoid
      // doing it every cycle). Detects 429 rate-limits AND 403 Forbidden.
      const pageText = (document.body.innerText || '').toLowerCase();
      const isHardBlocked = pageText.includes("too many requests") ||
                            pageText.includes("permanently blocked") ||
                            pageText.includes("access denied") ||
                            pageText.includes("http status 429") ||
                            pageText.includes("http status 403") ||
                            pageText.includes("403 forbidden") ||
                            pageText.includes("your request was forbidden") ||
                            pageText.includes("request was forbidden by the server") ||
                            (pageText.includes("forbidden") && pageText.length < 400); // short "Forbidden" error page

      if (isHardBlocked && !currentUrl.includes('wicket')) {
          reportStatus(state.fleetDroneId, "🔥 Blocked (403/429). Burning IP & rotating...", 'wicket');
          await fetch(`${API_URL}/report-429`, {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ droneId: state.fleetDroneId })
          });
          return; 
      }

      // --- STATE: EXAM ID (Landing Page) - UNTOUCHED ---
      if (currentUrl.includes('examid') || document.querySelector("a[onclick='gotoExamDetail()']")) {
          reportStatus(state.fleetDroneId, "🟢 Landing Page: Pushing to options...", 'landing');

          const firstBtn = document.querySelector("a[onclick='gotoExamDetail()']");
          if (firstBtn) {
              // Human-like interaction: scroll into view + natural delay before
              // clicking (keeps the bot looking organic to the site).
              console.log("👉 [State: Landing Page] Button found! Clicking (human sim)...");
              await humanClick(firstBtn);
              setTimeout(runAutomationCycle, 2000);
          } else {
              // No slot open yet. Wait a randomised 20-30s before refreshing so
              // we don't hammer the server (which triggers rate-limits / 429s).
              const waitMs = 20000 + Math.floor(Math.random() * 10000);
              const waitSec = Math.round(waitMs / 1000);
              reportStatus(state.fleetDroneId, `🕒 No slot yet — refreshing in ${waitSec}s`, 'landing');
              await sleep(waitMs);
              window.location.reload();
          }
          return;
      }

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
                      reportStatus(state.fleetDroneId, "🚫 No queued user matches available modules. Stopping drone.", 'options');
                      await fetch(`${API_URL}/no-match/${state.fleetDroneId}`, { method: 'POST' });
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
              const errText = document.body.innerText.toLowerCase();
              const looksFailed = errText.includes('incorrect') || errText.includes('invalid') ||
                                  errText.includes('wrong') || errText.includes('falsch') ||
                                  errText.includes('not correct') || errText.includes('try again') ||
                                  document.querySelector('.error, .cs-message--error, [class*="error"]');
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