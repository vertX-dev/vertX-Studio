/* UI for the frame generator: live preview, presets, background image, exports. */

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

  const OUTPUT_FORMAT = {
    margin: function (v) { return (v * 100).toFixed(1) + '%'; },
    marginJitter: function (v) { return (v * 100).toFixed(0) + '%'; },
    cornerRadius: function (v) { return (v * 100).toFixed(1) + '%'; },
    roughness: function (v) { return v.toFixed(2); },
    angle: function (v) { return v.toFixed(0) + '°'; },
    feather: function (v) { return v.toFixed(1) + 'px'; }
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

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------

  const canvas = $('frame');
  const stage = $('stage');
  let bgImage = null;
  let bgUrl = null;
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
    for (const id in NUMBER_FIELDS) {
      const out = $(id + 'Out');
      if (!out) continue;
      const v = parseFloat($(id).value) || 0;
      out.textContent = OUTPUT_FORMAT[id] ? OUTPUT_FORMAT[id](v) : String(v);
    }

    const style = $('style').value;
    const gradient = $('gradient').value;
    toggle($('roughness').closest('.field'), style !== 'clean');
    toggle($('detail').closest('.field'), style === 'torn' || style === 'blob');
    toggle($('waveCount').closest('.field'), style === 'wavy');
    toggle($('cornerRadius').closest('.field'), style !== 'blob');
    toggle($('color2').closest('.field'), gradient !== 'none');
    toggle($('angle').closest('.field'), gradient === 'linear');
  }

  // ------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------

  function scheduleRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      draw();
    });
  }

  function draw() {
    const opts = readOptions();
    const asTexture = $('useAsTexture').checked && bgImage;
    FrameGen.render(canvas, opts, asTexture ? bgImage : null);

    const showBehind = bgUrl && !asTexture;
    canvas.classList.toggle('has-bg', !!showBehind);
    canvas.style.backgroundImage = showBehind ? 'url("' + bgUrl + '")' : '';

    try {
      localStorage.setItem(STORE_LAST, JSON.stringify(opts));
    } catch (err) {
      /* storage may be blocked; not fatal */
    }
  }

  function renderTo(target, opts) {
    const asTexture = $('useAsTexture').checked && bgImage;
    FrameGen.render(target, opts, asTexture ? bgImage : null);

    if (!$('bakeBg').checked || !bgImage || asTexture) return target;

    const baked = document.createElement('canvas');
    baked.width = target.width;
    baked.height = target.height;
    const ctx = baked.getContext('2d');
    FrameGen.drawCover(ctx, bgImage, baked.width, baked.height);
    ctx.drawImage(target, 0, 0);
    return baked;
  }

  // ------------------------------------------------------------------
  // background image
  // ------------------------------------------------------------------

  function setBackground(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (bgUrl) URL.revokeObjectURL(bgUrl);
    bgUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      bgImage = img;
      scheduleRender();
      setStatus('Background: ' + file.name);
    };
    img.src = bgUrl;
  }

  function clearBackground() {
    if (bgUrl) URL.revokeObjectURL(bgUrl);
    bgUrl = null;
    bgImage = null;
    $('bgFile').value = '';
    scheduleRender();
    setStatus('');
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
    const out = renderTo(document.createElement('canvas'), opts);
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
      const out = renderTo(work, opts);
      files.push({
        name: 'frame_' + base.style + '_' + pad(i + 1, 4) + '.png',
        data: await canvasToBytes(out)
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
    if (event.target.id === 'bgFile' || event.target.id === 'presetSelect') return;
    syncUI();
    scheduleRender();
  });

  $('panel').addEventListener('change', function (event) {
    if (event.target.id === 'bgFile') setBackground(event.target.files[0]);
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

  $('bgClear').addEventListener('click', clearBackground);
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
    });
  });

  ['dragleave', 'drop'].forEach(function (type) {
    stage.addEventListener(type, function (event) {
      event.preventDefault();
      stage.classList.remove('dragover');
    });
  });

  stage.addEventListener('drop', function (event) {
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    setBackground(file);
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
