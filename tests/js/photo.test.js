// Run: node --test tests/js/
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../js/chatak-photo.js');

test('fitWithin caps the long edge at 1600 and never enlarges', () => {
  assert.deepEqual(P.fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(P.fitWithin(3000, 4000, 1600), { width: 1200, height: 1600 });
  assert.deepEqual(P.fitWithin(800, 600, 1600), { width: 800, height: 600 });
  assert.deepEqual(P.fitWithin(1600, 10, 1600), { width: 1600, height: 10 });
});

test('photo names from the phone give the time taken, in Japan time', () => {
  assert.equal(P.takenAtFromName('IMG20261024192355.jpg'), '2026-10-24T10:23:55.000Z');
  assert.equal(P.takenAtFromName('IMG_20261024_192355.jpg'), '2026-10-24T10:23:55.000Z');
  assert.equal(P.takenAtFromName('#Shopping/Donki/IMG20261024192355.jpg'), '2026-10-24T10:23:55.000Z');
  assert.equal(P.takenAtFromName('photo.jpg'), null);
  assert.equal(P.takenAtFromName('IMG20260231120000.jpg'), null, 'no 31 February');
});

// A minimal JPEG: SOI, APP1 Exif with IFD0 → Exif IFD → DateTimeOriginal
// (+ OffsetTimeOriginal when given), then SOS.
function jpegWithExif(dt, offset, little) {
  const tiff = [];
  const u16 = (n) => (little ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n) => (little ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const ascii = (s) => [...Buffer.from(s + '\0', 'latin1')];
  const exifEntries = offset ? 2 : 1;
  const ifd0 = 8, exifIfd = ifd0 + 2 + 12 + 4, data = exifIfd + 2 + exifEntries * 12 + 4;
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0));
  tiff.push(...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfd), ...u32(0));
  tiff.push(...u16(exifEntries), ...u16(0x9003), ...u16(2), ...u32(20), ...u32(data));
  if (offset) tiff.push(...u16(0x9011), ...u16(2), ...u32(7), ...u32(data + 20));
  tiff.push(...u32(0), ...ascii(dt));
  if (offset) tiff.push(...ascii(offset));
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xda, 0, 2]).buffer;
}

test('EXIF DateTimeOriginal is read, Japan time unless the photo says otherwise', () => {
  assert.equal(P.exifTakenAt(jpegWithExif('2026:10:24 19:23:55', null, false)), '2026-10-24T10:23:55.000Z');
  assert.equal(P.exifTakenAt(jpegWithExif('2026:10:24 19:23:55', null, true)), '2026-10-24T10:23:55.000Z');
  assert.equal(P.exifTakenAt(jpegWithExif('2026:10:24 19:23:55', '+01:00', true)), '2026-10-24T18:23:55.000Z');
});

test('files without EXIF, or not JPEG at all, give null instead of failing', () => {
  assert.equal(P.exifTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer), null);
  assert.equal(P.exifTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), null);
  assert.equal(P.exifTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 40, 0x45, 0x78]).buffer), null);
  assert.equal(P.exifTakenAt(new ArrayBuffer(0)), null);
});
