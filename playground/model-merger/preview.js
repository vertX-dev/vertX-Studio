/* Orthographic wireframe preview for a merged .bbmodel. Canvas 2D only, no
   dependencies -- the point is to confirm the arrangement, not to render skins.

   Geometry is flattened once per model change into world-space polylines, with
   group and element rotations baked in (ZYX euler order, matching Blockbench).
   The camera then orbits over those cached points.

   Public API: Preview.attach(canvas) -> { setModel, fit, destroy } */

const Preview = (function () {
  'use strict';

  /* One colour per source file, reused modulo the palette length. */
  const PALETTE = [
    '#4c8ff5', '#5ec27a', '#f0b429', '#e8613c',
    '#a05ce8', '#2fb8b0', '#e05fa0', '#8a9199'
  ];

  const DEG = Math.PI / 180;

  const CUBE_EDGES = [
    [0, 1], [1, 3], [3, 2], [2, 0],
    [4, 5], [5, 7], [7, 6], [6, 4],
    [0, 4], [1, 5], [2, 6], [3, 7]
  ];

  // ------------------------------------------------------------------
  // geometry
  // ------------------------------------------------------------------

  function rotate(point, origin, rotation) {
    if (!rotation || (!rotation[0] && !rotation[1] && !rotation[2])) return point;
    let x = point[0] - origin[0];
    let y = point[1] - origin[1];
    let z = point[2] - origin[2];

    const rx = (rotation[0] || 0) * DEG;
    const ry = (rotation[1] || 0) * DEG;
    const rz = (rotation[2] || 0) * DEG;

    if (rx) {
      const c = Math.cos(rx);
      const s = Math.sin(rx);
      const ny = y * c - z * s;
      z = y * s + z * c;
      y = ny;
    }
    if (ry) {
      const c = Math.cos(ry);
      const s = Math.sin(ry);
      const nx = x * c + z * s;
      z = -x * s + z * c;
      x = nx;
    }
    if (rz) {
      const c = Math.cos(rz);
      const s = Math.sin(rz);
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
    }
    return [x + origin[0], y + origin[1], z + origin[2]];
  }

  /* `stack` is outermost-first, so it is applied in reverse. */
  function applyStack(point, stack) {
    let p = point;
    for (let i = stack.length - 1; i >= 0; i--) {
      p = rotate(p, stack[i].origin, stack[i].rotation);
    }
    return p;
  }

  function vec3(value, fallback) {
    return Array.isArray(value) && value.length >= 3
      ? [+value[0] || 0, +value[1] || 0, +value[2] || 0]
      : (fallback || [0, 0, 0]);
  }

  /* Flattens the model into { color, points: [[x,y,z], ...] } polylines. */
  function buildScene(model, sourceOf) {
    const byUuid = {};
    (model.elements || []).forEach(function (el) { byUuid[el.uuid] = el; });

    const lines = [];

    function addElement(el, stack) {
      if (el.visibility === false) return;
      const colour = PALETTE[(sourceOf[el.uuid] || 0) % PALETTE.length];
      const origin = vec3(el.origin);
      const rotation = Array.isArray(el.rotation) ? el.rotation : null;
      const local = rotation ? [{ origin: origin, rotation: rotation }] : [];
      const full = stack.concat(local);

      function place(p) { return applyStack(p, full); }

      if (Array.isArray(el.from) && Array.isArray(el.to)) {
        const inflate = typeof el.inflate === 'number' ? el.inflate : 0;
        const from = vec3(el.from).map(function (v) { return v - inflate; });
        const to = vec3(el.to).map(function (v) { return v + inflate; });
        const corners = [];
        for (let i = 0; i < 8; i++) {
          corners.push(place([
            i & 1 ? to[0] : from[0],
            i & 2 ? to[1] : from[1],
            i & 4 ? to[2] : from[2]
          ]));
        }
        CUBE_EDGES.forEach(function (edge) {
          lines.push({ color: colour, points: [corners[edge[0]], corners[edge[1]]] });
        });
        return;
      }

      if (el.vertices && el.faces) {
        const verts = {};
        Object.keys(el.vertices).forEach(function (key) {
          const v = vec3(el.vertices[key]);
          verts[key] = place([v[0] + origin[0], v[1] + origin[1], v[2] + origin[2]]);
        });
        Object.keys(el.faces).forEach(function (key) {
          const face = el.faces[key];
          const keys = face && Array.isArray(face.vertices) ? face.vertices : [];
          if (keys.length < 2) return;
          const loop = keys.map(function (k) { return verts[k]; }).filter(Boolean);
          if (loop.length < 2) return;
          lines.push({ color: colour, points: loop.concat([loop[0]]) });
        });
        return;
      }

      if (Array.isArray(el.position) || el.type === 'locator' || el.type === 'null_object') {
        const at = place(vec3(el.position, origin));
        const r = 1.5;
        for (let axis = 0; axis < 3; axis++) {
          const a = at.slice();
          const b = at.slice();
          a[axis] -= r;
          b[axis] += r;
          lines.push({ color: colour, points: [a, b], thin: true });
        }
      }
    }

    (function walk(nodes, stack) {
      (nodes || []).forEach(function (node) {
        if (typeof node === 'string') {
          const el = byUuid[node];
          if (el) addElement(el, stack);
          return;
        }
        if (!node || typeof node !== 'object') return;
        if (node.visibility === false) return;
        const next = Array.isArray(node.rotation) &&
          (node.rotation[0] || node.rotation[1] || node.rotation[2])
          ? stack.concat([{ origin: vec3(node.origin), rotation: node.rotation }])
          : stack;
        walk(node.children, next);
      });
    })(model.outliner, []);

    return lines;
  }

  // ------------------------------------------------------------------
  // renderer
  // ------------------------------------------------------------------

  function attach(canvas) {
    const ctx = canvas.getContext('2d');
    const camera = { yaw: 35, pitch: 24, zoom: 6, panU: 0, panV: 0 };

    let lines = [];
    let centre = [0, 0, 0];
    let needsFit = true;
    let frame = null;

    /* Projects into camera units: [u, v, depth], relative to the model centre. */
    function project(point) {
      const x = point[0] - centre[0];
      const y = point[1] - centre[1];
      const z = point[2] - centre[2];

      const cy = Math.cos(camera.yaw * DEG);
      const sy = Math.sin(camera.yaw * DEG);
      const u = x * cy + z * sy;
      const zr = -x * sy + z * cy;

      const cp = Math.cos(camera.pitch * DEG);
      const sp = Math.sin(camera.pitch * DEG);
      const v = y * cp - zr * sp;
      const depth = y * sp + zr * cp;

      return [u, v, depth];
    }

    function fit() {
      needsFit = true;
      schedule();
    }

    function applyFit(width, height) {
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      lines.forEach(function (line) {
        line.points.forEach(function (p) {
          const q = project(p);
          if (q[0] < minU) minU = q[0];
          if (q[0] > maxU) maxU = q[0];
          if (q[1] < minV) minV = q[1];
          if (q[1] > maxV) maxV = q[1];
        });
      });
      if (minU === Infinity) {
        camera.panU = 0;
        camera.panV = 0;
        camera.zoom = 6;
        return;
      }
      camera.panU = (minU + maxU) / 2;
      camera.panV = (minV + maxV) / 2;
      const spanU = Math.max(maxU - minU, 1);
      const spanV = Math.max(maxV - minV, 1);
      camera.zoom = Math.min(width / spanU, height / spanV) * 0.82;
      needsFit = false;
    }

    function draw() {
      frame = null;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 600;
      const height = canvas.clientHeight || 400;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      if (needsFit) applyFit(width, height);

      const cx = width / 2;
      const cy = height / 2;
      function screen(point) {
        const q = project(point);
        return [
          cx + (q[0] - camera.panU) * camera.zoom,
          cy - (q[1] - camera.panV) * camera.zoom,
          q[2]
        ];
      }

      if (!lines.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Nothing to preview yet', cx, cy);
        return;
      }

      /* Ground grid at y = 0, spaced one block, heavier every 16. */
      const span = 32;
      const step = Math.max(1, Math.round(span / 16));
      ctx.lineWidth = 1;
      for (let i = -span; i <= span; i += step) {
        const major = i % 16 === 0;
        ctx.strokeStyle = major ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
        strokeSegment(screen([i, 0, -span]), screen([i, 0, span]));
        strokeSegment(screen([-span, 0, i]), screen([span, 0, i]));
      }

      function strokeSegment(a, b) {
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }

      /* Painter's algorithm on segment midpoints. Good enough for wireframe. */
      const segments = [];
      lines.forEach(function (line) {
        for (let i = 0; i < line.points.length - 1; i++) {
          const a = screen(line.points[i]);
          const b = screen(line.points[i + 1]);
          segments.push({
            a: a,
            b: b,
            depth: (a[2] + b[2]) / 2,
            color: line.color,
            thin: line.thin
          });
        }
      });
      segments.sort(function (p, q) { return p.depth - q.depth; });

      segments.forEach(function (seg) {
        ctx.strokeStyle = seg.color;
        ctx.globalAlpha = seg.thin ? 0.6 : 0.85;
        ctx.lineWidth = seg.thin ? 1 : 1.2;
        strokeSegment(seg.a, seg.b);
      });
      ctx.globalAlpha = 1;

      /* Origin axes on top, X red / Y green / Z blue. */
      const axes = [
        { to: [8, 0, 0], color: '#ff6b6b' },
        { to: [0, 8, 0], color: '#6bd47a' },
        { to: [0, 0, 8], color: '#6b9bff' }
      ];
      ctx.lineWidth = 1.5;
      axes.forEach(function (axis) {
        ctx.strokeStyle = axis.color;
        strokeSegment(screen([0, 0, 0]), screen(axis.to));
      });
    }

    function schedule() {
      if (frame === null) frame = requestAnimationFrame(draw);
    }

    function setModel(model, sourceOf) {
      if (!model) {
        lines = [];
        centre = [0, 0, 0];
      } else {
        lines = buildScene(model, sourceOf || {});
        const box = BBModel.bounds(model);
        centre = [
          (box.min[0] + box.max[0]) / 2,
          (box.min[1] + box.max[1]) / 2,
          (box.min[2] + box.max[2]) / 2
        ];
      }
      needsFit = true;
      schedule();
    }

    // interaction -----------------------------------------------------
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', function (event) {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      camera.yaw += (event.clientX - lastX) * 0.5;
      camera.pitch = Math.max(-89, Math.min(89, camera.pitch + (event.clientY - lastY) * 0.5));
      lastX = event.clientX;
      lastY = event.clientY;
      schedule();
    });
    ['pointerup', 'pointercancel'].forEach(function (type) {
      canvas.addEventListener(type, function (event) {
        dragging = false;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      });
    });
    canvas.addEventListener('wheel', function (event) {
      event.preventDefault();
      camera.zoom *= event.deltaY < 0 ? 1.12 : 1 / 1.12;
      camera.zoom = Math.max(0.2, Math.min(200, camera.zoom));
      needsFit = false;
      schedule();
    }, { passive: false });
    canvas.addEventListener('dblclick', fit);

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () {
        needsFit = true;
        schedule();
      }).observe(canvas);
    }

    schedule();
    return { setModel: setModel, fit: fit, palette: PALETTE };
  }

  return { attach: attach, PALETTE: PALETTE };
})();
