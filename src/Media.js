// Media dispatcher — route each game to the correct physical medium based on
// its system and file extension, then delegate to the matching factory.
//
// Use createMedia(meta) everywhere you previously used createCartridge(meta).
// createCartridge is still exported from Cartridge.js for callers that
// explicitly need the cartridge mesh (back-compat / direct cartridge use).

import { mediumFor } from './systems.js';
import { createCartridge } from './Cartridge.js';
import { createFloppy } from './Floppy.js';

/**
 * Mint the correct physical media object for `meta`.
 * Returns a Floppy group when mediumFor(meta) === 'floppy', else a Cartridge.
 * Both have identical userData shape with kind:'cartridge' for compatibility.
 *
 * @param {object} meta - normalised game meta (file, system, core, title, color,
 *                        boxart, boxartList, rom, …)
 * @returns {THREE.Group}
 */
export function createMedia(meta) {
  return mediumFor(meta) === 'floppy'
    ? createFloppy(meta)
    : createCartridge(meta);
}
