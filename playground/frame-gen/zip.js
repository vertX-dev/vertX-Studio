/* Minimal store-only (no compression) ZIP writer.
   PNGs are already compressed, so storing them is fine and keeps this dependency-free.
   Public API: Zip.make([{ name, data: Uint8Array }]) -> Blob */

const Zip = (function () {
  'use strict';

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xffff, date: date & 0xffff };
  }

  function encodeName(name) {
    return new TextEncoder().encode(name);
  }

  // ------------------------------------------------------------------
  // public
  // ------------------------------------------------------------------

  function make(files) {
    const stamp = dosDateTime(new Date());
    const entries = files.map(function (f) {
      const name = encodeName(f.name);
      return { name: name, data: f.data, crc: crc32(f.data) };
    });

    let size = 22;
    for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;

    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    const out = new Uint8Array(buf);
    let pos = 0;

    function u16(v) { view.setUint16(pos, v, true); pos += 2; }
    function u32(v) { view.setUint32(pos, v >>> 0, true); pos += 4; }
    function bytes(b) { out.set(b, pos); pos += b.length; }

    for (const e of entries) {
      e.offset = pos;
      u32(0x04034b50);
      u16(20); u16(0); u16(0);
      u16(stamp.time); u16(stamp.date);
      u32(e.crc); u32(e.data.length); u32(e.data.length);
      u16(e.name.length); u16(0);
      bytes(e.name);
      bytes(e.data);
    }

    const cdStart = pos;
    for (const e of entries) {
      u32(0x02014b50);
      u16(20); u16(20); u16(0); u16(0);
      u16(stamp.time); u16(stamp.date);
      u32(e.crc); u32(e.data.length); u32(e.data.length);
      u16(e.name.length); u16(0); u16(0); u16(0); u16(0);
      u32(0); u32(e.offset);
      bytes(e.name);
    }

    const cdSize = pos - cdStart;
    u32(0x06054b50);
    u16(0); u16(0);
    u16(entries.length); u16(entries.length);
    u32(cdSize); u32(cdStart);
    u16(0);

    return new Blob([buf], { type: 'application/zip' });
  }

  return { make: make, crc32: crc32 };
})();
