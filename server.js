const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.WORKER_SECRET || 'vw-render-secret';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'content-type, x-worker-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.path === '/health' || req.path.startsWith('/status')) return next();
  if (req.headers['x-worker-secret'] !== WORKER_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, build: 'VW-RAILWAY-V4' }));

async function dl(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed: ' + res.status + ' ' + url.slice(0,60));
  fs.writeFileSync(dest, await res.buffer());
  return dest;
}

async function uploadSB(filePath, storagePath) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const buf = fs.readFileSync(filePath);
  const mime = filePath.endsWith('.mp4') ? 'video/mp4' : 'image/gif';
  const { error } = await sb.storage.from('calendar-images').upload(storagePath, buf, { contentType: mime, upsert: true });
  if (error) throw new Error('SB upload failed: ' + error.message);
  return sb.storage.from('calendar-images').getPublicUrl(storagePath).data.publicUrl;
}

async function saveToDB(calendarId, formatKey, mp4Url, action) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data } = await sb.from('content_calendar').select('platform_images').eq('id', calendarId).single();
  const pi = data?.platform_images || {};
  if (action === 'slideshow') {
    if (formatKey === 'square')    { pi.instagram_feed_mp4=mp4Url; pi.threads_mp4=mp4Url; pi.mp4_music=mp4Url; }
    if (formatKey === 'story')     { pi.instagram_story_mp4=mp4Url; pi.facebook_story_mp4=mp4Url; pi.whatsapp_story_mp4=mp4Url; }
    if (formatKey === 'landscape') { pi.facebook_post_mp4=mp4Url; pi.youtube_mp4=mp4Url; }
  } else {
    if (formatKey === 'square')    { pi.instagram_feed_mp4=mp4Url; pi.mp4_music=mp4Url; }
    if (formatKey === 'story')     { pi.instagram_story_mp4=mp4Url; }
    if (formatKey === 'landscape') { pi.facebook_post_mp4=mp4Url; pi.youtube_mp4=mp4Url; }
  }
  await sb.from('content_calendar').update({ platform_images: pi, updated_at: new Date().toISOString() }).eq('id', calendarId);
  console.log('[v4] saved', formatKey, 'to DB');
}

function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg code ' + code + ': ' + stderr.slice(-400)));
    });
  });
}

