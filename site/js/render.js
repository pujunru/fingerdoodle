// Draws elements onto a 2D canvas context that already has its transform set.

export const FONT_FAMILY = '"Shantell Sans", -apple-system, system-ui, sans-serif';
export const LINE_HEIGHT = 1.25;

export const fontFor = (size) => `500 ${size}px ${FONT_FAMILY}`;

export function drawElement(ctx, el, colors) {
  const color = colors[el.color] ?? colors.ink;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = el.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (el.type) {
    case 'pencil': drawPencil(ctx, el); break;
    case 'rect':
      ctx.beginPath();
      ctx.rect(el.x, el.y, el.w, el.h);
      ctx.stroke();
      break;
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'text': {
      ctx.font = fontFor(el.size);
      ctx.textBaseline = 'top';
      el.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, el.x, el.y + i * el.size * LINE_HEIGHT);
      });
      break;
    }
  }
}

// Each sample becomes a curve control point, with the curve passing through the
// midpoints. Smooths the jitter of a fingertip without lagging behind it.
function drawPencil(ctx, el) {
  const pts = el.points;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], el.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

// Dotted sketchbook paper. The spacing doubles as you zoom out so the dots never
// turn into a grey wash.
export function drawPaper(ctx, width, height, camera, colors) {
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, width, height);
  let spacing = 32;
  while (spacing * camera.z < 22) spacing *= 2;
  const step = spacing * camera.z;
  const startX = ((camera.x % step) + step) % step;
  const startY = ((camera.y % step) + step) % step;
  ctx.fillStyle = colors.dot;
  for (let x = startX; x < width; x += step) {
    for (let y = startY; y < height; y += step) ctx.fillRect(x - 1, y - 1, 2, 2);
  }
}
