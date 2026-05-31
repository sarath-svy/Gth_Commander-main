# 🚀 Goethe Fleet Commander

Automated multi-browser exam-slot booking for the Goethe Institut website.
A central dashboard launches several browser windows ("drones"), each hunting
for an open exam slot. When one opens, a queued user is booked automatically —
through to the payment page — across many browsers at once.

---

## What it does

- Opens **multiple browser windows** at the same time, each with its own
  isolated profile and (optionally) its own IP.
- A live **dashboard** shows every drone's page, assigned user, and proxy.
- **IP rotation** (custom proxies or NordVPN SOCKS5) to dodge rate-limits.
- **Anti-fingerprinting** so the site can't tell the windows are one machine.
- **Sound + visual alerts** when a drone reaches the Options or Payment page.
- **Spotlight** a single browser to the front, kill/add drones on the fly,
  auto-retry failed logins, scheduled start, and a booking-history CSV.

> ⚠️ Use this only for accounts and bookings you are authorised to manage.

---

## 1. Requirements

| Need | Why | Notes |
|------|-----|-------|
| **Windows 10/11** | The window controls + browser launching use Windows tools | macOS/Linux not supported as-is |
| **Node.js 18 or newer** | Runs the server | Download from <https://nodejs.org> (LTS) |
| **Microsoft Edge** (recommended) | Runs the booking extension reliably | Pre-installed on Windows |
| *(optional)* A proxy provider or **NordVPN** | Unique IP per browser | See "IP Rotation" below |
| *(optional)* **Python** + CloakBrowser | Strongest anti-fingerprint | Only if you choose the Cloak engine |

**Why Edge?** Google removed command-line extension loading from normal Chrome
(v137+). Edge still allows it, so the bot runs out-of-the-box on Edge. To use
Chrome, you need "Chrome for Testing" or CloakBrowser (see below).

---

## 2. Install Node.js

1. Go to <https://nodejs.org> and download the **LTS** installer.
2. Run it, click Next through the defaults, and finish.
3. Verify it works — open **Command Prompt** and run:
   ```cmd
   node --version
   npm --version
   ```
   Both should print a version number. If `node` is "not recognized", close
   and reopen Command Prompt, or restart your PC so the PATH updates.

---

## 3. Install the Commander

1. Copy the whole `Gth_Commander-main` folder to your PC (e.g. your Desktop).
2. Open **Command Prompt** and go into the folder:
   ```cmd
   cd "C:\Users\YOURNAME\Desktop\Gth_Commander-main"
   ```
3. Install the dependencies (one time only):
   ```cmd
   npm install
   ```
   This reads `package.json` and downloads everything into `node_modules`.

---

## 4. Run it

```cmd
npm start
```
or
```cmd
node server.js
```

You'll see:
```
==================================================
  📡 Goethe Fleet Commander — Online
  🌐 Dashboard: http://localhost:3000
==================================================
```

Open a browser and go to **http://localhost:3000**.

> ⚠️ Do NOT open the HTML file directly and do NOT use VS Code "Live Server".
> The dashboard only works when served by `node server.js` on port 3000.

To stop the server: click the Command Prompt window and press **Ctrl + C**.

---

## 5. Using the dashboard

1. **Target Exam URL** — paste the Goethe exam booking link.
2. **Browser Engine** — leave on **Edge** (recommended).
3. **Max Drones** — how many browser windows to open (start with 2–3).
4. **Payment tab** — enter the card details (used for all users).
5. **Network tab** — pick your IP-rotation mode (see below).
6. **User Queue** — add each user's Goethe email + password + which modules
   to book, and whether "Allow partial booking" is on.
7. Click **💾 Save Configuration** (saves in your browser).
8. Click **▶ Ignite Swarm**.

Each drone opens, hunts for a slot, and books the next queued user when one is
found. When a drone reaches the **Payment** page it auto-marks the user as
booked and waits — you finish the bank OTP / 3-D Secure manually, then click
**🗙 Kill This Drone** to recycle it for the next user.

---

## 6. IP Rotation (avoid rate-limits)

In the **Network** tab pick one:

- **None** – all drones share your real IP. Simplest, but risky.
- **Custom Proxies** – paste one proxy per line. Supported formats:
  - `host:port`
  - `host:port:username:password`
  - `socks5://user:pass@host:port`
- **NordVPN SOCKS5** – enter your NordVPN **Service** username/password (from
  the NordVPN dashboard → Manual Setup → Service Credentials — NOT your login
  email) and tick countries (Netherlands, Sweden, USA are the available ones).

Use at least as many proxies as drones. When a drone is rate-limited (HTTP
429/403), the system burns that IP and relaunches the drone with a fresh one.

---

## 7. Anti-Fingerprinting (so windows aren't linked)

A unique IP + profile isn't enough — the site can still fingerprint your one
physical machine (GPU, canvas, fonts, etc.). Two layers:

- **Option A (built-in, automatic):** a script spoofs canvas/WebGL/audio and
  hardware hints uniquely per drone. Works on Edge/Chrome with no setup.
- **Option B (CloakBrowser, strongest):** a stealth Chromium that fakes the
  fingerprint at the source level. To use it:
  1. Install Python from <https://python.org> (tick "Add to PATH").
  2. ```cmd
     pip install cloakbrowser
     python -m cloakbrowser install
     ```
  3. In the dashboard, choose the **🥷 Cloak** engine → click
     **🔎 Auto-Detect CloakBrowser** → Ignite.

---

## 8. Files in this project

| File | Purpose |
|------|---------|
| `server.js` | The Node.js server + all the logic |
| `dashboard.html` | The web dashboard UI (served at `/`) |
| `proxyRelay.js` | Local relay so proxies/NordVPN auth works in the browser |
| `windowDaemon.ps1` | Fast window focus/minimize helper |
| `Extension/` | The browser extension the drones run |
| `Extension/content.js` | The booking automation logic |
| `Extension/fingerprint.js` | Per-drone fingerprint spoofing (Option A) |
| `Extension/manifest.json` | Extension manifest |
| `package.json` | Dependency list (read by `npm install`) |
| `booking-history.csv` | Auto-created log of bookings (download from dashboard) |

---

## 9. Troubleshooting

**"node is not recognized"** → Node.js isn't installed or PATH isn't updated.
Reinstall Node.js (LTS) and reopen Command Prompt.

**"address already in use" / port 3000 busy** → an old server is still
running. Close that Command Prompt window, or run:
```cmd
for /f "tokens=5" %a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %a
```
then start again.

**The dashboard loads but "Ignite" does nothing / says can't reach server** →
make sure `node server.js` is still running in Command Prompt and you opened
`http://localhost:3000` (not the file directly).

**Browser opens but the bot doesn't act (Chrome only)** → normal Chrome 137+
can't load the extension. Use **Edge**, or Chrome-for-Testing / CloakBrowser.

**"Turn off extensions in developer mode" popup (Edge)** → this is a Microsoft
security nag that can't be disabled by flags. It's harmless; the bot still runs
underneath it. Use CloakBrowser if you want it gone entirely.

**A browser still signs into a Microsoft account** → the server applies a
sign-in-blocking policy on Ignite. Close ALL Edge windows before igniting so
the policy takes effect on the fresh windows.

---

## 10. Quick start (cheat sheet)

```cmd
:: one time
cd "C:\path\to\Gth_Commander-main"
npm install

:: every time
npm start
:: then open http://localhost:3000
```
