const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { createCanvas, registerFont } = require('canvas');
const sharp = require('sharp');

const app = express();
app.use(cors());
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ============================================================
// FONT SETUP — Noto Naskh Arabic (Urdu ke liye server par)
// Railway par font install karne ka tarika:
//   nixpacks.toml mein:  [phases.setup] nixPkgs = ["fonts-noto"]
//   YA Dockerfile mein:  RUN apt-get install -y fonts-noto-core
// ============================================================
const FONT_PATHS = [
  '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf',
  '/usr/share/fonts/opentype/noto/NotoNaskhArabic-Bold.ttf',
  '/root/.fonts/NotoNaskhArabic-Bold.ttf',
  '/app/fonts/NotoNaskhArabic-Bold.ttf',
];

let FONT_FAMILY = 'Arial'; // fallback

for (const fp of FONT_PATHS) {
  if (fs.existsSync(fp)) {
    try {
      registerFont(fp, { family: 'UrduFont', weight: 'bold' });
      FONT_FAMILY = 'UrduFont';
      console.log('✓ Urdu font loaded:', fp);
      break;
    } catch (e) {
      console.log('Font load failed:', fp, e.message);
    }
  }
}

// ============================================================
// WATCH JOBS
// ============================================================
async function watchJobs() {
  db.collection('editing_jobs')
    .where('status', '==', 'pending')
    .onSnapshot(async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const jobId = change.doc.id;
          const job   = change.doc.data();
          console.log('✓ New job:', jobId);
          await processJob(jobId, job);
        }
      });
    });
}