async function renderSlideshow({ calendarId, imageUrls, formatKey, musicUrl, action, duration=3 }) {
  const tmp = os.tmpdir(), ts = Date.now();
  const imgPaths = [], out = path.join(tmp, `vw_${calendarId}_${formatKey}_${ts}.mp4`);
  let music = null;

  try {
    // Download images
    for (let i=0; i<imageUrls.length; i++) {
      const p = path.join(tmp, `img_${ts}_${i}.png`);
      await dl(imageUrls[i], p);
      imgPaths.push(p);
    }
    if (musicUrl) { music = path.join(tmp, `mus_${ts}.mp3`); await dl(musicUrl, music); }

    const dims = { square:[1080,1080], story:[1080,1920], landscape:[1920,1080] };
    const [W, H] = dims[formatKey] || [1080,1080];
    const n = imgPaths.length, fade = 0.5, hold = duration;

    // Build args
    const args = [];
    imgPaths.forEach(p => args.push('-loop','1','-t',String(hold+fade),'-i',p));
    if (music) args.push('-i', music);

    // Filter: scale each, then xfade chain
    const filt = [];
    for (let i=0; i<n; i++) {
      // Resize preserving aspect, pad to fill, center
      filt.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=25[s${i}]`);
    }
    if (n===1) {
      filt.push(`[s0]loop=${hold*25}:1:0[vout]`);
    } else {
      let prev='s0';
      for (let i=1; i<n; i++) {
        const offset = i*hold - fade;
        const out2 = i===n-1 ? 'vout' : `x${i}`;
        filt.push(`[${prev}][s${i}]xfade=transition=fade:duration=${fade}:offset=${offset}[${out2}]`);
        prev = out2;
      }
    }

    args.push('-filter_complex', filt.join(';'), '-map', '[vout]');
    if (music) args.push('-map', `${n}:a`, '-c:a','aac','-b:a','96k','-shortest');
    args.push('-c:v','libx264','-preset','ultrafast','-crf','26','-pix_fmt','yuv420p','-movflags','+faststart','-t',String(n*hold), out);

    console.log('[v4]', formatKey, 'running ffmpeg, filter:', filt.join(';').slice(0,150));
    await runFFmpeg(args);

    const url = await uploadSB(out, `rendered/${calendarId}_${action}_${formatKey}_${ts}.mp4`);
    await saveToDB(calendarId, formatKey, url, action);
    cleanup(...imgPaths, out, music);
    console.log('[v4] done', formatKey);
    return url;
  } catch(e) { cleanup(...imgPaths, out, music); throw e; }
}

async function renderAnimatedPoster({ calendarId, imageUrl, formatKey, musicUrl, duration=8 }) {
  const tmp = os.tmpdir(), ts = Date.now();
  const img = path.join(tmp, `pos_${ts}.png`);
  const out = path.join(tmp, `anim_${calendarId}_${formatKey}_${ts}.mp4`);
  let music = null;

  try {
    await dl(imageUrl, img);
    if (musicUrl) { music = path.join(tmp, `mus_${ts}.mp3`); await dl(musicUrl, music); }

    const dims = { square:[1080,1080], story:[1080,1920], landscape:[1920,1080] };
    const [W, H] = dims[formatKey] || [1080,1080];
    const fps=25, frames=duration*fps;
    const zoom=`[0:v]scale=${W*2}:${H*2},zoompan=z='min(zoom+0.0002,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps},fade=t=in:st=0:d=0.5,fade=t=out:st=${duration-0.5}:d=0.5[vout]`;

    const args = ['-loop','1','-t',String(duration+1),'-i',img];
    if (music) args.push('-i',music);
    args.push('-filter_complex',zoom,'-map','[vout]');
    if (music) args.push('-map','1:a','-c:a','aac','-b:a','96k','-shortest');
    args.push('-c:v','libx264','-preset','ultrafast','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart','-t',String(duration),out);

    await runFFmpeg(args);
    const url = await uploadSB(out, `rendered/${calendarId}_animated_${formatKey}_${ts}.mp4`);
    await saveToDB(calendarId, formatKey, url, 'animated_poster');
    cleanup(img, out, music);
    return url;
  } catch(e) { cleanup(img, out, music); throw e; }
}

app.post('/render', (req, res) => {
  const { action, calendar_id, format_key, image_urls, image_url, music_url, duration } = req.body;
  if (!calendar_id || !format_key) return res.status(400).json({ ok:false, error:'calendar_id and format_key required' });
  res.json({ ok:true, status:'queued' });

  const fn = action==='animated_poster'
    ? renderAnimatedPoster({ calendarId:calendar_id, imageUrl:image_url, formatKey:format_key, musicUrl:music_url, duration })
    : renderSlideshow({ calendarId:calendar_id, imageUrls:image_urls, formatKey:format_key, musicUrl:music_url, action:action||'slideshow', duration });

  fn.then(url => console.log('[v4] complete', format_key, url?.slice(-30)))
    .catch(e => console.error('[v4] error', format_key, e.message));
});

app.get('/status/:calendarId/:formatKey', async (req, res) => {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data } = await sb.from('content_calendar').select('platform_images').eq('id', req.params.calendarId).single();
    const pi = data?.platform_images || {};
    const keys = { square:'instagram_feed_mp4', story:'instagram_story_mp4', landscape:'facebook_post_mp4' };
    const k = keys[req.params.formatKey] || 'mp4_music';
    res.json({ ok:true, ready:!!pi[k], mp4_url:pi[k]||null });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.listen(PORT, () => console.log('[vw-render] v4 listening on port', PORT));
