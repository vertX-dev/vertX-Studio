/* Blockbench (.bbmodel) parsing and merging. No dependencies.

   The guiding rule here is "touch as little as possible": every model is deep
   cloned and passed through verbatim except for the things that genuinely
   cannot survive a merge unchanged --

     1. UUIDs           two files may legitimately contain the same UUID, so
                        every element / group / texture / animation / keyframe
                        gets a fresh one and every reference is rewritten.
     2. Texture indices `faces.*.texture` is an index into that file's own
                        textures array; it has to be rebased onto the combined
                        array or the merged model comes out with scrambled skins.
     3. UV space        face UVs live in the assigned texture's uv_width /
                        uv_height, falling back to the project resolution. Every
                        texture is therefore stamped with an explicit UV space
                        taken from its source project, which keeps UVs pixel
                        exact no matter what resolution the merged project ends
                        up with. Box UV is the exception -- see convertBoxUV.
     4. Coordinates     per-file offset and scale.

   Public API: BBModel.parse, BBModel.analyse, BBModel.bounds, BBModel.merge */

const BBModel = (function () {
  'use strict';

  const FACE_KEYS = ['north', 'east', 'south', 'west', 'up', 'down'];

  /* Blockbench marker colours per element. */
  const MARKER_COUNT = 8;

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  function uuid4() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [];
    for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
      hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10).join('');
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function num(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  function vec3(value, fallback) {
    return Array.isArray(value) && value.length >= 3
      ? [num(value[0], 0), num(value[1], 0), num(value[2], 0)]
      : (fallback || [0, 0, 0]);
  }

  /* Returns a name not yet present in `taken`, appending _2, _3 ... if needed.
     `taken` is a plain object used as a set. */
  function uniqueName(taken, name) {
    const base = name || 'unnamed';
    if (!taken[base]) {
      taken[base] = true;
      return base;
    }
    let n = 2;
    while (taken[base + '_' + n]) n++;
    const out = base + '_' + n;
    taken[out] = true;
    return out;
  }

  function resolutionOf(model) {
    const r = model && model.resolution;
    return {
      width: Math.max(1, Math.round(num(r && r.width, 16))),
      height: Math.max(1, Math.round(num(r && r.height, 16)))
    };
  }

  function isCube(el) {
    return el.type === 'cube' || (el.type === undefined && Array.isArray(el.from) && Array.isArray(el.to));
  }

  // ------------------------------------------------------------------
  // parsing
  // ------------------------------------------------------------------

  /* Throws on anything that is not plausibly a .bbmodel. */
  function parse(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('not valid JSON (' + err.message + ')');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('not a JSON object');
    }
    /* Pre-3.0 files called the array "cubes". */
    if (!Array.isArray(data.elements) && Array.isArray(data.cubes)) {
      data.elements = data.cubes;
      delete data.cubes;
    }
    if (!Array.isArray(data.elements) && !Array.isArray(data.outliner) && !data.meta) {
      throw new Error('does not look like a Blockbench model');
    }
    if (!Array.isArray(data.elements)) data.elements = [];
    if (!Array.isArray(data.outliner)) data.outliner = [];
    if (!Array.isArray(data.textures)) data.textures = [];
    if (!Array.isArray(data.animations)) data.animations = [];
    if (!data.meta || typeof data.meta !== 'object') data.meta = {};
    return data;
  }

  /* Counts and metadata for the file list. */
  function analyse(model) {
    const counts = { cubes: 0, meshes: 0, locators: 0, other: 0, groups: 0, boxUV: 0 };
    model.elements.forEach(function (el) {
      if (isCube(el)) {
        counts.cubes++;
        if (el.box_uv) counts.boxUV++;
      } else if (el.type === 'mesh') counts.meshes++;
      else if (el.type === 'locator' || el.type === 'null_object') counts.locators++;
      else counts.other++;
    });
    (function walk(nodes) {
      nodes.forEach(function (n) {
        if (typeof n === 'string') return;
        counts.groups++;
        walk(Array.isArray(n.children) ? n.children : []);
      });
    })(model.outliner);

    return {
      format: model.meta.model_format || 'free',
      formatVersion: model.meta.format_version || '',
      boxUV: !!model.meta.box_uv,
      resolution: resolutionOf(model),
      textures: model.textures.length,
      animations: model.animations.length,
      counts: counts,
      bounds: bounds(model)
    };
  }

  /* Axis-aligned bounds of the raw geometry. Rotations are ignored, which is
     good enough for auto-arranging and for framing the preview. */
  function bounds(model) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let seen = false;

    function acc(p) {
      seen = true;
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }

    model.elements.forEach(function (el) {
      if (Array.isArray(el.from) && Array.isArray(el.to)) {
        acc(vec3(el.from));
        acc(vec3(el.to));
      } else if (el.vertices && typeof el.vertices === 'object') {
        const origin = vec3(el.origin);
        Object.keys(el.vertices).forEach(function (key) {
          const v = vec3(el.vertices[key]);
          acc([v[0] + origin[0], v[1] + origin[1], v[2] + origin[2]]);
        });
      } else if (Array.isArray(el.position)) {
        acc(vec3(el.position));
      } else if (Array.isArray(el.origin)) {
        acc(vec3(el.origin));
      }
    });

    if (!seen) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
    return {
      min: min,
      max: max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    };
  }

  // ------------------------------------------------------------------
  // box UV
  // ------------------------------------------------------------------

  /* Box UV coordinates are derived from uv_offset plus the cube's size and are
     read in *project* resolution space, so a box-UV cube cannot survive either a
     resolution change or a rescale. This writes the equivalent per-face UVs
     using the standard cube net and clears the flag. Sizes are floored the way
     Blockbench floors them. */
  function convertBoxUV(cube) {
    const offset = Array.isArray(cube.uv_offset) ? cube.uv_offset : [0, 0];
    const ox = num(offset[0], 0);
    const oy = num(offset[1], 0);
    const from = vec3(cube.from);
    const to = vec3(cube.to);
    const x = Math.floor(Math.abs(to[0] - from[0]) + 1e-7);
    const y = Math.floor(Math.abs(to[1] - from[1]) + 1e-7);
    const z = Math.floor(Math.abs(to[2] - from[2]) + 1e-7);

    /* up and down are stored with their V axis reversed, as Blockbench does. */
    const uvs = {
      up: [ox + z + x, oy + z, ox + z, oy],
      down: [ox + z + x + x, oy, ox + z + x, oy + z],
      east: [ox, oy + z, ox + z, oy + z + y],
      north: [ox + z, oy + z, ox + z + x, oy + z + y],
      west: [ox + z + x, oy + z, ox + z + x + z, oy + z + y],
      south: [ox + z + x + z, oy + z, ox + z + x + z + x, oy + z + y]
    };

    if (!cube.faces || typeof cube.faces !== 'object') cube.faces = {};
    /* Box UV cubes normally share one texture across every face; if some faces
       are missing entirely, reuse whichever texture the cube already names,
       preferring one that actually points somewhere. */
    let sharedTexture = null;
    FACE_KEYS.forEach(function (key) {
      const face = cube.faces[key];
      if (!face || face.texture === undefined || face.texture === null || face.texture === false) return;
      if (sharedTexture === null) sharedTexture = face.texture;
    });
    FACE_KEYS.forEach(function (key) {
      if (!cube.faces[key] || typeof cube.faces[key] !== 'object') {
        cube.faces[key] = { texture: sharedTexture };
      }
      cube.faces[key].uv = uvs[key];
    });
    cube.box_uv = false;
  }

  // ------------------------------------------------------------------
  // transforms
  // ------------------------------------------------------------------

  /* Scale is applied about the model origin, then the offset is added, so a
     point ends up at p * scale + offset. Vectors stored relative to an element's
     own origin (mesh vertices, local pivots) are scaled only. */
  function transformElement(el, offset, scale) {
    if (scale !== 1) {
      ['from', 'to', 'origin', 'position'].forEach(function (key) {
        if (Array.isArray(el[key])) el[key] = vec3(el[key]).map(function (v) { return v * scale; });
      });
      if (Array.isArray(el.local_pivot)) {
        el.local_pivot = vec3(el.local_pivot).map(function (v) { return v * scale; });
      }
      if (typeof el.inflate === 'number') el.inflate *= scale;
      if (el.vertices && typeof el.vertices === 'object') {
        Object.keys(el.vertices).forEach(function (key) {
          el.vertices[key] = vec3(el.vertices[key]).map(function (v) { return v * scale; });
        });
      }
    }
    if (offset[0] || offset[1] || offset[2]) {
      ['from', 'to', 'origin', 'position'].forEach(function (key) {
        if (Array.isArray(el[key])) {
          const p = vec3(el[key]);
          el[key] = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
        }
      });
    }
  }

  function transformPoint(point, offset, scale) {
    const p = vec3(point);
    return [p[0] * scale + offset[0], p[1] * scale + offset[1], p[2] * scale + offset[2]];
  }

  // ------------------------------------------------------------------
  // textures
  // ------------------------------------------------------------------

  /* Adds one file's textures to the combined array and returns the lookup used
     to rewrite face references. */
  function addTextures(model, srcRes, ctx, warn, fileName) {
    const map = { byIndex: {}, byUuid: {}, byId: {} };

    model.textures.forEach(function (source, index) {
      const tex = clone(source);
      const uvWidth = Math.max(1, num(tex.uv_width, srcRes.width));
      const uvHeight = Math.max(1, num(tex.uv_height, srcRes.height));
      tex.uv_width = uvWidth;
      tex.uv_height = uvHeight;

      const key = tex.source
        ? 'src:' + tex.source
        : 'ref:' + (tex.path || '') + '|' + (tex.relative_path || '') + '|' + (tex.name || '');

      let target = -1;
      if (ctx.dedupeTextures && ctx.textureKeys[key] !== undefined) {
        const existing = ctx.textures[ctx.textureKeys[key]];
        /* The same image in a different UV space is not the same texture. */
        if (existing.uv_width === uvWidth && existing.uv_height === uvHeight) {
          target = ctx.textureKeys[key];
        }
      }

      if (target < 0) {
        tex.uuid = uuid4();
        tex.name = uniqueName(ctx.textureNames, tex.name || 'texture');
        target = ctx.textures.length;
        tex.id = String(target);
        ctx.textures.push(tex);
        ctx.textureKeys[key] = target;
        if (!tex.source && !tex.path) {
          warn('warn', fileName + ': texture "' + tex.name + '" has no embedded image, so it will be missing after the merge.');
        }
      }

      map.byIndex[index] = target;
      if (source.uuid) map.byUuid[source.uuid] = target;
      if (source.id !== undefined) map.byId[String(source.id)] = target;
    });

    return map;
  }

  /* Face texture references are normally an index, but Blockbench also accepts a
     UUID string, null (blank face) and false (hidden face). Everything
     resolvable is normalised to an index into the merged array. */
  function remapTexture(value, map) {
    if (value === null || value === false || value === undefined) return value;
    if (typeof value === 'number') {
      return map.byIndex[value] !== undefined ? map.byIndex[value] : null;
    }
    if (typeof value === 'string') {
      if (map.byUuid[value] !== undefined) return map.byUuid[value];
      if (map.byId[value] !== undefined) return map.byId[value];
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed) && map.byIndex[parsed] !== undefined) return map.byIndex[parsed];
      return null;
    }
    return null;
  }

  /* `report.lost` counts references that pointed at a texture the source file
     does not contain -- a pre-existing fault in that file, worth reporting
     rather than blaming on the merge. */
  function remapElementTextures(el, map, report) {
    function rewrite(value) {
      const mapped = remapTexture(value, map);
      if (mapped === null && value !== null && value !== false && value !== undefined) report.lost++;
      return mapped;
    }
    if (el.faces && typeof el.faces === 'object') {
      Object.keys(el.faces).forEach(function (key) {
        const face = el.faces[key];
        if (face && typeof face === 'object' && 'texture' in face) {
          face.texture = rewrite(face.texture);
        }
      });
    }
    /* texture_mesh names its texture directly. */
    if (el.type === 'texture_mesh' && 'texture' in el) {
      el.texture = rewrite(el.texture);
    }
  }

  // ------------------------------------------------------------------
  // animations
  // ------------------------------------------------------------------

  /* Position keyframes are in blocks, so a rescaled model needs them rescaled
     too. Molang expressions are left alone and reported rather than mangled. */
  function scaleKeyframes(animator, scale, flags) {
    (animator.keyframes || []).forEach(function (kf) {
      if (kf.channel !== 'position') return;
      (kf.data_points || []).forEach(function (point) {
        ['x', 'y', 'z'].forEach(function (axis) {
          const value = point[axis];
          if (typeof value === 'number') {
            point[axis] = value * scale;
          } else if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            if (isFinite(parsed)) point[axis] = String(parsed * scale);
            else flags.molang = true;
          }
        });
      });
    });
  }

  function addAnimations(model, ctx, entry, uuidMap, warn) {
    const flags = { molang: false, orphan: false };

    model.animations.forEach(function (source) {
      const anim = clone(source);
      anim.uuid = uuid4();
      const wanted = anim.name || 'animation';
      anim.name = uniqueName(ctx.animationNames, wanted);
      if (anim.name !== wanted) ctx.renamedAnimations.push(wanted + ' -> ' + anim.name);

      const animators = {};
      Object.keys(anim.animators || {}).forEach(function (key) {
        const animator = anim.animators[key];
        if (!animator || typeof animator !== 'object') return;
        (animator.keyframes || []).forEach(function (kf) { kf.uuid = uuid4(); });
        if (entry.scale !== 1) scaleKeyframes(animator, entry.scale, flags);

        let target;
        if (key === 'effects' || animator.type === 'effect') {
          target = 'effects';
        } else if (uuidMap[key]) {
          target = uuidMap[key];
        } else {
          target = key;
          flags.orphan = true;
        }

        if (animators[target] && Array.isArray(animators[target].keyframes)) {
          animators[target].keyframes = animators[target].keyframes.concat(animator.keyframes || []);
        } else {
          animators[target] = animator;
        }
      });
      anim.animators = animators;
      ctx.animations.push(anim);
    });

    (model.animation_controllers || []).forEach(function (source) {
      const controller = clone(source);
      controller.uuid = uuid4();
      controller.name = uniqueName(ctx.controllerNames, controller.name || 'controller');
      ctx.animationControllers.push(controller);
    });

    if (flags.molang) {
      warn('warn', entry.name + ': position keyframes containing Molang expressions were left unscaled.');
    }
    if (flags.orphan) {
      warn('warn', entry.name + ': an animation targets a bone that is not in the file; its animator was kept as-is.');
    }
  }

  // ------------------------------------------------------------------
  // merge
  // ------------------------------------------------------------------

  /* entries: [{ name, model, enabled, offset:[x,y,z], scale, groupName }]
     Returns { model, warnings, stats, sourceOf } -- sourceOf maps a merged
     element UUID to the index of the entry it came from, for the preview. */
  function merge(entries, options) {
    const opt = Object.assign({
      wrapGroups: true,
      dedupeTextures: true,
      includeAnimations: true,
      colorBySource: true,
      convertBoxUV: false,
      name: 'merged',
      resolution: null
    }, options || {});

    const warnings = [];
    function warn(level, text) { warnings.push({ level: level, text: text }); }

    const active = entries.filter(function (e) { return e.enabled !== false; });
    if (!active.length) {
      return { model: null, warnings: [{ level: 'info', text: 'Select at least one model.' }], stats: null, sourceOf: {} };
    }

    const base = active[0].model;

    // format ------------------------------------------------------------
    const baseFormat = base.meta.model_format || 'free';
    active.forEach(function (entry, i) {
      if (!i) return;
      const format = entry.model.meta.model_format || 'free';
      if (format !== baseFormat) {
        warn('warn', entry.name + ': format is "' + format + '" but the output is "' + baseFormat +
          '" (from ' + active[0].name + '). Blockbench may reject or reinterpret some elements.');
      }
    });

    // resolution --------------------------------------------------------
    let width = 0;
    let height = 0;
    active.forEach(function (entry) {
      const res = resolutionOf(entry.model);
      width = Math.max(width, res.width);
      height = Math.max(height, res.height);
    });
    if (opt.resolution) {
      width = Math.max(1, Math.round(opt.resolution.width));
      height = Math.max(1, Math.round(opt.resolution.height));
    }

    // box UV ------------------------------------------------------------
    const sameResolution = active.every(function (entry) {
      const res = resolutionOf(entry.model);
      return res.width === width && res.height === height;
    });
    const allBoxUV = active.every(function (entry) { return !!entry.model.meta.box_uv; });
    const anyScaled = active.some(function (entry) { return num(entry.scale, 1) !== 1; });
    const usesBoxUV = active.some(function (entry) {
      return entry.model.meta.box_uv || entry.model.elements.some(function (el) { return el.box_uv; });
    });
    const keepBoxUV = allBoxUV && sameResolution && !anyScaled && !opt.convertBoxUV;

    if (usesBoxUV && !keepBoxUV) {
      const reason = opt.convertBoxUV ? 'you asked for it'
        : !sameResolution ? 'the files use different resolutions'
          : anyScaled ? 'a model is rescaled'
            : 'the files disagree about box UV';
      warn('info', 'Box UV cubes were converted to per-face UV because ' + reason +
        '. The layout is computed from the standard cube net; check mirrored parts.');
    }

    // per-file pass -----------------------------------------------------
    const ctx = {
      dedupeTextures: opt.dedupeTextures,
      textures: [],
      textureKeys: {},
      textureNames: {},
      elements: [],
      outliner: [],
      animations: [],
      animationControllers: [],
      animationNames: {},
      controllerNames: {},
      renamedAnimations: []
    };
    const sourceOf = {};
    let convertedCubes = 0;

    active.forEach(function (entry, entryIndex) {
      const model = entry.model;
      const srcRes = resolutionOf(model);
      const offset = vec3(entry.offset);
      const scale = num(entry.scale, 1) || 1;
      const uuidMap = {};                     // per file: two files may share UUIDs
      const textureMap = addTextures(model, srcRes, ctx, warn, entry.name);
      const textureReport = { lost: 0 };
      const ownElements = [];

      model.elements.forEach(function (source) {
        const el = clone(source);
        const oldUuid = el.uuid;
        el.uuid = uuid4();
        if (oldUuid) uuidMap[oldUuid] = el.uuid;

        /* UV work first: the box net depends on the unscaled cube size. */
        if (isCube(el) && el.box_uv && !keepBoxUV) {
          convertBoxUV(el);
          convertedCubes++;
        }
        remapElementTextures(el, textureMap, textureReport);
        transformElement(el, offset, scale);
        if (opt.colorBySource) el.color = entryIndex % MARKER_COUNT;

        ctx.elements.push(el);
        ownElements.push(el.uuid);
        sourceOf[el.uuid] = entryIndex;
      });

      if (textureReport.lost) {
        warn('warn', entry.name + ': ' + textureReport.lost + ' face(s) referenced a texture the file does not contain and were left blank.');
      }

      /* Outliner: rewrite group UUIDs and element references. Elements are
         processed first, so uuidMap is already complete. */
      const referenced = {};
      function rebuild(nodes) {
        const out = [];
        nodes.forEach(function (node) {
          if (typeof node === 'string') {
            const mapped = uuidMap[node];
            if (mapped) {
              referenced[mapped] = true;
              out.push(mapped);
            }
            return;
          }
          if (!node || typeof node !== 'object') return;
          const group = clone(node);
          const oldUuid = group.uuid;
          group.uuid = uuid4();
          if (oldUuid) uuidMap[oldUuid] = group.uuid;
          group.origin = transformPoint(group.origin, offset, scale);
          group.children = rebuild(Array.isArray(node.children) ? node.children : []);
          out.push(group);
        });
        return out;
      }

      let roots = rebuild(model.outliner);
      /* Anything the outliner never mentions would silently disappear. */
      const orphans = ownElements.filter(function (uuid) { return !referenced[uuid]; });
      if (orphans.length) {
        if (model.outliner.length) {
          warn('info', entry.name + ': ' + orphans.length + ' element(s) were missing from the outliner and were added at the root.');
        }
        roots = roots.concat(orphans);
      }

      if (opt.wrapGroups) {
        ctx.outliner.push({
          name: entry.groupName || entry.name,
          origin: [0, 0, 0],
          color: entryIndex % MARKER_COUNT,
          uuid: uuid4(),
          export: true,
          mirror_uv: false,
          isOpen: true,
          locked: false,
          visibility: true,
          autouv: 0,
          children: roots
        });
      } else {
        ctx.outliner = ctx.outliner.concat(roots);
      }

      if (opt.includeAnimations) addAnimations(model, ctx, entry, uuidMap, warn);
    });

    if (ctx.renamedAnimations.length) {
      warn('warn', 'Duplicate animation names were renamed: ' + ctx.renamedAnimations.join(', ') +
        (ctx.animationControllers.length ? '. Animation controllers referencing the old names need updating.' : '.'));
    }

    // assemble ----------------------------------------------------------
    const out = clone(base);                   // keeps unknown root fields
    out.meta = clone(base.meta) || {};
    out.meta.model_format = baseFormat;
    out.meta.box_uv = keepBoxUV;
    out.meta.creation_time = Math.round(Date.now() / 1000);
    out.name = opt.name || 'merged';
    out.resolution = { width: width, height: height };
    out.elements = ctx.elements;
    out.outliner = ctx.outliner;
    out.textures = ctx.textures;
    out.animations = opt.includeAnimations ? ctx.animations : [];
    if (opt.includeAnimations && ctx.animationControllers.length) {
      out.animation_controllers = ctx.animationControllers;
    } else {
      delete out.animation_controllers;
    }

    const visible = [0, 0, 0];
    active.forEach(function (entry) {
      const box = entry.model.visible_box;
      if (Array.isArray(box)) {
        for (let i = 0; i < 3; i++) visible[i] = Math.max(visible[i], num(box[i], 0));
      }
    });
    out.visible_box = visible[0] || visible[1] || visible[2] ? visible : [1, 1, 0];

    const placeholders = [];
    active.forEach(function (entry) {
      const value = entry.model.variable_placeholders;
      if (typeof value === 'string' && value.trim() && placeholders.indexOf(value) < 0) placeholders.push(value);
    });
    out.variable_placeholders = placeholders.join('\n');

    // format sanity checks ----------------------------------------------
    if (baseFormat === 'java_block') {
      let outOfBounds = 0;
      ctx.elements.forEach(function (el) {
        if (!Array.isArray(el.from) || !Array.isArray(el.to)) return;
        const points = vec3(el.from).concat(vec3(el.to));
        if (points.some(function (v) { return v < -16 || v > 32; })) outOfBounds++;
      });
      if (outOfBounds) {
        warn('warn', outOfBounds + ' cube(s) fall outside the -16..32 range the Java Block/Item format allows. Reduce the offsets or change the format in Blockbench.');
      }
      if (ctx.elements.some(function (el) { return el.type === 'mesh'; })) {
        warn('warn', 'Meshes are not supported by the Java Block/Item format.');
      }
    }
    if (ctx.textures.length > 1 && baseFormat === 'bedrock') {
      warn('info', ctx.textures.length + ' textures ended up in the model. A Bedrock entity renders one texture at a time, so these need combining into an atlas.');
    }

    const stats = {
      files: active.length,
      elements: ctx.elements.length,
      cubes: ctx.elements.filter(isCube).length,
      meshes: ctx.elements.filter(function (el) { return el.type === 'mesh'; }).length,
      groups: (function count(nodes) {
        let total = 0;
        nodes.forEach(function (n) {
          if (typeof n === 'string') return;
          total += 1 + count(Array.isArray(n.children) ? n.children : []);
        });
        return total;
      })(ctx.outliner),
      textures: ctx.textures.length,
      animations: out.animations.length,
      convertedCubes: convertedCubes,
      resolution: { width: width, height: height },
      format: baseFormat,
      bounds: bounds(out)
    };

    return { model: out, warnings: warnings, stats: stats, sourceOf: sourceOf };
  }

  return {
    parse: parse,
    analyse: analyse,
    bounds: bounds,
    merge: merge,
    uuid4: uuid4,
    isCube: isCube,
    MARKER_COUNT: MARKER_COUNT
  };
})();
