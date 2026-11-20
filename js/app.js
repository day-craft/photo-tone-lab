/*!
 * app.js — 18 Pro Lab UI
 */
(function () {
  'use strict';

  var EX = window.P18EXIF;
  var ENG = window.P18Engine;
  var $ = function (id) { return document.getElementById(id); };

  var PREVIEW_FAST = 620;   // while dragging a slider
  var PREVIEW_FULL = 1180;  // idle preview
  var MAX_EXPORT_AREA = 16.5e6; // iOS Safari canvas safety cap (~16MP)

  var state = {
    file: null,
    buffer: null,
    kind: null,
    img: null,
    src: null,          // drawable (img or pre-rotated canvas)
    srcW: 0,
    srcH: 0,
    info: null,
    segs: null,
    heicTiff: null,
    mean: 0.4,
    preset: 'standard',
    params: null,
    out: null,
    previewW: 0,
    previewH: 0,
    busy: false,
    preparing: false,
    split: 0.5
  };

  /* ───────────────────────────────────────────────── helpers */
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fmtDateTime(s) {
    if (!s) return '';
    var m = String(s).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return String(s);
    var h = parseInt(m[4], 10);
    var ampm = h < 12 ? '오전' : '오후';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return m[1] + '. ' + parseInt(m[2], 10) + '. ' + parseInt(m[3], 10) + '. ' + ampm + ' ' + h12 + ':' + m[5];
  }
  function fmtExposure(t) {
    if (!t) return '';
    if (t >= 1) return (Math.round(t * 10) / 10) + 's';
    return '1/' + Math.round(1 / t) + 's';
  }
  function fmtCoords(lat, lon) {
    if (lat == null || lon == null) return '';
    return lat.toFixed(4) + ', ' + lon.toFixed(4);
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function raf(fn) { return (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(fn); }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  function showOverlay(title, sub) {
    $('overlayTitle').textContent = title || '보정하는 중…';
    $('overlaySub').textContent = sub || '원본 해상도로 처리하고 있어요';
    $('progressBar').style.width = '0%';
    $('overlay').hidden = false;
  }
  function setProgress(done, total) {
    var pct = total ? Math.round(done / total * 100) : 0;
    $('progressBar').style.width = Math.max(4, pct) + '%';
  }
  function hideOverlay() { $('overlay').hidden = true; }

  /* ───────────────────────────────────────────────── presets */
  function buildPresets() {
    var row = $('presetRow');
    row.innerHTML = '';
    ENG.PRESET_ORDER.forEach(function (key) {
      var p = ENG.PRESETS[key];
      var b = document.createElement('button');
      b.className = 'preset';
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.key = key;
      b.setAttribute('aria-selected', key === state.preset ? 'true' : 'false');
      b.innerHTML = '<strong></strong><span class="p-badge"></span><span class="p-desc"></span>';
      b.querySelector('strong').textContent = p.name;
      b.querySelector('.p-badge').textContent = p.badge;
      b.querySelector('.p-desc').textContent = p.desc;
      b.addEventListener('click', function () { selectPreset(key); });
      row.appendChild(b);
    });
  }

  function selectPreset(key) {
    state.preset = key;
    state.params = ENG.paramsFromPreset(key);
    document.querySelectorAll('.preset').forEach(function (el) {
      el.setAttribute('aria-selected', el.dataset.key === key ? 'true' : 'false');
    });
    $('presetNote').textContent = ENG.PRESETS[key].name;
    syncSlidersFromParams();
    invalidateOutput();
    renderPreview(true);
  }

  /* ───────────────────────────────────────────────── sliders */
  function buildSliders() {
    var list = $('sliderList');
    list.innerHTML = '';
    ENG.SLIDERS.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'slider-row';
      var id = 's_' + s.key;
      row.innerHTML =
        '<label for="' + id + '">' + s.label + '</label>' +
        '<input type="range" id="' + id + '" min="' + s.min + '" max="' + s.max + '" step="' + s.step + '">' +
        '<span class="val" id="v_' + s.key + '"></span>';
      list.appendChild(row);
      var input = row.querySelector('input');
      input.addEventListener('input', function () {
        readSliders();
        invalidateOutput();
        renderPreview(true);
      });
      input.addEventListener('change', function () { renderPreview(false); });
    });
  }

  function syncSlidersFromParams() {
    ENG.SLIDERS.forEach(function (s) {
      var input = $('s_' + s.key);
      if (!input) return;
      var v = state.params[s.key];
      input.value = v;
      var pct = (v - s.min) / (s.max - s.min) * 100;
      input.style.setProperty('--fill', clamp(pct, 0, 100) + '%');
      var label = $('v_' + s.key);
      var presetVal = ENG.PRESETS[state.preset][s.key];
      var changed = Math.abs(v - presetVal) > 1e-6;
      label.textContent = formatSliderValue(s, v);
      label.className = 'val' + (changed ? ' changed' : '');
    });
  }

  function formatSliderValue(s, v) {
    if (s.unit === 'EV') return (v > 0 ? '+' : '') + v.toFixed(2);
    return Math.round(v * 100) + '';
  }

  function readSliders() {
    ENG.SLIDERS.forEach(function (s) {
      var input = $('s_' + s.key);
      state.params[s.key] = parseFloat(input.value);
      var pct = (parseFloat(input.value) - s.min) / (s.max - s.min) * 100;
      input.style.setProperty('--fill', clamp(pct, 0, 100) + '%');
      var label = $('v_' + s.key);
      label.textContent = formatSliderValue(s, state.params[s.key]);
      var presetVal = ENG.PRESETS[state.preset][s.key];
      label.className = 'val' + (Math.abs(state.params[s.key] - presetVal) > 1e-6 ? ' changed' : '');
    });
  }

  /* ─────────────────────────────────────────────────── stage */
  function layoutStage() {
    var stage = $('stage');
    if (!state.srcW) return;
    var w = stage.clientWidth || (stage.parentElement ? stage.parentElement.clientWidth - 16 : 340);
    var ratio = state.srcH / state.srcW;
    var h = w * ratio;
    var maxH = Math.min(window.innerHeight * 0.62, 620);
    if (h > maxH) h = maxH;
    if (h < 160) h = 160;
    stage.style.height = Math.round(h) + 'px';
    setSplit(state.split);
  }

  function setSplit(frac) {
    state.split = clamp(frac, 0, 1);
    var stage = $('stage');
    stage.style.setProperty('--split', (state.split * 100).toFixed(2) + '%');
  }

  /* ──────────────────────────────────────────────────── load */
  function sniffKind(buf) {
    if (!buf || buf.length < 12) return 'other';
    var b = buf.subarray ? buf.subarray(0, 12) : new Uint8Array(buf.slice(0, 12));
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
    if (b[0] === 0x89 && b[1] === 0x50) return 'png';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'heif'; // 'ftyp'
    return 'other';
  }

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('script-load-failed')); };
      document.head.appendChild(s);
    });
  }

  async function decodeHeic(file) {
    if (!window.heic2any) {
      await loadScriptOnce('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
    }
    if (!window.heic2any) throw new Error('heic-decoder-unavailable');
    var blob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.94 });
    return Array.isArray(blob) ? blob[0] : blob;
  }

  function loadImageElement(blobOrFile) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blobOrFile);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode-failed')); };
      img.decoding = 'async';
      img.src = url;
    });
  }

  async function decodeFile(file) {
    try {
      var r = await loadImageElement(file);
      return { img: r.img, url: r.url, converted: false };
    } catch (e) {
      // HEIC/HEIF that Safari cannot decode (e.g. desktop Chrome) → heic2any
      if (state.kind === 'heif' || /heic|heif/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '')) {
        var jpeg = await decodeHeic(file);
        var r2 = await loadImageElement(jpeg);
        return { img: r2.img, url: r2.url, converted: true };
      }
      throw e;
    }
  }

  // Some older engines ignore EXIF orientation. Detect the common rotation cases
  // and pre-rotate so the saved pixels are upright (then Orientation=1 is right).
  function applyOrientationIfNeeded(img, info) {
    var o = info && info.orientation;
    if (!o || o === 1) return img;
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!info.width || !info.height) return img; // trust the browser if we cannot verify
    if (o >= 2 && o <= 8) {
      if (o >= 5) {
        var swapped = info.width && info.height && w === info.height && h === info.width;
        if (swapped) return img; // browser already rotated
      } else {
        return img; // 2/3/4 cannot be detected; modern browsers apply it
      }
    }
    var c = document.createElement('canvas');
    c.width = h;
    c.height = w;
    var ctx = c.getContext('2d');
    ctx.translate(h / 2, w / 2);
    var rot = o === 6 ? Math.PI / 2 : o === 8 ? -Math.PI / 2 : o === 3 ? Math.PI : 0;
    ctx.rotate(rot);
    if (o === 2) ctx.scale(-1, 1);
    if (o === 4) ctx.scale(1, -1);
    if (o === 5) { ctx.rotate(Math.PI / 2); ctx.scale(-1, 1); }
    if (o === 7) { ctx.rotate(-Math.PI / 2); ctx.scale(-1, 1); }
    ctx.drawImage(img, -w / 2, -h / 2);
    return c;
  }

  async function handleFile(file) {
    if (!file) return;
    if (state.busy) return;
    state.busy = true;
    try {
      if (!/^image\//.test(file.type || '') && !/\.(jpe?g|heic|heif|png|webp)$/i.test(file.name || '')) {
        toast('사진 파일만 열 수 있어요', true);
        return;
      }
      var buf = new Uint8Array(await file.arrayBuffer());
      state.file = file;
      state.buffer = buf;
      state.kind = sniffKind(buf);
      state.info = null;
      state.segs = null;
      state.heicTiff = null;

      try {
        if (state.kind === 'jpeg') {
          state.info = EX.readJPEGInfo(buf);
          state.segs = EX.collectSegments(buf);
        } else if (state.kind === 'heif') {
          var heif = EX.readHEIFExif(buf);
          state.heicTiff = heif ? heif.tiff : null;
          state.info = EX.readHEIFInfo(buf);
        }
      } catch (err) { console.warn('metadata parse failed', err); }

      var dec = await decodeFile(file);
      if (state.objectUrl && state.objectUrl !== dec.url) URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = dec.url;
      state.img = dec.img;
      state.src = applyOrientationIfNeeded(dec.img, state.info);
      state.srcW = dec.img.naturalWidth;
      state.srcH = dec.img.naturalHeight;
      state.mean = await estimateMean(state.src);
      state.out = null;
      state.split = 0.5;

      $('emptyState').hidden = true;
      $('editor').hidden = false;
      $('saveBar').hidden = false;

      layoutStage();
      renderMetaPanel();
      syncChips();
      $('adaptNote').hidden = !ENG.adaptToImage(ENG.normalize(state.params), state.mean).adapted;
      await renderPreview(false);
      setOutInfo('보정 준비됨 · 저장을 누르면 원본 해상도로 처리해요');
      schedulePrepare();
    } catch (e) {
      console.error(e);
      toast('이 사진은 열 수 없어요. 사진 앱에서 JPG로 내보낸 뒤 다시 시도해 주세요.', true);
    } finally {
      state.busy = false;
    }
  }

  function estimateMean(src) {
    try {
      var s = 48;
      var c = document.createElement('canvas');
      c.width = s; c.height = s;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(src, 0, 0, s, s);
      var d = ctx.getImageData(0, 0, s, s).data;
      return ENG.meanLuminance(d, s * s);
    } catch (e) { return 0.4; }
  }

  /* ───────────────────────────────────────────────── preview */
  var previewToken = 0;
  var previewTimer = null;

  function renderPreview(fast) {
    if (!state.src || !state.params) return;
    clearTimeout(previewTimer);
    var token = ++previewToken;
    var delay = fast ? 40 : 0;
    previewTimer = setTimeout(function () {
      if (token !== previewToken) return;
      var maxSide = fast ? PREVIEW_FAST : PREVIEW_FULL;
      var scale = Math.min(1, maxSide / Math.max(state.srcW, state.srcH));
      var pw = Math.max(1, Math.round(state.srcW * scale));
      var ph = Math.max(1, Math.round(state.srcH * scale));

      var before = $('beforeCanvas');
      var after = $('afterCanvas');
      after.style.clipPath = '';

      if (state.previewW !== pw || state.previewH !== ph) {
        before.width = pw; before.height = ph;
        after.width = pw; after.height = ph;
        state.previewW = pw; state.previewH = ph;
        var bctx = before.getContext('2d', { alpha: false });
        bctx.fillStyle = '#000';
        bctx.fillRect(0, 0, pw, ph);
        bctx.imageSmoothingQuality = 'high';
        bctx.drawImage(state.src, 0, 0, pw, ph);
      }

      try {
        ENG.render(state.src, after, pw, ph, state.params, {
          mean: state.mean,
          tileH: ph > 900 ? 220 : ph,
          skipSharpen: false
        });
      } catch (e) {
        console.error('preview failed', e);
      }
      after.style.clipPath = 'inset(0 0 0 ' + (state.split * 100).toFixed(2) + '%)';
      if (!fast) schedulePrepare();
    }, delay);
  }

  /* ──────────────────────────────────────────────── metadata UI */
  function fieldList(info) {
    if (!info) return [];
    var out = [];
    if (info.dateTimeOriginal || info.dateTime) out.push({ key: 'date', label: '촬영일시', value: fmtDateTime(info.dateTimeOriginal || info.dateTime) + (info.offsetTimeOriginal ? ' (' + info.offsetTimeOriginal + ')' : '') });
    if (info.make || info.model) out.push({ key: 'device', label: '기기', value: [info.make, info.model].filter(Boolean).join(' ') });
    if (info.lens) out.push({ key: 'lens', label: '렌즈', value: info.lens });
    var expo = [];
    if (info.fNumber) expo.push('f/' + (Math.round(info.fNumber * 100) / 100));
    if (info.exposureTime) expo.push(fmtExposure(info.exposureTime));
    if (info.iso) expo.push('ISO ' + info.iso);
    if (info.focalLength35) expo.push(info.focalLength35 + 'mm');
    else if (info.focalLength) expo.push(Math.round(info.focalLength) + 'mm');
    if (expo.length) out.push({ key: 'exposure', label: '노출', value: expo.join(' · ') });
    if (info.gps && info.gps.lat != null) out.push({ key: 'gps', label: '위치', value: 'GPS 있음 · ' + fmtCoords(info.gps.lat, info.gps.lon), keep: true });
    else out.push({ key: 'gps', label: '위치', value: 'GPS 없음', keep: false });
    if (info.hasMakerNote) out.push({ key: 'maker', label: 'MakerNote', value: 'Apple 원본 ' + fmtBytes(info.makerNoteSize) });
    return out;
  }

  function renderMetaPanel() {
    var grid = $('metaGrid');
    var status = $('metaStatus');
    var info = state.info;
    var rows = [];
    var fields = fieldList(info);
    fields.forEach(function (f) { rows.push([f.label, f.value]); });

    var dimText = state.srcW + ' × ' + state.srcH + ' (' + (state.srcW * state.srcH / 1e6).toFixed(1) + 'MP)';
    rows.push(['해상도', dimText]);
    rows.push(['파일', (state.file.name || '사진') + ' · ' + fmtBytes(state.file.size)]);
    rows.push(['형식', state.kind === 'heif' ? 'HEIC/HEIF (원본 EXIF 아이템 사용)' : state.kind === 'jpeg' ? 'JPEG' : state.kind.toUpperCase()]);

    if (!info) {
      rows.push(['메타데이터', '이 파일에는 EXIF가 없어요']);
    }

    grid.innerHTML = '';
    rows.forEach(function (r) {
      var dt = document.createElement('dt');
      dt.textContent = r[0];
      var dd = document.createElement('dd');
      dd.textContent = r[1];
      grid.appendChild(dt);
      grid.appendChild(dd);
    });

    if (info) {
      var keep = fields.filter(function (f) { return f.keep !== false; }).map(function (f) { return f.label; });
      status.className = 'meta-status';
      status.innerHTML = '<strong>저장할 때 그대로 유지돼요</strong><br>' + keep.join(' · ') +
        (info.orientation && info.orientation !== 1 ? '<br>방향 정보(' + info.orientation + ')는 똑바로 1로 맞춰 저장해요.' : '');
      $('metaSummary').textContent = keep.length + '개 항목 유지 · Orientation ' + (info.orientation || 1);
      var chip = $('chipMeta');
      chip.textContent = '메타데이터 ' + keep.length + '개 유지';
      chip.className = 'chip chip-meta-ok';
    } else {
      status.className = 'meta-status warn';
      status.innerHTML = '이 사진에는 EXIF 정보가 없어요. 보정은 그대로 되지만, 저장한 사진에도 메타데이터는 없어요.';
      $('metaSummary').textContent = 'EXIF 없음 — 보정만 적용';
      var chip2 = $('chipMeta');
      chip2.textContent = '메타데이터 없음';
      chip2.className = 'chip';
    }
  }

  function syncChips() {
    $('chipSize').textContent = state.srcW + ' × ' + state.srcH + ' · ' + (state.srcW * state.srcH / 1e6).toFixed(1) + 'MP';
  }

  function setOutInfo(text) {
    $('outInfo').textContent = text;
  }

  /* ────────────────────────────────────────────────── export */
  var prepareTimer = null;
  var prepareToken = 0;

  function invalidateOutput() {
    state.out = null;
    prepareToken++;              // abandon any render in flight
    setOutInfo('보정 준비됨 · 저장을 누르면 원본 해상도로 처리해요');
    if (state.file) renderMetaPanel(); // clear the previous "검증 완료" note
    schedulePrepare();
  }

  // iOS Safari only lets navigator.share() run inside the original tap, so the
  // full-resolution result is prepared in the background once the user settles.
  function schedulePrepare() {
    clearTimeout(prepareTimer);
    if (!state.src) return;
    prepareTimer = setTimeout(autoPrepare, 1400);
  }

  async function autoPrepare() {
    if (!state.src || state.busy || state.preparing) return;
    var token = ++prepareToken;
    var isStale = function () { return token !== prepareToken; };
    state.preparing = true;
    setOutInfo('저장 준비 중…');
    try {
      await buildOutput({ silent: true, shouldCancel: isStale });
    } finally {
      state.preparing = false;
    }
    if (isStale()) return;
    if (!state.out) setOutInfo('보정 준비됨 · 저장을 누르면 원본 해상도로 처리해요');
  }

  // Blob.arrayBuffer() is missing on older Safari; FileReader covers it.
  function blobToBytes(blob) {
    return new Promise(function (resolve, reject) {
      if (blob.arrayBuffer) { blob.arrayBuffer().then(function (b) { resolve(new Uint8Array(b)); }, reject); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('read-failed')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', quality);
      } else {
        try {
          var data = canvas.toDataURL('image/jpeg', quality);
          var bin = atob(data.split(',')[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: 'image/jpeg' }));
        } catch (e) { resolve(null); }
      }
    });
  }

  function attachMetadata(newBytes, outW, outH) {
    var segs = [];
    var info = state.info || null;
    if (state.kind === 'jpeg' && state.segs && state.segs.segments.length) {
      var col = state.segs;
      for (var i = 0; i < col.segments.length; i++) {
        var seg = col.segments[i].slice();
        if (i === col.exifIndex) {
          var tiff = seg.slice(10);
          EX.patchTIFF(tiff, { orientation: 1, width: outW, height: outH });
          seg = EX.buildAPP1(tiff);
        } else if (i === col.xmpIndex) {
          var patched = EX.patchXMPOrientation(seg, 1);
          if (patched) seg = patched;
        }
        segs.push(seg);
      }
    } else if (state.heicTiff) {
      var ht = state.heicTiff.slice();
      EX.patchTIFF(ht, { orientation: 1, width: outW, height: outH });
      segs.push(EX.buildAPP1(ht));
    } else if (info) {
      var built = EX.buildTIFF({
        orientation: 1, make: info.make, model: info.model, software: info.software,
        dateTime: info.dateTime, dateTimeOriginal: info.dateTimeOriginal,
        offsetTimeOriginal: info.offsetTimeOriginal, exposureTime: info.exposureTime,
        fNumber: info.fNumber, iso: info.iso, focalLength: info.focalLength,
        focalLength35: info.focalLength35, lens: info.lens,
        width: outW, height: outH, pixelXDim: outW, pixelYDim: outH,
        gps: info.gps
      });
      segs.push(EX.buildAPP1(built));
    }
    var bytes = segs.length ? EX.injectSegments(newBytes, segs) : newBytes;
    var report = null;
    try { report = EX.verify(info, bytes); } catch (e) { console.warn(e); }
    return { bytes: bytes, report: report };
  }

  async function buildOutput(opts) {
    opts = opts || {};
    if (state.out && !opts.force) return state.out;
    if (!state.src) return null;
    if (!opts.silent) {
      showOverlay('보정하는 중…', '원본 해상도로 처리하고 있어요');
      await new Promise(function (r) { raf(function () { raf(r); }); });
    }
    if (opts.shouldCancel && opts.shouldCancel()) return null;

    var srcW = state.srcW, srcH = state.srcH;
    var area = srcW * srcH;
    var scale = area > MAX_EXPORT_AREA ? Math.sqrt(MAX_EXPORT_AREA / area) : 1;
    var result = null;

    for (var attempt = 0; attempt < 4 && !result; attempt++) {
      if (opts.shouldCancel && opts.shouldCancel()) break;
      var w = Math.max(320, Math.round(srcW * scale));
      var h = Math.max(320, Math.round(srcH * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      try {
        var ok = ENG.render(state.src, canvas, w, h, state.params, {
          mean: state.mean,
          onProgress: opts.silent ? null : function (done, total) { setProgress(done, total); }
        });
        if (ok === false) break;
        var blob = await canvasToBlob(canvas, 0.96);
        if (!blob) throw new Error('encode-failed');
        var bytes = await blobToBytes(blob);
        if (bytes.length < 1024) throw new Error('empty');
        var meta = attachMetadata(bytes, w, h);
        result = {
          blob: new Blob([meta.bytes], { type: 'image/jpeg' }),
          bytes: meta.bytes,
          report: meta.report,
          width: w, height: h,
          scaled: scale < 0.999
        };
      } catch (e) {
        console.warn('export attempt failed at ' + w + 'x' + h, e);
        canvas.width = 0; canvas.height = 0;
        scale *= 0.7; // iOS canvas limits: retry smaller
      }
    }

    if (!opts.silent) hideOverlay();
    if (!result) {
      if (opts.shouldCancel && opts.shouldCancel()) return null;
      if (!opts.silent) toast('저장용 이미지를 만들지 못했어요. 사진을 조금 줄이거나 다시 시도해 주세요.', true);
      setOutInfo('보정 준비됨 · 저장을 누르면 원본 해상도로 처리해요');
      return null;
    }
    state.out = result;
    updateOutSummary();
    return result;
  }

  function updateOutSummary() {
    var o = state.out;
    if (!o) return;
    var bits = [];
    bits.push(o.width + ' × ' + o.height);
    bits.push(fmtBytes(o.blob.size));
    if (o.scaled) bits.push('메모리 한계로 축소');
    if (o.report) {
      bits.push(o.report.ok ? '메타데이터 완전 유지' : '일부 항목 확인 필요');
    }
    setOutInfo(bits.join(' · '));
    renderVerification(o.report);
  }

  function renderVerification(report) {
    var status = $('metaStatus');
    if (!report || !report.checks.length) return;
    var html = '';
    var failed = report.checks.filter(function (c) { return !c.ok; });
    if (!failed.length) {
      html = '<strong>저장한 사진 검증 완료 ✓</strong><br>촬영일시 · 기기 · 렌즈 · 노출 · GPS · MakerNote 그대로 담겼어요.';
    } else {
      html = '<strong>저장한 사진 검증 결과</strong><ul>' + report.checks.map(function (c) {
        return '<li class="' + (c.ok ? '' : 'miss') + '">' + c.label + ': ' + (c.ok ? '유지' : '확인 필요') + '</li>';
      }).join('') + '</ul>';
    }
    status.className = 'meta-status' + (failed.length ? ' warn' : '');
    status.innerHTML = html;
  }

  function outName() {
    var name = (state.file && state.file.name) || 'IMG';
    var base = name.replace(/\.[^.]+$/, '');
    return base + '_18pro.jpg';
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 4000);
  }

  async function onSave() {
    if (state.busy) return;
    state.busy = true;
    $('saveBtn').disabled = true;
    try {
      var prepared = state.out;
      var file = prepared ? new File([prepared.blob], outName(), { type: 'image/jpeg' }) : null;
      if (!prepared || !(navigator.canShare && navigator.canShare({ files: [file] }))) {
        var o = prepared || await buildOutput();
        if (!o) return;
        file = new File([o.blob], outName(), { type: 'image/jpeg' });
      }
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: '18 Pro 사진' });
          toast('공유 시트에서 “이미지 저장”을 누르면 사진첩에 들어가요');
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          downloadBlob(prepared ? prepared.blob : file, outName());
          toast('공유가 안 돼서 다운로드로 저장했어요');
        }
      } else {
        downloadBlob(prepared ? prepared.blob : file, outName());
        toast('다운로드에 저장했어요 · 사진 앱에서 열 수 있어요');
      }
    } finally {
      state.busy = false;
      $('saveBtn').disabled = false;
    }
  }

  async function onDownload() {
    if (state.busy) return;
    state.busy = true;
    $('downloadBtn').disabled = true;
    try {
      var o = await buildOutput();
      if (!o) return;
      downloadBlob(o.blob, outName());
      toast('다운로드에 저장했어요');
    } finally {
      state.busy = false;
      $('downloadBtn').disabled = false;
    }
  }

  /* ──────────────────────────────────────────────────── event */
  function wireStageSlider() {
    var stage = $('stage');
    var dragging = false;

    function move(clientX) {
      var rect = stage.getBoundingClientRect();
      var frac = (clientX - rect.left) / rect.width;
      setSplit(frac);
      $('afterCanvas').style.clipPath = 'inset(0 0 0 ' + (state.split * 100).toFixed(2) + '%)';
    }

    stage.addEventListener('pointerdown', function (e) {
      dragging = true;
      stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
      move(e.clientX);
    });
    stage.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      e.preventDefault();
      move(e.clientX);
    });
    stage.addEventListener('pointerup', function () { dragging = false; });
    stage.addEventListener('pointercancel', function () { dragging = false; });
  }

  function wireUi() {
    $('pickBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('changeBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handleFile(f);
    });
    $('saveBtn').addEventListener('click', onSave);
    $('downloadBtn').addEventListener('click', onDownload);
    $('resetBtn').addEventListener('click', function () {
      state.params = ENG.paramsFromPreset(state.preset);
      syncSlidersFromParams();
      invalidateOutput();
      renderPreview(false);
    });

    $('metaToggle').addEventListener('click', function () {
      var btn = $('metaToggle');
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      $('metaBody').hidden = open;
    });

    // info sheet
    var sheet = $('infoSheet'), backdrop = $('sheetBackdrop');
    function openSheet() { sheet.hidden = false; backdrop.hidden = false; }
    function closeSheet() { sheet.hidden = true; backdrop.hidden = true; }
    $('infoBtn').addEventListener('click', openSheet);
    $('sheetClose').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', closeSheet);

    // drag & drop (desktop)
    var card = $('dropCard');
    ['dragenter', 'dragover'].forEach(function (t) {
      card.addEventListener(t, function (e) { e.preventDefault(); card.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      card.addEventListener(t, function (e) { e.preventDefault(); card.classList.remove('dragover'); });
    });
    card.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      handleFile(e.dataTransfer.files[0]);
    });

    document.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          var f = items[i].getAsFile();
          if (f) { handleFile(f); break; }
        }
      }
    });

    window.addEventListener('resize', function () {
      if (!state.srcW) return;
      layoutStage();
      renderPreview(false);
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { layoutStage(); renderPreview(false); }, 250);
    });
  }

  /* ───────────────────────────────────────────────────── start */
  function start() {
    buildPresets();
    buildSliders();
    state.params = ENG.paramsFromPreset('standard');
    syncSlidersFromParams();
    wireUi();
    wireStageSlider();
    setSplit(0.5);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
