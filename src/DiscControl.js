// Adapts either purpose-built libretrowebxr exports or RetroArch's existing
// disk hotkey commands to one explicit eject/select/insert API.

export class DiscControlBridge extends EventTarget {
  constructor(module, { discCount = 1, initialIndex = 0 } = {}) {
    super();
    this.module = module;
    this.discCount = Math.max(1, discCount);
    this.index = initialIndex;
    this.ejected = false;
  }

  capabilities() {
    const m = this.module || {};
    const explicit = typeof m._libretrowebxr_set_disc_index === 'function' && typeof m._libretrowebxr_set_eject_state === 'function';
    const sequential = typeof m._cmd_disk_next === 'function' && typeof m._cmd_disk_eject_toggle === 'function';
    return { supported: explicit || sequential, explicit, sequential, discCount: this.discCount };
  }

  status() {
    return { index: this.index, ejected: this.ejected, discCount: this.discCount, ...this.capabilities() };
  }

  setEjected(ejected) {
    const next = !!ejected;
    if (next === this.ejected) return this.status();
    const m = this.module;
    if (typeof m?._libretrowebxr_set_eject_state === 'function') m._libretrowebxr_set_eject_state(next ? 1 : 0);
    else if (typeof m?._cmd_disk_eject_toggle === 'function') m._cmd_disk_eject_toggle();
    else throw new Error('The loaded core does not expose disc eject control');
    this.ejected = next;
    this._changed();
    return this.status();
  }

  setDisc(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.discCount) {
      throw new RangeError(`Disc index ${index} is outside 0..${this.discCount - 1}`);
    }
    const capabilities = this.capabilities();
    if (!capabilities.supported) throw new Error('The loaded core does not expose disc control');
    const wasEjected = this.ejected;
    if (!wasEjected) this.setEjected(true);

    if (capabilities.explicit) {
      const accepted = this.module._libretrowebxr_set_disc_index(index);
      if (accepted === 0) throw new Error(`Core rejected disc index ${index}`);
    } else {
      const forward = (index - this.index + this.discCount) % this.discCount;
      const backward = (this.index - index + this.discCount) % this.discCount;
      if (backward < forward && typeof this.module._cmd_disk_prev === 'function') {
        for (let i = 0; i < backward; i++) this.module._cmd_disk_prev();
      } else {
        for (let i = 0; i < forward; i++) this.module._cmd_disk_next();
      }
    }
    this.index = index;
    if (!wasEjected) this.setEjected(false);
    this._changed();
    return this.status();
  }

  _changed() {
    this.dispatchEvent(new Event('change'));
  }
}

export function discEntriesFromBundle(contentBundle) {
  if (!contentBundle) return [];
  if (String(contentBundle.entryPath).toLowerCase().endsWith('.m3u')) {
    return contentBundle.dependencies.filter((path) => /\.(cue|chd|ccd|pbp)$/i.test(path));
  }
  return [contentBundle.entryPath];
}
