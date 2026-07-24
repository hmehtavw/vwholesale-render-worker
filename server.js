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
  if (req.path === '/health' || req.path.startsWith('/status') || req.path === '/progress') return next();
  if (req.headers['x-worker-secret'] !== (process.env.WORKER_SECRET || 'vw-render-secret')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function sb() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    realtime: { transport: WebSocket }
  });
}

// Queue - process one job at a time
const queue = [];
let isProcessing = false;

app.get('/health', (req, res) => {
  res.json({ ok: true, build: 'VW-RAILWAY-V6-FULL', queue: queue.length, processing: isProcessing });
});

// Progress endpoint - browser polls this
app.get('/progress/:calendarId', async (req, res) => {
  try {
    const { data } = await sb().from('content_calendar')
      .select('gif_status, gif_progress, platform_images')
      .eq('id', req.params.calendarId).single();
    res.json({ ok: true, status: data?.gif_status, progress: data?.gif_progress,
      has_mp4: !!(data?.platform_images?.instagram_feed_mp4) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

async function updateProgress(calendarId, status, progress) {
  await sb().from('content_calendar').update({
    gif_status: status,
    gif_progress: progress,
    updated_at: new Date().toISOString()
  }).eq('id', calendarId);
  console.log('[v6]', calendarId, status, JSON.stringify(progress).slice(0,80));
}

async function dl(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('DL failed: ' + res.status);
  fs.writeFileSync(dest, await res.buffer());
}

async function uploadSB(filePath, storagePath) {
  const buf = fs.readFileSync(filePath);
  const mime = filePath.endsWith('.mp4') ? 'video/mp4' : 'image/png';
  const { error } = await sb().storage.from('calendar-images')
    .upload(storagePath, buf, { contentType: mime, upsert: true });
  if (error) throw new Error('Upload: ' + error.message);
  return sb().storage.from('calendar-images').getPublicUrl(storagePath).data.publicUrl;
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-300)));
    });
    proc.on('error', e => reject(new Error('spawn: ' + e.message)));
  });
}

// Generate ONE image via OpenAI
async function genImage(prompt, size) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2-2026-04-21', prompt, n: 1, size, quality: 'medium', output_format: 'png', background: 'opaque' })
  });
  if (!res.ok) throw new Error('OpenAI ' + res.status + ': ' + await res.text().catch(() => ''));
  const d = await res.json();
  const b64 = d.data?.[0]?.b64_json;
  if (!b64 || b64.length < 1000) throw new Error('No image data from OpenAI');
  return Buffer.from(b64, 'base64');
}

// Get slide themes from GPT
async function getThemes(topic) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini', temperature: 0.6, max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'For V Wholesale slideshow about "' + topic + '", create 3 slide themes. Same topic, 3 different angles. Return JSON {"slides":[{"headline":"max 5 words","message":"one benefit","angle":"visual scene for AI image"}]}' }]
    })
  });
  const d = await res.json();
  return JSON.parse(d.choices?.[0]?.message?.content || '{}').slides || [];
}

const CATEGORY_SETS = [
  'Granite | Vitrified Tiles | Bathroom Fittings',
  'Paints | Plywood | Hardware',
  'Modular Kitchen | Wardrobes | Flooring',
  'UPVC Windows | Doors | Glass',
  'Waterproofing | Electrical | Plumbing',
];

