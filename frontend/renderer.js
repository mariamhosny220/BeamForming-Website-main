// ============================================================
// RENDERER — Base canvas rendering utilities
// Shared by all simulator modes — zero duplication
// ============================================================

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.dpr    = window.devicePixelRatio || 1;
    this.width  = 0;
    this.height = 0;
    this._setup();
  }

  _setup() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width  || this.canvas.offsetWidth  || this.canvas.parentElement?.offsetWidth  || 800;
    const h = rect.height || this.canvas.offsetHeight || this.canvas.parentElement?.offsetHeight || 600;
    if (w && h) {
      this.canvas.width  = w * this.dpr;
      this.canvas.height = h * this.dpr;
      this.ctx.scale(this.dpr, this.dpr);
      this.width  = w;
      this.height = h;
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    // Fallback to offsetWidth/Height when canvas is in a hidden/transitioning container
    const w = rect.width  || this.canvas.offsetWidth  || this.canvas.parentElement?.offsetWidth  || 800;
    const h = rect.height || this.canvas.offsetHeight || this.canvas.parentElement?.offsetHeight || 600;
    this.canvas.width  = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
    this.width  = w;
    this.height = h;
  }

  clear(color = 'transparent') {
    this.ctx.clearRect(0, 0, this.width, this.height);
    if (color !== 'transparent') {
      this.ctx.fillStyle = color;
      this.ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  drawCircle(x, y, r, fill = null, stroke = null, lw = 1) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill)   { this.ctx.fillStyle   = fill;   this.ctx.fill();              }
    if (stroke) { this.ctx.strokeStyle = stroke; this.ctx.lineWidth = lw; this.ctx.stroke(); }
  }

  drawArc(x, y, r, start, end, stroke, lw = 1, alpha = 1) {
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, start, end);
    this.ctx.strokeStyle = stroke;
    this.ctx.lineWidth   = lw;
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawLine(x1, y1, x2, y2, color, lw = 1, alpha = 1, dash = []) {
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.setLineDash(dash);
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1); this.ctx.lineTo(x2, y2);
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth   = lw;
    this.ctx.stroke();
    this.ctx.setLineDash([]);
    this.ctx.restore();
  }

  drawText(text, x, y, color, size = 12, font = 'monospace', align = 'left') {
    this.ctx.fillStyle  = color;
    this.ctx.font       = `${size}px ${font}`;
    this.ctx.textAlign  = align;
    this.ctx.fillText(text, x, y);
  }

  drawGradientBeam(x1, y1, x2, y2, width, color, alpha = 0.8) {
    const angle = Math.atan2(y2-y1, x2-x1);
    const px    = Math.cos(angle + Math.PI/2);
    const py    = Math.sin(angle + Math.PI/2);
    const grad  = this.ctx.createLinearGradient(
      x1+px*width, y1+py*width, x1-px*width, y1-py*width
    );
    grad.addColorStop(0,   'rgba(0,0,0,0)');
    grad.addColorStop(0.5, color);
    grad.addColorStop(1,   'rgba(0,0,0,0)');
    this.ctx.save();
    this.ctx.globalAlpha  = alpha;
    this.ctx.strokeStyle  = grad;
    this.ctx.lineWidth    = width * 2;
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1); this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawWaveRipple(cx, cy, radius, maxRadius, color, alpha) {
    if (radius > maxRadius) return;
    const a = alpha * (1 - radius / maxRadius);
    this.drawArc(cx, cy, radius, 0, Math.PI*2, color, 1.5, a);
  }

  /** Render an intensity grid as a heatmap using putImageData */
  renderHeatmap(intensityGrid, w, h, colormap = 'hot') {
    const img = this.ctx.createImageData(w, h);
    for (let i = 0; i < intensityGrid.length; i++) {
      const val        = MathUtils.clamp(intensityGrid[i], 0, 1);
      const [r, g, b]  = Renderer.colormapColor(val, colormap);
      img.data[i*4]    = r;
      img.data[i*4+1]  = g;
      img.data[i*4+2]  = b;
      img.data[i*4+3]  = val > 0.05 ? Math.floor(val * 220) : 0;
    }
    this.ctx.putImageData(img, 0, 0);
  }

  drawPolygon(points, fill, stroke, lw = 1, alpha = 1) {
    if (points.length < 2) return;
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.beginPath();
    this.ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.ctx.lineTo(points[i].x, points[i].y);
    this.ctx.closePath();
    if (fill)   { this.ctx.fillStyle   = fill;   this.ctx.fill();              }
    if (stroke) { this.ctx.strokeStyle = stroke; this.ctx.lineWidth = lw; this.ctx.stroke(); }
    this.ctx.restore();
  }

  /** Colormap: shared static method — used by all modes */
  static colormapColor(t, map) {
    switch (map) {
      case 'hot':
        if (t < 0.333) return [Math.floor(t*3*255), 0, 0];
        if (t < 0.666) return [255, Math.floor((t-0.333)*3*255), 0];
        return [255, 255, Math.floor((t-0.666)*3*255)];
      case 'cool':
        return [Math.floor((1-t)*100), Math.floor(t*200), 255];
      case 'radar':
        if (t < 0.5) return [0, Math.floor(t*2*255), 0];
        return [Math.floor((t-0.5)*2*255), 255, 0];
      default:
        if (t < 0.25) return [0, 0, Math.floor(t*4*255)];
        if (t < 0.50) return [0, Math.floor((t-0.25)*4*255), 255];
        if (t < 0.75) return [0, 255, Math.floor((1-(t-0.5)*4)*255)];
        return [Math.floor((t-0.75)*4*255), 255, 0];
    }
  }
}

// Legacy shim so existing colormapColor(t, map) calls still work
function colormapColor(t, map) { return Renderer.colormapColor(t, map); }