/* UI for the frame generator: live preview, layers, presets, exports.

   Compositing order, bottom to top:
     background layer -> generated frame -> foreground layer
   The preview always shows every loaded layer; the per-layer "export" checkbox
   only affects what Download PNG and the ZIP batch contain. */

(function () {
  'use strict';

  const STORE_PRESETS = 'frameGen.presets';
  const STORE_LAST = 'frameGen.last';

  /* id -> option key, with the parser used when reading the input */
  const NUMBER_FIELDS = {
    width: 'width',
    height: 'height',
    margin: 'margin',
    marginJitter: 'marginJitter',
    roughness: 'roughness',
    detail: 'detail',
    cornerRadius: 'cornerRadius',
    waveCount: 'waveCount',
    points: 'points',
    angle: 'angle',
    feather: 'feather',
    seed: 'seed'
  };

  const TEXT_FIELDS = {
    style: 'style',
    gradient: 'gradient',
    color: 'color',
    color2: 'color2'
  };

  const LAYER_NUMBERS = ['Opacity', 'Scale', 'OffsetX', 'OffsetY'];

  const OUTPUT_FORMAT = {
    margin: function (v) { return (v * 100).toFixed(1) + '%'; },
    marginJitter: function (v) { return (v * 100).toFixed(0) + '%'; },
    cornerRadius: function (v) { return (v * 100).toFixed(1) + '%'; },
    roughness: function (v) { return v.toFixed(2); },
    angle: function (v) { return v.toFixed(0) + '°'; },
    feather: function (v) { return v.toFixed(1) + 'px'; },
    bgOpacity: percent, fgOpacity: percent,
    bgScale: percent, fgScale: percent,
    bgOffsetX: signedPercent, fgOffsetX: signedPercent,
    bgOffsetY: signedPercent, fgOffsetY: signedPercent
  };

  const BUILTIN_PRESETS = {
    'Torn paper': { style: 'torn', margin: 0.13, roughness: 0.45, detail: 5, cornerRadius: 0, gradient: 'none', color: '#5b14f5', feather: 0, marginJitter: 0 },
    'Ripped edges': { style: 'torn', margin: 0.16, roughness: 0.9, detail: 7, marginJitter: 0.25, gradient: 'radial', color: '#ff3d81', color2: '#7a0033' },
    'Soft card': { style: 'clean', margin: 0.09, cornerRadius: 0.06, gradient: 'linear', angle: 120, color: '#00c2ff', color2: '#0047b3', feather: 2 },
    'Scallop': { style: 'wavy', margin: 0.14, roughness: 0.7, waveCount: 16, cornerRadius: 0.03, gradient: 'none', color: '#ffb703' },
    'Ink blob': { style: 'blob', margin: 0.12, roughness: 0.5, detail: 6, gradient: 'radial', color: '#1b1b1f', color2: '#3d3d47' }
  };

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  function percent(v) {
    return (v * 100).toFixed(0) + '%';
  }

  function signedPercent(v) {
    return (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function loadPresets() {
    try {
      return JSON.parse(localStorage.getItem(STORE_PRESETS) || '{}');
    } catch (err) {
      return {};
    }
  }

  function savePresets(map) {
    try {
      localStorage.setItem(STORE_PRESETS, JSON.stringify(map));
    } catch (err) {
      setStatus('Could not save preset (storage blocked).');
    }
  }

  function setStatus(text) {
    $('status').textContent = text || '';
  }

  function toggle(el, visible) {
    if (el) el.classList.toggle('hidden', !visible);
  }

  function canvasToBytes(canvas) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); });
      }, 'image/png');
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function pad(n, width) {
    return String(n).padStart(width, '0');
  }

  /* Load a File into a slot of IMAGES, then re-render. */
  function loadImage(slot, file, onDone) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) return;
    const entry = IMAGES[slot];
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = URL.createObjectURL(file);
    entry.name = file.name;
    const img = new Image();
    img.onload = function () {
      entry.image = img;
      if (onDone) onDone();
      scheduleRender();
      setStatus(slot + ': ' + file.name);
    };
    img.onerror = function () {
      setStatus('Could not read ' + file.name);
    };
    img.src = entry.url;
  }

  function clearImage(slot, onDone) {
    const entry = IMAGES[slot];
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = null;
    entry.image = null;
    entry.name = '';
    if (onDone) onDone();
    scheduleRender();
  }

  /* Draw one image layer with its fit mode, scale, offset and opacity. */
  function drawLayer(ctx, layer, w, h) {
    const img = layer.image;
    if (!img || !layer.opacity) return;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;

    const ox = layer.offsetX * w;
    const oy = layer.offsetY * h;

    ctx.save();
    ctx.globalAlpha = clamp(layer.opacity, 0, 1);

    if (layer.fit === 'tile') {
      const pattern = ctx.createPattern(img, 'repeat');
      if (pattern) {
        if (pattern.setTransform && typeof DOMMatrix === 'function') {
          pattern.setTransform(new DOMMatrix().translate(ox, oy).scale(layer.scale));
        }
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
      }
    } else {
      let dw = w;
      let dh = h;
      if (layer.fit !== 'stretch') {
        const s = layer.fit === 'contain'
          ? Math.min(w / iw, h / ih)
          : Math.max(w / iw, h / ih);
        dw = iw * s;
        dh = ih * s;
      }
      dw *= layer.scale;
      dh *= layer.scale;
      ctx.drawImage(img, (w - dw) / 2 + ox, (h - dh) / 2 + oy, dw, dh);
    }

    ctx.restore();
  }

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------

  const canvas = $('frame');
  const stage = $('stage');
  const frameCanvas = document.createElement('canvas');

  const IMAGES = {
    bg: { image: null, url: null, name: '' },
    fg: { image: null, url: null, name: '' },
    texture: { image: null, url: null, name: '' }
  };

  let pending = false;

  // ------------------------------------------------------------------
  // options <-> form
  // ------------------------------------------------------------------

  function readOptions() {
    const o = {};
    for (const id in NUMBER_FIELDS) o[NUMBER_FIELDS[id]] = parseFloat($(id).value) || 0;
    for (const id in TEXT_FIELDS) o[TEXT_FIELDS[id]] = $(id).value;
    o.holeFill = $('holeFillOn').checked ? $('holeFillColor').value : null;
    return o;
  }

  function readLayer(prefix) {
    return {
      image: IMAGES[prefix].image,
      fit: $(prefix + 'Fit').value,
      opacity: parseFloat($(prefix + 'Opacity').value),
      scale: parseFloat($(prefix + 'Scale').value) || 1,
      offsetX: parseFloat($(prefix + 'OffsetX').value) || 0,
      offsetY: parseFloat($(prefix + 'OffsetY').value) || 0,
      include: $(prefix + 'Export').checked
    };
  }

  function applyOptions(o) {
    const merged = Object.assign({}, FrameGen.DEFAULTS, o || {});
    for (const id in NUMBER_FIELDS) {
      const v = merged[NUMBER_FIELDS[id]];
      if (typeof v === 'number' && isFinite(v)) $(id).value = v;
    }
    for (const id in TEXT_FIELDS) {
      const v = merged[TEXT_FIELDS[id]];
      if (typeof v === 'string') $(id).value = v;
    }
    $('holeFillOn').checked = !!merged.holeFill;
    if (merged.holeFill) $('holeFillColor').value = merged.holeFill;
    syncUI();
    scheduleRender();
  }

  function syncUI() {
    const numeric = Object.keys(NUMBER_FIELDS).slice();
    ['bg', 'fg'].forEach(function (p) {
      LAYER_NUMBERS.forEach(function (key) { numeric.push(p + key); });
    });

    numeric.forEach(function (id) {
      const out = $(id + 'Out');
      if (!out) return;
      const v = parseFloat($(id).value) || 0;
      out.textContent = OUTPUT_FORMAT[id] ? OUTPUT_FORMAT[id](v) : String(v);
    });

    const style = $('style').value;
    const gradient = $('gradient').value;
    toggle($('roughness').closest('.field'), style !== 'clean');
    toggle($('detail').closest('.field'), style === 'torn' || style === 'blob');
    toggle($('waveCount').closest('.field'), style === 'wavy');
    toggle($('cornerRadius').closest('.field'), style !== 'blob');
    toggle($('color').closest('.field'), gradient !== 'texture');
    toggle($('color2').closest('.field'), gradient === 'linear' || gradient === 'radial');
    toggle($('angle').closest('.field'), gradient === 'linear');
    toggle(document.querySelector('[data-for="texture"]'), gradient === 'texture');

    ['bg', 'fg'].forEach(function (p) {
      $(p + 'Name').textContent = IMAGES[p].name || 'empty';
    });
  }

  // ------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------

  function scheduleRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      composite(canvas, readOptions(), false);
    });
  }

  /* Draw background, frame and foreground into target.
     forExport honours the per-layer export checkboxes. */
  function composite(target, opts, forExport) {
    const w = Math.max(8, opts.width | 0);
    const h = Math.max(8, opts.height | 0);
    target.width = w;
    target.height = h;

    const ctx = target.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const bg = readLayer('bg');
    const fg = readLayer('fg');
    const texture = opts.gradient === 'texture' ? IMAGES.texture.image : null;

    if (!forExport || bg.include) drawLayer(ctx, bg, w, h);

    if (!forExport || $('frameExport').checked) {
      FrameGen.render(frameCanvas, opts, texture);
      ctx.drawImage(frameCanvas, 0, 0);
    }

    if (!forExport || fg.include) drawLayer(ctx, fg, w, h);

    if (!forExport) {
      try {
        localStorage.setItem(STORE_LAST, JSON.stringify(opts));
      } catch (err) {
        /* storage may be blocked; not fatal */
      }
    }
    return target;
  }

  // ------------------------------------------------------------------
  // presets
  // ------------------------------------------------------------------

  function refreshPresetList(selected) {
    const builtin = $('presetBuiltin');
    const user = $('presetUser');
    builtin.innerHTML = '';
    user.innerHTML = '';

    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— custom —';
    builtin.appendChild(blank);

    for (const name in BUILTIN_PRESETS) {
      const opt = document.createElement('option');
      opt.value = 'b:' + name;
      opt.textContent = name;
      builtin.appendChild(opt);
    }

    const saved = loadPresets();
    for (const name in saved) {
      const opt = document.createElement('option');
      opt.value = 'u:' + name;
      opt.textContent = name;
      user.appendChild(opt);
    }
    user.disabled = !user.children.length;
    $('presetSelect').value = selected || '';
  }

  function applyPresetValue(value) {
    if (!value) return;
    const name = value.slice(2);
    const preset = value.charAt(0) === 'b' ? BUILTIN_PRESETS[name] : loadPresets()[name];
    if (preset) applyOptions(preset);
  }

  // ------------------------------------------------------------------
  // exports
  // ------------------------------------------------------------------

  function downloadPng() {
    const opts = readOptions();
    const out = composite(document.createElement('canvas'), opts, true);
    out.toBlob(function (blob) {
      downloadBlob(blob, 'frame-' + opts.style + '-' + opts.seed + '.png');
    }, 'image/png');
  }

  async function exportBatch() {
    const count = Math.max(2, Math.min(200, parseInt($('batchCount').value, 10) || 10));
    const base = readOptions();
    const work = document.createElement('canvas');
    const files = [];
    const btn = $('batchBtn');
    btn.disabled = true;

    for (let i = 0; i < count; i++) {
      const opts = Object.assign({}, base, { seed: base.seed + i });
      composite(work, opts, true);
      files.push({
        name: 'frame_' + base.style + '_' + pad(i + 1, 4) + '.png',
        data: await canvasToBytes(work)
      });
      setStatus('Rendering ' + (i + 1) + ' / ' + count);
      await new Promise(function (r) { setTimeout(r, 0); });
    }

    downloadBlob(Zip.make(files), 'frames-' + base.style + '.zip');
    setStatus(count + ' frames exported');
    btn.disabled = false;
    scheduleRender();
  }

  // ------------------------------------------------------------------
  // wiring
  // ------------------------------------------------------------------

  $('panel').addEventListener('input', function (event) {
    if (event.target.type === 'file' || event.target.id === 'presetSelect') return;
    syncUI();
    scheduleRender();
  });

  $('panel').addEventListener('change', function (event) {
    const id = event.target.id;
    if (id === 'bgFile') loadImage('bg', event.target.files[0], syncUI);
    else if (id === 'fgFile') loadImage('fg', event.target.files[0], syncUI);
    else if (id === 'textureFile') loadImage('texture', event.target.files[0], syncUI);
  });

  ['bg', 'fg'].forEach(function (prefix) {
    const card = $(prefix + 'Card');

    $(prefix + 'Clear').addEventListener('click', function () {
      $(prefix + 'File').value = '';
      clearImage(prefix, syncUI);
      setStatus('');
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      card.addEventListener(type, function (event) {
        event.preventDefault();
        card.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(function (type) {
      card.addEventListener(type, function (event) {
        event.preventDefault();
        card.classList.remove('dragover');
      });
    });

    card.addEventListener('drop', function (event) {
      event.stopPropagation();
      const file = event.dataTransfer && event.dataTransfer.files[0];
      loadImage(prefix, file, syncUI);
    });
  });

  $('textureClear').addEventListener('click', function () {
    $('textureFile').value = '';
    clearImage('texture', syncUI);
  });

  $('presetSelect').addEventListener('change', function (event) {
    applyPresetValue(event.target.value);
  });

  $('presetSave').addEventListener('click', function () {
    const name = prompt('Preset name');
    if (!name) return;
    const map = loadPresets();
    map[name] = readOptions();
    savePresets(map);
    refreshPresetList('u:' + name);
    setStatus('Saved preset "' + name + '"');
  });

  $('presetDelete').addEventListener('click', function () {
    const value = $('presetSelect').value;
    if (value.charAt(0) !== 'u') {
      setStatus('Select one of your saved presets to delete.');
      return;
    }
    const map = loadPresets();
    delete map[value.slice(2)];
    savePresets(map);
    refreshPresetList('');
    setStatus('Preset deleted');
  });

  $('resetBtn').addEventListener('click', function () {
    applyOptions(FrameGen.DEFAULTS);
    refreshPresetList('');
    setStatus('');
  });

  $('randomSeed').addEventListener('click', function () {
    $('seed').value = Math.floor(Math.random() * 1e9);
    scheduleRender();
  });

  $('downloadBtn').addEventListener('click', downloadPng);
  $('batchBtn').addEventListener('click', exportBatch);

  document.querySelectorAll('[data-size]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const parts = btn.dataset.size.split('x');
      $('width').value = parts[0];
      $('height').value = parts[1];
      scheduleRender();
    });
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    stage.addEventListener(type, function (event) {
      event.preventDefault();
      stage.classList.add('dragover');
      const target = document.querySelector('input[name="dropTarget"]:checked');
      $('dropHint').textContent = 'Drop into ' + (target && target.value === 'fg' ? 'foreground' : 'background');
    });
  });

  ['dragleave', 'drop'].forEach(function (type) {
    stage.addEventListener(type, function (event) {
      event.preventDefault();
      stage.classList.remove('dragover');
    });
  });

  stage.addEventListener('drop', function (event) {
    const target = document.querySelector('input[name="dropTarget"]:checked');
    const file = event.dataTransfer && event.dataTransfer.files[0];
    loadImage(target ? target.value : 'bg', file, syncUI);
  });

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------

  refreshPresetList('');
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem(STORE_LAST) || 'null');
  } catch (err) {
    last = null;
  }
  applyOptions(last || FrameGen.DEFAULTS);
})();