async function processGifJob(job) {
  const { calendarId } = job;
  const tmp = os.tmpdir();
  const ts = Date.now();

  try {
    await updateProgress(calendarId, 'generating_themes', { step: 'Getting slide themes', done: 0, total: 9 });

    // Get item from DB
    const { data: item } = await sb().from('content_calendar').select('*').eq('id', calendarId).single();
    if (!item) throw new Error('Item not found');

    const topic = item.topic.replace(/\s*[—–\-]\s*(GIF|Slideshow|Campaign|Reel).*/gi, '').trim();
    const t = topic.toLowerCase();
    const scheme = t.includes('granite') || t.includes('tile') ? 'elegant cream charcoal stone' :
      t.includes('monsoon') || t.includes('rain') ? 'calm blue grey rainy atmosphere' :
      t.includes('bathroom') ? 'clean white chrome spa' :
      t.includes('paint') ? 'warm terracotta sage green' :
      item.is_festival ? 'festive gold jewel tones' : 'warm professional cream charcoal';

    // Declare slideImages before the if/else so both branches can use it
    const slideImages = { square: [], story: [], landscape: [] };
    const pi0 = item.platform_images || {};
    const existingSq = (pi0.gif_slides_square||'').split('|').filter(Boolean);
    const existingSt = (pi0.gif_slides_story||'').split('|').filter(Boolean);
    const existingLs = (pi0.gif_slides_landscape||'').split('|').filter(Boolean);

    if (existingSq.length >= 3 && existingSt.length >= 3 && existingLs.length >= 3) {
      console.log('[v6] all 9 images exist, skipping to MP4');
      slideImages.square = existingSq;
      slideImages.story = existingSt;
      slideImages.landscape = existingLs;
    } else {
      const themes = await getThemes(topic);
      if (!themes.length) throw new Error('Could not generate slide themes');
      let doneCount = 0;

      // PREMIUM MODE: Generate 9 images (3 slides x 3 native formats)
      // Each format generated independently with safe margins — no cropping needed
      const formats = [
        {
          key: 'square',
          size: '1024x1024',
          prompt_suffix: 'Instagram Feed square 1:1 (1080x1080). SAFE ZONE RULE: Keep ALL elements — logo, headline, text, phone number, footer — inside the central 88% of the canvas. Minimum 60px from every edge. No element may touch or cross the edge. LAYOUT: V Wholesale logo top-center in safe zone. Indian home interior lifestyle photo fills center. Bold headline below photo. Category strip. Footer with phone number well inside bottom margin. Generous whitespace around all content.'
        },
        {
          key: 'story',
          size: '1024x1536',
          prompt_suffix: 'Instagram Story and WhatsApp Status vertical 9:16. CRITICAL SAFE ZONE: Left 90px = unsafe. Right 90px = unsafe. Top 140px = unsafe. Bottom 220px = unsafe. ALL content (V Wholesale logo, headline, phone number, footer, icons, category strip) must be COMPLETELY inside the safe center area. Instagram UI will cover edges. LAYOUT: Logo in safe top area. Full-bleed lifestyle photo in middle. Large centered headline in safe zone. Footer phone number well above the 220px bottom unsafe margin. Nothing touches edges.'
        },
        {
          key: 'landscape',
          size: '1536x1024',
          prompt_suffix: 'Facebook and YouTube wide 16:9 landscape. SAFE ZONE: 70px on all sides. ALL content must stay 70px+ from every edge. LAYOUT: Left 40% text column — V Wholesale logo, bold headline, message, footer all within safe margins (70px+ from left edge). Right 60% — Indian home interior lifestyle photo within safe margins. No text, logo or footer may cross the 70px safe margin on any side. Professional wide banner.'
        }
      ];

      for (let si = 0; si < themes.length; si++) {
        const theme = themes[si];
        const cats = CATEGORY_SETS[si % CATEGORY_SETS.length];

        for (const fmt of formats) {
          await updateProgress(calendarId, 'generating_images', {
            step: 'Slide ' + (si+1) + '/3 — ' + fmt.key, done: doneCount, total: 9
          });

          const prompt = 'Premium V Wholesale home building materials marketing poster. Color: ' + scheme + '. Real Indian home interior lifestyle photography. ' + fmt.prompt_suffix + ' Brand: V Wholesale. Tagline: Build Better. Pay Less. Headline: "' + theme.headline + '". Visual: ' + theme.angle + '. Message: "' + theme.message + '". Category strip: ' + cats + '. Footer: +91 8712697930 | vwholesale.in | Visit V Wholesale. No black bars. No padding. No watermark. No gibberish.';

          try {
            let imgBuf = await genImage(prompt, fmt.size);
            console.log('[cost] slide', si+1, fmt.key, 'Rs', fmt.size === '1024x1024' ? '10.20' : '11.90');
            const imgPath = path.join(tmp, 'img_' + ts + '_s' + si + '_' + fmt.key + '.png');
            fs.writeFileSync(imgPath, imgBuf);
            imgBuf = null;
            const url = await uploadSB(imgPath, 'calendar/' + calendarId + '_gif_s' + (si+1) + '_' + fmt.key + '_' + ts + '.png');
            slideImages[fmt.key].push(url);
            doneCount++;
            console.log('[v6] slide', si+1, fmt.key, 'done', url.slice(-30));
            fs.unlinkSync(imgPath);
            await new Promise(r => setTimeout(r, 300));
          } catch(e) { console.error('[v6] slide', si+1, fmt.key, 'failed:', e.message); }
        }
      }
    if (!slideImages.square.length) throw new Error('No images generated');
    } // end else (new image generation)

    // Save image URLs to DB
    const pi = item.platform_images || {};
    if (slideImages.square[0])    { pi.instagram_feed = slideImages.square[0]; pi.threads = slideImages.square[0]; }
    if (slideImages.story[0])     { pi.instagram_story = slideImages.story[0]; pi.facebook_story = slideImages.story[0]; pi.whatsapp_story = slideImages.story[0]; }
    if (slideImages.landscape[0]) { pi.facebook_post = slideImages.landscape[0]; pi.youtube = slideImages.landscape[0]; pi.gbp = slideImages.landscape[0]; }
    pi.gif_slides_square    = slideImages.square.join('|');
    pi.gif_slides_story     = slideImages.story.join('|');
    pi.gif_slides_landscape = slideImages.landscape.join('|');

    await sb().from('content_calendar').update({
      image_url: slideImages.square[0],
      platform_images: pi,
      updated_at: new Date().toISOString()
    }).eq('id', calendarId);

    await updateProgress(calendarId, 'generating_mp4', { step: 'Creating MP4 slideshows', done: 9, total: 9 });

    // Generate MP4 for each format
    const formatDims = { square: [1080, 1080], story: [1080, 1920], landscape: [1920, 1080] };
    for (const [fmt, urls] of Object.entries(slideImages)) {
      if (!urls.length) continue;
      const [W, H] = formatDims[fmt];
      const imgPaths = [];
      const clips = [];
      const hold = 3;

      try {
        // Download images
        for (let i = 0; i < urls.length; i++) {
          const p = path.join(tmp, 'mp4img_' + ts + '_' + fmt + '_' + i + '.png');
          await dl(urls[i], p);
          imgPaths.push(p);
        }

        // Premium: images native size, encode at 85% to save memory
        const encW = Math.round(W * 0.85);
        const encH = Math.round(H * 0.85);
        for (let i = 0; i < imgPaths.length; i++) {
          const clip = path.join(tmp, 'clip_' + ts + '_' + fmt + '_' + i + '.mp4');
          let ffArgs;
          if (fmt === 'square') {
            // Square 1:1 — simple scale, minimal padding
            ffArgs = [
              '-loop', '1', '-t', String(hold), '-i', imgPaths[i],
              '-vf', 'scale=' + encW + ':' + encH + ':force_original_aspect_ratio=decrease,pad=' + encW + ':' + encH + ':(ow-iw)/2:(oh-ih)/2:color=#111827,setsar=1,fps=25,format=yuv420p',
              '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', clip
            ];
          } else {
            // Story + Landscape: blurred background fill (ChatGPT recommended)
            // Split: blurred enlarged BG + sharp contained FG overlay
            const bf = [
              '[0:v]split=2[background][foreground]',
              '[background]scale=' + encW + ':' + encH + ':force_original_aspect_ratio=increase,crop=' + encW + ':' + encH + ',gblur=sigma=35,eq=brightness=-0.08:saturation=0.85[blurred]',
              '[foreground]scale=' + encW + ':' + encH + ':force_original_aspect_ratio=decrease[poster]',
              '[blurred][poster]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=25,format=yuv420p[video]'
            ].join(';');
            ffArgs = [
              '-loop', '1', '-t', String(hold), '-i', imgPaths[i],
              '-filter_complex', bf, '-map', '[video]',
              '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip
            ];
          }
          await runFFmpeg(ffArgs);
          clips.push(clip);
        }

        // Concat clips
        const concatFile = path.join(tmp, 'concat_' + ts + '_' + fmt + '.txt');
        fs.writeFileSync(concatFile, clips.map(p => `file '${p}'`).join('\n'));
        const outMp4 = path.join(tmp, 'out_' + calendarId + '_' + fmt + '_' + ts + '.mp4');
        await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outMp4]);

        const mp4Url = await uploadSB(outMp4, 'rendered/' + calendarId + '_slideshow_' + fmt + '_' + ts + '.mp4');

        // Save MP4 URL
        const { data: fresh } = await sb().from('content_calendar').select('platform_images').eq('id', calendarId).single();
        const pi2 = fresh?.platform_images || {};
        if (fmt === 'square')    { pi2.instagram_feed_mp4 = mp4Url; pi2.threads_mp4 = mp4Url; pi2.mp4_music = mp4Url; }
        if (fmt === 'story')     { pi2.instagram_story_mp4 = mp4Url; pi2.facebook_story_mp4 = mp4Url; pi2.whatsapp_story_mp4 = mp4Url; }
        if (fmt === 'landscape') { pi2.facebook_post_mp4 = mp4Url; pi2.youtube_mp4 = mp4Url; pi2.gbp_mp4 = mp4Url; }
        await sb().from('content_calendar').update({ platform_images: pi2, updated_at: new Date().toISOString() }).eq('id', calendarId);
        console.log('[v6] mp4 done', fmt, mp4Url.slice(-30));

        // Cleanup
        [concatFile, outMp4, ...imgPaths, ...clips].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
      } catch(e) {
        console.error('[v6] mp4 failed', fmt, e.message);
        [...imgPaths, ...clips].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
      }
    }

    // Mark complete
    await sb().from('content_calendar').update({ gif_status: 'ready', updated_at: new Date().toISOString() }).eq('id', calendarId);
    await updateProgress(calendarId, 'ready', { step: 'Complete!', done: 9, total: 9 });
    console.log('[v6] JOB COMPLETE for', calendarId);

  } catch(e) {
    console.error('[v6] JOB FAILED', calendarId, e.message);
    await updateProgress(calendarId, 'failed', { step: 'Failed: ' + e.message, done: 0, total: 9 });
  }
}

async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  const job = queue.shift();
  try { await processGifJob(job); }
  catch(e) { console.error('[v6] queue error', e.message); }
  isProcessing = false;
  if (queue.length > 0) processQueue();
}

// Main endpoint — accepts job, responds immediately
app.post('/render', (req, res) => {
  const { calendar_id, action } = req.body;
  if (!calendar_id) return res.status(400).json({ ok: false, error: 'calendar_id required' });
  
  if (action === 'gif_slideshow') {
    queue.push({ calendarId: calendar_id });
    res.json({ ok: true, status: 'queued', queue_position: queue.length });
    processQueue();
  } else {
    res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  }
});

app.listen(PORT, () => console.log('[vw-render] v6 FULL listening on port', PORT));

process.on('uncaughtException', (e) => console.error('[CRASH]', e.message));
process.on('unhandledRejection', (e) => console.error('[REJECT]', e));
