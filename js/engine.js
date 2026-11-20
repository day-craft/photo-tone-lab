/*!
 * engine.js — the "18 Pro" tone engine.
 *
 * Aim: take the slightly dark, shadow-crushed look of an iPhone 14 Pro photo and
 * give it the brighter, wider-dynamic-range look of newer iPhones (Smart HDR 5 /
 * Photographic Styles 3 inspired), without blowing highlights or wrecking skin.
 *
 * How it works
 *  - Tone mapping is a set of per-luminance-level channel LUTs: shadow lift via a
 *    luminance-dependent gamma, an exposure gain, a soft highlight shoulder and a
 *    gentle S-curve. One pass, no per-pixel pow().
 *  - Clarity uses a low-resolution blurred base so local contrast can be added
 *    across tile borders without halos.
 *  - Night preset adds chroma noise smoothing against that same base.
 *  - Export is rendered in horizontal tiles so a 48MP photo never needs one huge
 *    ImageData in memory (iOS Safari friendly).
 */
(function (global) {
  'use strict';

  var LEVELS = 28;

  var PRESETS = {
    standard: {
      key: 'standard',
      name: '18 Pro 표준',
      badge: '화사함',
      desc: '그림자를 살짝 들어 올리고 중간톤을 밝게. 가장 무난한 기본값',
      exposureEV: 0.2, shadows: 0.42, highlight: 0.22, contrast: 0.11,
      warmth: 0.06, vibrance: 0.16, clarity: 0.2, nr: 0.12, sharpen: 0.35, skin: 0.25
    },
    portrait: {
      key: 'portrait',
      name: '실내·인물',
      badge: '피부톤',
      desc: '하이라이트를 부드럽게 눌러 피부를 자연스럽고 따뜻하게',
      exposureEV: 0.12, shadows: 0.34, highlight: 0.26, contrast: 0.0,
      warmth: 0.12, vibrance: 0.08, clarity: 0.08, nr: 0.26, sharpen: 0.18, skin: 0.8
    },
    night: {
      key: 'night',
      name: '저조도·야간',
      badge: '암부 복원',
      desc: '어두운 실내·밤 사진의 그림자를 크게 끌어올리고 노이즈를 정리',
      exposureEV: 0.32, shadows: 0.62, highlight: 0.2, contrast: 0.08,
      warmth: 0.03, vibrance: 0.12, clarity: 0.12, nr: 0.78, sharpen: 0.22, skin: 0.35
    },
    outdoor: {
      key: 'outdoor',
      name: '선명한 야외',
      badge: '선명함',
      desc: '하늘 하이라이트를 지키면서 미세 대비와 색을 진하게',
      exposureEV: 0.06, shadows: 0.28, highlight: 0.35, contrast: 0.15,
      warmth: 0.0, vibrance: 0.2, clarity: 0.36, nr: 0.06, sharpen: 0.5, skin: 0.15
    }
  };
  var PRESET_ORDER = ['standard', 'portrait', 'night', 'outdoor'];

  // Sliders the user can move. Internal look parameters (highlight, vibrance,
  // noise reduction, sharpening) follow the preset.
  var SLIDERS = [
    { key: 'exposureEV', label: '밝기', min: -0.6, max: 1.0, step: 0.01, unit: 'EV', def: 0.18 },
    { key: 'shadows', label: '암부 복원', min: 0, max: 1, step: 0.01, unit: '', def: 0.44 },
    { key: 'contrast', label: '대비', min: -0.5, max: 0.5, step: 0.01, unit: '', def: 0.08 },
    { key: 'warmth', label: '색감·따뜻함', min: -0.5, max: 0.6, step: 0.01, unit: '', def: 0.07 },
    { key: 'clarity', label: '선명도', min: 0, max: 1, step: 0.01, unit: '', def: 0.18 }
  ];

  function paramsFromPreset(presetKey, overrides) {
    var base = PRESETS[presetKey] || PRESETS.standard;
    var p = {};
    for (var k in base) p[k] = base[k];
    p.presetKey = presetKey;
    if (overrides) for (var j in overrides) p[j] = overrides[j];
    return p;
  }

  function normalize(p) {
    var out = {};
    out.exposureEV = num(p.exposureEV, 0.18);
    out.shadows = clamp(num(p.shadows, 0.44), 0, 1);
    out.highlight = clamp(num(p.highlight, 0.34), 0, 1);
    out.contrast = clamp(num(p.contrast, 0.08), -1, 1);
    out.warmth = clamp(num(p.warmth, 0.07), -1, 1);
    out.tint = clamp(num(p.tint, 0), -1, 1);
    out.vibrance = clamp(num(p.vibrance, 0.18), 0, 1);
    out.clarity = clamp(num(p.clarity, 0.18), 0, 1);
    out.nr = clamp(num(p.nr, 0.12), 0, 1);
    out.sharpen = clamp(num(p.sharpen, 0.38), 0, 1);
    out.skin = clamp(num(p.skin, 0.25), 0, 1);
    return out;
  }
  /**
   * The presets assume a 14 Pro photo that came out a bit dark. On an already
   * bright photo the same numbers would look over-cooked, so the strength scales
   * with how dark the source actually is (mean luminance, 0..1).
   */
  function adaptToImage(p, mean) {
    var k = 1;
    if (typeof mean === 'number' && isFinite(mean)) k = clamp((0.52 - mean) / 0.24, 0.3, 1.12);
    var out = {};
    for (var key in p) out[key] = p[key];
    out.exposureEV = clamp(p.exposureEV * k, -0.6, 1.2);
    out.shadows = clamp(p.shadows * (0.45 + 0.55 * Math.min(1, k)), 0, 1);
    out.highlight = clamp(p.highlight * (0.72 + 0.28 * Math.min(1, k)), 0, 1);
    out.clarity = clamp(p.clarity * (0.72 + 0.28 * Math.min(1, k)), 0, 1);
    out.adapted = k < 0.999;
    return out;
  }

  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smoothstep(e0, e1, x) {
    var t = (x - e0) / (e1 - e0);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }

  /* ------------------------------------------------------------------- LUTs */
  // Tone tables.
  //  ch[3][256]  — exposure + white balance only (per channel)
  //  shape[256]  — shadow lift · contrast · highlight roll-off, expressed as one
  //                multiplier keyed on luminance so channel ratios (hue) survive
  function buildLUT(p) {
    var ch = new Float32Array(3 * 256);
    var shape = new Float32Array(256);
    var shoulder = new Float32Array(256);
    var lift = new Float32Array(256);
    var ev = Math.pow(2, p.exposureEV);
    var wr = 1 + 0.09 * p.warmth + 0.014 * p.tint;
    var wg = 1 + 0.003 * p.tint;
    var wb = 1 - 0.09 * p.warmth - 0.014 * p.tint;
    var gains = [wr, wg, wb];
    for (var c = 0; c < 3; c++) {
      for (var v = 0; v < 256; v++) {
        var x0 = (v / 255) * gains[c] * ev;
        // keep the headroom: clamping here would break the hue of a clipped
        // warm highlight (e.g. a sunset sky). The shape factor rolls it off.
        ch[c * 256 + v] = x0 > 1.5 ? 1.5 : x0;
      }
    }
    for (var l = 0; l < 256; l++) {
      var t = l / 255;
      lift[l] = 1 + p.shadows * 1.55 * Math.pow(1 - t, 1.8) * Math.pow(1 - t, 0.25);
      var over = (t - 0.82) / 0.18;
      shoulder[l] = over > 0 ? 1 / (1 + p.highlight * 0.55 * over * over) : 1;
    }
    // shape[m] over luminance 0..TMAX: contrast · shadow lift · soft highlight
    // shoulder, blended as one hue-preserving multiplier.
    var TMAX = 1.6;
    for (var m = 0; m < 256; m++) {
      var l = (m / 255) * TMAX;
      var v = l;
      if (p.contrast !== 0 && v <= 1) v = v + p.contrast * (v * v * (3 - 2 * v) - v);
      var t = v < 1 ? v : 1;
      v *= 1 + p.shadows * 1.55 * Math.pow(1 - t, 1.8) * Math.pow(1 - t, 0.25);
      var knee = 0.82;
      if (v > knee) {
        var u = Math.min(1, (v - knee) / (TMAX - knee));
        var mapped = knee + (0.96 - knee) * (1 - (1 - u) * (1 - u));
        var strength = 0.75 + 0.25 * p.highlight;
        v = v + strength * (mapped - v);
      }
      shape[m] = l > 0.002 ? clamp(v / l, 0, 3) : 1;
    }
    return { ch: ch, shape: shape, lift: lift, shoulder: shoulder };
  }

  function tableAt(tbl, x) {
    var i = x * 255;
    if (i <= 0) return tbl[0];
    if (i >= 255) return tbl[255];
    var i0 = i | 0, f = i - i0;
    return tbl[i0] + (tbl[i0 + 1] - tbl[i0]) * f;
  }

  /* ----------------------------------------------------------- low-res base */
  // Blurred, low resolution version of the image: used for clarity (local
  // contrast) and for chroma noise smoothing. Kept tiny so tiles stay cheap.
  function buildBaseFromPixels(rgba, w, h, radius) {
    var r = new Float32Array(w * h), g = new Float32Array(w * h), b = new Float32Array(w * h), lum = new Float32Array(w * h);
    for (var i = 0, j = 0; i < w * h; i++, j += 4) {
      r[i] = rgba[j] / 255; g[i] = rgba[j + 1] / 255; b[i] = rgba[j + 2] / 255;
      lum[i] = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i];
    }
    boxBlur(r, w, h, radius); boxBlur(g, w, h, radius); boxBlur(b, w, h, radius); boxBlur(lum, w, h, radius);
    return { w: w, h: h, r: r, g: g, b: b, lum: lum };
  }

  function boxBlur(arr, w, h, radius) {
    if (radius < 1) return arr;
    var tmp = new Float32Array(w * h), win = radius * 2 + 1, i, x, y;
    for (y = 0; y < h; y++) {
      var row = y * w, acc = 0;
      for (x = -radius; x <= radius; x++) acc += arr[row + clampInt(x, 0, w - 1)];
      for (x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        acc += arr[row + clampInt(x + radius + 1, 0, w - 1)] - arr[row + clampInt(x - radius, 0, w - 1)];
      }
    }
    for (x = 0; x < w; x++) {
      var acc2 = 0;
      for (y = -radius; y <= radius; y++) acc2 += tmp[clampInt(y, 0, h - 1) * w + x];
      for (y = 0; y < h; y++) {
        arr[y * w + x] = acc2 / win;
        acc2 += tmp[clampInt(y + radius + 1, 0, h - 1) * w + x] - tmp[clampInt(y - radius, 0, h - 1) * w + x];
      }
    }
    return arr;
  }
  function clampInt(v, a, b) { return v < a ? a : v > b ? b : v; }

  function sampleBase(base, u, v) {
    var x = u * base.w - 0.5, y = v * base.h - 0.5;
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    var xa = clampInt(x0, 0, base.w - 1), xb = clampInt(x0 + 1, 0, base.w - 1);
    var ya = clampInt(y0, 0, base.h - 1), yb = clampInt(y0 + 1, 0, base.h - 1);
    var i00 = ya * base.w + xa, i10 = ya * base.w + xb, i01 = yb * base.w + xa, i11 = yb * base.w + xb;
    var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    return {
      r: base.r[i00] * w00 + base.r[i10] * w10 + base.r[i01] * w01 + base.r[i11] * w11,
      g: base.g[i00] * w00 + base.g[i10] * w10 + base.g[i01] * w01 + base.g[i11] * w11,
      b: base.b[i00] * w00 + base.b[i10] * w10 + base.b[i01] * w01 + base.b[i11] * w11,
      lum: base.lum[i00] * w00 + base.lum[i10] * w10 + base.lum[i01] * w01 + base.lum[i11] * w11
    };
  }

  // tone-only pass (no clarity / noise reduction) — used to build the base map
  function toneSmall(data, w, h, p, LUT) {
    var C = LUT.ch;
    for (var i = 0; i < w * h; i++) {
      var j = i * 4;
      var xr = data[j], xg = data[j + 1], xb = data[j + 2];
      var nr = C[xr], ng = C[256 + xg], nb = C[512 + xb];
      var lum = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
      var lf = tableAt(LUT.shape, lum / 1.6);
      nr *= lf; ng *= lf; nb *= lf;
      data[j] = nr * 255; data[j + 1] = ng * 255; data[j + 2] = nb * 255;
    }
    return data;
  }

  /* ------------------------------------------------------------- tone pass */
  /**
   * Process one tile of RGBA pixels in place.
   * data: Uint8ClampedArray (w*h*4). (ox, oy) = tile origin in the full image.
   */
  function toneTile(data, w, h, ox, oy, fullW, fullH, p, LUT, base) {
    var vib = p.vibrance, clar = p.clarity * 1.9, nrk = p.nr * 0.6, skinAmt = p.skin;
    var invW = 1 / fullW, invH = 1 / fullH;
    var i = 0;
    for (var y = 0; y < h; y++) {
      var v = (oy + y + 0.5) * invH;
      for (var x = 0; x < w; x++, i += 4) {
        var r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        var xr = r * 255, xg = g * 255, xb = b * 255;
        var xri = xr | 0; if (xri > 254) xri = 254; var xrf = xr - xri;
        var xgi = xg | 0; if (xgi > 254) xgi = 254; var xgf = xg - xgi;
        var xbi = xb | 0; if (xbi > 254) xbi = 254; var xbf = xb - xbi;
        var C = LUT.ch;
        var nr = C[xri] + (C[xri + 1] - C[xri]) * xrf;
        var ng = C[256 + xgi] + (C[256 + xgi + 1] - C[256 + xgi]) * xgf;
        var nb = C[512 + xbi] + (C[512 + xbi + 1] - C[512 + xbi]) * xbf;

        // --- shadow lift · contrast · highlight roll-off in one hue-safe factor
        var lumA = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
        var lf = tableAt(LUT.shape, lumA / 1.6);
        nr *= lf; ng *= lf; nb *= lf;

        // --- chroma restore: lifting shadows squeezes colour, put some back
        var lum = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
        if (p.shadows > 0.001) {
          var csat = p.shadows * 0.16 * (1 - lum);
          nr = lum + (nr - lum) * (1 + csat);
          ng = lum + (ng - lum) * (1 + csat);
          nb = lum + (nb - lum) * (1 + csat);
          lum = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
        }

        // --- vibrance (protect already saturated + very bright pixels)
        if (vib > 0.001) {
          var mx = nr > ng ? (nr > nb ? nr : nb) : (ng > nb ? ng : nb);
          var mn = nr < ng ? (nr < nb ? nr : nb) : (ng < nb ? ng : nb);
          var sat = mx > 0.0001 ? (mx - mn) / mx : 0;
          var relax = (1 - sat) * (1 - sat);
          var gain = vib * relax * (0.55 + 0.45 * (1 - lum));
          if (skinAmt > 0.001) {
            // warm skin-ish hues get less saturation push
            var rg = nr - ng, gb = ng - nb;
            var skinness = (nr > ng && ng >= nb) ? smoothstep(0.02, 0.09, rg) * (1 - smoothstep(0.28, 0.45, rg)) * smoothstep(-0.02, 0.05, gb) * (1 - smoothstep(0.22, 0.4, gb)) : 0;
            gain *= 1 - skinAmt * skinness * 0.85;
          }
          nr = lum + (nr - lum) * (1 + gain);
          ng = lum + (ng - lum) * (1 + gain);
          nb = lum + (nb - lum) * (1 + gain);
          lum = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
        }

        // --- clarity / local contrast from the blurred base
        var bs = (clar > 0.001 || nrk > 0.001) ? sampleBase(base, (ox + x + 0.5) * invW, v) : null;
        if (bs && clar > 0.001) {
          var detail = lum - bs.lum;
          var guard = 1 - smoothstep(0.12, 0.34, Math.abs(detail));
          var add = clar * detail * guard;
          nr += add; ng += add; nb += add;
          lum += add;
        }

        // --- chroma noise smoothing toward the blurred base (keeps luminance)
        if (bs && nrk > 0.001) {
          var dr = bs.r - bs.lum, dg = bs.g - bs.lum, db = bs.b - bs.lum;
          nr = nr + ((lum + dr) - nr) * nrk;
          ng = ng + ((lum + dg) - ng) * nrk;
          nb = nb + ((lum + db) - nb) * nrk;
        }

        data[i] = nr * 255;
        data[i + 1] = ng * 255;
        data[i + 2] = nb * 255;
        data[i + 3] = 255;
      }
    }
  }

  /* --------------------------------------------------------------- sharpening */
  function sharpenTile(data, w, h, amount) {
    if (amount <= 0.001 || w < 3 || h < 3) return;
    var lum = new Float32Array(w * h);
    var i = 0;
    for (var k = 0; k < w * h; k++, i += 4) lum[k] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    var amt = amount * 0.85;
    var rowOff = [];
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = y * w + x;
        var blur = (lum[idx - w - 1] + 2 * lum[idx - w] + lum[idx - w + 1] +
          2 * lum[idx - 1] + 4 * lum[idx] + 2 * lum[idx + 1] +
          lum[idx + w - 1] + 2 * lum[idx + w] + lum[idx + w + 1]) / 16;
        var diff = lum[idx] - blur;
        // do not sharpen very strong edges (halo control)
        diff *= 1 - smoothstep(24, 70, Math.abs(diff));
        var d = diff * amt;
        if (d === 0) continue;
        var p4 = idx * 4;
        data[p4] = data[p4] + d;
        data[p4 + 1] = data[p4 + 1] + d;
        data[p4 + 2] = data[p4 + 2] + d;
      }
    }
  }

  /* ------------------------------------------------------------------ render */
  function meanLuminance(data, count) {
    var sum = 0;
    for (var i = 0; i < count; i++) {
      var j = i * 4;
      sum += 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
    }
    return count ? sum / count / 255 : 0.35;
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /**
   * Render src into dstCanvas at w×h.
   * opts: { tileH, onProgress(done,total), shouldCancel(), skipSharpen }
   */
  function render(src, dstCanvas, w, h, params, opts) {
    opts = opts || {};
    var p0 = normalize(params);

    // low-res base (~1/24 of the long edge)
    var bw = Math.max(32, Math.round(w / 10)), bh = Math.max(32, Math.round(h / 10));
    var bc = makeCanvas(bw, bh);
    var bctx = bc.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(src, 0, 0, bw, bh);
    var basePix = bctx.getImageData(0, 0, bw, bh).data;
    var mean = meanLuminance(basePix, bw * bh);
    var p = adaptToImage(p0, opts.mean != null ? opts.mean : mean);
    var LUT = buildLUT(p);
    toneSmall(basePix, bw, bh, p, LUT);
    var base = buildBaseFromPixels(basePix, bw, bh, 3);

    dstCanvas.width = w; dstCanvas.height = h;
    var ctx = dstCanvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    var pad = 2;
    var tileH = opts.tileH || Math.max(96, Math.min(256, Math.round(4000000 / w)));
    var tile = makeCanvas(w, tileH + pad * 2);
    var tctx = tile.getContext('2d', { willReadFrequently: true, alpha: false });

    var sw = src.videoWidth || src.naturalWidth || src.width;
    var sh = src.videoHeight || src.naturalHeight || src.height;
    var scaleY = sh / h;
    var tiles = Math.ceil(h / tileH);
    for (var t = 0; t < tiles; t++) {
      if (opts.shouldCancel && opts.shouldCancel()) return false;
      var y0 = t * tileH;
      var rows = Math.min(tileH, h - y0);
      var top = Math.max(0, y0 - pad);
      var bottom = Math.min(h, y0 + rows + pad);
      tctx.clearRect(0, 0, w, tile.height);
      var Y0 = top - pad;            // image y of tile canvas row 0
      var drawY = pad;               // image row `top` lands here
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(src, 0, top * scaleY, sw, (bottom - top) * scaleY, 0, drawY, w, bottom - top);
      // replicate edge rows into the padding so sharpening has no dark fringe
      if (top === 0) tctx.drawImage(tile, 0, drawY, w, 1, 0, 0, w, pad);
      if (bottom === h) tctx.drawImage(tile, 0, drawY + (bottom - top) - 1, w, 1, 0, drawY + (bottom - top), w, pad);

      var usedH = drawY + (bottom - top) + (bottom === h ? pad : 0);
      var img = tctx.getImageData(0, 0, w, Math.max(usedH, 1));
      toneTile(img.data, w, img.height, 0, Y0, w, h, p, LUT, base);
      if (!opts.skipSharpen && p.sharpen > 0.001) sharpenTile(img.data, w, img.height, p.sharpen);
      tctx.putImageData(img, 0, 0);

      ctx.drawImage(tile, 0, drawY, w, rows, 0, y0, w, rows);
      if (opts.onProgress) opts.onProgress(t + 1, tiles);
    }
    return true;
  }

  /* --------------------------------------------------------- node-test helper */
  function renderPixels(rgba, w, h, params) {
    var p0 = normalize(params);
    var bw = Math.max(32, Math.round(w / 10)), bh = Math.max(32, Math.round(h / 10));
    var small = new Uint8ClampedArray(bw * bh * 4);
    for (var y = 0; y < bh; y++) {
      for (var x = 0; x < bw; x++) {
        var si = ((Math.min(h - 1, Math.floor(y * h / bh)) * w) + Math.min(w - 1, Math.floor(x * w / bw))) * 4;
        var di = (y * bw + x) * 4;
        small[di] = rgba[si]; small[di + 1] = rgba[si + 1]; small[di + 2] = rgba[si + 2]; small[di + 3] = 255;
      }
    }
    var mean = meanLuminance(small, bw * bh);
    var p = adaptToImage(p0, params && params.mean != null ? params.mean : mean);
    var LUT = buildLUT(p);
    toneSmall(small, bw, bh, p, LUT);
    var base = buildBaseFromPixels(small, bw, bh, 3);
    var data = new Uint8ClampedArray(rgba);
    toneTile(data, w, h, 0, 0, w, h, p, LUT, base);
    if (p.sharpen > 0.001) sharpenTile(data, w, h, p.sharpen);
    return data;
  }

  var api = {
    PRESETS: PRESETS, PRESET_ORDER: PRESET_ORDER, SLIDERS: SLIDERS,
    paramsFromPreset: paramsFromPreset, normalize: normalize,
    buildLUT: buildLUT, buildBaseFromPixels: buildBaseFromPixels,
    toneTile: toneTile, sharpenTile: sharpenTile, render: render,
    renderPixels: renderPixels, LEVELS: LEVELS,
    adaptToImage: adaptToImage, meanLuminance: meanLuminance
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.P18Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
