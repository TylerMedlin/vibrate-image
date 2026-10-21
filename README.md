# vibrate-image

Record a voice message and watch a sticker shake along with your voice, like a little figure is doing the talking. Export the result as a video.

- **Silence = still.** Below a loudness gate the sticker doesn't move at all.
- **Louder = more shake.** Shake distance, wobble and squash scale with how loud you speak.
- **Stickers:** pick an emoji or upload any image (transparent PNGs look best).
- **Export:** saves an MP4 (Chrome, Safari) or WebM (Firefox) with your audio, plus a Share button on phones.
- **Sliders:** *Intensity* controls how wild the shake is; *Sensitivity* controls how quiet a sound still counts as talking. There's also a background color and a green-screen option for editing.

## Run it

It's a static web app with no build step. Serve the folder over HTTPS or localhost (microphone access requires a secure context):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

To put it online, enable GitHub Pages for this repo (Settings → Pages → deploy from `main`, root).

## How it works

- Audio is recorded with `MediaRecorder` and decoded with the Web Audio API.
- Loudness (RMS in dBFS) is measured 60 times a second. A gate set by the Sensitivity slider maps loudness to a 0–1 shake level, smoothed with fast attack and slower release.
- The sticker is drawn on a canvas with jitter, rotation and squash driven by that level. The jitter is deterministic, so the export matches the preview.
- Export plays the clip through a `MediaStreamDestination` and records it together with `canvas.captureStream()`. It runs in real time, so a 10s clip takes about 10s to export.
