// Turns raw browser events into a small vocabulary a drawing app can use:
//
//   strokeStart(x, y) / strokeMove(x, y) / strokeEnd() / strokeCancel()
//   pan(dx, dy) / zoom(factor, x, y)
//
// The touchscreen MacBook Pro needs this layer because macOS does not give web
// pages touch events. Measured on macOS 27.2 (recordings in test/fixtures),
// browsers report maxTouchPoints 0 and every finger arrives as something else:
//
//   Gesture            Chrome                        Safari
//   tap                left click, all at once       left click
//   quick drag         wheel deltas, then inertia    left drag
//   slow or held drag  RIGHT-button drag             left drag
//   pinch              ctrl+wheel                    gesture events
//   two-finger slide   ctrl+wheel noise, no position pointercancel, then a
//                                                    left drag at the centroid
//
// Chrome's two-finger slide cannot be recovered: the page gets a fixed position,
// no horizontal delta and no pointer events, so the direction never arrives. The
// noise looks like a very small pinch, and a dead zone keeps it from wobbling the
// zoom. A slide that dies in the dead zone is reported as slideIgnored.
//
// Chrome's quick drag is the hard case: no pointerdown ever fires, which is why
// ordinary drawing sites ignore the finger. Three facts make it recoverable:
//
//   1. Just before the first wheel event, the reported cursor jumps to the finger.
//      A trackpad scroll has no such jump, which tells a finger from a trackpad.
//   2. The deltas track the finger 1:1, so the path can be integrated.
//   3. Finger samples arrive at 120 Hz. Inertia starts after a ~33 ms gap and runs
//      at exactly 60 Hz, so it can be told apart and thrown away.
//
// When the gesture finishes, the cursor snaps back to where it really was, and
// that pointermove is the end-of-gesture signal.

const NEAR_PX = 2.5;              // two coordinates this close are the same place
const JUMP_PX = 80;               // a hover move this long in one event is a teleport
const GAP_MS = 22;                // a longer wheel gap may be the finger lifting
const COAST_MIN_MS = 14.5;        // inertia cadence, lower bound
const COAST_MAX_MS = 19;          // inertia cadence, upper bound
const COAST_SAMPLES = 3;          // intervals to check before calling it inertia
const COAST_MIN_SPEED = 0.2;      // px/ms; a slower finger leaves no inertia
const SPEED_WINDOW = 5;           // recent samples used to estimate finger speed
const GESTURE_TIMEOUT_MS = 600;   // end if the cursor-restore signal never arrives
const SECOND_FINGER_MS = 250;     // Safari: pointercancel, then pointerdown = two fingers
const WHEEL_LINE_PX = 16;
const PINCH_DEAD_ZONE = 20;       // wheel units of net pinch; slides stayed under 17
const PINCH_GAP_MS = 120;         // a longer silence ends a pinch
const SLIDE_MIN_SAMPLES = 15;     // fewer than this is a stray touch, not a slide

const near = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by) <= NEAR_PX;

export class InputInterpreter {
  constructor(out) {
    this.out = out;
    this.home = null;            // last hover position, when known
    this.jumped = false;         // that position was reached by a teleport
    this.stroke = null;          // { id } while a pointer-based stroke is live
    this.pan2 = null;            // { x, y } while Safari reports two fingers as a drag
    this.gestureActive = false;
    this.gestureScale = 1;
    this.secondFingerUntil = -Infinity;
    this.wheel = null;           // the finger-as-wheel gesture in progress
    this.touches = new Map();    // real touch or pen pointers, on hardware that has them
    this.pinch = null;
    this.pinchGate = null;       // Chrome pinch waiting to clear the dead zone
  }

  // ---- pointers ----------------------------------------------------------

  pointerDown(e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') return this.#touchDown(e);
    if (!e.overSurface) return;
    if (this.gestureActive || e.t < this.secondFingerUntil) {
      this.pan2 = { x: e.x, y: e.y };
      return;
    }
    if (e.button === 1) { this.pan2 = { x: e.x, y: e.y }; return; }
    if (e.button !== 0 && e.button !== 2) return;
    this.#endWheel();
    this.stroke = { id: e.pointerId };
    this.out.strokeStart(e.x, e.y);
  }

  pointerMove(e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') return this.#touchMove(e);
    if (e.buttons === 0) return this.#cursorMoved(e);
    if (this.pan2) {
      this.out.pan(e.x - this.pan2.x, e.y - this.pan2.y);
      this.pan2 = { x: e.x, y: e.y };
    } else if (this.stroke) {
      this.out.strokeMove(e.x, e.y);
    }
  }

