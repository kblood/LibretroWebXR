// ArtResolver — derive libretro-thumbnails box-art URLs for a game when the
// collection doesn't supply an explicit `boxart`.
//
// Ported from EmuVR/RetroArch's proven name-matching scheme (see
// docs/EMUVR_RESEARCH.md §2). We can't stat a remote repo, so instead of
// "try filename, else title, else tag-stripped" as sequential lookups, we
// emit an ORDERED LIST OF CANDIDATE URLS and let the image loader try each in
// turn (Cartridge.js does this). The order encodes the same precedence:
//   1. exact ROM filename (without extension)
//   2. exact game title / detected name
//   3. title with ()/[] region/revision tags stripped
//
// libretro-thumbnails stores three media kinds; box art is Named_Boxarts.
// File names replace the characters & * / : ` < > ? \ |  with _ and are URL-
// encoded. Repos live at github.com/libretro-thumbnails/<Repo>.

const THUMB_BASE = 'https://raw.githubusercontent.com/libretro-thumbnails';
const MEDIA = 'Named_Boxarts';

// RetroArch's forbidden-character substitution for thumbnail file names.
const FORBIDDEN = /[&*/:`<>?\\|]/g;
export function sanitizeThumbName(name) {
  return String(name).replace(FORBIDDEN, '_');
}

/** Strip the extension from a filename (and any leading path). */
export function baseName(file) {
  const justFile = String(file).split(/[\\/]/).pop();
  const dot = justFile.lastIndexOf('.');
  return dot > 0 ? justFile.slice(0, dot) : justFile;
}

/** Remove ()/[] tag groups (region, revision, dump flags) and collapse spaces. */
export function stripTags(name) {
  return String(name)
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** One thumbnail URL for a repo + raw (pre-sanitize) name. */
function thumbUrl(repo, rawName) {
  const file = sanitizeThumbName(rawName) + '.png';
  return `${THUMB_BASE}/${repo}/master/${MEDIA}/${encodeURIComponent(file)}`;
}

/**
 * Ordered, de-duplicated list of candidate box-art URLs for a game.
 *   game: { file?, title?, boxart? }
 *   system: a SYSTEMS entry (needs .thumbnailRepo) or null
 * If game.boxart is set it is returned first (explicit always wins).
 * Returns [] when there's nothing to go on (no repo and no explicit art).
 */
export function boxartCandidates(game, system) {
  const out = [];
  const push = (u) => { if (u && !out.includes(u)) out.push(u); };

  if (game.boxart) push(game.boxart);

  const repo = system?.thumbnailRepo;
  if (repo) {
    const names = [];
    if (game.file) names.push(baseName(game.file));
    if (game.title) names.push(game.title);
    // tag-stripped variants of whatever we have
    if (game.title) names.push(stripTags(game.title));
    if (game.file) names.push(stripTags(baseName(game.file)));
    for (const n of names) if (n) push(thumbUrl(repo, n));
  }
  return out;
}

/** Convenience: the single best-guess URL (or null). */
export function bestBoxart(game, system) {
  return boxartCandidates(game, system)[0] || null;
}
