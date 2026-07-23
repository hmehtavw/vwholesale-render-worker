const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.WORKER_SECRET || 'vw-render-secret';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/status')) return next();
  if (req.headers['x-worker-secret'] !== WORKER_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, build: 'VW-RAILWAY-V3' }));

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed: ' + res.status);
  fs.writeFileSync(dest, await res.buffer());
  return dest;
}

async function uploadToSupabase(filePath, storagePath) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const buf = fs.readFileSync(filePath);
  const mime = filePath.endsWith('.mp4') ? 'video/mp4' : 'image/gif';
  const { error } = await sb.storage.from('calendar-images').upload(storagePath, buf, { contentType: mime, upsert: true });
  if (error) throw new Error('Upload failed: ' + error.message);
  return sb.storage.from('calendar-images').getPublicUrl(storagePath).data.publicUrl;
}

async function saveToCalendar(calendarId, formatKey, mp4Url, action) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: item } = await sb.from('content_calendar').select('platform_images').eq('id', calendarId).single();
  const pi = item?.platform_images || {};
  if (action === 'slideshow') {
    if (formatKey === 'square')    { pi.instagram_feed_mp4 = mp4Url; pi.threads_mp4 = mp4Url; pi.mp4_music = mp4Url; }
    if (formatKey === 'story')     { pi.instagram_story_mp4 = mp4Url; pi.facebook_story_mp4 = mp4Url; }
    if (formatKey === 'landscape') { pi.facebook_post_mp4 = mp4Url; pi.youtube_mp4 = mp4Url; }
  } else if (action === 'animated_poster') {
    if (formatKey === 'square')    { pi.instagram_feed_mp4 = mp4Url; pi.mp4_music = mp4Url; }
    if (formatKey === 'story')     { pi.instagram_story_mp4 = mp4Url; }
    if (formatKey === 'landscape') { pi.facebook_post_mp4 = mp4Url; pi.youtube_mp4 = mp4Url; }
  }
  await sb.from('content_calendar').update({ platform_images: pi, updated_at: new Date().toISOString() }).eq('id', calendarId);
  console.log('[railway] saved', formatKey, 'mp4 to DB:', mp4Url.slice(-40));
}

function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
}