  pointerUp(e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') return this.#touchUp(e);
    this.pan2 = null;
    if (this.stroke) {
      this.stroke = null;
      this.out.strokeEnd();
    }
  }

  pointerCancel(e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') return this.#touchUp(e, true);
    this.pan2 = null;
    this.secondFingerUntil = e.t + SECOND_FINGER_MS;
    if (this.stroke) {
      this.stroke = null;
      this.out.strokeCancel();
    }
  }

  #cursorMoved(e) {
    const w = this.wheel;
    if (w) {
      if (near(e.x, e.y, w.originX, w.originY)) return;   // the finger's own hover echo
      this.#endWheel();                                   // the cursor snapped back
      this.jumped = false;
      this.home = { x: e.x, y: e.y };
      return;
    }
    const from = this.home;
    if (from && near(e.x, e.y, from.x, from.y)) return;   // Chrome repeats the teleport
    this.jumped = !!from && Math.hypot(e.x - from.x, e.y - from.y) > JUMP_PX;
    this.home = { x: e.x, y: e.y };
  }

  // ---- wheel: pinch, trackpad scroll and Chrome's finger scroll ----------

  wheelEvent(e) {
    if (e.ctrlKey) {
      this.#endWheel();
      if (e.overSurface) this.#ctrlWheel(e);
      return;
    }
    if (e.deltaMode !== 0) {
      if (e.overSurface) this.out.pan(-e.deltaX * WHEEL_LINE_PX, -e.deltaY * WHEEL_LINE_PX);
      return;
    }
    let w = this.wheel;
    if (w && !near(e.x, e.y, w.originX, w.originY)) {
      this.#endWheel();
      w = null;
    }
    if (!w) {
      const atCursor = this.home && !this.jumped && near(e.x, e.y, this.home.x, this.home.y);
      if (!e.overSurface) return;
      if (atCursor) return this.out.pan(-e.deltaX, -e.deltaY);
      w = this.wheel = {
        originX: e.x, originY: e.y, x: e.x, y: e.y,
        mode: 'track', last: e.t, buffer: [], recent: [],
      };
      this.out.strokeStart(e.x, e.y);
    }
    const dt = e.t - w.last;
    w.last = e.t;
    if (w.mode === 'coast') return;
    if (w.mode === 'suspect') {
      w.buffer.push({ dx: e.deltaX, dy: e.deltaY, dt });
      if (w.buffer.length > COAST_SAMPLES) this.#judgeSuspect(w);
      return;
    }
    if (dt >= GAP_MS && this.#speed(w) >= COAST_MIN_SPEED) {
      w.mode = 'suspect';
      w.buffer = [{ dx: e.deltaX, dy: e.deltaY, dt }];
      return;
    }
    this.#follow(w, e.deltaX, e.deltaY, dt);
  }

  // The exponent is the inverse of how Chrome encodes a pinch: deltaY = -100 ln(scale).
  #ctrlWheel(e) {
    let gate = this.pinchGate;
    if (!gate || e.t - gate.last > PINCH_GAP_MS) gate = this.pinchGate = { net: 0, samples: 0, open: false };
    gate.last = e.t;
    gate.samples++;
    if (gate.open) return this.out.zoom(Math.exp(-e.deltaY / 100), e.x, e.y);
    gate.net += e.deltaY;
    if (Math.abs(gate.net) < PINCH_DEAD_ZONE) return;
    gate.open = true;
    this.out.zoom(Math.exp(-gate.net / 100), e.x, e.y);
  }

  #closePinchGate(now) {
    const gate = this.pinchGate;
    if (!gate || now - gate.last <= PINCH_GAP_MS) return;
    this.pinchGate = null;
    if (!gate.open && gate.samples >= SLIDE_MIN_SAMPLES) this.out.slideIgnored?.();
  }

  #follow(w, dx, dy, dt) {
    w.x -= dx;
    w.y -= dy;
    w.recent.push({ d: Math.hypot(dx, dy), dt });
    if (w.recent.length > SPEED_WINDOW) w.recent.shift();
    this.out.strokeMove(w.x, w.y);
  }

  #speed(w) {
    const time = w.recent.reduce((sum, s) => sum + s.dt, 0);
    const dist = w.recent.reduce((sum, s) => sum + s.d, 0);
    return time > 0 ? dist / time : 0;
  }

  // Samples after the gap were held back. A steady 60 Hz means inertia; anything
  // else means the finger only paused, so the held samples become ink after all.
  #judgeSuspect(w) {
    const steady = w.buffer.slice(1).every((s) => s.dt >= COAST_MIN_MS && s.dt <= COAST_MAX_MS);
    if (steady) {
      w.mode = 'coast';
      w.buffer = [];
      this.out.strokeEnd();
      return;
    }
    w.mode = 'track';
    for (const s of w.buffer) this.#follow(w, s.dx, s.dy, s.dt);
    w.buffer = [];
  }

  #endWheel() {
    const w = this.wheel;
    if (!w) return;
    this.wheel = null;
    this.jumped = false;
    if (w.mode !== 'coast') this.out.strokeEnd();  // a held-back buffer is dropped as inertia
  }

  // Call regularly. Covers a cursor sitting outside the window, whose restore
  // pointermove the page never sees.
  tick(now) {
    if (this.wheel && now - this.wheel.last > GESTURE_TIMEOUT_MS) this.#endWheel();
    this.#closePinchGate(now);
  }

  // ---- Safari gesture events ---------------------------------------------

  gestureStart() {
    this.gestureActive = true;
    this.gestureScale = 1;
    this.#endWheel();
    if (this.stroke) {
      this.stroke = null;
      this.out.strokeCancel();
    }
  }

  gestureChange(e) {
    if (!this.gestureActive) return;
    const factor = e.scale / this.gestureScale;
    this.gestureScale = e.scale;
    if (factor !== 1 && Number.isFinite(factor)) this.out.zoom(factor, e.x, e.y);
  }

  gestureEnd() {
    this.gestureActive = false;
    this.pan2 = null;
  }

  // ---- real multi-touch, for tablets and any future browser that exposes it

  #touchDown(e) {
    if (!e.overSurface) return;
    this.touches.set(e.pointerId, { x: e.x, y: e.y });
    if (this.touches.size === 1) {
      this.stroke = { id: e.pointerId };
      this.out.strokeStart(e.x, e.y);
    } else if (this.touches.size === 2) {
      if (this.stroke) {
        this.stroke = null;
        this.out.strokeCancel();
      }
      this.pinch = this.#pinchState();
    }
  }

  #touchMove(e) {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.set(e.pointerId, { x: e.x, y: e.y });
    if (this.stroke && this.stroke.id === e.pointerId) {
      this.out.strokeMove(e.x, e.y);
    } else if (this.pinch && this.touches.size >= 2) {
      const next = this.#pinchState();
      this.out.pan(next.x - this.pinch.x, next.y - this.pinch.y);
      if (this.pinch.d > 0) this.out.zoom(next.d / this.pinch.d, next.x, next.y);
      this.pinch = next;
    }
  }

  #touchUp(e, cancelled = false) {
    if (!this.touches.delete(e.pointerId)) return;
    if (this.stroke && this.stroke.id === e.pointerId) {
      this.stroke = null;
      if (cancelled) this.out.strokeCancel();
      else this.out.strokeEnd();
    }
    if (this.touches.size < 2) this.pinch = null;
  }

  #pinchState() {
    const [a, b] = [...this.touches.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }
}

