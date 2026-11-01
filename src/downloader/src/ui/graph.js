/**
 * Real-time canvas bandwidth throughput visualizer (IDM style sparkline).
 */

export class BandwidthGraph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.history = new Array(30).fill(0);
    this.maxSpeed = 1024 * 1024; // 1 MB/s min ceiling for scale
  }

  push(speedBytesPerSec) {
    this.history.shift();
    this.history.push(speedBytesPerSec);
    this.draw();
  }

  draw() {
    if (!this.canvas || !this.ctx) return;
    const { width, height } = this.canvas;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, width, height);

    const currentMax = Math.max(...this.history, 10240);
    this.maxSpeed = Math.max(this.maxSpeed * 0.95, currentMax);

    const step = width / (this.history.length - 1);

    // Draw area fill
    ctx.beginPath();
    ctx.moveTo(0, height);

    for (let i = 0; i < this.history.length; i++) {
      const val = this.history[i];
      const y = height - (val / this.maxSpeed) * (height - 4);
      ctx.lineTo(i * step, y);
    }

    ctx.lineTo(width, height);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(0, 242, 254, 0.35)');
    gradient.addColorStop(1, 'rgba(0, 242, 254, 0.02)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Draw top line
    ctx.beginPath();
    for (let i = 0; i < this.history.length; i++) {
      const val = this.history[i];
      const y = height - (val / this.maxSpeed) * (height - 4);
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo(i * step, y);
    }

    ctx.strokeStyle = '#00f2fe';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = 4;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
