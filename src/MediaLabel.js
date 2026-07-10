// MediaLabel — shared canvas-label helpers for all physical game media
// (Cartridge and Floppy). Extracted from Cartridge.js so both media types
// draw labels the same way without duplicating logic.
//
// All functions take a plain HTMLCanvasElement and draw onto it via the 2D
// context. They are synchronous except for loadFirstBoxart which returns
// a Promise. THREE.CanvasTexture.needsUpdate must be set by the caller
// after an async draw.

/** Draw a text-only label (title + system name) onto canvas `c`. */
export function drawTextLabel(c, title, system) {
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#f5f0e0');
  grad.addColorStop(1, '#dcd6c2');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, c.width - 6, c.height - 6);
  ctx.fillStyle = '#222';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText((system || '').toUpperCase(), 14, 28);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  wrap(ctx, title, c.width / 2, 80, c.width - 24, 34);
}

/** Draw a boxart image + title strip onto canvas `c`. */
export function drawBoxartLabel(c, img, title) {
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  // Letterbox the boxart on a dark backing so portrait box scans don't
  // distort to the label's aspect ratio.
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, c.width, c.height);
  const targetAspect = c.width / c.height;
  const imgAspect = img.width / img.height;
  let dw, dh, dx, dy;
  if (imgAspect > targetAspect) {
    dw = c.width; dh = c.width / imgAspect;
    dx = 0; dy = (c.height - dh) / 2;
  } else {
    dh = c.height; dw = c.height * imgAspect;
    dy = 0; dx = (c.width - dw) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
  // Tiny title strip at the bottom for context.
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, c.height - 22, c.width, 22);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Truncate if too long.
  let t = title;
  while (t.length > 4 && ctx.measureText(t).width > c.width - 12) t = t.slice(0, -1);
  if (t !== title) t = t.slice(0, -1) + '…';
  ctx.fillText(t, c.width / 2, c.height - 11);
  ctx.textBaseline = 'alphabetic';
}

/**
 * Overlay a "you don't have this ROM" ribbon on an already-drawn label canvas
 * (composited on top, not a replacement, so the title/boxart underneath stays
 * legible). Used for cartridges [[src/RomResolver.js]] `isUnresolvableHere`
 * flags — a pre-flight affordance so a multiplayer peer sees a cart is
 * unplayable for them before walking it to the console, not just after the
 * load throws.
 */
export function drawUnavailableBadge(c) {
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.fillStyle = 'rgba(15,15,15,0.5)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#e0a030';
  ctx.fillRect(0, c.height - 26, c.width, 26);
  ctx.fillStyle = '#1a1200';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText("YOU DON'T HAVE THIS ROM", c.width / 2, c.height - 13);
  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function loadBoxart(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`boxart load failed: ${url}`));
    img.src = url;
  });
}

/**
 * Resolve with the first candidate URL that loads; reject only if all fail.
 * @param {string[]} urls - ordered list of candidate boxart URLs
 * @returns {Promise<HTMLImageElement>}
 */
export function loadFirstBoxart(urls) {
  return urls.reduce(
    (p, url) => p.catch(() => loadBoxart(url)),
    Promise.reject(new Error('no boxart candidates')),
  );
}

/** Word-wrap `text` centred at (x, y) on `ctx`, with `maxW` and `lineH`. */
export function wrap(ctx, text, x, y, maxW, lineH) {
  const words = String(text).split(/\s+/);
  let line = '';
  const lines = [];
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const start = y - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, start + i * lineH));
}
