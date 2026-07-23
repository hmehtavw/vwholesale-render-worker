const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.WORKER_SECRET || 'vw-render-secret';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Auth middleware
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.headers['x-worker-secret'];
  if (auth !== WORKER_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, build: 'VW-RAILWAY-V1' }));

// Download file from URL to temp path
async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed: ' + res.status + ' ' + url.slice(0, 80));
  const buf = await res.buffer();
  fs.writeFileSync(destPath, buf);
  return destPath;
}

// Upload file to Supabase Storage
async function uploadToSupabase(filePath, storagePath) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const fileBuffer = fs.readFileSync(filePath);
  const mimeType = filePath.endsWith('.mp4') ? 'video/mp4' : filePath.endsWith('.gif') ? 'image/gif' : 'image/png';
  const { error } = await sb.storage.from('calendar-images').upload(storagePath, fileBuffer, {
    contentType: mimeType, upsert: true
  });
  if (error) throw new Error('Supabase upload failed: ' + error.message);
  const { data } = sb.storage.from('calendar-images').getPublicUrl(storagePath);
  return data.publicUrl;
}

// Cleanup temp files
function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
}

// ── RENDER: Poster Slideshow (3 images → crossfade MP4) ──
async function renderSlideshow({ calendarId, imageUrls, formatKey, musicUrl, duration = 3 }) {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const imgPaths = [];
  const outputMp4 = path.join(tmpDir, `vw_${calendarId}_${formatKey}_${ts}.mp4`);
  const outputGif = path.join(tmpDir, `vw_${calendarId}_${formatKey}_${ts}.gif`);
  let musicPath = null;

  try {
    // Download images
    for (let i = 0; i < imageUrls.length; i++) {
      const imgPath = path.join(tmpDir, `vw_slide_${ts}_${i}.png`);
      await downloadFile(imageUrls[i], imgPath);
      imgPaths.push(imgPath);
    }

    // Download music if provided
    if (musicUrl) {
      musicPath = path.join(tmpDir, `vw_music_${ts}.mp3`);
      await downloadFile(musicUrl, musicPath);
    }

    // Determine dimensions based on format
    const dims = {
      square:    { w: 1080, h: 1080 },
      story:     { w: 1080, h: 1920 },
      landscape: { w: 1920, h: 1080 },
    };
    const { w, h } = dims[formatKey] || dims.square;

    // Build FFmpeg filter for crossfade slideshow
    // Each image holds for `duration` seconds with 0.5s crossfade
    const fadeTime = 0.5;
    const holdTime = duration;
    const totalDuration = imageUrls.length * holdTime;

    // Build complex filtergraph
    let filterParts = [];
    let inputs = [];

    // Scale each image to target size
    for (let i = 0; i < imgPaths.length; i++) {
      filterParts.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,settb=1/25[v${i}]`);
    }

    // Crossfade between images
    if (imgPaths.length === 1) {
      filterParts.push(`[v0]loop=${holdTime * 25}:1:0[vout]`);
    } else {
      // Chain xfades
      let lastOutput = 'v0';
      for (let i = 1; i < imgPaths.length; i++) {
        const offset = i * holdTime - fadeTime;
        const outName = i === imgPaths.length - 1 ? 'vout' : `xf${i}`;
        filterParts.push(`[${lastOutput}][v${i}]xfade=transition=fade:duration=${fadeTime}:offset=${offset}[${outName}]`);
        lastOutput = outName;
      }
    }

    // Build FFmpeg command
    return new Promise((resolve, reject) => {
      let cmd = ffmpeg();

      // Add image inputs (each loops for hold duration)
      imgPaths.forEach(imgPath => {
        cmd = cmd.input(imgPath).inputOptions(['-loop 1', `-t ${holdTime + fadeTime}`]);
      });

      // Add music if available
      if (musicPath) cmd = cmd.input(musicPath);

      const filterStr = filterParts.join(';');

      cmd
        .complexFilter(filterStr, 'vout')
        .outputOptions([
          '-map [vout]',
          musicPath ? `-map ${imgPaths.length}:a` : '',
          '-c:v libx264',
          '-preset fast',
          '-crf 23',
          '-pix_fmt yuv420p',
          musicPath ? '-c:a aac -b:a 128k -shortest' : '',
          '-movflags +faststart',
          `-t ${totalDuration}`,
        ].filter(Boolean))
        .output(outputMp4)
        .on('start', cmd => console.log('[ffmpeg] start:', cmd.slice(0, 100)))
        .on('progress', p => console.log('[ffmpeg] progress:', Math.round(p.percent || 0) + '%'))
        .on('error', err => reject(new Error('FFmpeg error: ' + err.message)))
        .on('end', () => resolve(outputMp4))
        .run();
    });

  } catch(e) {
    cleanup(...imgPaths, outputMp4, outputGif, musicPath);
    throw e;
  }
}

// ── RENDER: Animated Poster (1 poster + Ken Burns zoom + text overlay) ──
async function renderAnimatedPoster({ calendarId, imageUrl, formatKey, musicUrl, headline, duration = 8 }) {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const imgPath = path.join(tmpDir, `vw_poster_${ts}.png`);
  const outputMp4 = path.join(tmpDir, `vw_anim_${calendarId}_${formatKey}_${ts}.mp4`);
  let musicPath = null;

  try {
    await downloadFile(imageUrl, imgPath);
    if (musicUrl) {
      musicPath = path.join(tmpDir, `vw_music_${ts}.mp3`);
      await downloadFile(musicUrl, musicPath);
    }

    const dims = { square: [1080,1080], story: [1080,1920], landscape: [1920,1080] };
    const [w, h] = dims[formatKey] || dims.square;
    const fps = 25;
    const totalFrames = duration * fps;

    // Ken Burns: zoom from 100% to 108% over duration
    const zoomFilter = `scale=${w*2}:${h*2},` +
      `zoompan=z='min(zoom+0.0002,1.08)':` +
      `x='iw/2-(iw/zoom/2)':` +
      `y='ih/2-(ih/zoom/2)':` +
      `d=${totalFrames}:s=${w}x${h}:fps=${fps}`;

    // Fade in at start, fade out at end
    const fadeFilter = `fade=t=in:st=0:d=0.5,fade=t=out:st=${duration-0.5}:d=0.5`;

    return new Promise((resolve, reject) => {
      let cmd = ffmpeg()
        .input(imgPath)
        .inputOptions(['-loop 1', `-t ${duration}`]);

      if (musicPath) cmd = cmd.input(musicPath);

      cmd
        .complexFilter(`[0:v]${zoomFilter},${fadeFilter}[vout]`, 'vout')
        .outputOptions([
          '-map [vout]',
          musicPath ? `-map 1:a` : '',
          '-c:v libx264',
          '-preset fast',
          '-crf 22',
          '-pix_fmt yuv420p',
          musicPath ? '-c:a aac -b:a 128k -shortest' : '',
          '-movflags +faststart',
          `-t ${duration}`,
        ].filter(Boolean))
        .output(outputMp4)
        .on('error', err => reject(new Error('FFmpeg error: ' + err.message)))
        .on('end', () => resolve(outputMp4))
        .run();
    });

  } catch(e) {
    cleanup(imgPath, outputMp4, musicPath);
    throw e;
  }
}

// ── MAIN RENDER ENDPOINT ──
app.post('/render', async (req, res) => {
  const { action, calendar_id, format_key, image_urls, image_url, music_url, headline, duration } = req.body;

  if (!calendar_id || !format_key) {
    return res.status(400).json({ ok: false, error: 'calendar_id and format_key required' });
  }

  const ts = Date.now();
  let outputPath = null;

  try {
    console.log('[render] action:', action, 'calendar_id:', calendar_id, 'format:', format_key);

    if (action === 'slideshow') {
      if (!image_urls?.length) return res.status(400).json({ ok: false, error: 'image_urls required' });
      outputPath = await renderSlideshow({
        calendarId: calendar_id, imageUrls: image_urls,
        formatKey: format_key, musicUrl: music_url, duration: duration || 3
      });
    } else if (action === 'animated_poster') {
      if (!image_url) return res.status(400).json({ ok: false, error: 'image_url required' });
      outputPath = await renderAnimatedPoster({
        calendarId: calendar_id, imageUrl: image_url,
        formatKey: format_key, musicUrl: music_url,
        headline: headline, duration: duration || 8
      });
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
    }

    // Upload to Supabase
    const storagePath = `rendered/${calendar_id}_${action}_${format_key}_${ts}.mp4`;
    console.log('[render] uploading to Supabase:', storagePath);
    const publicUrl = await uploadToSupabase(outputPath, storagePath);

    cleanup(outputPath);
    console.log('[render] done:', publicUrl.slice(-50));
    res.json({ ok: true, mp4_url: publicUrl, format_key, action });

  } catch(e) {
    if (outputPath) cleanup(outputPath);
    console.error('[render] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log('[vw-render] listening on port', PORT));
