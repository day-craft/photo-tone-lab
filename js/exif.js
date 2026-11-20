/*!
 * exif.js — JPEG / HEIF metadata reader, patcher and JPEG metadata injector.
 * Pure JS, no dependency. Used by the 18 Pro Lab web app.
 *
 * Design notes
 *  - For JPEG sources we keep the ORIGINAL metadata segments (APP1 Exif/XMP,
 *    APP2 ICC, APP13 IPTC, COM) byte-for-byte and inject them into the freshly
 *    encoded JPEG. Only the Orientation tag is rewritten to 1, plus the pixel
 *    dimension tags when the output was resized.
 *  - For HEIF/HEIC sources (iPhone originals) the Exif item inside the HEIF
 *    container is extracted as a TIFF block — Apple MakerNote included — and
 *    wrapped into a plain APP1 segment.
 */
(function (global) {
  'use strict';

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  var ORIENT = 0x0112, IMG_W = 0x0100, IMG_H = 0x0101;
  var EXIF_IFD = 0x8769, GPS_IFD = 0x8825, INTEROP_IFD = 0xA005;
  var PX_W = 0xA002, PX_H = 0xA003;

  /* ------------------------------------------------------------------ utils */
  function u16(b, o, le) {
    return le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
  }
  function u32(b, o, le) {
    return le
      ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0)
      : (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  }
  function s32(v) { return v > 0x7fffffff ? v - 0x100000000 : v; }
  function ascii(b, start, len) {
    var s = '', end = Math.min(b.length, start + len);
    for (var i = start; i < end; i++) {
      var c = b[i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.replace(/\s+$/, '');
  }
  function isJPEG(b) { return b.length > 3 && b[0] === 0xff && b[1] === 0xd8; }

  function fourcc(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }

  /* --------------------------------------------------------------- JPEG scan */
  // Returns [{marker, start, end, payloadStart}] for every marker segment before SOS.
  function scanJPEG(b) {
    if (!isJPEG(b)) return [];
    var out = [], p = 2, n = b.length;
    while (p + 3 < n) {
      if (b[p] !== 0xff) break;
      var marker = b[p + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      if (marker === 0xda || marker === 0xd9) { out.push({ marker: marker, start: p, end: n, payloadStart: p + 2 }); break; }
      var len = (b[p + 2] << 8) | b[p + 3];
      if (len < 2) break;
      out.push({ marker: marker, start: p, end: p + 2 + len, payloadStart: p + 4 });
      p = p + 2 + len;
    }
    return out;
  }

  var KEEP_MARKERS = { 0xe1: 1, 0xe2: 1, 0xed: 1, 0xfe: 1 }; // APP1, APP2, APP13, COM

  /**
   * Collect the metadata segments of a JPEG, in their original order.
   * Returns { segments: Uint8Array[], exifIndex, xmpIndex, hasExif }.
   */
  function collectSegments(b) {
    var segs = [], exifIndex = -1, xmpIndex = -1;
    var marks = scanJPEG(b);
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (!KEEP_MARKERS[m.marker]) continue;
      if (m.marker === 0xe1) {
        var isExif = ascii(b, m.payloadStart, 5) === 'Exif';
        var isXmp = ascii(b, m.payloadStart, 29).indexOf('http://ns.adobe.com/xap/1.0/') === 0;
        if (!isExif && !isXmp) continue; // skip unrelated APP1 payloads
        if (isExif && exifIndex < 0) exifIndex = segs.length;
        if (isXmp && xmpIndex < 0) xmpIndex = segs.length;
      }
      segs.push(b.subarray(m.start, m.end));
    }
    return { segments: segs, exifIndex: exifIndex, xmpIndex: xmpIndex, hasExif: exifIndex >= 0 };
  }

  /* ------------------------------------------------------------- TIFF reader */
  function readIFD(b, tiffStart, off, le) {
    if (off + 2 > b.length) return null;
    var count = u16(b, off, le);
    if (count > 1000) return null;
    var entries = [];
    for (var i = 0; i < count; i++) {
      var e = off + 2 + i * 12;
      if (e + 12 > b.length) break;
      var type = u16(b, e + 2, le), n = u32(b, e + 4, le);
      var size = (TYPE_SIZE[type] || 1) * n;
      entries.push({
        tag: u16(b, e, le),
        type: type,
        count: n,
        entryOffset: e,
        valueOffset: size > 4 ? tiffStart + u32(b, e + 8, le) : e + 8,
        byteSize: size,
        inline: size <= 4
      });
    }
    var next = off + 2 + count * 12 + 4 <= b.length ? u32(b, off + 2 + count * 12, le) : 0;
    return { offset: off, entries: entries, next: next };
  }

  function findEntry(ifd, tag) {
    if (!ifd) return null;
    for (var i = 0; i < ifd.entries.length; i++) if (ifd.entries[i].tag === tag) return ifd.entries[i];
    return null;
  }

  function entryNumber(b, e, le) {
    if (!e) return null;
    var p = e.valueOffset;
    if (p >= b.length) return null;
    switch (e.type) {
      case 1: case 7: case 6: return b[p];
      case 3: case 8: return u16(b, p, le);
      case 4: case 9: return s32(u32(b, p, le));
      case 5: case 10: {
        var num = u32(b, p, le), den = u32(b, p + 4, le);
        return den ? num / den : (num === 0 ? 0 : null);
      }
      default: return null;
    }
  }

  function entryString(b, e) {
    if (!e) return '';
    if (e.type !== 2) return '';
    return ascii(b, e.valueOffset, Math.min(e.count, 512));
  }

  function entryRational(b, e, le) {
    if (!e) return null;
    if (e.type !== 5 && e.type !== 10) { var v = entryNumber(b, e, le); return v == null ? null : v; }
    var p = e.valueOffset;
    if (p + 8 > b.length) return null;
    var num = u32(b, p, le), den = u32(b, p + 4, le);
    if (!den) return null;
    return e.type === 10 ? s32(num) / s32(den) : num / den;
  }

  function tiffBase(b, start) {
    start = start || 0;
    if (b.length < start + 8) return null;
    var le;
    if (b[start] === 0x49 && b[start + 1] === 0x49) le = true;
    else if (b[start] === 0x4d && b[start + 1] === 0x4d) le = false;
    else return null;
    var magic = u16(b, start + 2, le);
    if (magic !== 42 && magic !== 0x4f52) return null;
    var first = u32(b, start + 4, le);
    if (first < 8 || start + first >= b.length) return null;
    return { start: start, le: le, ifd0: start + first };
  }

  function readInfoFromTIFF(b, start) {
    var base = tiffBase(b, start);
    if (!base) return null;
    var le = base.le, ifd0 = readIFD(b, base.start, base.ifd0, le);
    if (!ifd0) return null;
    var exifPtr = entryNumber(b, findEntry(ifd0, EXIF_IFD), le);
    var gpsPtr = entryNumber(b, findEntry(ifd0, GPS_IFD), le);
    var exif = exifPtr ? readIFD(b, base.start, base.start + exifPtr, le) : null;
    var gps = gpsPtr ? readIFD(b, base.start, base.start + gpsPtr, le) : null;

    var info = {
      hasExif: true,
      littleEndian: le,
      orientation: entryNumber(b, findEntry(ifd0, ORIENT), le) || 1,
      make: entryString(b, findEntry(ifd0, 0x010f)),
      model: entryString(b, findEntry(ifd0, 0x0110)),
      software: entryString(b, findEntry(ifd0, 0x0131)),
      hostComputer: entryString(b, findEntry(ifd0, 0x013c)),
      artist: entryString(b, findEntry(ifd0, 0x013b)),
      copyright: entryString(b, findEntry(ifd0, 0x8298)),
      dateTime: entryString(b, findEntry(ifd0, 0x0132)),
      width: entryNumber(b, findEntry(ifd0, IMG_W), le),
      height: entryNumber(b, findEntry(ifd0, IMG_H), le),
      dateTimeOriginal: '', offsetTimeOriginal: '', offsetTime: '',
      lens: '', lensMake: '', lensSpec: '',
      exposureTime: null, fNumber: null, iso: null, focalLength: null, focalLength35: null,
      exposureBias: null, meteringMode: null, flash: null, whiteBalance: null, colorSpace: null,
      pixelX: null, pixelY: null, pixelXDim: null, pixelYDim: null,
      gps: null, makerNoteSize: 0, hasMakerNote: false,
      exifIfdEntries: exif ? exif.entries.length : 0
    };

    if (exif) {
      info.dateTimeOriginal = entryString(b, findEntry(exif, 0x9003));
      info.offsetTimeOriginal = entryString(b, findEntry(exif, 0x9011));
      info.offsetTime = entryString(b, findEntry(exif, 0x9010));
      info.lens = entryString(b, findEntry(exif, 0xa434));
      info.lensMake = entryString(b, findEntry(exif, 0xa433));
      info.lensSpec = entryString(b, findEntry(exif, 0xa432)).trim();
      info.exposureTime = entryRational(b, findEntry(exif, 0x829a), le);
      info.fNumber = entryRational(b, findEntry(exif, 0x829d), le);
      var iso = findEntry(exif, 0x8827);
      info.iso = iso ? (iso.count > 1 ? entryNumber(b, iso, le) : entryNumber(b, iso, le)) : null;
      info.focalLength = entryRational(b, findEntry(exif, 0x920a), le);
      info.focalLength35 = entryNumber(b, findEntry(exif, 0xa405), le);
      info.exposureBias = entryRational(b, findEntry(exif, 0x9204), le);
      info.whiteBalance = entryNumber(b, findEntry(exif, 0x9208), le);
      info.colorSpace = entryNumber(b, findEntry(exif, 0xa001), le);
      info.pixelXDim = entryNumber(b, findEntry(exif, PX_W), le);
      info.pixelYDim = entryNumber(b, findEntry(exif, PX_H), le);
      var mn = findEntry(exif, 0x927c);
      info.hasMakerNote = !!mn;
      info.makerNoteSize = mn ? mn.byteSize : 0;
      var mt = findEntry(exif, 0x9291 /* SubjectArea */);
      if (mt) info.subjectAreaCount = mt.count;
    }

    if (!info.width) info.width = info.pixelXDim;
    if (!info.height) info.height = info.pixelYDim;

    if (gps) {
      var latRef = entryString(b, findEntry(gps, 0x0001)) || 'N';
      var lonRef = entryString(b, findEntry(gps, 0x0003)) || 'E';
      var lat = gpsTriple(b, findEntry(gps, 0x0002), le);
      var lon = gpsTriple(b, findEntry(gps, 0x0004), le);
      var altRef = entryNumber(b, findEntry(gps, 0x0005), le);
      var alt = entryRational(b, findEntry(gps, 0x0006), le);
      var gpsDate = entryString(b, findEntry(gps, 0x001d));
      var gpsTime = null;
      var t = findEntry(gps, 0x0007);
      if (t && t.count >= 3) {
        var p = t.valueOffset;
        gpsTime = [u32(b, p, le), u32(b, p + 4, le), u32(b, p + 8, le)];
      }
      if (lat && lon) {
        info.gps = {
          lat: lat * (latRef === 'S' ? -1 : 1),
          lon: lon * (lonRef === 'W' ? -1 : 1),
          altitude: alt == null ? null : (altRef === 1 ? -alt : alt),
          dateStamp: gpsDate || null,
          timeStamp: gpsTime
        };
      } else {
        info.gps = { lat: null, lon: null };
      }
    }
    return info;
  }

  function gpsTriple(b, e, le) {
    if (!e || e.count < 3) return null;
    var p = e.valueOffset;
    if (p + 24 > b.length) return null;
    var deg = u32(b, p, le) / (u32(b, p + 4, le) || 1);
    var min = u32(b, p + 8, le) / (u32(b, p + 12, le) || 1);
    var sec = u32(b, p + 16, le) / (u32(b, p + 20, le) || 1);
    return deg + min / 60 + sec / 3600;
  }

  /* ----------------------------------------------------------- JPEG metadata */
  function readJPEGInfo(b) {
    if (!isJPEG(b)) return null;
    var marks = scanJPEG(b);
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (m.marker !== 0xe1) continue;
      if (ascii(b, m.payloadStart, 5) !== 'Exif') continue;
      var tiffStart = m.payloadStart + 6;
      var info = readInfoFromTIFF(b, tiffStart);
      if (info) {
        info.container = 'jpeg';
        info.makerNoteOffset = null;
        return info;
      }
    }
    return null;
  }

  /* --------------------------------------------------------------- HEIF read */
  function boxHeader(b, p, end) {
    if (p + 8 > end) return null;
    var size = u32(b, p, false);
    var type = fourcc(b, p + 4);
    var hdr = 8;
    if (size === 1) {
      if (p + 16 > end) return null;
      var hi = u32(b, p + 8, false), lo = u32(b, p + 12, false);
      size = hi * 4294967296 + lo;
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr) return null;
    return { type: type, start: p, size: size, hdr: hdr, dataStart: p + hdr, end: Math.min(end, p + size) };
  }

  function childBoxes(b, start, end) {
    var list = [], p = start;
    while (p + 8 <= end) {
      var h = boxHeader(b, p, end);
      if (!h || h.size < h.hdr) break;
      list.push(h);
      p += h.size;
    }
    return list;
  }

  function findBox(b, start, end, type, depth) {
    depth = depth || 0;
    var boxes = childBoxes(b, start, end);
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].type === type) return boxes[i];
    }
    if (depth >= 3) return null;
    for (var j = 0; j < boxes.length; j++) {
      var t = boxes[j].type;
      if (t === 'meta' || t === 'moov' || t === 'trak' || t === 'mdia') {
        var inner = boxes[j].type === 'meta' ? boxes[j].dataStart + 4 : boxes[j].dataStart;
        var found = findBox(b, inner, boxes[j].end, type, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function parseIloc(b, box) {
    var p = box.dataStart, end = box.end;
    var version = b[p];
    p += 4;
    var byte1 = b[p], byte2 = b[p + 1];
    var offsetSize = byte1 >> 4, lengthSize = byte1 & 0xf;
    var baseOffsetSize = byte2 >> 4, indexSize = version >= 1 ? (byte2 & 0xf) : 0;
    p += 2;
    var count = version < 2 ? u16(b, p, false) : u32(b, p, false);
    p += version < 2 ? 2 : 4;
    var items = [];
    for (var i = 0; i < count && p < end; i++) {
      var itemId = version < 2 ? u16(b, p, false) : u32(b, p, false);
      p += version < 2 ? 2 : 4;
      var method = 0;
      if (version >= 1) { method = u16(b, p, false) & 0xf; p += 2; }
      p += 2; // data_reference_index
      var baseOffset = readVar(b, p, baseOffsetSize); p += baseOffsetSize;
      var extentCount = u16(b, p, false); p += 2;
      var extents = [];
      for (var k = 0; k < extentCount; k++) {
        if (indexSize) p += indexSize;
        var off = readVar(b, p, offsetSize); p += offsetSize;
        var len = readVar(b, p, lengthSize); p += lengthSize;
        extents.push({ offset: off, length: len });
      }
      items.push({ id: itemId, method: method, baseOffset: baseOffset, extents: extents });
    }
    return items;
  }

  function readVar(b, p, size) {
    var v = 0;
    for (var i = 0; i < size; i++) v = v * 256 + (b[p + i] || 0);
    return v;
  }

  function parseIinf(b, box) {
    var p = box.dataStart, end = box.end;
    var version = b[p];
    p += 4;
    p += 2; // entry_count, we just walk the child boxes
    var out = [];
    var boxes = childBoxes(b, p, end);
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].type !== 'infe') continue;
      var q = boxes[i].dataStart;
      var v = b[q];
      q += 4;
      var id = v >= 3 ? u32(b, q, false) : u16(b, q, false);
      q += v >= 3 ? 4 : 2;
      q += 2; // protection index
      var type = fourcc(b, q);
      out.push({ id: id, type: type });
    }
    return out;
  }

  /**
   * Extract the Exif item of a HEIF/HEIC file as a standalone TIFF block.
   * Returns { tiff: Uint8Array } or null.
   */
  function readHEIFExif(bytes) {
    var b = bytes;
    if (b.length < 16) return null;
    var ftyp = boxHeader(b, 0, b.length);
    if (!ftyp || ftyp.type !== 'ftyp') return null;
    var brand = fourcc(b, ftyp.dataStart);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1', 'MiHE'].indexOf(brand) < 0) {
      var compat = [];
      for (var i = 0; i < 4; i++) compat.push(fourcc(b, ftyp.dataStart + 8 + i * 4));
      if (!compat.some(function (c) { return c === 'heic' || c === 'heix' || c === 'mif1'; })) return null;
    }
    var meta = findBox(b, 0, b.length, 'meta');
    if (!meta) return null;
    var metaStart = meta.dataStart + 4;
    var iinf = findBox(b, metaStart, meta.end, 'iinf');
    var iloc = findBox(b, metaStart, meta.end, 'iloc');
    if (!iinf || !iloc) return null;
    var items = parseIinf(b, iinf);
    var exifItem = null;
    for (var j = 0; j < items.length; j++) if (items[j].type === 'Exif') { exifItem = items[j]; break; }
    if (!exifItem) return null;
    var locs = parseIloc(b, iloc);
    var loc = null;
    for (var k = 0; k < locs.length; k++) if (locs[k].id === exifItem.id) { loc = locs[k]; break; }
    if (!loc || !loc.extents.length) return null;
    var idat = loc.method === 1 ? findBox(b, metaStart, meta.end, 'idat') : null;

    var chunks = [], total = 0;
    for (var e = 0; e < loc.extents.length; e++) {
      var ext = loc.extents[e];
      var abs = (loc.method === 1 && idat) ? (idat.dataStart + (loc.baseOffset || 0) + ext.offset) : (loc.baseOffset + ext.offset);
      var len = ext.length;
      if (abs + len > b.length) return null;
      chunks.push(b.subarray(abs, abs + len));
      total += len;
    }
    var payload = new Uint8Array(total), at = 0;
    for (var c = 0; c < chunks.length; c++) { payload.set(chunks[c], at); at += chunks[c].length; }
    if (payload.length < 12) return null;

    // HEIF Exif item: 4-byte big-endian offset to the TIFF header.
    var hdrOffset = u32(payload, 0, false);
    var candidate = 4 + hdrOffset;
    if (candidate + 8 <= payload.length && tiffBase(payload, candidate)) {
      return { tiff: payload.subarray(candidate) };
    }
    // Fallbacks: strip a leading "Exif\0\0", or search for the TIFF magic nearby.
    if (ascii(payload, 0, 4) === 'Exif' && tiffBase(payload, 6)) return { tiff: payload.subarray(6) };
    for (var s = 0; s + 8 < Math.min(payload.length, 64); s++) {
      if (tiffBase(payload, s)) return { tiff: payload.subarray(s) };
    }
    return null;
  }

  function readHEIFInfo(bytes) {
    var r = readHEIFExif(bytes);
    if (!r) return null;
    var info = readInfoFromTIFF(r.tiff, 0);
    if (!info) return null;
    info.container = 'heif';
    return info;
  }

  /* --------------------------------------------------------------- TIFF patch */
  function setEntryNumber(b, entry, value, le) {
    if (!entry) return false;
    if (entry.type === 3) { // SHORT
      if (entry.inline) {
        if (le) { b[entry.entryOffset + 8] = value & 0xff; b[entry.entryOffset + 9] = (value >> 8) & 0xff; }
        else { b[entry.entryOffset + 8] = (value >> 8) & 0xff; b[entry.entryOffset + 9] = value & 0xff; }
        return true;
      }
      var p = entry.valueOffset;
      if (le) { b[p] = value & 0xff; b[p + 1] = (value >> 8) & 0xff; }
      else { b[p] = (value >> 8) & 0xff; b[p + 1] = value & 0xff; }
      return true;
    }
    if (entry.type === 4 || entry.type === 9) { // LONG / SLONG
      if (entry.inline) {
        var q = entry.entryOffset + 8;
        if (le) { b[q] = value & 0xff; b[q + 1] = (value >> 8) & 0xff; b[q + 2] = (value >> 16) & 0xff; b[q + 3] = (value >>> 24) & 0xff; }
        else { b[q] = (value >>> 24) & 0xff; b[q + 1] = (value >> 16) & 0xff; b[q + 2] = (value >> 8) & 0xff; b[q + 3] = value & 0xff; }
        return true;
      }
      var r = entry.valueOffset;
      if (le) { b[r] = value & 0xff; b[r + 1] = (value >> 8) & 0xff; b[r + 2] = (value >> 16) & 0xff; b[r + 3] = (value >>> 24) & 0xff; }
      else { b[r] = (value >>> 24) & 0xff; b[r + 1] = (value >> 16) & 0xff; b[r + 2] = (value >> 8) & 0xff; b[r + 3] = value & 0xff; }
      return true;
    }
    return false;
  }

  /**
   * Patch a TIFF block in place (the array is mutated).
   * opts: { orientation: 1, width, height }
   * Returns a list of applied changes, e.g. ['Orientation→1'].
   */
  function patchTIFF(b, opts) {
    var base = tiffBase(b, 0);
    if (!base) return [];
    var le = base.le, changes = [];
    var ifd0 = readIFD(b, base.start, base.ifd0, le);
    if (!ifd0) return [];
    if (opts.orientation != null) {
      var oe = findEntry(ifd0, ORIENT);
      if (oe) {
        var cur = entryNumber(b, oe, le);
        if (cur !== opts.orientation && setEntryNumber(b, oe, opts.orientation, le)) {
          changes.push('Orientation ' + (cur == null ? '?' : cur) + '→' + opts.orientation);
        }
      }
    }
    if (opts.width && opts.height) {
      var wl = [[ifd0, IMG_W, opts.width], [ifd0, IMG_H, opts.height]];
      var exifPtr = entryNumber(b, findEntry(ifd0, EXIF_IFD), le);
      var exif = exifPtr ? readIFD(b, base.start, base.start + exifPtr, le) : null;
      if (exif) { wl.push([exif, PX_W, opts.width], [exif, PX_H, opts.height]); }
      for (var i = 0; i < wl.length; i++) {
        var ent = findEntry(wl[i][0], wl[i][1]);
        if (!ent || ent.count !== 1) continue;
        var old = entryNumber(b, ent, le);
        if (old !== wl[i][2] && setEntryNumber(b, ent, wl[i][2], le)) {
          changes.push((wl[i][1] === IMG_W || wl[i][1] === PX_W ? 'Width ' : 'Height ') + old + '→' + wl[i][2]);
        }
      }
    }
    return changes;
  }

  /* --------------------------------------------------------------- TIFF build */
  // A compact little-endian EXIF/TIFF writer. Used only when a source has no
  // reusable TIFF block (for example a HEIF file whose Exif item we could not
  // locate). tag spec: {tag, type, text|nums|pairs}
  function buildTIFF(info) {
    function a(tag, text) { return text ? { tag: tag, type: 2, text: String(text) } : null; }
    function sh(tag, v) { return v == null ? null : { tag: tag, type: 3, nums: [v] }; }
    function lo(tag, v) { return v == null ? null : { tag: tag, type: 4, nums: [v] }; }
    function rat(tag, pairs) { return pairs ? { tag: tag, type: 5, pairs: pairs } : null; }

    var ifd0 = [], exif = [], gps = [];
    function add(list, e) { if (e) list.push(e); }

    add(ifd0, sh(ORIENT, info.orientation || 1));
    add(ifd0, a(0x010f, info.make));
    add(ifd0, a(0x0110, info.model));
    add(ifd0, a(0x0131, info.software));
    add(ifd0, a(0x0132, info.dateTime || info.dateTimeOriginal));
    add(ifd0, lo(IMG_W, info.width));
    add(ifd0, lo(IMG_H, info.height));

    if (info.dateTimeOriginal) {
      add(exif, a(0x9003, info.dateTimeOriginal));
      add(exif, a(0x9004, info.dateTimeOriginal));
    }
    add(exif, a(0x9011, info.offsetTimeOriginal));
    if (info.exposureTime) {
      add(exif, info.exposureTime >= 1
        ? rat(0x829a, [[Math.round(info.exposureTime * 100), 100]])
        : rat(0x829a, [[1, Math.round(1 / info.exposureTime)]]));
    }
    if (info.fNumber) add(exif, rat(0x829d, [[Math.round(info.fNumber * 100), 100]]));
    add(exif, sh(0x8827, info.iso));
    if (info.focalLength) add(exif, rat(0x920a, [[Math.round(info.focalLength * 100), 100]]));
    add(exif, sh(0xa405, info.focalLength35));
    add(exif, a(0xa434, info.lens));
    add(exif, lo(PX_W, info.pixelXDim || info.width));
    add(exif, lo(PX_H, info.pixelYDim || info.height));

    if (info.gps && info.gps.lat != null && info.gps.lon != null) {
      gps.push({ tag: 0x0000, type: 1, nums: [2, 3, 0, 0] });
      add(gps, a(0x0001, info.gps.lat >= 0 ? 'N' : 'S'));
      add(gps, rat(0x0002, degToPairs(Math.abs(info.gps.lat))));
      add(gps, a(0x0003, info.gps.lon >= 0 ? 'E' : 'W'));
      add(gps, rat(0x0004, degToPairs(Math.abs(info.gps.lon))));
      if (info.gps.altitude != null) {
        add(gps, { tag: 0x0005, type: 1, nums: [info.gps.altitude < 0 ? 1 : 0] });
        add(gps, rat(0x0006, [[Math.round(Math.abs(info.gps.altitude) * 100), 100]]));
      }
      if (info.gps.dateStamp) add(gps, a(0x001d, info.gps.dateStamp));
    }

    function byTag(x, y) { return x.tag - y.tag; }
    ifd0.sort(byTag); exif.sort(byTag); gps.sort(byTag);

    var hasExif = exif.length > 0, hasGps = gps.length > 0;
    var ifd0Count = ifd0.length + (hasExif ? 1 : 0) + (hasGps ? 1 : 0);

    // --- serialize entries (compute count + raw bytes)
    function pad2(bytes) { return bytes.length & 1 ? bytes.concat([0]) : bytes; }
    function entryBytes(e) {
      var bytes = [];
      if (e.text != null) {
        for (var i = 0; i < e.text.length; i++) bytes.push(e.text.charCodeAt(i) & 0xff);
        bytes.push(0);
        e.type = 2; e.count = bytes.length;
      } else if (e.pairs) {
        e.count = e.pairs.length;
        for (var p = 0; p < e.pairs.length; p++) {
          var num = e.pairs[p][0], den = e.pairs[p][1];
          bytes.push(num & 0xff, (num >>> 8) & 0xff, (num >>> 16) & 0xff, (num >>> 24) & 0xff);
          bytes.push(den & 0xff, (den >>> 8) & 0xff, (den >>> 16) & 0xff, (den >>> 24) & 0xff);
        }
      } else {
        e.count = e.nums.length;
        for (var k = 0; k < e.nums.length; k++) {
          var v = e.nums[k];
          if (e.type === 1 || e.type === 7) bytes.push(v & 0xff);
          else if (e.type === 3) bytes.push(v & 0xff, (v >>> 8) & 0xff);
          else bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
        }
      }
      e.bytes = bytes;
      return bytes;
    }
    ifd0.forEach(entryBytes); exif.forEach(entryBytes); gps.forEach(entryBytes);

    // --- layout
    var ifd0Size = 2 + ifd0Count * 12 + 4;
    var exifSize = hasExif ? 2 + exif.length * 12 + 4 : 0;
    var gpsSize = hasGps ? 2 + gps.length * 12 + 4 : 0;
    var ifd0Off = 8;
    var exifOff = ifd0Off + ifd0Size;
    var gpsOff = exifOff + exifSize;
    var dataOff = gpsOff + gpsSize;

    var pool = [];
    function assignOffsets(list) {
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e.bytes.length > 4) {
          e.dataOffset = dataOff + pool.length;
          pool = pool.concat(pad2(e.bytes));
        }
      }
    }
    assignOffsets(ifd0); assignOffsets(exif); assignOffsets(gps);

    function writeIFD(list, extra) {
      var all = list.slice();
      if (extra) all = all.concat(extra);
      all.sort(byTag);
      var out = [all.length & 0xff, (all.length >>> 8) & 0xff];
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        out.push(e.tag & 0xff, (e.tag >>> 8) & 0xff, e.type, 0, e.count & 0xff, (e.count >>> 8) & 0xff, (e.count >>> 16) & 0xff, (e.count >>> 24) & 0xff);
        if (e.bytes.length <= 4) {
          for (var b = 0; b < 4; b++) out.push(e.bytes[b] || 0);
        } else {
          var o = e.dataOffset;
          out.push(o & 0xff, (o >>> 8) & 0xff, (o >>> 16) & 0xff, (o >>> 24) & 0xff);
        }
      }
      out.push(0, 0, 0, 0);
      return out;
    }
    function pointer(tag, offset) {
      return { tag: tag, type: 4, count: 1, bytes: [offset & 0xff, (offset >>> 8) & 0xff, (offset >>> 16) & 0xff, (offset >>> 24) & 0xff] };
    }
    var ptr = [];
    if (hasExif) ptr.push(pointer(EXIF_IFD, exifOff));
    if (hasGps) ptr.push(pointer(GPS_IFD, gpsOff));

    var out = [0x49, 0x49, 42, 0, ifd0Off & 0xff, (ifd0Off >>> 8) & 0xff, 0, 0];
    out = out.concat(writeIFD(ifd0, ptr));
    if (hasExif) out = out.concat(writeIFD(exif));
    if (hasGps) out = out.concat(writeIFD(gps));
    out = out.concat(pool);
    return new Uint8Array(out);
  }

  function degToPairs(deg) {
    var d = Math.floor(deg);
    var minFull = (deg - d) * 60;
    var m = Math.floor(minFull);
    var s = (minFull - m) * 60;
    return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]];
  }

  /* ----------------------------------------------------------------- APP1 ops */
  function buildAPP1(tiff) {
    var payloadLen = 6 + tiff.length;
    var total = payloadLen + 4;
    var out = new Uint8Array(total);
    out[0] = 0xff; out[1] = 0xe1;
    out[2] = ((payloadLen + 2) >> 8) & 0xff;
    out[3] = (payloadLen + 2) & 0xff;
    out[4] = 0x45; out[5] = 0x78; out[6] = 0x69; out[7] = 0x66; out[8] = 0; out[9] = 0;
    out.set(tiff, 10);
    return out;
  }

  function patchXMPOrientation(seg, value) {
    // XMP packets are UTF-8 text; orientation appears in two shapes.
    var s = '', n = seg.length;
    for (var i = 0; i < n; i++) s += String.fromCharCode(seg[i]);
    var next = s
      .replace(/(<tiff:Orientation>)\d+(<\/tiff:Orientation>)/g, '$1' + value + '$2')
      .replace(/(tiff:Orientation=")\d+(")/g, '$1' + value + '$2');
    if (next === s) return null;
    var out = new Uint8Array(n);
    for (var j = 0; j < n; j++) out[j] = next.charCodeAt(j) & 0xff;
    return out;
  }

  /**
   * Inject the collected metadata segments into a freshly encoded JPEG.
   * The encoder's own APP1/APP2/APP13/COM segments are dropped (exif.js owns
   * metadata) while its APP0/APP14 and image data are kept as they are.
   */
  function injectSegments(newJpeg, segments) {
    if (!isJPEG(newJpeg)) return newJpeg;
    var n = newJpeg.length, parts = [], total = 2;
    parts.push(newJpeg.subarray(0, 2)); // SOI

    var marks = scanJPEG(newJpeg);
    var q = 2;
    if (marks.length && marks[0].marker === 0xe0) { // keep the encoder's JFIF APP0 first
      parts.push(newJpeg.subarray(marks[0].start, marks[0].end));
      total += marks[0].end - marks[0].start;
      q = marks[0].end;
    }
    for (var i = 0; i < segments.length; i++) {
      parts.push(segments[i]);
      total += segments[i].length;
    }

    var skip = { 0xe1: 1, 0xe2: 1, 0xed: 1, 0xfe: 1 };
    while (q + 3 < n) {
      if (newJpeg[q] !== 0xff) break;
      var marker = newJpeg[q + 1];
      if (marker === 0xd9) break;
      if (marker === 0xda) { parts.push(newJpeg.subarray(q, n)); total += n - q; q = n; break; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        parts.push(newJpeg.subarray(q, q + 2)); total += 2; q += 2; continue;
      }
      var len = (newJpeg[q + 2] << 8) | newJpeg[q + 3];
      if (len < 2) break;
      var end = Math.min(n, q + 2 + len);
      if (!skip[marker]) { parts.push(newJpeg.subarray(q, end)); total += end - q; }
      q = end;
    }

    var out = new Uint8Array(total), at = 0;
    for (var p = 0; p < parts.length; p++) { out.set(parts[p], at); at += parts[p].length; }
    return at === total ? out : out.subarray(0, at);
  }

  /* -------------------------------------------------------------- verification */
  function verify(originalInfo, outBytes) {
    var out = readJPEGInfo(outBytes);
    var report = { ok: false, checks: [], container: out ? 'jpeg' : 'none' };
    function add(label, ok, detail) { report.checks.push({ label: label, ok: !!ok, detail: detail || '' }); }
    if (!out) {
      add('출력 JPEG 파싱', false, 'EXIF 없음');
      return report;
    }
    var src = originalInfo || {};
    add('촬영일시', sameText(src.dateTimeOriginal, out.dateTimeOriginal), out.dateTimeOriginal || '없음');
    add('기기 (Make/Model)', sameText(src.make, out.make) && sameText(src.model, out.model), [out.make, out.model].filter(Boolean).join(' '));
    if (src.lens || src.focalLength) add('렌즈', sameText(src.lens, out.lens), out.lens || '');
    add('GPS', src.gps && src.gps.lat != null ? (out.gps && out.gps.lat != null) : true, out.gps && out.gps.lat != null ? '위치 유지' : '위치 없음');
    add('노출 정보', src.exposureTime ? sameNum(src.exposureTime, out.exposureTime) : true,
      [out.fNumber ? 'f/' + out.fNumber : '', out.exposureTime ? fmtShutter(out.exposureTime) : '', out.iso ? 'ISO ' + out.iso : ''].filter(Boolean).join(' · '));
    if (src.hasMakerNote) add('Apple MakerNote', out.hasMakerNote && out.makerNoteSize === src.makerNoteSize, out.makerNoteSize + ' bytes');
    add('Orientation', out.orientation === 1, String(out.orientation));
    report.orientation = out.orientation;
    report.ok = report.checks.every(function (c) { return c.ok; });
    return report;
  }
  function sameText(a, b) { if (!a) return true; return String(a) === String(b); }
  function sameNum(a, b) { if (a == null) return true; if (b == null) return false; return Math.abs(a - b) < Math.max(1e-6, Math.abs(a) * 1e-4); }
  function fmtShutter(t) { if (!t) return ''; return t >= 1 ? t + 's' : '1/' + Math.round(1 / t) + 's'; }

  /* ---------------------------------------------------------------------- API */
  var api = {
    isJPEG: isJPEG,
    scanJPEG: scanJPEG,
    collectSegments: collectSegments,
    readJPEGInfo: readJPEGInfo,
    readHEIFExif: readHEIFExif,
    readHEIFInfo: readHEIFInfo,
    readInfoFromTIFF: readInfoFromTIFF,
    patchTIFF: patchTIFF,
    buildTIFF: buildTIFF,
    buildAPP1: buildAPP1,
    patchXMPOrientation: patchXMPOrientation,
    injectSegments: injectSegments,
    verify: verify,
    fmtShutter: fmtShutter,
    _internal: { boxHeader: boxHeader, childBoxes: childBoxes, findBox: findBox, parseIinf: parseIinf, parseIloc: parseIloc }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.P18EXIF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
