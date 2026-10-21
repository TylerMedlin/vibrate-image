(() => {
  'use strict';

  // ---------- Config ----------
  const FPS = 60;               // envelope + animation resolution
  const EXPORT_FPS = 30;        // video frame rate
  const MAX_RECORD_SECONDS = 120;
  const STICKER_SIZE = 0.68;    // fraction of canvas the sticker fills
  const EMOJIS = ['🐸', '🐶', '🐱', '🤖', '👽', '🦆', '🐵', '🥔', '🍄', '👻', '🦖'];

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('stage');
  const ctx2d = canvas.getContext('2d');
  const recordBtn = $('recordBtn');
  const playBtn = $('playBtn');
  const exportBtn = $('exportBtn');
  const statusEl = $('status');
  const meterFill = $('meterFill');
  const stickersEl = $('stickers');
  const fileInput = $('fileInput');
  const pasteBtn = $('pasteBtn');
  const stickerBox = $('stickerBox');
  const intensityEl = $('intensity');
  const sensitivityEl = $('sensitivity');
  const bgColorEl = $('bgColor');
  const transparentBtn = $('transparentBtn');
  const resultEl = $('result');
  const resultVideo = $('resultVideo');
  const downloadLink = $('downloadLink');
  const shareBtn = $('shareBtn');

  // ---------- State ----------
  let audioCtx = null;
  let sticker = null;           // canvas holding the current sticker artwork
  let audioBuffer = null;       // decoded voice recording
  let envelopeDb = null;        // Float32Array, loudness (dBFS) per 1/FPS second
  let mode = 'idle';            // idle | recording | playing | exporting
  let liveLevel = 0;            // smoothed level used while recording
  let rafId = 0;
  let stopCurrent = null;       // function that stops the current activity
  let resultBlob = null;
  let resultUrl = null;

  // ---------- Helpers ----------
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const setStatus = (msg) => { statusEl.textContent = msg; };

  // iPhone: 'playback' makes sound ignore the silent switch and use the loudspeaker
  // (the mic otherwise leaves audio routed to the quiet earpiece).
  function setAudioSession(type) {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (_) { /* unsupported */ }
  }

  // Must be called from a tap so Safari lets the audio start.
  function ensureAudioCtx() {
    if (audioCtx && (audioCtx.state === 'closed' || audioCtx.state === 'interrupted')) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function releaseAudioCtx() {
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  const player = new Audio();      // plays the preview (not muted by the silent switch)
  player.setAttribute('playsinline', '');
  player.preload = 'auto';
  let audioUrl = null;

  // Map loudness (dBFS) to a 0..1 shake level. Anything below the gate is
  // silence and keeps the sticker perfectly still.
  function dbToLevel(db) {
    const sens = parseFloat(sensitivityEl.value);  // 0..1
    const gate = -32 - sens * 26;                  // -32 dB (strict) .. -58 dB (very sensitive)
    const full = gate + 30;                        // 30 dB above the gate = max shake
    return clamp01((db - gate) / (full - gate));
  }

  function rmsDb(samples, start, end) {
    let sum = 0;
    const n = Math.max(1, end - start);
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    return 20 * Math.log10(Math.sqrt(sum / n) + 1e-9);
  }

  // Fast attack, slower release so the shake feels like it follows speech.
  function smoothStep(prev, target) {
    const k = target > prev ? 0.55 : 0.18;
    const v = prev + (target - prev) * k;
    return v < 0.004 ? 0 : v;
  }

  function computeEnvelope(buffer) {
    const len = buffer.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    const hop = buffer.sampleRate / FPS;
    const frames = Math.ceil(len / hop);
    const env = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const start = Math.floor(f * hop);
      env[f] = rmsDb(mono, start, Math.min(len, Math.floor(start + hop)));
    }
    return env;
  }

  // Smoothed level per frame, using current sensitivity setting.
  function smoothedLevels() {
    const out = new Float32Array(envelopeDb.length);
    let v = 0;
    for (let i = 0; i < envelopeDb.length; i++) {
      v = smoothStep(v, dbToLevel(envelopeDb[i]));
      out[i] = v;
    }
    return out;
  }

  // Deterministic pseudo-random in [-1, 1] so exports look like the preview.
  function hashRand(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }

  // ---------- Drawing ----------
  function background() {
    return transparentBtn.classList.contains('on') ? '#00ff00' : bgColorEl.value;
  }

  function draw(level, t) {
    const W = canvas.width, H = canvas.height;
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.fillStyle = background();
    ctx2d.fillRect(0, 0, W, H);
    if (!sticker) return;

    const amp = level * parseFloat(intensityEl.value);
    let dx = 0, dy = 0, rot = 0, sx = 1, sy = 1;
    if (amp > 0) {
      // New random jitter target ~24 times a second, interpolated between.
      const tick = t * 24;
      const k = Math.floor(tick), f = tick - k;
      const mix = (seed) => hashRand(k * 3 + seed) * (1 - f) + hashRand((k + 1) * 3 + seed) * f;
      const px = W * 0.05;
      dx = mix(0) * px * amp;
      dy = mix(1) * px * amp;
      rot = mix(2) * 0.14 * amp;                    // up to ~8° at full level
      const bounce = Math.abs(Math.sin(t * 22)) * amp;
      sy = 1 + 0.10 * bounce;                       // squash & stretch like talking
      sx = 1 - 0.05 * bounce;
    }

    const size = Math.min(W, H) * STICKER_SIZE;
    const scale = size / Math.max(sticker.width, sticker.height);
    const w = sticker.width * scale, h = sticker.height * scale;

    ctx2d.translate(W / 2 + dx, H / 2 + dy + h / 2); // pivot at the sticker's base
    ctx2d.rotate(rot);
    ctx2d.scale(sx, sy);
    ctx2d.drawImage(sticker, -w / 2, -h, w, h);
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  }

  function setMeter(level) {
    meterFill.style.width = `${Math.round(level * 100)}%`;
  }

  function drawIdle() {
    if (mode === 'idle') { draw(0, 0); setMeter(0); }
  }

  // ---------- Stickers ----------
  function emojiCanvas(emoji) {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '420px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.fillText(emoji, 256, 280);
    return c;
  }

  function imageCanvas(img) {
    const max = 1024;
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return trimTransparent(c);
  }

  // Crop away empty transparent edges so cutouts fill the frame.
  function trimTransparent(c) {
    let data;
    try { data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; } catch (_) { return c; }
    let top = c.height, left = c.width, right = -1, bottom = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] > 8) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          bottom = y;
        }
      }
    }
    if (right < 0) return c;                                   // fully transparent
    const w = right - left + 1, h = bottom - top + 1;
    if (w === c.width && h === c.height) return c;             // nothing to trim
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(c, left, top, w, h, 0, 0, w, h);
    return out;
  }

  function selectButton(btn) {
    stickersEl.querySelectorAll('.sticker').forEach((b) => b.classList.toggle('selected', b === btn));
  }

  function addStickerButton(content, artwork, select) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sticker';
    if (typeof content === 'string') btn.textContent = content;
    else btn.appendChild(content);
    btn.addEventListener('click', () => { sticker = artwork; selectButton(btn); drawIdle(); });
    stickersEl.appendChild(btn);
    if (select) btn.click();
    return btn;
  }

  EMOJIS.forEach((e, i) => addStickerButton(e, emojiCanvas(e), i === 0));

  // ---------- Importing your own stickers ----------
  // Adds an image (PNG with transparency, Apple sticker, photo…) as the selected sticker.
  function addCustomSticker(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const art = imageCanvas(img);
        const thumb = new Image();
        thumb.src = art.toDataURL('image/png');
        thumb.alt = 'Your sticker';
        const btn = addStickerButton(thumb, art, false);
        stickersEl.insertBefore(btn, stickersEl.firstChild);
        btn.click();
        setStatus('Sticker added. Tap Record and start talking.');
        resolve(true);
      };
      img.onerror = () => {
        setStatus('Could not read that image. Try a PNG, JPG or HEIC, or copy it and tap Paste.');
        resolve(false);
      };
      img.src = src;
    });
  }

  function addCustomStickerFromBlob(blob) {
    const url = URL.createObjectURL(blob);
    addCustomSticker(url).then(() => URL.revokeObjectURL(url));
  }

  function firstImageFile(dt) {
    if (!dt) return null;
    for (const f of Array.from(dt.files || [])) if (f.type.startsWith('image/') || /\.(hei[cf]|png|webp)$/i.test(f.name)) return f;
    for (const it of Array.from(dt.items || [])) {
      if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) return f; }
    }
    return null;
  }

  function addEmojiSticker(text) {
    const btn = addStickerButton(text, emojiCanvas(text), false);
    stickersEl.insertBefore(btn, stickersEl.firstChild);
    btn.click();
    setStatus('Emoji added. Tap Record and start talking.');
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) addCustomStickerFromBlob(file);
    fileInput.value = '';
  });

  pasteBtn.addEventListener('click', async () => {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      setStatus('Your browser blocks the Paste button. Tap the box below and paste there instead.');
      stickerBox.focus();
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) { addCustomStickerFromBlob(await item.getType(type)); return; }
      }
      setStatus('No picture on the clipboard yet. In Photos, touch and hold the subject, tap Copy, then try again.');
    } catch (err) {
      setStatus('Could not paste. Tap the box below and paste there instead.');
    }
  });

  // Paste anywhere on the page (e.g. Cmd/Ctrl+V on a computer).
  document.addEventListener('paste', (e) => {
    const f = firstImageFile(e.clipboardData);
    if (f) { e.preventDefault(); addCustomStickerFromBlob(f); stickerBox.textContent = ''; }
  });

  // The box accepts stickers from the iPhone emoji keyboard, pasted images, or an emoji.
  stickerBox.addEventListener('beforeinput', (e) => {
    const f = firstImageFile(e.dataTransfer);
    if (f) { e.preventDefault(); addCustomStickerFromBlob(f); }
  });
  stickerBox.addEventListener('input', () => {
    // Let the browser finish inserting before reading what landed in the box.
    setTimeout(async () => {
      const img = stickerBox.querySelector('img');
      if (img && img.src) {
        const src = img.src;
        stickerBox.textContent = '';
        await addCustomSticker(src);
        return;
      }
      const text = stickerBox.textContent.trim();
      if (text && /\p{Extended_Pictographic}/u.test(text)) {
        stickerBox.textContent = '';
        addEmojiSticker(text);
      }
    }, 50);
  });
  stickerBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  stickerBox.addEventListener('blur', () => {
    if (!stickerBox.querySelector('img') && !/\p{Extended_Pictographic}/u.test(stickerBox.textContent)) stickerBox.textContent = '';
  });

  // Drag and drop an image onto the box or the preview.
  [stickerBox, canvas].forEach((el) => {
    el.addEventListener('dragover', (e) => { e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      const f = firstImageFile(e.dataTransfer);
      if (f) { e.preventDefault(); addCustomStickerFromBlob(f); }
    });
  });

  [intensityEl, sensitivityEl, bgColorEl].forEach((el) => el.addEventListener('input', () => {
    if (el === bgColorEl) transparentBtn.classList.remove('on');
    syncStageBg();
    drawIdle();
  }));
  transparentBtn.addEventListener('click', () => {
    transparentBtn.classList.toggle('on');
    transparentBtn.textContent = transparentBtn.classList.contains('on') ? 'Green screen ✓' : 'Green screen';
    syncStageBg();
    drawIdle();
  });
  function syncStageBg() { canvas.style.background = background(); }

  // ---------- Mode handling ----------
  function setMode(m) {
    mode = m;
    recordBtn.classList.toggle('recording', m === 'recording');
    recordBtn.textContent = m === 'recording' ? '■ Stop' : '● Record';
    recordBtn.disabled = m === 'playing' || m === 'exporting';
    playBtn.textContent = m === 'playing' ? '■ Stop' : '▶ Play';
    playBtn.disabled = !audioBuffer || m === 'recording' || m === 'exporting';
    exportBtn.textContent = m === 'exporting' ? '■ Cancel' : '⬇ Export';
    exportBtn.disabled = !audioBuffer || m === 'recording' || m === 'playing';
    if (m === 'idle') drawIdle();
  }

  // ---------- Recording ----------
  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setStatus('This browser cannot record audio. Try Chrome or Safari.');
      return;
    }
    releaseAudioCtx();
    const ac = ensureAudioCtx();
    setAudioSession('play-and-record');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
    } catch (err) {
      setAudioSession('playback');
      setStatus('Microphone access was blocked. Allow it in your browser settings and try again.');
      return;
    }

    const src = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const chunks = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const started = performance.now();
    liveLevel = 0;
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      const db = rmsDb(buf, 0, buf.length);
      liveLevel = smoothStep(liveLevel, dbToLevel(db));
      const t = (performance.now() - started) / 1000;
      draw(liveLevel, t);
      setMeter(liveLevel);
      setStatus(`Recording… ${t.toFixed(1)}s`);
      if (t >= MAX_RECORD_SECONDS) { stopCurrent(); return; }
      rafId = requestAnimationFrame(loop);
    };

    rec.onstop = async () => {
      cancelAnimationFrame(rafId);
      stream.getTracks().forEach((tr) => tr.stop());
      src.disconnect();
      setAudioSession('playback');
      setStatus('Processing…');
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const arr = await blob.arrayBuffer();
        audioBuffer = await decode(ac, arr);
        envelopeDb = computeEnvelope(audioBuffer);
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        audioUrl = URL.createObjectURL(blob);
        player.src = audioUrl;
        player.load();
        setStatus(`Got ${audioBuffer.duration.toFixed(1)}s of audio. Tap Play to preview or Export to save a video.`);
      } catch (err) {
        console.error(err);
        setStatus('Could not read the recording. Please try again.');
      }
      // Drop the mic's audio engine; Play/Export start a fresh one from a tap.
      releaseAudioCtx();
      setMode('idle');
    };

    stopCurrent = () => { if (rec.state !== 'inactive') rec.stop(); };
    rec.start(250);
    setMode('recording');
    rafId = requestAnimationFrame(loop);
  }

  function decode(ac, arr) {
    // Older Safari only supports the callback form.
    return new Promise((resolve, reject) => {
      const p = ac.decodeAudioData(arr, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // ---------- Playback (shared by preview and export) ----------
  // Plays the recording and animates the sticker from the precomputed envelope.
  function playAnimated(outputNode, onEnd, onProgress) {
    const ac = ensureAudioCtx();
    const levels = smoothedLevels();
    const source = ac.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(outputNode);
    // Also play out loud: you hear the export, and Safari only runs audio
    // graphs that reach the speakers.
    if (outputNode !== ac.destination) source.connect(ac.destination);
    const startAt = ac.currentTime + 0.05;
    let stopped = false;

    const loop = () => {
      if (stopped) return;
      const t = Math.max(0, ac.currentTime - startAt);
      const level = levelAt(levels, t);
      draw(level, t);
      setMeter(level);
      if (onProgress) onProgress(t);
      rafId = requestAnimationFrame(loop);
    };

    source.onended = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(rafId);
      draw(0, 0);
      setMeter(0);
      onEnd(false);
    };

    source.start(startAt);
    rafId = requestAnimationFrame(loop);

    return () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(rafId);
      try { source.stop(); } catch (_) { /* already stopped */ }
      onEnd(true);
    };
  }

  function levelAt(levels, t) {
    return levels[Math.min(levels.length - 1, Math.floor(t * FPS))] || 0;
  }

  // Preview uses a plain audio player so the iPhone silent switch doesn't mute it.
  function startPlayback() {
    setAudioSession('playback');
    const levels = smoothedLevels();
    let stopped = false;
    const finish = (msg) => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(rafId);
      player.onended = null;
      player.pause();
      setStatus(msg);
      setMode('idle');
    };
    const loop = () => {
      if (stopped) return;
      const t = player.currentTime;
      const level = levelAt(levels, t);
      draw(level, t);
      setMeter(level);
      rafId = requestAnimationFrame(loop);
    };
    player.onended = () => finish('Done. Tap Export to save it as a video.');
    stopCurrent = () => finish('Stopped.');
    setMode('playing');
    setStatus('Playing…');
    try { player.currentTime = 0; } catch (_) { /* not loaded yet */ }
    player.play().then(() => {
      rafId = requestAnimationFrame(loop);
    }).catch((err) => {
      console.error(err);
      finish('Could not play the audio. Check your volume and try again.');
    });
  }

  // ---------- Export ----------
  function pickVideoMime() {
    const options = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return options.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  }

  async function startExport() {
    if (!canvas.captureStream || !window.MediaRecorder) {
      setStatus('Video export is not supported in this browser. Try Chrome or Safari.');
      return;
    }
    setAudioSession('playback');
    const ac = ensureAudioCtx();   // created/resumed synchronously inside the tap
    stopCurrent = () => {};
    setMode('exporting');
    setStatus('Preparing export…');
    try { await ac.resume(); } catch (_) { /* checked below */ }
    if (ac.state !== 'running') {
      setMode('idle');
      setStatus('Audio could not start. Tap Export again.');
      return;
    }
    const dest = ac.createMediaStreamDestination();
    const videoStream = canvas.captureStream(EXPORT_FPS);
    const stream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = pickVideoMime();
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
    } catch (err) {
      rec = new MediaRecorder(stream);
    }
    const chunks = [];
    let cancelled = false;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      videoStream.getTracks().forEach((t) => t.stop());
      setMode('idle');
      if (cancelled) { setStatus('Export cancelled.'); return; }
      const type = rec.mimeType || mime || 'video/webm';
      showResult(new Blob(chunks, { type }), type);
    };

    // Draw a still first frame so the video doesn't start blank.
    draw(0, 0);
    rec.start(500);
    const total = audioBuffer.duration;
    const stopPlay = playAnimated(dest, (wasCancelled) => {
      cancelled = wasCancelled;
      // Hold the still frame briefly so the ending isn't clipped.
      setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, wasCancelled ? 0 : 300);
    }, (t) => {
      setStatus(`Exporting video… ${Math.min(100, Math.round((t / total) * 100))}% (keep this tab open)`);
    });
    stopCurrent = stopPlay;
  }

  function showResult(blob, type) {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultBlob = blob;
    resultUrl = URL.createObjectURL(blob);
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const name = `vibrate-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
    resultVideo.src = resultUrl;
    downloadLink.href = resultUrl;
    downloadLink.download = name;
    resultEl.hidden = false;
    const file = new File([blob], name, { type: type.split(';')[0] });
    shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    shareBtn.onclick = () => navigator.share({ files: [file], title: 'Vibrate Image' }).catch(() => {});
    setStatus(`Video ready (${(blob.size / 1024 / 1024).toFixed(1)} MB, ${ext.toUpperCase()}).`);
    // Safari can report the tracks; warn if the sound didn't make it in.
    resultVideo.onloadedmetadata = () => {
      if (resultVideo.audioTracks && resultVideo.audioTracks.length === 0) {
        setStatus('The video was saved without sound. Turn off silent mode, raise the volume and tap Export again.');
      }
    };
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- Buttons ----------
  recordBtn.addEventListener('click', () => {
    if (mode === 'recording') stopCurrent();
    else if (mode === 'idle') startRecording();
  });
  playBtn.addEventListener('click', () => {
    if (mode === 'playing') stopCurrent();
    else if (mode === 'idle' && audioBuffer) startPlayback();
  });
  exportBtn.addEventListener('click', () => {
    if (mode === 'exporting') stopCurrent();
    else if (mode === 'idle' && audioBuffer) startExport();
  });

  // Exposed for automated tests only.
  window.__vibrate = { getMode: () => mode, hasAudio: () => !!audioBuffer, getResult: () => resultBlob };

  syncStageBg();
  setMode('idle');
})();
