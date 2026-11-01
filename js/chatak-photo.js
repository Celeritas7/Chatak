// chatak-photo.js — shelf photos for Compare: shrink in the browser, read when
// the photo was taken. Nothing leaves the device at full size.
//
// The shrink re-encodes through a canvas, so the stored copy carries no EXIF
// (no GPS position, no camera serial). The time it was taken is read first and
// kept in its own column.
//
// Classic script: registers window.ChatakPhoto. In Node: module.exports (the
// pure helpers only; shrink() needs a browser).

(function (root) {
  'use strict';

  const MAX_EDGE = 1600;          // long edge, px
  const TARGET_BYTES = 300000;    // aim; the bucket refuses anything over 2 MB

  // Scale (w, h) so the long edge is at most max. Never enlarges.
  function fitWithin(w, h, max) {
    const long = Math.max(w, h);
    if (!(long > max)) return { width: w, height: h };
    const k = max / long;
    return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
  }

  // Phone camera names: IMG20261024192355.jpg, IMG_20261024_192355.jpg,
  // PXL_20261024_102355123.jpg. Read as Japan time, where the photos are taken.
  function takenAtFromName(name) {
    const m = /(20\d\d)[-_]?([01]\d)[-_]?([0-3]\d)[-_ ]?([0-2]\d)[-_.]?([0-5]\d)[-_.]?([0-5]\d)/.exec(String(name || ''));
    if (!m) return null;
    return isoJst(m[1], m[2], m[3], m[4], m[5], m[6]);
  }

  function isoJst(y, mo, d, h, mi, s, offset) {
    const iso = y + '-' + mo + '-' + d + 'T' + h + ':' + mi + ':' + s + (offset || '+09:00');
    const t = Date.parse(iso);
    if (!isFinite(t)) return null;
    // Reject roll-overs such as 2026-02-31, which Date.parse would accept.
    const back = new Date(t + (offsetMinutes(offset || '+09:00') * 60000)).toISOString();
    if (back.slice(0, 10) !== y + '-' + mo + '-' + d) return null;
    return new Date(t).toISOString();
  }
  const offsetMinutes = (o) => { const m = /^([+-])(\d\d):(\d\d)$/.exec(o); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 540; };

  // DateTimeOriginal (and OffsetTimeOriginal when present) from a JPEG's EXIF.
  // Returns an ISO timestamp, or null when the file has none.
  function exifTakenAt(buf) {
    try {
      const v = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
      let p = 2;
      while (p + 4 <= v.byteLength) {
        const marker = v.getUint16(p), len = v.getUint16(p + 2);
        if ((marker & 0xFF00) !== 0xFF00 || len < 2) return null;
        if (marker === 0xFFDA) return null;  // image data starts: no EXIF before it
        if (marker === 0xFFE1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {
          return readTiff(v, p + 10, Math.min(v.byteLength, p + 2 + len));
        }
        p += 2 + len;
      }
    } catch (e) { /* a broken header is the same as none */ }
    return null;
  }

  function readTiff(v, t, end) {
    const little = v.getUint16(t) === 0x4949;
    const u16 = (o) => v.getUint16(t + o, little), u32 = (o) => v.getUint32(t + o, little);
    if (u16(2) !== 42) return null;
    const tags = (ifd) => {
      const out = {};
      if (t + ifd + 2 > end) return out;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (t + e + 12 > end) break;
        out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
      }
      return out;
    };
    const ascii = (tag) => {
      if (!tag || tag.type !== 2) return null;
      const off = tag.count > 4 ? u32(tag.at) : tag.at;
      let s = '';
      for (let i = 0; i < tag.count - 1 && t + off + i < end; i++) s += String.fromCharCode(v.getUint8(t + off + i));
      return s;
    };
    const ifd0 = tags(u32(4));
    if (!ifd0[0x8769]) return null;
    const exif = tags(u32(ifd0[0x8769].at));
    const dt = ascii(exif[0x9003]) || ascii(ifd0[0x0132]);
    const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(dt || '');
    if (!m) return null;
    const off = ascii(exif[0x9011]);
    return isoJst(m[1], m[2], m[3], m[4], m[5], m[6], /^[+-]\d\d:\d\d$/.test(off || '') ? off : null);
  }

  // ── browser only ──
  async function decode(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  }

  const toBlob = (canvas, q) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));

  // File → { blob, width, height, bytes, taken_at, original_name }.
  // Long edge 1600 px, JPEG, stepped down until it is about 300 KB.
  async function shrink(file, opts) {
    const o = Object.assign({ max: MAX_EDGE, target: TARGET_BYTES }, opts || {});
    let taken = null;
    try { taken = exifTakenAt(await file.slice(0, 256 * 1024).arrayBuffer()); } catch (e) { /* none */ }
    if (!taken) taken = takenAtFromName(file.name);
    let src;
    try { src = await decode(file); }
    catch (e) { throw new Error(file.name + ' could not be read as an image. Choose a JPEG or PNG.'); }
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    let edge = o.max, blob = null, size = null;
    for (let round = 0; round < 4 && !blob; round++) {
      size = fitWithin(w0, h0, edge);
      const c = document.createElement('canvas');
      c.width = size.width; c.height = size.height;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);  // PNG transparency → white, not black
      g.drawImage(src, 0, 0, c.width, c.height);
      for (const q of [0.82, 0.72, 0.62]) {
        const b = await toBlob(c, q);
        if (b && b.size <= o.target) { blob = b; break; }
        if (b && q === 0.62 && round === 3) blob = b;  // smallest we try; still far under the 2 MB cap
      }
      edge = Math.round(edge * 0.8);
    }
    if (src.close) src.close();
    if (!blob) throw new Error(file.name + ' could not be shrunk.');
    return { blob, width: size.width, height: size.height, bytes: blob.size, taken_at: taken, original_name: file.name || null };
  }

  const api = { MAX_EDGE, TARGET_BYTES, fitWithin, takenAtFromName, exifTakenAt, shrink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatakPhoto = api;
})(typeof window !== 'undefined' ? window : globalThis);
