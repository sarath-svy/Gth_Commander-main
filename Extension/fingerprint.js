// ==========================================
// FINGERPRINT SPOOFER (Option A)
// ==========================================
// Runs in the PAGE's main world at document_start (before the site's own JS),
// so the spoofed values are what the page sees. Each drone gets a UNIQUE but
// internally-CONSISTENT fingerprint derived from its fleetSession seed in the
// URL — so canvas/WebGL/audio/navigator differ per drone, making them look
// like separate physical devices instead of the same machine.
//
// NOTE: This is JavaScript-level spoofing. It defeats common/basic fingerprint
// checks. For the strongest evasion use the CloakBrowser engine (Option B),
// which patches fingerprints at the Chromium C++ level.
(function () {
  'use strict';
  try {
    // ---- Seed: unique per drone (from ?fleetSession=...) ----
    var seedStr = '';
    try {
      var m = location.href.match(/fleetSession=([^&]+)/);
      seedStr = m ? m[1] : (location.host || 'seed');
    } catch (e) { seedStr = 'seed'; }

    // Deterministic PRNG from the seed string (mulberry32)
    function hashStr(s) {
      var h = 1779033703 ^ s.length;
      for (var i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
      }
      return (h ^= h >>> 16) >>> 0;
    }
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    var rand = mulberry32(hashStr(seedStr));
    function ri(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
    function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

    // A tiny per-drone noise byte used to perturb canvas/audio
    var noise = ri(1, 9);

    // ====================================================
    // 1) CANVAS fingerprint — perturb pixel data slightly
    // ====================================================
    function patchCanvas() {
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

      CanvasRenderingContext2D.prototype.getImageData = function () {
        var data = origGetImageData.apply(this, arguments);
        try {
          var d = data.data;
          for (var i = 0; i < d.length; i += 4) {
            // nudge a tiny, seed-consistent amount on some pixels
            if ((i / 4) % 13 === 0) {
              d[i]   = (d[i]   + noise) & 255;
              d[i+1] = (d[i+1] + noise) & 255;
              d[i+2] = (d[i+2] + noise) & 255;
            }
          }
        } catch (e) {}
        return data;
      };

      HTMLCanvasElement.prototype.toDataURL = function () {
        try {
          var ctx = this.getContext('2d');
          if (ctx) {
            // draw an invisible seed-based pixel to shift the hash consistently
            ctx.fillStyle = 'rgba(' + noise + ',' + noise + ',' + noise + ',0.01)';
            ctx.fillRect(0, 0, 1, 1);
          }
        } catch (e) {}
        return origToDataURL.apply(this, arguments);
      };
    }

    // ====================================================
    // 2) WEBGL — spoof renderer/vendor + tiny param noise
    // ====================================================
    var gpuVendors = ['Intel Inc.', 'Google Inc. (Intel)', 'Google Inc. (NVIDIA)', 'Google Inc. (AMD)'];
    var gpuRenderers = [
      'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'
    ];
    var spoofVendor = pick(gpuVendors);
    var spoofRenderer = pick(gpuRenderers);

    function patchWebGL(proto) {
      if (!proto) return;
      var orig = proto.getParameter;
      proto.getParameter = function (p) {
        // UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446
        if (p === 37445) return spoofVendor;
        if (p === 37446) return spoofRenderer;
        return orig.apply(this, arguments);
      };
    }

    // ====================================================
    // 3) AUDIOCONTEXT — perturb output frequency data
    // ====================================================
    function patchAudio() {
      try {
        var AP = (window.AnalyserNode && window.AnalyserNode.prototype);
        if (AP && AP.getFloatFrequencyData) {
          var origF = AP.getFloatFrequencyData;
          AP.getFloatFrequencyData = function (arr) {
            origF.apply(this, arguments);
            for (var i = 0; i < arr.length; i += 100) { arr[i] = arr[i] + (noise * 0.0001); }
          };
        }
      } catch (e) {}
    }

    // ====================================================
    // 4) NAVIGATOR — vary hardware hints per drone
    // ====================================================
    function patchNavigator() {
      try {
        var cores = pick([4, 6, 8, 8, 12, 16]);
        var mem = pick([4, 8, 8, 16]);
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: function () { return cores; }, configurable: true });
        Object.defineProperty(navigator, 'deviceMemory', { get: function () { return mem; }, configurable: true });
      } catch (e) {}
    }

    patchCanvas();
    patchWebGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patchWebGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
    patchAudio();
    patchNavigator();
  } catch (e) {
    // never break the page if spoofing fails
  }
})();
