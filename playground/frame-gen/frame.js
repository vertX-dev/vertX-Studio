/* Frame generator core.
   Port of frames.py. Draws an RGBA frame with a cut-out opening onto a canvas.
   Public API: FrameGen.render(canvas, options, textureImage) */

const FrameGen = (function () {
  'use strict';

  const STYLES = ['torn', 'clean', 'wavy', 'blob'];
  const GRADIENTS = ['none', 'linear', 'radial'];

  const DEFAULTS = {
    width: 1024,
    height: 1024,
    style: 'torn',
    margin: 0.13,
    marginJitter: 0,
    roughness: 0.45,
    detail: 5,
    cornerRadius: 0,
    waveCount: 10,
    points: 1600,
    color: '#5b14f5',
    color2: '#2a00a8',
    gradient: 'none',
    angle: 90,
    holeFill: null,
    feather: 0,
    seed: 1
  };

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function smoothstep(t) {
    return t * t * (3 - 2 * t);
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Periodic 1D fractal noise of length n, normalised to [-1, 1]. */
  function fractalNoise(n, octaves, rand, baseFreq) {
    const out = new Float64Array(n);
    let amp = 1;
    let norm = 0;
    let freq = Math.max(2, baseFreq | 0);

    for (let o = 0; o < Math.max(1, octaves | 0); o++) {
      const ctrl = new Float64Array(freq);
      for (let i = 0; i < freq; i++) ctrl[i] = rand() - 0.5;
      for (let i = 0; i < n; i++) {
        const x = (i * freq) / n;
        const fl = Math.floor(x);
        const i0 = fl % freq;
        const i1 = (i0 + 1) % freq;
        const t = smoothstep(x - fl);
        out[i] += amp * (ctrl[i0] * (1 - t) + ctrl[i1] * t);
      }
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }

    let peak = 0;
    for (let i = 0; i < n; i++) {
      out[i] /= norm;
      peak = Math.max(peak, Math.abs(out[i]));
    }
    if (peak > 1e-9) for (let i = 0; i < n; i++) out[i] /= peak;
    return out;
  }

  /* Points and outward unit normals along a rounded rectangle. */
  function roundedRectPath(x0, y0, x1, y1, radius, n) {
    const w = x1 - x0;
    const h = y1 - y0;
    const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
    const q = Math.PI / 2;

    const segs = [
      { arc: false, a: [x0 + r, y0], b: [x1 - r, y0], nrm: [0, -1], len: Math.max(w - 2 * r, 0) },
      { arc: true, c: [x1 - r, y0 + r], a0: -q, a1: 0, len: r * q },
      { arc: false, a: [x1, y0 + r], b: [x1, y1 - r], nrm: [1, 0], len: Math.max(h - 2 * r, 0) },
      { arc: true, c: [x1 - r, y1 - r], a0: 0, a1: q, len: r * q },
      { arc: false, a: [x1 - r, y1], b: [x0 + r, y1], nrm: [0, 1], len: Math.max(w - 2 * r, 0) },
      { arc: true, c: [x0 + r, y1 - r], a0: q, a1: Math.PI, len: r * q },
      { arc: false, a: [x0, y1 - r], b: [x0, y0 + r], nrm: [-1, 0], len: Math.max(h - 2 * r, 0) },
      { arc: true, c: [x0 + r, y0 + r], a0: Math.PI, a1: 1.5 * Math.PI, len: r * q }
    ];

    let total = 0;
    for (const s of segs) total += s.len;
    if (total <= 0) total = 1;

    const pts = [];
    const nrms = [];
    for (const s of segs) {
      const count = Math.max(2, Math.round((n * s.len) / total));
      for (let i = 0; i < count; i++) {
        const t = i / count;
        if (s.arc) {
          const ang = s.a0 + (s.a1 - s.a0) * t;
          const nx = Math.cos(ang);
          const ny = Math.sin(ang);
          pts.push([s.c[0] + r * nx, s.c[1] + r * ny]);
          nrms.push([nx, ny]);
        } else {
          pts.push([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]);
          nrms.push(s.nrm);
        }
      }
    }
    return { pts: pts, nrms: nrms };
  }

  /* Polygon describing the inner opening, in pixel coordinates. */
  function buildOutline(o, rand) {
    const w = o.width;
    const h = o.height;
    const short = Math.min(w, h);

    let m = o.margin < 1 ? o.margin * short : o.margin;
    m = Math.max(1, Math.min(m, short / 2 - 2));

    const j = o.marginJitter;
    const side = [];
    for (let i = 0; i < 4; i++) side.push(m * (1 + j * (rand() * 2 - 1)));

    const x0 = side[0];
    const y0 = side[1];
    const x1 = w - side[2];
    const y1 = h - side[3];
    const n = Math.max(64, o.points | 0);

    let pts;
    if (o.style === 'blob') {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = (x1 - x0) / 2;
      const ry = (y1 - y0) / 2;
      const noise = fractalNoise(n, Math.max(2, o.detail - 2), rand, 3);
      pts = [];
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        const k = 1 + o.roughness * 0.9 * noise[i];
        pts.push([cx + rx * Math.cos(a) * k, cy + ry * Math.sin(a) * k]);
      }
    } else {
      const radius = o.cornerRadius < 1 ? o.cornerRadius * short : o.cornerRadius;
      const path = roundedRectPath(x0, y0, x1, y1, radius, n);
      const k = path.pts.length;
      let offset;

      if (o.style === 'torn') {
        const nz = fractalNoise(k, o.detail, rand, 6);
        offset = function (i) { return o.roughness * m * nz[i]; };
      } else if (o.style === 'wavy') {
        const waves = Math.max(1, o.waveCount | 0);
        offset = function (i) {
          return o.roughness * m * 0.6 * Math.sin((2 * Math.PI * waves * i) / k);
        };
      } else {
        offset = function () { return 0; };
      }

      pts = path.pts.map(function (p, i) {
        const d = offset(i);
        return [p[0] + path.nrms[i][0] * d, p[1] + path.nrms[i][1] * d];
      });
    }

    return pts.map(function (p) {
      return [clamp(p[0], 1, w - 1), clamp(p[1], 1, h - 1)];
    });
  }

  /* Solid colour or CanvasGradient for the frame body. */
  function bodyFill(ctx, o, w, h) {
    if (o.gradient === 'linear') {
      const a = (o.angle * Math.PI) / 180;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
      const g = ctx.createLinearGradient(
        w / 2 - dx * half, h / 2 - dy * half,
        w / 2 + dx * half, h / 2 + dy * half
      );
      g.addColorStop(0, o.color);
      g.addColorStop(1, o.color2);
      return g;
    }
    if (o.gradient === 'radial') {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
      g.addColorStop(0, o.color);
      g.addColorStop(1, o.color2);
      return g;
    }
    return o.color;
  }

  /* Draw an image covering the whole canvas, preserving aspect ratio. */
  function drawCover(ctx, img, w, h) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function tracePath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }

  // ------------------------------------------------------------------
  // public
  // ------------------------------------------------------------------

  function render(canvas, options, texture) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const w = Math.max(8, o.width | 0);
    const h = Math.max(8, o.height | 0);
    o.width = w;
    o.height = h;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';

    if (texture) {
      drawCover(ctx, texture, w, h);
    } else {
      ctx.fillStyle = bodyFill(ctx, o, w, h);
      ctx.fillRect(0, 0, w, h);
    }

    const pts = buildOutline(o, mulberry32(o.seed));
    ctx.globalCompositeOperation = 'destination-out';
    if (o.feather > 0) ctx.filter = 'blur(' + o.feather + 'px)';
    ctx.fillStyle = '#000';
    tracePath(ctx, pts);
    ctx.fill();
    ctx.filter = 'none';

    if (o.holeFill) {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = o.holeFill;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.globalCompositeOperation = 'source-over';
    return canvas;
  }

  return {
    STYLES: STYLES,
    GRADIENTS: GRADIENTS,
    DEFAULTS: DEFAULTS,
    render: render,
    drawCover: drawCover
  };
})();
