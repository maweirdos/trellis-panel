/* Standalone pixel motion engine. Coordinates are viewBox centers; frame rotation is
 * in degrees, and sx/sy are projection multipliers, never pixel dimensions.
 * The host owns rendering, requestAnimationFrame, pointer events and visibility. */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const MODES = new Set(['observe', 'c', 'loading', 'waiting', 'loadingAlt', 'waitingAlt', 'magnet']);
  const SAFE_MIN = 8;
  const SAFE_MAX = 104;
  const SUBSTEP = 1 / 120;
  const MAX_DT = 0.1;
  const C_ENTRY_END = 0.905;
  const MAGNET_ENTRY_END = 2;
  const POSITION_EPSILON = 0.008;
  const VELOCITY_EPSILON = 0.035;

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const mix = (a, b, amount) => a + (b - a) * amount;
  const smooth = (amount) => {
    const t = clamp(amount, 0, 1);
    return t * t * (3 - 2 * t);
  };
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function copyPoint(value, label) {
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
      throw new TypeError('Invalid pixel point: ' + label);
    }
    return Object.freeze({ x: clamp(value.x, SAFE_MIN, SAFE_MAX), y: clamp(value.y, SAFE_MIN, SAFE_MAX) });
  }

  class CruxPixelRig {
    constructor(geometry) {
      if (!geometry || !Array.isArray(geometry.pixels) || geometry.pixels.length === 0) {
        throw new TypeError('CruxPixelRig requires a nonempty pixel geometry.');
      }
      this._pixels = [];
      this._byId = new Map();
      for (const item of geometry.pixels) {
        if (!item || typeof item.id !== 'string' || this._byId.has(item.id) ||
            (item.role !== 'field' && item.role !== 'core')) {
          throw new TypeError('Pixel IDs must be unique strings with a field/core role.');
        }
        const origin = copyPoint(item, item.id);
        const pixel = {
          id: item.id, role: item.role, zone: item.zone || '',
          x: origin.x, y: origin.y, vx: 0, vy: 0,
          opacity: 1, localScale: 1, localRadius: Number.isFinite(geometry.rx) ? geometry.rx : 1.5
        };
        this._pixels.push(pixel);
        this._byId.set(pixel.id, pixel);
      }
      const suppliedCore = Array.isArray(geometry.coreIds)
        ? geometry.coreIds.slice()
        : this._pixels.filter((p) => p.role === 'core').map((p) => p.id);
      if (this._pixels.filter((p) => p.role === 'core').length !== 4 ||
          suppliedCore.length !== 4 || new Set(suppliedCore).size !== 4 ||
          suppliedCore.some((id) => !this._byId.has(id) || this._byId.get(id).role !== 'core')) {
        throw new TypeError('CruxPixelRig requires four persistent core IDs.');
      }
      this._coreIds = suppliedCore;
      this._shapes = {};
      for (const shape of ['observer', 'c', 'loading', 'waiting']) {
        const map = geometry.shapes && geometry.shapes[shape];
        if (!map) throw new TypeError('Missing shape map: ' + shape);
        const clone = {};
        for (const pixel of this._pixels) clone[pixel.id] = copyPoint(map[pixel.id], shape + '/' + pixel.id);
        this._shapes[shape] = Object.freeze(clone);
      }
      if (!geometry.dock || !geometry.dock.targets) throw new TypeError('Missing core dock.');
      this._dockCenter = copyPoint(geometry.dock.center, 'dock center');
      this._dockTargets = {};
      for (const id of this._coreIds) {
        this._dockTargets[id] = copyPoint(geometry.dock.targets[id], 'dock/' + id);
      }
      this._pixelSize = Number.isFinite(geometry.size) && geometry.size > 0 ? geometry.size : 7.8;
      this._pixelRadius = Number.isFinite(geometry.rx) && geometry.rx >= 0 ? geometry.rx : 1.5;
      const display = geometry.displayGrid;
      if (!display || display.rows !== 2 || display.columns !== 2 ||
          !Number.isFinite(display.loadingGap) || !Number.isFinite(display.waitingGap) ||
          display.loadingGap < 0 || display.waitingGap < 0) {
        throw new TypeError('A two-by-two component display grid is required.');
      }
      this._displayGrid = Object.freeze({ ...display });
      if (!Array.isArray(geometry.components) || geometry.components.length !== 4) {
        throw new TypeError('Four nine-pixel component definitions are required.');
      }
      this._componentByPixel = new Map();
      this._componentDefs = geometry.components.map((item, index) => {
        if (!item || typeof item.id !== 'string' || !Array.isArray(item.members) || item.members.length !== 9 ||
            !item.members.includes(item.coreId) || !this._coreIds.includes(item.coreId)) {
          throw new TypeError('Invalid component membership.');
        }
        for (const id of item.members) {
          if (!this._byId.has(id) || this._componentByPixel.has(id)) {
            throw new TypeError('Component members must partition the persistent pixels.');
          }
          this._componentByPixel.set(id, index);
        }
        for (const key of ['loadingSize', 'waitingSize', 'loadingRadius', 'waitingRadius']) {
          if (!Number.isFinite(item[key]) || item[key] <= 0) throw new TypeError('Invalid component dimension: ' + key);
        }
        if (!Number.isInteger(item.clockwiseIndex) || item.clockwiseIndex < 0 || item.clockwiseIndex > 3) {
          throw new TypeError('Invalid clockwise component order.');
        }
        if (!Array.isArray(item.children) || item.children.length !== 4) {
          throw new TypeError('Each component requires four child groups.');
        }
        const childMembers = new Set();
        const childSlots = new Set();
        const children = item.children.map((child) => {
          if (!child || typeof child.id !== 'string' || ![0, 1].includes(child.row) ||
              ![0, 1].includes(child.col) || !Array.isArray(child.members) || child.members.length === 0 ||
              childSlots.has(child.row + '/' + child.col)) {
            throw new TypeError('Invalid two-by-two child group.');
          }
          childSlots.add(child.row + '/' + child.col);
          for (const id of child.members) {
            if (!item.members.includes(id) || childMembers.has(id)) {
              throw new TypeError('Child groups must partition their source members.');
            }
            childMembers.add(id);
          }
          return Object.freeze({
            id: child.id, row: child.row, col: child.col,
            members: Object.freeze(child.members.slice())
          });
        });
        if (childMembers.size !== item.members.length || new Set(children.map((c) => c.id)).size !== 4) {
          throw new TypeError('Four children must cover each component exactly once.');
        }
        return Object.freeze({
          id: item.id, coreId: item.coreId, members: Object.freeze(item.members.slice()),
          children: Object.freeze(children),
          loadingCenter: copyPoint(item.loadingCenter, item.id + '/loading'),
          waitingCenter: copyPoint(item.waitingCenter, item.id + '/waiting'),
          loadingSize: item.loadingSize, waitingSize: item.waitingSize,
          loadingRadius: item.loadingRadius, waitingRadius: item.waitingRadius,
          clockwiseIndex: item.clockwiseIndex
        });
      });
      if (this._componentByPixel.size !== this._pixels.length ||
          new Set(this._componentDefs.map((c) => c.id)).size !== 4 ||
          new Set(this._componentDefs.map((c) => c.clockwiseIndex)).size !== 4) {
        throw new TypeError('Four components must cover every persistent pixel exactly once.');
      }
      this._coreOffsets = new Map();
      this._orbitAngles = new Map();
      // The observer has two vertical eyes. Free/magnetic clusters and the
      // backup orbit retain the original even-quadrant arrangement.
      const quadrantOffsets = [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: -5, y: 5 }, { x: 5, y: 5 }];
      this._coreIds.forEach((id, index) => {
        const offset = quadrantOffsets[index];
        this._coreOffsets.set(id, offset);
        this._orbitAngles.set(id, Math.atan2(offset.y, offset.x));
      });
      this._clusterExtent = {
        x: Math.max(...Array.from(this._coreOffsets.values(), (p) => Math.abs(p.x))),
        y: Math.max(...Array.from(this._coreOffsets.values(), (p) => Math.abs(p.y)))
      };
      this._mode = 'observe';
      this._elapsed = 0;
      this._time = 0;
      this._entryPositions = new Map();
      this._entryCenter = { x: 56, y: 56 };
      this._skipEntry = false;
      this._isReduced = false;
      this._mirrored = false;
      this._angle = 0;
      this._angleVelocity = 0;
      this._breathing = false;
      this._breathAmount = 0;
      this._breathVelocity = 0;
      this._look = null;
      this._drag = null;
      this._magnetManual = false;
      this._dockIntent = false;
      this._fusionProfile = null;
      this._fusionBlend = 0;
      this._fusionRetiring = false;
      this._componentMorph = false;
      this._morphOpacities = [1, 1, 1, 1];
      this._retireSizes = this._componentDefs.map((c) => ({ width: c.loadingSize, rx: c.loadingRadius }));
      this._retireOpacities = [1, 1, 1, 1];
      this._retireStartBlend = 1;
      this._retireMicroStart = 1;
      this._assemblyReady = false;
      this._componentClock = 0;
      this._captureEntry();
    }

    _centroid(points) {
      return {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y: points.reduce((sum, p) => sum + p.y, 0) / points.length
      };
    }

    _captureEntry() {
      this._entryPositions = new Map(this._pixels.map((p) => [p.id, { x: p.x, y: p.y }]));
      this._entryCenter = this._centroid(this._coreIds.map((id) => this._entryPositions.get(id)));
    }


    setMode(mode, { instant = false } = {}) {
      if (!MODES.has(mode)) throw new RangeError('Unknown Crux pixel mode: ' + mode);
      this._prepareFusionExit(mode);
      this._captureEntry();
      this._mode = mode;
      this._elapsed = 0;
      this._drag = null;
      this._magnetManual = false;
      this._dockIntent = mode === 'c';
      this._skipEntry = Boolean(instant || this._isReduced);
      this._assemblyReady = false;
      this._componentClock = 0;
      if (this._isPrimary()) {
        this._mirrored = false;
        this._breathing = false;
      }
      if (instant || this._isReduced) this._snapToTargets();
      return this;
    }

    setReduced(value) {
      const next = Boolean(value);
      if (next === this._isReduced) return this;
      this._isReduced = next;
      if (next) {
        this._skipEntry = true;
        this._angle = this._mirrored ? Math.PI : 0;
        this._angleVelocity = 0;
        this._breathAmount = 0;
        this._breathVelocity = 0;
        this._snapToTargets();
      }
      return this;
    }

    setMirrored(value) {
      if (this._isPrimary()) return this;
      this._mirrored = Boolean(value);
      if (this._isReduced) {
        this._angle = this._mirrored ? Math.PI : 0;
        this._angleVelocity = 0;
        this._snapToTargets();
      }
      return this;
    }

    setBreathing(value) {
      if (this._isPrimary()) return this;
      this._breathing = Boolean(value);
      if (this._isReduced) {
        this._breathAmount = 0;
        this._breathVelocity = 0;
      }
      return this;
    }

    // Visual gaze offsets, not absolute pointer coordinates; mirror reverses the
    // world-side offset so attention still looks toward the visual pointer.
    setLook(x, y) {
      this._look = { x: clamp(finite(x), -4, 4), y: clamp(finite(y), -3, 3) };
      if (this._isReduced) this._snapToTargets();
      return this;
    }

    clearLook() {
      this._look = null;
      if (this._isReduced) this._snapToTargets();
      return this;
    }

    kick() {
      if (this._isReduced || this._isPrimary()) return this;
      const eyeVelocity = {
        x: this._coreIds.reduce((sum, id) => sum + this._byId.get(id).vx, 0) / 4 + 30,
        y: this._coreIds.reduce((sum, id) => sum + this._byId.get(id).vy, 0) / 4 - 7
      };
      const coreCenter = this._centroid(this._coreIds.map((id) => this._byId.get(id)));
      for (let i = 0; i < this._pixels.length; i += 1) {
        const p = this._pixels[i];
        if (this._mode === 'observe' && p.role === 'core') {
          p.vx = clamp(eyeVelocity.x, -240, 240);
          p.vy = clamp(eyeVelocity.y, -240, 240);
          continue;
        }
        const origin = p.role === 'core' ? coreCenter : { x: 56, y: 56 };
        let dx = p.x - origin.x;
        let dy = p.y - origin.y;
        const length = Math.hypot(dx, dy);
        if (length < 0.01) {
          const a = this._orbitAngles.get(p.id) || i * 0.7;
          dx = Math.cos(a); dy = Math.sin(a);
        } else {
          dx /= length; dy /= length;
        }
        const amount = p.role === 'core' ? 38 : 13;
        const tangent = p.role === 'core' ? 6 : 2;
        p.vx = clamp(p.vx + dx * amount - dy * tangent, -240, 240);
        p.vy = clamp(p.vy + dy * amount + dx * tangent, -240, 240);
      }
      return this;
    }

    _breathProjection() {
      if (this._isReduced || this._breathAmount === 0) return { scale: 1, opacity: 1 };
      const wave = Math.sin(this._time * TAU / 4.2);
      return {
        scale: 1 + 0.025 * wave * this._breathAmount,
        opacity: 1 - (0.06 - 0.06 * wave) * this._breathAmount
      };
    }

    _pointerToWorld(x, y) {
      const screenX = clamp(finite(x, 56), SAFE_MIN, SAFE_MAX) - 56;
      const screenY = clamp(finite(y, 56), SAFE_MIN, SAFE_MAX) - 56;
      const cos = Math.cos(this._angle);
      const sin = Math.sin(this._angle);
      const k = sin * 0.12 / 56;
      let denominator = cos - screenX * k;
      if (Math.abs(denominator) < 0.18) {
        denominator = (denominator < 0 || (denominator === 0 && this._mirrored) ? -1 : 1) * 0.18;
      }
      const breath = this._breathProjection().scale;
      const rawX = screenX / denominator;
      const rawY = screenY * (1 + rawX * k);
      return {
        x: clamp(56 + rawX / breath, SAFE_MIN, SAFE_MAX),
        y: clamp(56 + rawY / breath, SAFE_MIN, SAFE_MAX)
      };
    }

    _safeClusterCenter(point) {
      return {
        x: clamp(point.x, SAFE_MIN + this._clusterExtent.x, SAFE_MAX - this._clusterExtent.x),
        y: clamp(point.y, SAFE_MIN + this._clusterExtent.y, SAFE_MAX - this._clusterExtent.y)
      };
    }

    beginDrag(x, y) {
      if (this._mode !== 'magnet') this.setMode('magnet');
      const center = this._centroid(this._coreIds.map((id) => this._byId.get(id)));
      const pointer = this._pointerToWorld(x, y);
      const wasDocked = this._dockIntent || this._physicalDocked();
      this._magnetManual = true;
      this._dockIntent = false;
      this._drag = {
        center: this._safeClusterCenter(center),
        offset: { x: center.x - pointer.x, y: center.y - pointer.y },
        wasDocked
      };
      if (this._isReduced) this._snapToTargets();
      return this;
    }

    dragTo(x, y) {
      if (!this._drag) return this;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return this;
      const pointer = this._pointerToWorld(x, y);
      this._drag.center = this._safeClusterCenter({
        x: pointer.x + this._drag.offset.x,
        y: pointer.y + this._drag.offset.y
      });
      if (this._isReduced) this._snapToTargets();
      return this;
    }

    endDrag({ cancel = false } = {}) {
      if (!this._drag) return this;
      const current = this._drag;
      this._dockIntent = cancel
        ? current.wasDocked
        : distance(current.center, this._dockCenter) <= 18;
      this._drag = null;
      this._magnetManual = true;
      if (this._isReduced) this._snapToTargets();
      return this;
    }

    dock() {
      if (this._mode !== 'magnet') this.setMode('magnet');
      this._drag = null;
      this._magnetManual = true;
      this._dockIntent = true;
      if (this._isReduced) this._snapToTargets();
      return this;
    }


    _scan() {
      if (this._look) return this._look;
      if (this._isReduced) return { x: 0, y: 0 };
      const keys = [
        [0, 0], [0.3, 0], [0.8, -3.5], [1.2, -3.5],
        [2, 3.5], [2.45, 3.5], [3.3, 0], [4.2, 0]
      ];
      const t = this._elapsed % 4.2;
      for (let i = 1; i < keys.length; i += 1) {
        if (t <= keys[i][0]) {
          const a = keys[i - 1]; const b = keys[i];
          return { x: mix(a[1], b[1], smooth((t - a[0]) / (b[0] - a[0]))), y: 0 };
        }
      }
      return { x: 0, y: 0 };
    }

    _coreMagnetTarget(id, index, finalPose) {
      const slot = this._dockTargets[id];
      const offset = this._coreOffsets.get(id);
      if (this._drag) {
        const center = this._drag.center;
        const strength = smooth(1 - distance(center, this._dockCenter) / 18);
        return {
          x: mix(center.x + offset.x, slot.x, strength),
          y: mix(center.y + offset.y, slot.y, strength)
        };
      }
      if (this._magnetManual) {
        return this._dockIntent ? slot : { x: 56 + offset.x, y: 56 + offset.y };
      }
      if (finalPose || this._skipEntry) return slot;
      const entry = this._entryPositions.get(id);
      const approach = smooth(this._elapsed / 1.1);
      const restore = smooth(this._elapsed / 0.5);
      const center = {
        x: mix(this._entryCenter.x, this._dockCenter.x, approach),
        y: mix(this._entryCenter.y, this._dockCenter.y, approach)
      };
      const free = {
        x: center.x + mix(entry.x - this._entryCenter.x, offset.x, restore),
        y: center.y + mix(entry.y - this._entryCenter.y, offset.y, restore)
      };
      const unfurl = smooth((this._elapsed - 1 - index * 0.075) / 0.75);
      return { x: mix(free.x, slot.x, unfurl), y: mix(free.y, slot.y, unfurl) };
    }



    _isPrimary() {
      return this._mode === 'loading' || this._mode === 'waiting';
    }

    _waitingHop(index) {
      if (this._isReduced || !this._assemblyReady || this._mode !== 'waiting') {
        return { offset: 0, velocity: 0 };
      }
      const t = this._componentClock % 1.8;
      const slot = Math.floor(t / 0.4);
      const local = t - slot * 0.4;
      if (slot !== index || slot > 3 || local >= 0.34) return { offset: 0, velocity: 0 };
      const phase = Math.PI * local / 0.34;
      return {
        offset: -8 * Math.sin(phase) ** 2,
        velocity: -8 * Math.PI / 0.34 * Math.sin(2 * phase)
      };
    }

    _loadingLuminance(component) {
      const phase = this._componentClock / 0.45;
      const age = ((phase - component.clockwiseIndex) % 4 + 4) % 4;
      let intensity = 0;
      if (age < 2.4) intensity = Math.cos(age / 2.4 * Math.PI / 2) ** 2;
      else if (age > 3.65) intensity = smooth((age - 3.65) / 0.35);
      return 0.24 + 0.76 * intensity;
    }

    _prepareFusionExit(nextMode) {
      if (this._fusionBlend <= 0 || !this._fusionProfile) {
        this._componentMorph = false;
        return;
      }
      const microVisibility = this._microVisibility();
      const snapshots = this.components();
      const alpha = Math.max(0.00001, this._fusionBlend * this._breathProjection().opacity);
      const opacities = snapshots.map((c) => clamp(c.opacity / alpha, 0, 1));
      const nextPrimary = nextMode === 'loading' || nextMode === 'waiting';
      const keepSolid = nextPrimary && this._isPrimary() &&
        this._fusionBlend === 1 && !this._fusionRetiring;
      if (!this._fusionRetiring && this._mode === 'waiting' && this._assemblyReady && !this._isReduced) {
        this._componentDefs.forEach((component, index) => {
          const hop = this._waitingHop(index);
          for (const id of component.members) {
            const p = this._byId.get(id);
            p.y = clamp(p.y + hop.offset, SAFE_MIN, SAFE_MAX);
            p.vy = clamp(p.vy + hop.velocity, -600, 600);
          }
        });
      }
      if (keepSolid) {
        this._componentMorph = true;
        this._morphOpacities = opacities;
        this._fusionProfile = nextMode;
        return;
      }
      if (!this._fusionRetiring) {
        this._retireStartBlend = this._fusionBlend;
        this._retireMicroStart = microVisibility;
        this._retireOpacities = opacities;
        this._retireSizes = snapshots.map((c) => ({ width: c.width, rx: c.rx }));
      }
      this._componentMorph = false;
      this._fusionRetiring = true;
    }

    _assemblySettled(targets) {
      if (this._angle !== 0 || this._angleVelocity !== 0 || this._breathAmount !== 0 || this._breathVelocity !== 0) return false;
      return this._pixels.every((p) => {
        const t = targets.get(p.id);
        return p.x === t.x && p.y === t.y && p.vx === 0 && p.vy === 0 &&
          p.localScale === t.scale && p.localRadius === t.radius && p.opacity === t.opacity;
      });
    }

    _advanceFusion(h, targets) {
      if (this._fusionRetiring) {
        this._fusionBlend = Math.max(0, this._fusionBlend - h / 0.14);
        if (this._fusionBlend === 0) {
          this._fusionProfile = null;
          this._fusionRetiring = false;
        }
      }
      if (!this._isPrimary() || this._assemblyReady || this._fusionRetiring) return;
      if (!this._assemblySettled(targets)) return;
      if (this._componentMorph) {
        this._componentMorph = false;
        this._assemblyReady = true;
        this._componentClock = 0;
        return;
      }
      if (this._fusionProfile !== this._mode) {
        this._fusionProfile = this._mode;
        this._fusionBlend = 0;
      }
      this._fusionBlend = Math.min(1, this._fusionBlend + h / 0.16);
      if (this._fusionBlend === 1) {
        this._assemblyReady = true;
        this._componentClock = 0;
      }
    }

    _targets(finalPose = false) {
      const result = new Map();
      const primary = this._isPrimary();
      const base = primary ? this._shapes[this._mode]
        : this._mode === 'c' || this._mode === 'magnet' ? this._shapes.c : this._shapes.observer;
      const gaze = this._mode === 'observe' ? this._scan() : null;
      const visualSign = Math.cos(this._angle) < 0 ? -1 : 1;
      for (const p of this._pixels) {
        const original = base[p.id];
        let x = original.x; let y = original.y;
        let opacity = this._mode === 'waitingAlt' && p.role === 'field' ? 0.82 : 1;
        let scale = 1;
        if (primary) {
          const component = this._componentDefs[this._componentByPixel.get(p.id)];
          const size = this._mode === 'loading' ? component.loadingSize : component.waitingSize;
          const gap = this._mode === 'loading' ? this._displayGrid.loadingGap : this._displayGrid.waitingGap;
          scale = (size - gap) / (2 * this._pixelSize);
        } else if (p.role === 'core') {
          const index = this._coreIds.indexOf(p.id);
          if (this._mode === 'observe') {
            x += gaze.x * visualSign;
            y += gaze.y;
          } else if (this._mode === 'c') {
            const entry = this._entryPositions.get(p.id);
            const slot = this._dockTargets[p.id];
            const amount = finalPose || this._skipEntry
              ? 1 : smooth((this._elapsed - 0.18 - index * 0.075) / 0.5);
            x = mix(entry.x, slot.x, amount);
            y = mix(entry.y, slot.y, amount);
          } else if (this._mode === 'loadingAlt') {
            const phase = this._orbitAngles.get(p.id) + (this._isReduced ? 0 : this._elapsed) * TAU / 2.4;
            x = 56 + Math.cos(phase) * 12.5;
            y = 56 + Math.sin(phase) * 12.5;
          } else if (this._mode === 'waitingAlt') {
            x = 41 + index * 10; y = 56;
            if (!this._isReduced) {
              const pulse = 0.5 + 0.5 * Math.sin(this._elapsed * TAU / 3.2 - index * 0.8);
              opacity = 0.82 + 0.18 * pulse;
              scale = 0.975 + 0.05 * pulse;
            }
          } else if (this._mode === 'magnet') {
            const target = this._coreMagnetTarget(p.id, index, finalPose);
            x = target.x; y = target.y;
          }
        }
        result.set(p.id, { x: clamp(x, SAFE_MIN, SAFE_MAX), y: clamp(y, SAFE_MIN, SAFE_MAX), opacity, scale, radius: this._pixelRadius });
      }
      return result;
    }


    _snapToTargets() {
      const targets = this._targets(true);
      for (const p of this._pixels) {
        const target = targets.get(p.id);
        p.x = target.x; p.y = target.y;
        p.vx = 0; p.vy = 0;
        p.opacity = target.opacity; p.localScale = target.scale; p.localRadius = target.radius;
      }
      if (this._isPrimary()) {
        this._angle = 0; this._angleVelocity = 0;
        this._breathAmount = 0; this._breathVelocity = 0;
        this._fusionProfile = this._mode;
        this._fusionBlend = 1;
        this._fusionRetiring = false;
        this._componentMorph = false;
        this._assemblyReady = true;
        this._componentClock = 0;
      } else {
        this._fusionProfile = null;
        this._fusionBlend = 0;
        this._fusionRetiring = false;
        this._componentMorph = false;
        this._assemblyReady = false;
        this._componentClock = 0;
      }
    }

    _transitionPending() {
      if (this._skipEntry) return false;
      if (this._mode === 'c') return this._elapsed < C_ENTRY_END;
      if (this._mode === 'magnet' && !this._magnetManual && !this._drag) {
        return this._elapsed < MAGNET_ENTRY_END;
      }
      return false;
    }

    _continuous() {
      return !this._isReduced &&
        (this._mode === 'observe' || this._isPrimary() || this._mode === 'loadingAlt' || this._mode === 'waitingAlt' || this._breathing);
    }

    needsFrame() {
      if (this._isReduced) return false;
      if (this._continuous() || this._transitionPending() || this._fusionBlend > 0 && this._fusionRetiring) return true;
      const angleTarget = this._mirrored ? Math.PI : 0;
      if (Math.abs(this._angle - angleTarget) > 0.0001 || Math.abs(this._angleVelocity) > 0.0004) return true;
      const breathTarget = this._breathing ? 1 : 0;
      if (Math.abs(this._breathAmount - breathTarget) > 0.001 || Math.abs(this._breathVelocity) > 0.004) return true;
      const targets = this._targets();
      return this._pixels.some((p) => {
        const t = targets.get(p.id);
        return Math.hypot(p.x - t.x, p.y - t.y) > POSITION_EPSILON ||
          Math.hypot(p.vx, p.vy) > VELOCITY_EPSILON ||
          Math.abs(p.opacity - t.opacity) > 0.002 ||
          Math.abs(p.localScale - t.scale) > 0.001 || Math.abs(p.localRadius - t.radius) > 0.001;
      });
    }

    advance(dtSeconds) {
      if (this._isReduced || !this.needsFrame()) return this;
      const dt = clamp(finite(dtSeconds), 0, MAX_DT);
      if (dt === 0) return this;
      const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
      const h = dt / steps;
      for (let i = 0; i < steps; i += 1) {
        this._elapsed += h;
        this._time += h;
        this._step(h);
      }
      return this;
    }

    _step(h) {
      const angleTarget = this._mirrored ? Math.PI : 0;
      this._angleVelocity += ((angleTarget - this._angle) * 90 - this._angleVelocity * 18) * h;
      this._angle += this._angleVelocity * h;
      if (Math.abs(this._angle - angleTarget) < 0.0001 && Math.abs(this._angleVelocity) < 0.0004) {
        this._angle = angleTarget; this._angleVelocity = 0;
      }
      const breathTarget = this._breathing ? 1 : 0;
      this._breathVelocity += ((breathTarget - this._breathAmount) * 60 - this._breathVelocity * 16) * h;
      this._breathAmount = clamp(this._breathAmount + this._breathVelocity * h, 0, 1);
      if (Math.abs(this._breathAmount - breathTarget) < 0.001 && Math.abs(this._breathVelocity) < 0.004) {
        this._breathAmount = breathTarget; this._breathVelocity = 0;
      }
      if (this._isPrimary() && this._assemblyReady) {
        this._componentClock += h;
        return;
      }
      const targets = this._targets();
      const fade = 1 - Math.exp(-h * 13);
      for (const p of this._pixels) {
        const t = targets.get(p.id);
        const core = p.role === 'core';
        const stiffness = core ? 150 : 240;
        const damping = core ? 20 : 32;
        p.vx += ((t.x - p.x) * stiffness - p.vx * damping) * h;
        p.vy += ((t.y - p.y) * stiffness - p.vy * damping) * h;
        p.vx = clamp(p.vx, -600, 600); p.vy = clamp(p.vy, -600, 600);
        p.x += p.vx * h; p.y += p.vy * h;
        if (p.x < SAFE_MIN || p.x > SAFE_MAX) { p.x = clamp(p.x, SAFE_MIN, SAFE_MAX); p.vx = 0; }
        if (p.y < SAFE_MIN || p.y > SAFE_MAX) { p.y = clamp(p.y, SAFE_MIN, SAFE_MAX); p.vy = 0; }
        if (Math.hypot(t.x - p.x, t.y - p.y) < POSITION_EPSILON &&
            Math.hypot(p.vx, p.vy) < VELOCITY_EPSILON) {
          p.x = t.x; p.y = t.y; p.vx = 0; p.vy = 0;
        }
        p.opacity += (t.opacity - p.opacity) * fade;
        p.localScale += (t.scale - p.localScale) * fade;
        p.localRadius += (t.radius - p.localRadius) * fade;
        if (Math.abs(t.opacity - p.opacity) < 0.0005) p.opacity = t.opacity;
        if (Math.abs(t.scale - p.localScale) < 0.0002) p.localScale = t.scale;
        if (Math.abs(t.radius - p.localRadius) < 0.0002) p.localRadius = t.radius;
      }
      this._advanceFusion(h, targets);
    }

    _project(x, y, localScale = 1) {
      const breath = this._breathProjection();
      const cos = Math.cos(this._angle);
      const sin = Math.sin(this._angle);
      const dx = (finite(x, 56) - 56) * breath.scale;
      const dy = (finite(y, 56) - 56) * breath.scale;
      const perspective = clamp(1 / (1 + dx / 56 * sin * 0.12), 0.9, 1.12);
      const scale = breath.scale * localScale;
      return {
        x: clamp(56 + dx * cos * perspective, SAFE_MIN, SAFE_MAX),
        y: clamp(56 + dy * perspective, SAFE_MIN, SAFE_MAX),
        sx: Math.max(0.12, Math.abs(cos) * perspective * scale),
        sy: clamp(perspective * scale, 0.3, 2.3),
        rotation: 0
      };
    }

    // Same projection as frame(), excluding each pixel's waiting pulse scale.
    projectPoint(x, y) {
      return this._project(x, y);
    }



    // Child groups have equal visual weight even when their source counts are
    // 3/2/2/2. Averaging nine sources directly would shift the visible center.
    _componentCenter(component) {
      return this._centroid(component.children.map((child) =>
        this._centroid(child.members.map((id) => this._byId.get(id)))));
    }

    _componentChildSide(component) {
      return component.children.reduce((sum, child) =>
        sum + child.members.reduce((total, id) => total + this._byId.get(id).localScale * this._pixelSize, 0) /
          child.members.length, 0) / 4;
    }

    _componentSizeFromChildSide(component, side) {
      const waitingSide = (component.waitingSize - this._displayGrid.waitingGap) / 2;
      const loadingSide = (component.loadingSize - this._displayGrid.loadingGap) / 2;
      const ratio = clamp((side - waitingSide) / (loadingSide - waitingSide), 0, 1);
      const gap = mix(this._displayGrid.waitingGap, this._displayGrid.loadingGap, ratio);
      return 2 * side + gap;
    }

    _microVisibility() {
      if (this._fusionRetiring) {
        const progress = 1 - this._fusionBlend / Math.max(0.00001, this._retireStartBlend);
        return mix(this._retireMicroStart, 1, clamp(progress, 0, 1));
      }
      if (this._isPrimary() && (this._assemblyReady || this._componentMorph)) return 0;
      // Aliased sources already cover the same sixteen children at fusion.
      // Keep that coverage until the complete component view takes over.
      return 1;
    }

    frame() {
      const breath = this._breathProjection();
      const hidden = this._microVisibility();
      return this._pixels.map((p) => {
        const index = this._componentByPixel.get(p.id);
        const jump = this._isPrimary() && this._assemblyReady && this._mode === 'waiting'
          ? this._waitingHop(index).offset : 0;
        return {
          id: p.id,
          ...this._project(p.x, p.y + jump, p.localScale),
          opacity: clamp(p.opacity * breath.opacity * hidden, 0, 1),
          rx: p.localRadius
        };
      });
    }

    // Four stable composite nodes. opacity is final (already includes blend);
    // hosts must not multiply it by blend again. Source pixels remain in frame().
    components() {
      const breath = this._breathProjection();
      const active = this._isPrimary() && this._assemblyReady && !this._fusionRetiring;
      return this._componentDefs.map((component, index) => {
        const profile = this._fusionProfile || (this._mode === 'waiting' ? 'waiting' : 'loading');
        const waiting = profile === 'waiting';
        const morphing = this._componentMorph && !this._fusionRetiring && !this._assemblyReady;
        const size = this._fusionRetiring ? this._retireSizes[index].width
          : morphing ? this._componentSizeFromChildSide(component, this._componentChildSide(component))
          : waiting ? component.waitingSize : component.loadingSize;
        const ratio = clamp((size - component.waitingSize) / (component.loadingSize - component.waitingSize), 0, 1);
        const radius = this._fusionRetiring ? this._retireSizes[index].rx
          : morphing ? mix(component.waitingRadius, component.loadingRadius, ratio)
          : waiting ? component.waitingRadius : component.loadingRadius;
        const center = active
          ? (waiting ? component.waitingCenter : component.loadingCenter)
          : this._componentCenter(component);
        const jump = active && waiting ? this._waitingHop(index).offset : 0;
        const projected = this._project(center.x, center.y + jump);
        const halfW = size * projected.sx / 2;
        const halfH = size * projected.sy / 2;
        const intrinsic = this._fusionRetiring ? this._retireOpacities[index]
          : morphing ? mix(this._morphOpacities[index], 1, smooth(this._elapsed / 0.2))
          : active && !waiting && !this._isReduced
            ? mix(1, this._loadingLuminance(component), smooth(this._componentClock / 0.18)) : 1;
        return {
          id: component.id,
          members: component.members.slice(),
          ...projected,
          x: clamp(projected.x, halfW + 1, 111 - halfW),
          y: clamp(projected.y, halfH + 1, 111 - halfH),
          width: size,
          height: size,
          rx: radius,
          opacity: clamp(intrinsic * breath.opacity * this._fusionBlend, 0, 1),
          blend: this._fusionBlend
        };
      });
    }

    _physicalDocked() {
      return this._coreIds.every((id) => {
        const p = this._byId.get(id);
        return distance(p, this._dockTargets[id]) < 0.9 && Math.hypot(p.vx, p.vy) < 5;
      });
    }

    getState() {
      const active = this.needsFrame();
      return {
        mode: this._mode,
        elapsed: this._elapsed,
        mirrored: this._mirrored,
        breathing: this._breathing,
        dragging: Boolean(this._drag),
        docked: (this._mode === 'c' || this._mode === 'magnet') && this._physicalDocked(),
        maxSpeed: Math.max(...this._pixels.map((p) => Math.hypot(p.vx, p.vy))),
        cError: Math.max(...this._pixels.map((p) => distance(p, this._shapes.c[p.id]))),
        needsFrame: active,
        continuous: this._continuous(),
        settled: !active,
        reduced: this._isReduced,
        assemblyReady: this._isPrimary() && this._assemblyReady,
        componentCount: this.components().filter((c) => c.opacity > 0.001).length,
        componentElapsed: this._componentClock,
        phase: this._fusionRetiring ? 'reforming'
          : this._isPrimary() ? (this._assemblyReady ? 'active' : this._fusionBlend > 0 ? 'fusing' : 'assembling')
          : this._transitionPending() ? 'assembling' : 'active'
      };
    }
  }

  globalThis.CruxPixelRig = CruxPixelRig;
})();