// ============================================================
// PROCESS JOB
// ============================================================
async function processJob(jobId, job) {
  const tmpDir = `/tmp/${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await updateJob(jobId, 'processing', 10, 'ویڈیو ڈاؤن لوڈ ہو رہی ہے');
    const videoPath = `${tmpDir}/input.mp4`;
    await downloadFile(job.videoUrl, videoPath);

    await updateJob(jobId, 'processing', 25, 'کٹنگ ہو رہی ہے');
    const cutPath = `${tmpDir}/cut.mp4`;
    await cutVideo(videoPath, cutPath, job.startTime, job.endTime);

    await updateJob(jobId, 'processing', 40, '3 ویریئنٹ بن رہے ہیں');

    // Banner download
    let bannerPath = null;
    if (job.bannerUrl && job.bannerUrl.startsWith('data:image')) {
      bannerPath = `${tmpDir}/banner.png`;
      const base64Data = job.bannerUrl.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(bannerPath, Buffer.from(base64Data, 'base64'));
    } else if (job.bannerUrl && job.bannerUrl.startsWith('http')) {
      bannerPath = `${tmpDir}/banner.png`;
      await downloadFile(job.bannerUrl, bannerPath);
    }

    // 3 variants banayein
    const variants = await makeThreeVariants(cutPath, tmpDir, job, bannerPath);

    await updateJob(jobId, 'processing', 80, 'Bunny پر اپلوڈ ہو رہا ہے');
    const urls = await uploadVariantsToBunny(variants, job);

    await updateJob(jobId, 'processing', 92, 'Firebase میں محفوظ ہو رہا ہے');
    await saveToFeed(urls, job);

    await updateJob(jobId, 'done', 100, 'مکمل ✓');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

  } catch (err) {
    console.error('Job error:', err);
    await updateJob(jobId, 'error', 0, 'خرابی: ' + err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function updateJob(jobId, status, progress, message) {
  try {
    await db.collection('editing_jobs').doc(jobId).update({
      status, progress, message, updatedAt: Date.now()
    });
  } catch (e) {
    // job already deleted — ignore
  }
}

function downloadFile(url, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
      const writer = fs.createWriteStream(dest);
      res.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function cutVideo(input, output, start, end) {
  const startSec = parseFloat(start) || 0;
  const endSec   = parseFloat(end)   || 15;
  const duration = Math.max(endSec - startSec, 1);
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .setStartTime(startSec)
      .setDuration(duration)
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ============================================================
// 3 VARIANTS CONFIG — prompt ke mutabiq
// V1: Red  (#FF0000) — hook top 21%,    banner bottom 65%
// V2: Blue (#0066FF) — hook top 21%,    banner bottom 65%
// V3: Purple (#8A2BE2) — hook bottom 65%, banner top 21%
// ============================================================
async function makeThreeVariants(cutPath, tmpDir, job, bannerPath) {
  const variants = [
    {
      out:        `${tmpDir}/v1.mp4`,
      hook:       job.hook1 || '',
      hookColor:  '#FF0000',   // Solid Red
      hookPos:    'top',       // 21%
      bannerPos:  'bottom',    // 65%
    },
    {
      out:        `${tmpDir}/v2.mp4`,
      hook:       job.hook2 || '',
      hookColor:  '#0066FF',   // Solid Blue
      hookPos:    'top',       // 21%
      bannerPos:  'bottom',    // 65%
    },
    {
      out:        `${tmpDir}/v3.mp4`,
      hook:       job.hook3 || '',
      hookColor:  '#8A2BE2',   // Solid Purple
      hookPos:    'bottom',    // 65%
      bannerPos:  'top',       // 21%
    }
  ];

  for (const v of variants) {
    await applyOverlay(cutPath, v, bannerPath);
  }
  return variants;
}

// ============================================================
// CREATE HOOK IMAGE — Canvas se pill shape, Urdu text
// ============================================================
async function createHookImage(text, bgColorHex, videoWidth = 1080) {
  if (!text || !text.trim()) return null;

  const MAX_WIDTH    = Math.floor(videoWidth * 0.82); // 82% of screen
  const PADDING_X    = 36;
  const FONT_SIZE    = 54;
  const LINE_HEIGHT  = FONT_SIZE * 1.5;
  const PILL_HEIGHT  = Math.floor(LINE_HEIGHT + 20); // tight wrap
  const BORDER_RAD   = PILL_HEIGHT / 2;

  // Canvas measure karo — text width ke liye
  const measureCanvas = createCanvas(MAX_WIDTH * 2, PILL_HEIGHT * 2);
  const mCtx = measureCanvas.getContext('2d');
  mCtx.font = `bold ${FONT_SIZE}px "${FONT_FAMILY}"`;

  const measured = mCtx.measureText(text).width;
  // Auto-adjust: agar text bada ho to font chhota karo
  let finalFontSize = FONT_SIZE;
  let finalWidth = Math.min(measured + PADDING_X * 2, MAX_WIDTH);

  if (measured + PADDING_X * 2 > MAX_WIDTH) {
    // Font shrink karo proportionally
    const ratio = (MAX_WIDTH - PADDING_X * 2) / measured;
    finalFontSize = Math.max(Math.floor(FONT_SIZE * ratio), 28);
    mCtx.font = `bold ${finalFontSize}px "${FONT_FAMILY}"`;
    const remeasured = mCtx.measureText(text).width;
    finalWidth = Math.min(remeasured + PADDING_X * 2, MAX_WIDTH);
  }

  const finalHeight = Math.floor(finalFontSize * 1.6 + 18);
  const finalRadius = finalHeight / 2;

  // Actual canvas
  const canvas = createCanvas(finalWidth, finalHeight);
  const ctx = canvas.getContext('2d');

  // Background: pill shape with glossy gradient
  ctx.clearRect(0, 0, finalWidth, finalHeight);

  // Parse hex color
  const r = parseInt(bgColorHex.slice(1, 3), 16);
  const g = parseInt(bgColorHex.slice(3, 5), 16);
  const b = parseInt(bgColorHex.slice(5, 7), 16);

  // Glossy gradient — top lighter, bottom solid
  const grad = ctx.createLinearGradient(0, 0, 0, finalHeight);
  grad.addColorStop(0,   `rgba(${r+40},${g+40},${b+40},0.97)`);
  grad.addColorStop(0.5, `rgba(${r},${g},${b},0.95)`);
  grad.addColorStop(1,   `rgba(${Math.max(r-20,0)},${Math.max(g-20,0)},${Math.max(b-20,0)},0.98)`);

  // Draw pill
  ctx.beginPath();
  ctx.moveTo(finalRadius, 0);
  ctx.arcTo(finalWidth, 0, finalWidth, finalHeight, finalRadius);
  ctx.arcTo(finalWidth, finalHeight, 0, finalHeight, finalRadius);
  ctx.arcTo(0, finalHeight, 0, 0, finalRadius);
  ctx.arcTo(0, 0, finalWidth, 0, finalRadius);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Subtle inner glow on top edge
  const gloss = ctx.createLinearGradient(0, 0, 0, finalHeight * 0.5);
  gloss.addColorStop(0, 'rgba(255,255,255,0.18)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gloss;
  ctx.fill();

  // Text shadow
  ctx.shadowColor   = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur    = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  // Text
  ctx.font      = `bold ${finalFontSize}px "${FONT_FAMILY}"`;
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction    = 'rtl';

  // Slight vertical overflow effect — text center slightly above midpoint
  const textY = finalHeight * 0.50;
  ctx.fillText(text, finalWidth / 2, textY);

  return canvas.toBuffer('image/png');
}

// ============================================================
// APPLY OVERLAY — FFmpeg se hook + banner lagao
// ============================================================
function applyOverlay(input, config, bannerPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const tmpHook = config.out.replace('.mp4', '_overlay.png');

      let overlayExists = false;
      if (config.hookPng) {
        overlayExists = saveBase64Png(config.hookPng, tmpHook);
        console.log('✓ Overlay PNG saved:', overlayExists);
      }

      const cmd = ffmpeg(input);
      let filter = '[0:v]copy[out]';

      if (overlayExists) {
        cmd.input(tmpHook);
        // PNG exact 1080x1920 hai — seedha 0,0 par lagao
        filter = `[0:v][1:v]overlay=0:0[out]`;
      }

      cmd
        .complexFilter(filter)
        .map('[out]')
        .outputOptions([
          '-c:v libx264',
          '-preset fast',
          '-crf 23',
          '-c:a copy',
          '-movflags +faststart'
        ])
        .output(config.out)
        .on('end', () => {
          if (fs.existsSync(tmpHook)) fs.unlinkSync(tmpHook);
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          reject(err);
        })
        .run();

    } catch (err) { reject(err); }
  });
}

// ============================================================
// BUNNY UPLOAD
// ============================================================
async function uploadVariantsToBunny(variants, job) {
  const bunnyKey  = process.env.BUNNY_API_KEY;
  const bunnyZone = process.env.BUNNY_STORAGE_ZONE;
  const bunnyHost = process.env.BUNNY_HOSTNAME;
  const bunnyCdn  = process.env.BUNNY_CDN_URL;
  const urls = [];

  for (let i = 0; i < variants.length; i++) {
    const v        = variants[i];
    const filename = `edited_${Date.now()}_v${i + 1}.mp4`;
    const fileBuf  = fs.readFileSync(v.out);

    await axios.put(
      `https://${bunnyHost}/${bunnyZone}/${filename}`,
      fileBuf,
      {
        headers: { AccessKey: bunnyKey, 'Content-Type': 'video/mp4' },
        maxBodyLength: Infinity
      }
    );

    urls.push({
      url:       `${bunnyCdn}/${filename}`,
      hook:      v.hook,
      hookPos:   v.hookPos,
      bannerPos: v.bannerPos,
      hookColor: v.hookColor
    });
  }
  return urls;
}