// Feeds real DOM events to an interpreter. Listens on window so a stroke keeps
// going when the finger slides over the toolbar.
export function attachInput(surface, handlers) {
  const interpreter = new InputInterpreter(handlers);
  const overSurface = (e) => e.target === surface;
  const norm = (e) => ({
    t: e.timeStamp, x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons,
    pointerType: e.pointerType, pointerId: e.pointerId, deltaX: e.deltaX, deltaY: e.deltaY,
    deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, scale: e.scale, overSurface: overSurface(e),
  });
  const on = (type, fn, options) => window.addEventListener(type, fn, { capture: true, ...options });

  on('pointerdown', (e) => interpreter.pointerDown(norm(e)));
  on('pointermove', (e) => interpreter.pointerMove(norm(e)));
  on('pointerup', (e) => interpreter.pointerUp(norm(e)));
  on('pointercancel', (e) => interpreter.pointerCancel(norm(e)));
  on('wheel', (e) => {
    interpreter.wheelEvent(norm(e));
    if (e.target.tagName !== 'TEXTAREA') e.preventDefault();  // no page zoom, no swipe-back
  }, { passive: false });
  on('gesturestart', (e) => { e.preventDefault(); interpreter.gestureStart(); }, { passive: false });
  on('gesturechange', (e) => { e.preventDefault(); interpreter.gestureChange(norm(e)); }, { passive: false });
  on('gestureend', (e) => { e.preventDefault(); interpreter.gestureEnd(); }, { passive: false });
  on('contextmenu', (e) => { if (overSurface(e)) e.preventDefault(); });  // press and hold is a right click
  on('dragstart', (e) => e.preventDefault());
  surface.addEventListener('selectstart', (e) => e.preventDefault());

  setInterval(() => interpreter.tick(performance.now()), 150);
  return interpreter;
}
