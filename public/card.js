// Draws a bingo card on a canvas. Used by the public page and the admin preview.
(function () {
  const cache = { v: -1, img: null };
  function loadBackground(version, has) {
    if (!has) { cache.v = -1; return Promise.resolve(null); }
    if (cache.v === version) return Promise.resolve(cache.img);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { cache.v = version; cache.img = img; resolve(img); };
      img.onerror = () => { cache.v = version; cache.img = null; resolve(null); };
      img.src = 'background?v=' + version;   // relative: each room has its own
    });
  }
  function wrap(ctx, text, maxW) {
    const words = text.split(/\s+/), lines = []; let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; } }
    if (line) lines.push(line); return lines;
  }
  function fit(ctx, text, w, h, max, min) {
    for (let s = max; s >= min; s--) {
      ctx.font = `bold ${s}px Arial, Helvetica, sans-serif`;
      const lines = wrap(ctx, text, w);
      if (Math.max(...lines.map((l) => ctx.measureText(l).width)) <= w && lines.length * s * 1.15 <= h) return { s, lines };
    }
    ctx.font = `bold ${min}px Arial, Helvetica, sans-serif`; return { s: min, lines: wrap(ctx, text, w) };
  }
  function draw(canvas, view, layout, bg, title) {
    const W = layout.width, H = layout.height;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (bg) { const k = Math.max(W / bg.width, H / bg.height); ctx.drawImage(bg, (W - bg.width * k) / 2, (H - bg.height * k) / 2, bg.width * k, bg.height * k); }
    else { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1b1038'); g.addColorStop(1, '#3a0f4d'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 12;
    const banner = view.blackout ? 'BLACKOUT!' : view.bingo ? 'BINGO!' : null;
    ctx.fillStyle = banner ? layout.accent : layout.textColor;
    // the heading shrinks to fit: page titles can be 40 characters long
    const head = banner || title || 'STREAM BINGO', headH = Math.round(H * 0.09);
    const hf = fit(ctx, head, W - 40, headH, Math.round(W * 0.064), 14);
    ctx.font = `bold ${hf.s}px Arial, Helvetica, sans-serif`;
    const hy0 = Math.round(H * 0.058) - ((hf.lines.length - 1) * hf.s * 1.1) / 2;
    hf.lines.forEach((l, n) => ctx.fillText(l, W / 2, hy0 + n * hf.s * 1.1));
    const nb = layout.nameBox;
    ctx.fillStyle = layout.textColor;
    const nf = fit(ctx, view.name, nb.w, nb.h, Math.floor(nb.h * 0.7), 20);
    ctx.font = `bold ${nf.s}px Arial, Helvetica, sans-serif`;
    const nlh = nf.s * 1.15, ny0 = nb.y + nb.h / 2 - ((nf.lines.length - 1) * nlh) / 2;
    nf.lines.forEach((l, n) => ctx.fillText(l, nb.x + nb.w / 2, ny0 + n * nlh));
    ctx.shadowBlur = 0;
    const g = layout.grid, cell = g.size / 5, pad = 14;
    view.cells.forEach((c, i) => {
      const x = g.x + (i % 5) * cell, y = g.y + Math.floor(i / 5) * cell;
      ctx.fillStyle = c.marked ? layout.accent : layout.cellFill; ctx.fillRect(x + 3, y + 3, cell - 6, cell - 6);
      // a word called before this player joined: dashed accent outline (it does not count on this card)
      if (c.early) { ctx.strokeStyle = layout.accent; ctx.lineWidth = 5; ctx.setLineDash([14, 9]); }
      else { ctx.strokeStyle = layout.cellBorder; ctx.lineWidth = 3; }
      ctx.strokeRect(x + 3, y + 3, cell - 6, cell - 6); ctx.setLineDash([]);
      // the viewer's own dab (public page only, never sent to the server)
      if (c.dab) {
        ctx.save(); ctx.globalAlpha = 0.6; ctx.fillStyle = c.dab;
        ctx.beginPath(); ctx.arc(x + cell / 2, y + cell / 2, cell * 0.38, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.9; ctx.lineWidth = 4; ctx.strokeStyle = c.dab; ctx.stroke(); ctx.restore();
      }
      const f = fit(ctx, c.free ? 'FREE' : c.text, cell - pad * 2, cell - pad * 2, c.free ? 40 : 30, 12);
      ctx.fillStyle = layout.textColor; ctx.font = `bold ${f.s}px Arial, Helvetica, sans-serif`;
      const lh = f.s * 1.15, y0 = y + cell / 2 - ((f.lines.length - 1) * lh) / 2;
      if (c.dab) { ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 6; }
      f.lines.forEach((l, n) => ctx.fillText(l, x + cell / 2, y0 + n * lh));
      ctx.shadowBlur = 0;
    });
  }
  // which square (0-24) a click at client coordinates lands on, or -1
  function cellAt(canvas, layout, clientX, clientY) {
    const r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return -1;
    const x = (clientX - r.left) * canvas.width / r.width, y = (clientY - r.top) * canvas.height / r.height;
    const g = layout.grid, cell = g.size / 5, col = Math.floor((x - g.x) / cell), row = Math.floor((y - g.y) / cell);
    return col >= 0 && col < 5 && row >= 0 && row < 5 ? row * 5 + col : -1;
  }
  window.BingoCard = { loadBackground, draw, cellAt };
})();
