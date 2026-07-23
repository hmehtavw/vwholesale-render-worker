const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'content-type, x-worker-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.path === '/health' || req.path.startsWith('/status')) return next();
  if (req.headers['x-worker-secret'] !== (process.env.WORKER_SECRET || 'vw-render-secret')) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Queue to prevent concurrent renders (memory limit)
let isRendering = false;
const renderQueue = [];

app.get('/health', (req, res) => res.json({ ok: true, build: 'VW-RAILWAY-V5', queued: renderQueue.length, rendering: isRendering }));

async function dl(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('DL failed: ' + res.status);
  fs.writeFileSync(dest, await res.buffer());
}

async function uploadSB(filePath, storagePath) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { realtime: { transport: WebSocket } });
  const buf = fs.readFileSync(filePath);
  const { error } = await sb.storage.from('calendar-images').upload(storagePath, buf, { contentType: 'video/mp4', upsert: true });
  if (error) throw new Error('Upload failed: ' + error.message);
  return sb.storage.from('calendar-images').getPublicUrl(storagePath).data.publicUrl;
}

async function saveToDB(calendarId, formatKey, mp4Url) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { realtime: { transport: WebSocket } });
  const { data } = await sb.from('content_calendar').select('platform_images').eq('id', calendarId).single();
  const pi = data?.platform_images || {};
  if (formatKey === 'square')    { pi.instagram_feed_mp4 = mp4Url; pi.threads_mp4 = mp4Url; pi.mp4_music = mp4Url; }
  if (formatKey === 'story')     { pi.instagram_story_mp4 = mp4Url; pi.facebook_story_mp4 = mp4Url; pi.whatsapp_story_mp4 = mp4Url; }
  if (formatKey === 'landscape') { pi.facebook_post_mp4 = mp4Url; pi.youtube_mp4 = mp4Url; }
  await sb.from('content_calendar').update({ platform_images: pi, updated_at: new Date().toISOString() }).eq('id', calendarId);
  console.log('[v5] saved', formatKey, 'to DB');
}

function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); process.stdout.write('.'); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-300)));
    });
    proc.on('error', e => reject(new Error('spawn error: ' + e.message)));
  });
}

async function renderOne(job) {
  const { calendarId, imageUrls, formatKey, duration = 3 } = job;
  const tmp = os.tmpdir(), ts = Date.now();
  const imgPaths = [];
  const out = path.join(tmp, `vw_${calendarId}_${formatKey}_${ts}.mp4`);

  try {
    console.log('[v5] rendering', formatKey, 'for', calendarId);

    // Download images sequentially (saves memory)
    for (let i = 0; i < imageUrls.length; i++) {
      const p = path.join(tmp, `img_${ts}_${i}.png`);
      await dl(imageUrls[i], p);
      imgPaths.push(p);
      console.log('[v5] downloaded img', i + 1);
    }

    const dims = { square: [1080, 1080], story: [1080, 1920], landscape: [1920, 1080] };
    const [W, H] = dims[formatKey] || [1080, 1080];
    const n = imgPaths.length;
    const fade = 0.5, hold = duration;

    // Build simple concat approach - more reliable than xfade
    const args = [];

    if (n === 1) {
      // Single image: Ken Burns zoom
      args.push('-loop', '1', '-t', String(hold), '-i', imgPaths[0]);
      args.push('-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=25`);
    } else {
      // Multiple images: use concat with crossfade
      // Create individual clips first, then concat
      const clipPaths = [];
      for (let i = 0; i < n; i++) {
        const clipOut = path.join(tmp, `clip_${ts}_${i}.mp4`);
        await runFFmpeg([
          '-loop', '1', '-t', String(hold), '-i', imgPaths[i],
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=25`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', clipOut
        ]);
        clipPaths.push(clipOut);
        console.log('[v5] clip', i + 1, 'done');
      }

      // Concat all clips
      const concatFile = path.join(tmp, `concat_${ts}.txt`);
      fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));
      args.push('-f', 'concat', '-safe', '0', '-i', concatFile);
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
      args.push(out);
      await runFFmpeg(args);
      cleanup(concatFile, ...clipPaths, ...imgPaths);

      const url = await uploadSB(out, `rendered/${calendarId}_slideshow_${formatKey}_${ts}.mp4`);
      await saveToDB(calendarId, formatKey, url);
      cleanup(out);
      return url;
    }

    // Single image path
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
    await runFFmpeg(args);
    cleanup(...imgPaths);

    const url = await uploadSB(out, `rendered/${calendarId}_slideshow_${formatKey}_${ts}.mp4`);
    await saveToDB(calendarId, formatKey, url);
    cleanup(out);
    console.log('[v5] done', formatKey);
    return url;
  } catch(e) {
    cleanup(...imgPaths, out);
    throw e;
  }
}

async function processQueue() {
  if (isRendering || renderQueue.length === 0) return;
  isRendering = true;
  const job = renderQueue.shift();
  try {
    await renderOne(job);
  } catch(e) {
    console.error('[v5] job failed', job.formatKey, e.message);
  }
  isRendering = false;
  processQueue(); // Process next
}

app.post('/render', (req, res) => {
  const { action, calendar_id, format_key, image_urls } = req.body;
  if (!calendar_id || !format_key) return res.status(400).json({ ok: false, error: 'calendar_id and format_key required' });

  renderQueue.push({ calendarId: calendar_id, imageUrls: image_urls, formatKey: format_key, action });
  res.json({ ok: true, status: 'queued', queue_position: renderQueue.length });

  processQueue();
});

app.get('/status/:calendarId/:formatKey', async (req, res) => {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { realtime: { transport: WebSocket } });
    const { data } = await sb.from('content_calendar').select('platform_images').eq('id', req.params.calendarId).single();
    const pi = data?.platform_images || {};
    const keys = { square: 'instagram_feed_mp4', story: 'instagram_story_mp4', landscape: 'facebook_post_mp4' };
    const k = keys[req.params.formatKey];
    res.json({ ok: true, ready: !!pi[k], mp4_url: pi[k] || null });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log('[vw-render] v5 listening on port', PORT));
