// Unit tests for src/ImageLibrary.js pure helpers and src/RoomBuilder.js
// fitModeUV, and src/EnvEditor.js cycleFitMode / stepScale.
//
// No DOM, no THREE, no browser APIs. Run: node scripts/test-imagelibrary.mjs
// Exit 0 = all pass, 1 = any failure.

import { fileExtension, isImageFile, filterImageNames } from '../src/ImageLibrary.js';
import { fitModeUV } from '../src/PosterFit.js';
import { cycleFitMode, stepScale, FIT_MODE_OPTIONS } from '../src/EnvEditor.js';

let passed = 0;
let failed = 0;

const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; }
  else { failed++; console.error(`  FAIL: ${name}\n    got:  ${g}\n    want: ${w}`); }
};

const near = (name, got, want, tol = 1e-9) => {
  if (Math.abs(got - want) <= tol) { passed++; }
  else { failed++; console.error(`  FAIL: ${name}  got=${got}  want=${want}`); }
};

// ===========================================================================
// fileExtension
// ===========================================================================
console.log('--- fileExtension ---');
eq('png',       fileExtension('poster.png'),          'png');
eq('JPG upper', fileExtension('PHOTO.JPG'),            'jpg');
eq('jpeg',      fileExtension('image.jpeg'),           'jpeg');
eq('webp',      fileExtension('banner.webp'),          'webp');
eq('no ext',    fileExtension('README'),               '');
eq('path sep /', fileExtension('path/to/img.png'),    'png');
eq('path sep \\', fileExtension('path\\to\\img.gif'), 'gif');
eq('empty',     fileExtension(''),                     '');
eq('null',      fileExtension(null),                   '');

// ===========================================================================
// isImageFile
// ===========================================================================
console.log('--- isImageFile ---');
ok(isImageFile('poster.png'),   'png is image');
ok(isImageFile('photo.jpg'),    'jpg is image');
ok(isImageFile('anim.gif'),     'gif is image');
ok(isImageFile('art.webp'),     'webp is image');
ok(isImageFile('ART.PNG'),      'PNG uppercase is image');
ok(!isImageFile('game.nes'),    '.nes not image');
ok(!isImageFile('room.json'),   '.json not image');
ok(!isImageFile(''),            'empty string not image');

// ===========================================================================
// filterImageNames
// ===========================================================================
console.log('--- filterImageNames ---');
{
  const names = ['poster.png', 'game.nes', 'art.jpg', 'README', 'bg.webp'];
  const imgs = filterImageNames(names);
  eq('filters to images only', imgs, ['poster.png', 'art.jpg', 'bg.webp']);
}
eq('empty list', filterImageNames([]), []);
eq('no images',  filterImageNames(['a.rom', 'b.bin']), []);

// ===========================================================================
// fitModeUV — stretch (always 1,1,0,0 regardless of aspect)
// ===========================================================================
console.log('--- fitModeUV: stretch ---');
{
  const r = fitModeUV(200, 100, 0.8, 1.1, 'stretch');
  near('stretch repeatX', r.repeatX, 1);
  near('stretch repeatY', r.repeatY, 1);
  near('stretch offsetX', r.offsetX, 0);
  near('stretch offsetY', r.offsetY, 0);
}
// null/undefined mode → stretch
{
  const r = fitModeUV(200, 100, 0.8, 1.1, null);
  near('null mode = stretch repeatX', r.repeatX, 1);
}

// ===========================================================================
// fitModeUV — contain: square image on landscape plane
// Image 1:1, plane 2:1 → image constrained by height → pillarboxed horizontally
// ===========================================================================
console.log('--- fitModeUV: contain ---');
{
  // Square image (1:1), landscape plane (2:1).
  // imgAspect=1, planeAspect=2 → planeAspect > imgAspect → constrained by height
  // repeatX = imgAspect / planeAspect = 0.5; repeatY = 1.
  const r = fitModeUV(100, 100, 2, 1, 'contain');
  near('contain sq/land repeatX', r.repeatX, 0.5);
  near('contain sq/land repeatY', r.repeatY, 1);
  // offsetX should centre: (1 - 0.5) / 2 = 0.25
  near('contain sq/land offsetX', r.offsetX, 0.25);
  near('contain sq/land offsetY', r.offsetY, 0);
}
{
  // Landscape image (2:1), portrait plane (1:2).
  // imgAspect=2, planeAspect=0.5 → imgAspect > planeAspect → constrained by width
  // repeatX = 1; repeatY = planeAspect / imgAspect = 0.25
  const r = fitModeUV(200, 100, 1, 2, 'contain');
  near('contain land/port repeatX', r.repeatX, 1);
  near('contain land/port repeatY', r.repeatY, 0.25);
  near('contain land/port offsetX', r.offsetX, 0);
  near('contain land/port offsetY', r.offsetY, 0.375);
}
{
  // Same aspect → no letterboxing.
  const r = fitModeUV(800, 1100, 0.8, 1.1, 'contain');
  near('contain same aspect repeatX ≈1', r.repeatX, 1, 1e-6);
  near('contain same aspect repeatY ≈1', r.repeatY, 1, 1e-6);
}

