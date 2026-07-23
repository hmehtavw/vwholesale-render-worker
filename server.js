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
  if (req.path === '/health' || req.path === '/status') return next();
  if (req.headers['x-worker-secret'] !== WORKER_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, build: 'VW-RAILWAY-V2-ASYNC' }));

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
    if (formatKey === 'landscape') { pi.facebook_post_mp4 = mp4Url; pi.youtube_mp4 = mp4Url; pi.gbp_mp4 = mp4Url; }
  } else if (action === 'animated_poster') {
    if (formatKey === 'square')    { pi.instagram_feed_mp4 = mp4Url; pi.mp4_music = mp4Url; }
    if (formatKey === 'story')     { pi.instagram_story_mp4 = mp4Url; }
    if (formatKey === 'landscape') { pi.facebook_post_mp4 = mp4Url; pi.youtube_mp4 = mp4Url; }
  }
  await sb.from('content_calendar').update({ platform_images: pi, updated_at: new Date().toISOString() }).eq('id', calendarId);
  console.log('[railway] saved', formatKey, 'mp4 to DB');
}

function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
}

async function renderSlideshow({ calendarId, imageUrls, formatKey, musicUrl, action }) {
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
    const holdTime = 3, fadeTime = 0.5;

    let filterParts = [];
    for (let i = 0; i < imgPaths.length; i++) {
      filterParts.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[v${i}]`);
    }
    if (imgPaths.length === 1) {
      filterParts.push(`[v0]loop=${holdTime*25}:1:0[vout]`);
    } else {
      let last = 'v0';
      for (let i = 1; i < imgPaths.length; i++) {
        const offset = i * holdTime - fadeTime;
        const out = i === imgPaths.length - 1 ? 'vout' : `xf${i}`;
        filterParts.push(`[${last}][v${i}]xfade=transition=fade:duration=${fadeTime}:offset=${offset}[${out}]`);
        last = out;
      }
    }

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg();
      imgPaths.forEach(p => cmd = cmd.input(p).inputOptions(['-loop 1', `-t ${holdTime + fadeTime}`]));
      if (musicPath) cmd = cmd.input(musicPath);
      cmd
        .complexFilter(filterParts.join(';'), 'vout')
        .outputOptions([
          '-map [vout]',
          musicPath ? `-map ${imgPaths.length}:a` : null,
          '-c:v libx264', '-preset ultrafast', '-crf 26', '-pix_fmt yuv420p',
          musicPath ? '-c:a aac -b:a 96k -shortest' : null,
          '-movflags +faststart',
          `-t ${imgPaths.length * holdTime}`
        ].filter(Boolean))
        .output(outputMp4)
        .on('error', reject)
        .on('end', resolve)
        .run();
    });

    const storagePath = `rendered/${calendarId}_${action}_${formatKey}_${ts}.mp4`;
    const mp4Url = await uploadToSupabase(outputMp4, storagePath);
    await saveToCalendar(calendarId, formatKey, mp4Url, action);
    cleanup(...imgPaths, outputMp4, musicPath);
    console.log('[railway] done', formatKey, mp4Url.slice(-40));
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

    const zoomFilter = `scale=${w*2}:${h*2},zoompan=z='min(zoom+0.0002,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps}`;
    const fadeFilter = `fade=t=in:st=0:d=0.5,fade=t=out:st=${duration-0.5}:d=0.5`;

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg().input(imgPath).inputOptions(['-loop 1', `-t ${duration}`]);
      if (musicPath) cmd = cmd.input(musicPath);
      cmd
        .complexFilter(`[0:v]${zoomFilter},${fadeFilter}[vout]`, 'vout')
        .outputOptions(['-map [vout]', musicPath?`-map 1:a`:null, '-c:v libx264','-preset ultrafast','-crf 24','-pix_fmt yuv420p',musicPath?'-c:a aac -b:a 96k -shortest':null,'-movflags +faststart',`-t ${duration}`].filter(Boolean))
        .output(outputMp4).on('error', reject).on('end', resolve).run();
    });

    const storagePath = `rendered/${calendarId}_animated_${formatKey}_${ts}.mp4`;
    const mp4Url = await uploadToSupabase(outputMp4, storagePath);
    await saveToCalendar(calendarId, formatKey, mp4Url, 'animated_poster');
    cleanup(imgPath, outputMp4, musicPath);
    return mp4Url;
  } catch(e) { cleanup(imgPath, outputMp4, musicPath); throw e; }
}

// FIRE-AND-FORGET endpoint — responds immediately, renders in background
app.post('/render', (req, res) => {
  const { action, calendar_id, format_key, image_urls, image_url, music_url, duration } = req.body;
  if (!calendar_id || !format_key) return res.status(400).json({ ok: false, error: 'calendar_id and format_key required' });

  // Respond immediately
  res.json({ ok: true, status: 'queued', message: 'Rendering in background — check platform_images in DB when ready' });

  // Render in background
  const renderFn = action === 'animated_poster'
    ? renderAnimatedPoster({ calendarId: calendar_id, imageUrl: image_url, formatKey: format_key, musicUrl: music_url, duration })
    : renderSlideshow({ calendarId: calendar_id, imageUrls: image_urls, formatKey: format_key, musicUrl: music_url, action });

  renderFn
    .then(url => console.log('[railway] background render complete:', format_key, url?.slice(-30)))
    .catch(e => console.error('[railway] background render failed:', format_key, e.message));
});

// STATUS endpoint — check if MP4 is ready
app.get('/status/:calendarId/:formatKey', async (req, res) => {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await sb.from('content_calendar').select('platform_images').eq('id', req.params.calendarId).single();
    const pi = data?.platform_images || {};
    const mp4Key = req.params.formatKey === 'square' ? 'instagram_feed_mp4' : req.params.formatKey === 'story' ? 'instagram_story_mp4' : 'facebook_post_mp4';
    const ready = !!pi[mp4Key];
    res.json({ ok: true, ready, mp4_url: pi[mp4Key] || null });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log('[vw-render] listening on port', PORT));
