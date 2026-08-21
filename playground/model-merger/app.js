/* UI for the model merger: file list, options, live preview, download.

   The merge itself is pure and cheap, so every change simply re-runs it and
   repaints. State lives in `entries`; the DOM is rebuilt only when the list
   changes structurally, so typing in a field never steals its own focus. */

(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  const dom = {
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    pickBtn: $('pickBtn'),
    files: $('files'),
    card: $('fileCard'),
    canvas: $('preview'),
    stats: $('stats'),
    warnings: $('warnings'),
    status: $('status'),
    downloadBtn: $('downloadBtn'),
    clearBtn: $('clearBtn'),
    arrangeBtn: $('arrangeBtn'),
    arrangeMode: $('arrangeMode'),
    arrangeGap: $('arrangeGap'),
    resetOffsets: $('resetOffsets'),
    outName: $('outName'),
    optWrap: $('optWrap'),
    optColor: $('optColor'),
    optDedupe: $('optDedupe'),
    optAnimations: $('optAnimations'),
    optBoxUV: $('optBoxUV'),
    optPretty: $('optPretty'),
    optCustomRes: $('optCustomRes'),
    resRow: $('resRow'),
    resWidth: $('resWidth'),
    resHeight: $('resHeight')
  };

  const preview = Preview.attach(dom.canvas);

  const state = {
    entries: [],
    result: null,
    nextId: 1,
    nameTouched: false
  };

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  function baseName(fileName) {
    return fileName.replace(/\.[^.]+$/, '') || fileName;
  }

  function plural(count, word, many) {
    return count + ' ' + (count === 1 ? word : (many || word + 's'));
  }

  function setStatus(text, isError) {
    dom.status.textContent = text || '';
    dom.status.classList.toggle('error', !!isError);
  }

  function activeEntries() {
    return state.entries.filter(function (entry) { return entry.enabled; });
  }

  /* Bounding box of an entry as it will appear after its own scale. */
  function scaledBounds(entry) {
    const box = entry.analysis.bounds;
    const s = entry.scale;
    return {
      min: box.min.map(function (v) { return v * s; }),
      max: box.max.map(function (v) { return v * s; }),
      size: box.size.map(function (v) { return v * s; })
    };
  }

  // ------------------------------------------------------------------
  // loading
  // ------------------------------------------------------------------

  function addFiles(fileList) {
    const files = Array.prototype.slice.call(fileList);
    if (!files.length) return;

    const failures = [];
    let added = 0;

    Promise.all(files.map(function (file) {
      return file.text().then(function (text) {
        const model = BBModel.parse(text);
        state.entries.push({
          id: state.nextId++,
          name: file.name,
          groupName: baseName(file.name),
          model: model,
          analysis: BBModel.analyse(model),
          enabled: true,
          offset: [0, 0, 0],
          scale: 1
        });
        added++;
      }).catch(function (err) {
        failures.push(file.name + ' — ' + err.message);
      });
    })).then(function () {
      if (added && !state.nameTouched) {
        dom.outName.value = baseName(state.entries[0].name) + '_merged';
      }
      renderFiles();
      recompute();
      if (failures.length) {
        setStatus('Skipped ' + failures.length + ' file(s): ' + failures.join('; '), true);
      } else {
        setStatus(plural(added, 'file') + ' loaded.');
      }
    });
  }

  // ------------------------------------------------------------------
  // file list
  // ------------------------------------------------------------------

  function renderFiles() {
    dom.files.textContent = '';
    let activeIndex = 0;

    state.entries.forEach(function (entry, index) {
      const node = dom.card.content.firstElementChild.cloneNode(true);
      const colour = entry.enabled
        ? Preview.PALETTE[activeIndex++ % Preview.PALETTE.length]
        : null;

      node.classList.toggle('disabled', !entry.enabled);
      node.querySelector('.swatch').style.background = colour || 'var(--muted-color)';
      node.querySelector('.file-name').textContent = entry.name;
      node.querySelector('.file-name').title = entry.name;

      const enabled = node.querySelector('.f-enabled');
      enabled.checked = entry.enabled;
      enabled.addEventListener('change', function () {
        entry.enabled = enabled.checked;
        renderFiles();
        recompute();
      });

      const group = node.querySelector('.f-group');
      group.value = entry.groupName;
      group.addEventListener('input', function () {
        entry.groupName = group.value;
        recompute();
      });

      const analysis = entry.analysis;
      const meta = node.querySelector('.file-meta');
      const tags = [
        { text: analysis.format },
        { text: analysis.resolution.width + '×' + analysis.resolution.height },
        { text: plural(analysis.counts.cubes, 'cube') }
      ];
      if (analysis.counts.meshes) tags.push({ text: plural(analysis.counts.meshes, 'mesh', 'meshes') });
      if (analysis.counts.locators) tags.push({ text: plural(analysis.counts.locators, 'locator') });
      if (analysis.counts.groups) tags.push({ text: plural(analysis.counts.groups, 'group') });
      tags.push({ text: plural(analysis.textures, 'texture') });
      if (analysis.animations) tags.push({ text: plural(analysis.animations, 'animation') });
      if (analysis.boxUV || analysis.counts.boxUV) tags.push({ text: 'box UV' });
      if (index && analysis.format !== state.entries[0].analysis.format) {
        tags.push({ text: 'format differs', alert: true });
      }
      tags.forEach(function (tag) {
        const span = document.createElement('span');
        span.className = 'tag' + (tag.alert ? ' alert' : '');
        span.textContent = tag.text;
        meta.appendChild(span);
      });

      [['.f-x', 0], ['.f-y', 1], ['.f-z', 2]].forEach(function (pair) {
        const input = node.querySelector(pair[0]);
        input.value = entry.offset[pair[1]];
        input.addEventListener('input', function () {
          entry.offset[pair[1]] = Number(input.value) || 0;
          recompute();
        });
      });

      const scale = node.querySelector('.f-scale');
      scale.value = entry.scale;
      scale.addEventListener('input', function () {
        const value = Number(scale.value);
        entry.scale = isFinite(value) && value > 0 ? value : 1;
        recompute();
      });

      node.querySelector('.f-up').disabled = index === 0;
      node.querySelector('.f-up').addEventListener('click', function () { move(index, -1); });
      node.querySelector('.f-down').disabled = index === state.entries.length - 1;
      node.querySelector('.f-down').addEventListener('click', function () { move(index, 1); });
      node.querySelector('.f-remove').addEventListener('click', function () {
        state.entries.splice(index, 1);
        renderFiles();
        recompute();
      });

      dom.files.appendChild(node);
    });
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.entries.length) return;
    const moved = state.entries.splice(index, 1)[0];
    state.entries.splice(target, 0, moved);
    renderFiles();
    recompute();
  }

  // ------------------------------------------------------------------
  // arranging
  // ------------------------------------------------------------------

  /* Places each enabled model next to the previous one using its bounding box,
     so nothing overlaps regardless of where the models sit in their own space. */
  function arrange() {
    const entries = activeEntries();
    if (!entries.length) return;
    const mode = dom.arrangeMode.value;
    const gap = Number(dom.arrangeGap.value) || 0;

    if (mode === 'grid') {
      const columns = Math.ceil(Math.sqrt(entries.length));
      let cellX = 0;
      let cellZ = 0;
      entries.forEach(function (entry) {
        const box = scaledBounds(entry);
        cellX = Math.max(cellX, box.size[0]);
        cellZ = Math.max(cellZ, box.size[2]);
      });
      entries.forEach(function (entry, i) {
        const box = scaledBounds(entry);
        const col = i % columns;
        const row = Math.floor(i / columns);
        entry.offset = [
          col * (cellX + gap) - box.min[0],
          -box.min[1],
          row * (cellZ + gap) - box.min[2]
        ];
      });
    } else {
      const axis = mode === 'z' ? 2 : mode === 'stack' ? 1 : 0;
      let cursor = 0;
      entries.forEach(function (entry) {
        const box = scaledBounds(entry);
        const offset = [0, 0, 0];
        offset[axis] = cursor - box.min[axis];
        entry.offset = offset;
        cursor += box.size[axis] + gap;
      });
    }

    /* Centre the whole row on the origin so the preview stays framed. */
    if (mode !== 'grid' && mode !== 'stack') {
      const axis = mode === 'z' ? 2 : 0;
      let span = 0;
      entries.forEach(function (entry) {
        span = Math.max(span, entry.offset[axis] + scaledBounds(entry).max[axis]);
      });
      entries.forEach(function (entry) { entry.offset[axis] -= span / 2; });
    }

    renderFiles();
    recompute();
    setStatus('Arranged ' + plural(entries.length, 'model') + '.');
  }

  // ------------------------------------------------------------------
  // merging and output
  // ------------------------------------------------------------------

  function options() {
    return {
      wrapGroups: dom.optWrap.checked,
      colorBySource: dom.optColor.checked,
      dedupeTextures: dom.optDedupe.checked,
      includeAnimations: dom.optAnimations.checked,
      convertBoxUV: dom.optBoxUV.checked,
      name: dom.outName.value.trim() || 'merged',
      resolution: dom.optCustomRes.checked
        ? { width: Number(dom.resWidth.value) || 16, height: Number(dom.resHeight.value) || 16 }
        : null
    };
  }

  let pending = null;

  function recompute() {
    if (pending) clearTimeout(pending);
    pending = setTimeout(runMerge, 60);
  }

  function runMerge() {
    pending = null;
    if (!state.entries.length) {
      state.result = null;
      dom.downloadBtn.disabled = true;
      renderStats(null);
      renderWarnings([{ level: 'empty', text: 'Load some models to begin.' }]);
      preview.setModel(null);
      return;
    }

    let result;
    try {
      result = BBModel.merge(state.entries, options());
    } catch (err) {
      state.result = null;
      dom.downloadBtn.disabled = true;
      renderWarnings([{ level: 'warn', text: 'Merge failed: ' + err.message }]);
      setStatus('Merge failed.', true);
      return;
    }

    state.result = result;
    dom.downloadBtn.disabled = !result.model;
    renderStats(result.stats);
    renderWarnings(result.warnings.length ? result.warnings : [{ level: 'empty', text: 'Nothing to report.' }]);
    preview.setModel(result.model, result.sourceOf);

    if (!dom.optCustomRes.checked && result.stats) {
      dom.resWidth.value = result.stats.resolution.width;
      dom.resHeight.value = result.stats.resolution.height;
    }
  }

  function renderStats(stats) {
    dom.stats.textContent = '';
    const rows = stats ? [
      ['Files', stats.files],
      ['Elements', stats.elements],
      ['Cubes', stats.cubes],
      ['Meshes', stats.meshes],
      ['Groups', stats.groups],
      ['Textures', stats.textures],
      ['Animations', stats.animations],
      ['Resolution', stats.resolution.width + '×' + stats.resolution.height],
      ['Format', stats.format],
      ['Size', stats.bounds.size.map(function (v) { return Math.round(v * 100) / 100; }).join(' × ')]
    ] : [['Elements', '—']];

    if (stats && stats.convertedCubes) rows.splice(4, 0, ['Box UV converted', stats.convertedCubes]);

    rows.forEach(function (row) {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = row[0];
      dd.textContent = row[1];
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      dom.stats.appendChild(wrap);
    });
  }

  function renderWarnings(items) {
    dom.warnings.textContent = '';
    items.forEach(function (item) {
      const li = document.createElement('li');
      li.className = item.level;
      li.textContent = item.text;
      dom.warnings.appendChild(li);
    });
  }

  function download() {
    if (!state.result || !state.result.model) return;
    const json = dom.optPretty.checked
      ? JSON.stringify(state.result.model, null, 2)
      : JSON.stringify(state.result.model);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (dom.outName.value.trim() || 'merged') + '.bbmodel';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus('Saved ' + link.download + ' (' + Math.round(json.length / 1024) + ' KB).');
  }

  // ------------------------------------------------------------------
  // wiring
  // ------------------------------------------------------------------

  dom.pickBtn.addEventListener('click', function () { dom.fileInput.click(); });
  dom.dropzone.addEventListener('click', function (event) {
    if (event.target === dom.pickBtn) return;
    dom.fileInput.click();
  });
  dom.fileInput.addEventListener('change', function () {
    addFiles(dom.fileInput.files);
    dom.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    dom.dropzone.addEventListener(type, function (event) {
      event.preventDefault();
      dom.dropzone.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    dom.dropzone.addEventListener(type, function (event) {
      event.preventDefault();
      dom.dropzone.classList.remove('over');
    });
  });
  dom.dropzone.addEventListener('drop', function (event) {
    if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
  });
  /* Dropping anywhere else should not navigate away from the page. */
  window.addEventListener('dragover', function (event) { event.preventDefault(); });
  window.addEventListener('drop', function (event) { event.preventDefault(); });

  [dom.optWrap, dom.optColor, dom.optDedupe, dom.optAnimations, dom.optBoxUV].forEach(function (input) {
    input.addEventListener('change', recompute);
  });
  dom.outName.addEventListener('input', function () {
    state.nameTouched = true;
    recompute();
  });
  dom.optCustomRes.addEventListener('change', function () {
    dom.resRow.hidden = !dom.optCustomRes.checked;
    recompute();
  });
  [dom.resWidth, dom.resHeight].forEach(function (input) {
    input.addEventListener('input', recompute);
  });

  dom.arrangeBtn.addEventListener('click', arrange);
  dom.resetOffsets.addEventListener('click', function () {
    state.entries.forEach(function (entry) {
      entry.offset = [0, 0, 0];
      entry.scale = 1;
    });
    renderFiles();
    recompute();
    setStatus('Offsets cleared.');
  });

  dom.downloadBtn.addEventListener('click', download);
  dom.clearBtn.addEventListener('click', function () {
    state.entries = [];
    state.nameTouched = false;
    dom.outName.value = 'merged';
    renderFiles();
    recompute();
    setStatus('');
  });

  runMerge();
})();