async function renderSlideshow({ calendarId, imageUrls, formatKey, musicUrl, action, duration = 3 }) {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const imgPaths = [];
  const outputMp4 = path.join(tmpDir, `vw_${calendarId}_${formatKey}_${ts}.mp4`);
  let musicPath = null;

  try {
    console.log('[railway] downloading', imageUrls.length, 'images for', formatKey);
    for (let i = 0; i < imageUrls.length; i++) {
      const p = path.join(tmpDir, `img_${ts}_${i}.png`);
      await downloadFile(imageUrls[i], p);
      imgPaths.push(p);
    }
    if (musicUrl) {
      musicPath = path.join(tmpDir, `music_${ts}.mp3`);
      await downloadFile(musicUrl, musicPath);
    }

    const dims = { square:[1080,1080], story:[1080,1920], landscape:[1920,1080] };
    const [w, h] = dims[formatKey] || [1080,1080];
    const holdTime = duration;
    const fadeTime = 0.5;
    const n = imgPaths.length;

    // Build FFmpeg args directly (more reliable than fluent-ffmpeg complexFilter)
    const ffmpegArgs = [];

    // Add inputs
    imgPaths.forEach(p => {
      ffmpegArgs.push('-loop', '1', '-t', String(holdTime + fadeTime), '-i', p);
    });
    if (musicPath) ffmpegArgs.push('-i', musicPath);

    // Build filter complex
    // Step 1: scale each input
    const filterParts = [];
    for (let i = 0; i < n; i++) {
      filterParts.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[s${i}]`);
    }

    // Step 2: chain xfades
    if (n === 1) {
      filterParts.push(`[s0]loop=${holdTime*25}:1:0[vout]`);
    } else {
      let prev = 's0';
      for (let i = 1; i < n; i++) {
        const offset = i * holdTime - fadeTime;
        const outLabel = i === n - 1 ? 'vout' : `x${i}`;
        filterParts.push(`[${prev}][s${i}]xfade=transition=fade:duration=${fadeTime}:offset=${offset}[${outLabel}]`);
        prev = outLabel;
      }
    }

    ffmpegArgs.push('-filter_complex', filterParts.join(';'));
    ffmpegArgs.push('-map', '[vout]');
    if (musicPath) { ffmpegArgs.push('-map', `${n}:a`); ffmpegArgs.push('-c:a', 'aac', '-b:a', '96k', '-shortest'); }
    ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    ffmpegArgs.push('-t', String(n * holdTime));
    ffmpegArgs.push(outputMp4);

    console.log('[railway] ffmpeg filter:', filterParts.join(';').slice(0, 200));

    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const proc = spawn('ffmpeg', ['-y', ...ffmpegArgs]);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg exited with code ' + code + ': ' + stderr.slice(-300)));
      });
    });

    const storagePath = `rendered/${calendarId}_${action}_${formatKey}_${ts}.mp4`;
    const mp4Url = await uploadToSupabase(outputMp4, storagePath);
    await saveToCalendar(calendarId, formatKey, mp4Url, action);
    cleanup(...imgPaths, outputMp4, musicPath);
    return mp4Url;
  } catch(e) {
    cleanup(...imgPaths, outputMp4, musicPath);
    throw e;
  }
}

async function renderAnimatedPoster({ calendarId, imageUrl, formatKey, musicUrl, duration = 8 }) {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const imgPath = path.join(tmpDir, `poster_${ts}.png`);
  const outputMp4 = path.join(tmpDir, `anim_${calendarId}_${formatKey}_${ts}.mp4`);
  let musicPath = null;

  try {
    await downloadFile(imageUrl, imgPath);
    if (musicUrl) { musicPath = path.join(tmpDir, `music_${ts}.mp3`); await downloadFile(musicUrl, musicPath); }

    const dims = { square:[1080,1080], story:[1080,1920], landscape:[1920,1080] };
    const [w, h] = dims[formatKey] || [1080,1080];
    const fps = 25, frames = duration * fps;

    const ffmpegArgs = ['-y', '-loop', '1', '-t', String(duration + 1), '-i', imgPath];
    if (musicPath) ffmpegArgs.push('-i', musicPath);

    const zoomFilter = `[0:v]scale=${w*2}:${h*2},zoompan=z='min(zoom+0.0002,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps},fade=t=in:st=0:d=0.5,fade=t=out:st=${duration-0.5}:d=0.5[vout]`;

    ffmpegArgs.push('-filter_complex', zoomFilter, '-map', '[vout]');
    if (musicPath) { ffmpegArgs.push('-map', '1:a', '-c:a', 'aac', '-b:a', '96k', '-shortest'); }
    ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', String(duration), outputMp4);

    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const proc = spawn('ffmpeg', ffmpegArgs);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => { code === 0 ? resolve() : reject(new Error('ffmpeg code ' + code + ': ' + stderr.slice(-200))); });
    });

    const storagePath = `rendered/${calendarId}_animated_${formatKey}_${ts}.mp4`;
    const mp4Url = await uploadToSupabase(outputMp4, storagePath);
    await saveToCalendar(calendarId, formatKey, mp4Url, 'animated_poster');
    cleanup(imgPath, outputMp4, musicPath);
    return mp4Url;
  } catch(e) { cleanup(imgPath, outputMp4, musicPath); throw e; }
}

// Fire-and-forget
app.post('/render', (req, res) => {
  const { action, calendar_id, format_key, image_urls, image_url, music_url, duration } = req.body;
  if (!calendar_id || !format_key) return res.status(400).json({ ok: false, error: 'calendar_id and format_key required' });
  res.json({ ok: true, status: 'queued' });

  const fn = action === 'animated_poster'
    ? renderAnimatedPoster({ calendarId: calendar_id, imageUrl: image_url, formatKey: format_key, musicUrl: music_url, duration })
    : renderSlideshow({ calendarId: calendar_id, imageUrls: image_urls, formatKey: format_key, musicUrl: music_url, action: action || 'slideshow', duration });

  fn.then(url => console.log('[railway] done', format_key, url?.slice(-30)))
    .catch(e => console.error('[railway] failed', format_key, e.message));
});

app.get('/status/:calendarId/:formatKey', async (req, res) => {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await sb.from('content_calendar').select('platform_images').eq('id', req.params.calendarId).single();
    const pi = data?.platform_images || {};
    const keys = { square: 'instagram_feed_mp4', story: 'instagram_story_mp4', landscape: 'facebook_post_mp4' };
    const mp4Key = keys[req.params.formatKey] || 'mp4_music';
    res.json({ ok: true, ready: !!pi[mp4Key], mp4_url: pi[mp4Key] || null });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log('[vw-render] listening on port', PORT));