// ===========================================================================
// fitModeUV — cover: crops to fill
// ===========================================================================
console.log('--- fitModeUV: cover ---');
{
  // Square image (1:1), landscape plane (2:1).
  // imgAspect=1 < planeAspect=2 → fill by width, crop top/bottom
  // repeatX = 1; repeatY = imgAspect / planeAspect = 0.5
  const r = fitModeUV(100, 100, 2, 1, 'cover');
  near('cover sq/land repeatX', r.repeatX, 1);
  near('cover sq/land repeatY', r.repeatY, 0.5);
  near('cover sq/land offsetX', r.offsetX, 0);
  near('cover sq/land offsetY', r.offsetY, 0.25);
}
{
  // Landscape image (2:1), portrait plane (1:2).
  // imgAspect=2 > planeAspect=0.5 → fill by height, crop left/right
  // repeatX = planeAspect / imgAspect = 0.25; repeatY = 1
  const r = fitModeUV(200, 100, 1, 2, 'cover');
  near('cover land/port repeatX', r.repeatX, 0.25);
  near('cover land/port repeatY', r.repeatY, 1);
  near('cover land/port offsetX', r.offsetX, 0.375);
  near('cover land/port offsetY', r.offsetY, 0);
}

// ===========================================================================
// fitModeUV — degenerate / zero dimensions
// ===========================================================================
console.log('--- fitModeUV: degenerate ---');
{
  const r = fitModeUV(0, 100, 0.8, 1.1, 'contain');
  near('zero imgW → stretch repeatX', r.repeatX, 1);
}
{
  const r = fitModeUV(100, 0, 0.8, 1.1, 'cover');
  near('zero imgH → stretch repeatX', r.repeatX, 1);
}
{
  const r = fitModeUV(100, 100, 0, 1.1, 'contain');
  near('zero planeW → stretch repeatX', r.repeatX, 1);
}

// ===========================================================================
// cycleFitMode
// ===========================================================================
console.log('--- cycleFitMode ---');
{
  const prop = {};
  // First call from undefined → first option.
  const v1 = cycleFitMode(prop);
  eq('cycleFit first',  v1, FIT_MODE_OPTIONS[0]);
  const v2 = cycleFitMode(prop);
  eq('cycleFit second', v2, FIT_MODE_OPTIONS[1]);
  const v3 = cycleFitMode(prop);
  eq('cycleFit third',  v3, FIT_MODE_OPTIONS[2]);
  const v4 = cycleFitMode(prop);
  eq('cycleFit wraps',  v4, FIT_MODE_OPTIONS[0]);
}
{
  // cycleFitMode on a non-poster prop (null guard).
  eq('cycleFit null',  cycleFitMode(null),       undefined);
  eq('cycleFit undef', cycleFitMode(undefined),  undefined);
}
{
  // cycleFitMode preserves the prop's other fields.
  const prop = { texture: 'builtin:poster-1', size: [0.8, 1.1], fit: 'cover', scale: 1.5 };
  cycleFitMode(prop);
  eq('cycleFit leaves texture', prop.texture, 'builtin:poster-1');
  eq('cycleFit leaves scale',   prop.scale,   1.5);
}

// ===========================================================================
// stepScale
// ===========================================================================
console.log('--- stepScale ---');
{
  const prop = { scale: 1.0 };
  const v = stepScale(prop, 'up');
  ok(v > 1.0, 'stepScale up increases');
  ok(prop.scale === v, 'prop.scale updated');
}
{
  const prop = { scale: 1.0 };
  const v = stepScale(prop, 'down');
  ok(v < 1.0, 'stepScale down decreases');
}
{
  // Clamp at top of scale list.
  const prop = { scale: 999 };
  stepScale(prop, 'up');
  ok(prop.scale <= 10, 'stepScale up clamps at max');
}
{
  // Clamp at bottom of scale list.
  const prop = { scale: 0.001 };
  stepScale(prop, 'down');
  ok(prop.scale > 0, 'stepScale down clamps at min (>0)');
}
{
  // Null guard.
  eq('stepScale null', stepScale(null), 1.0);
}
{
  // Missing scale defaults.
  const prop = {};
  const v = stepScale(prop, 'up');
  ok(typeof v === 'number', 'stepScale from missing scale returns number');
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
