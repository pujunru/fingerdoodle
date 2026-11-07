# Fingerdoodle

Doodle with your finger on a touchscreen MacBook, right in the browser.

A touchscreen should make sketching on a web page effortless, and most drawing sites do run on a Mac. But macOS gives web pages no touch events: browsers report `maxTouchPoints: 0`, and in Chrome a quick finger drag arrives only as scrolling. Drawing sites wait for a press that never comes, so the finger does nothing. Fingerdoodle reads what macOS actually sends and turns it back into strokes, so one finger draws and two fingers pinch to zoom, with no install and no account.

## Drawing

Open the page in Chrome or Safari and start drawing. The tray along the bottom holds every tool, and each one is a large tap target.

| Tool | What your finger does |
| --- | --- |
| Pencil | Drag to draw, tap for a dot |
| Rectangle, Circle | Drag from corner to corner |
| Text | Tap a spot and type on the keyboard, then tap away to finish |
| Eraser | Drag across anything to remove it |
| Move | Drag a drawing to a new spot |
| Hand | Drag to pan the canvas |

Two-finger gestures depend on the browser, because each one receives them differently:

| Gesture | Chrome | Safari |
| --- | --- | --- |
| Pinch to zoom | Yes | Yes |
| Two fingers to pan | No, use the Hand tool | Yes |

Your drawing saves itself in the browser. The percentage button fits the drawing to the screen, and the download button saves it as a PNG. Mouse and trackpad work too, and each tool has a keyboard shortcut shown in its tooltip.

## How touch reaches a web page on a Mac

Each browser receives a finger as something else, and `site/js/input.js` turns all of it into one set of drawing actions:

| Gesture | Chrome | Safari |
| --- | --- | --- |
| Tap | Left click, press and release at once | Left click |
| Quick drag | Wheel deltas followed by inertia | Left-button drag |
| Slow or held drag | Right-button drag | Left-button drag |
| Pinch | `ctrlKey` wheel events | `gesturechange` events |
| Two-finger slide | `ctrlKey` wheel noise, no position | `pointercancel`, then a drag at the centroid |

Chrome's quick drag is the hard case, and three measured facts recover it. The reported cursor jumps to the finger just before the first wheel event, which separates a finger from a trackpad. The deltas follow the finger 1:1, so the path can be rebuilt by adding them up. Finger samples arrive at 120 Hz, while inertia starts after a gap of about 33 ms and runs at exactly 60 Hz, so it can be dropped instead of drawn as phantom ink.

These behaviours were measured on macOS 27.2 with Chrome 156 and Safari 27.2, and a later update could change them. To see what your own machine sends, open `probe.html`.

## Developing

The site is plain HTML, CSS and JavaScript with no build step and no dependencies. Serve the `site` folder with any static server:

```bash
python3 -m http.server 4173 --directory site
```

The tests replay real finger gestures from `test/fixtures` through the input code:

```bash
npm test
```

Every push to `main` runs the tests and deploys `site` to GitHub Pages. The bundled typeface is [Shantell Sans](https://github.com/arrowtype/shantell-sans), under the SIL Open Font License.