// ============================================================
// SAVE TO FEED — prompt ke mutabiq classes
// ============================================================
async function saveToFeed(urls, job) {
  const uid = Date.now();

  // hook-v1 = Red, hook-v2 = Blue, hook-v3 = Purple
  const hookClasses   = ['hook-v1', 'hook-v2', 'hook-v3'];
  // Variant 1 & 2: hook top, banner bottom
  // Variant 3: hook bottom, banner top
  const textClasses   = ['hook-top', 'hook-top', 'hook-bottom'];
  const bannerClasses = ['banner-bottom', 'banner-bottom', 'banner-top'];

  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    await db.collection('marketing_feed').add({
      id:                  `sv${i + 1}_${uid}`,
      mediaUrl:            u.url,
      mediaType:           'video',
      hookText:            u.hook || '',
      caption:             job.captions ? (job.captions[i] || '') : '',
      bannerUrl:           job.bannerUrl || '',
      // User HTML mein: hook-top hook-v1 etc.
      textPositionClass:   `${textClasses[i]} ${hookClasses[i]}`,
      bannerPositionClass: bannerClasses[i],
      timestamp:           uid - i,
      extCaps:             job.extCaps || {}
    });
  }
}

// ============================================================
// SERVER START
// ============================================================
app.get('/', (req, res) => res.send('Aaspaas Server Running ✓'));
watchJobs();
app.listen(3000, () => console.log('Server on port 3000'));
