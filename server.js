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

const FONT_PATHS = [
  '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf',
  '/usr/share/fonts/opentype/noto/NotoNaskhArabic-Bold.ttf',
  '/root/.fonts/NotoNaskhArabic-Bold.ttf',
  '/app/fonts/NotoNaskhArabic-Bold.ttf',
];

let FONT_FAMILY = 'Arial';

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

    const variants = await makeThreeVariants(cutPath, tmpDir, job, bannerPath);

    await updateJob(jobId, 'processing', 80, 'Bunny پر اپلوڈ ہو رہا ہے');
    const urls = await uploadVariantsToBunny(variants, job);

    await updateJob(jobId, 'processing', 92, 'Firebase میں محفوظ ہو رہا ہے');
    await saveToFeed(urls, job);

    await updateJob(jobId, 'done', 100, 'مکمل ✓');

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
// CREATE HOOK IMAGE — Canvas se pill shape, Urdu text
// ============================================================
async function createHookImage(text, bgColorHex, videoWidth = 1080) {
  if (!text || !text.trim()) return null;

  const MAX_WIDTH   = Math.floor(videoWidth * 0.82);
  const PADDING_X   = 36;
  const FONT_SIZE   = 54;
  const LINE_HEIGHT = FONT_SIZE * 1.5;
  const PILL_HEIGHT = Math.floor(LINE_HEIGHT + 20);

  const measureCanvas = createCanvas(MAX_WIDTH * 2, PILL_HEIGHT * 2);
  const mCtx = measureCanvas.getContext('2d');
  mCtx.font = `bold ${FONT_SIZE}px "${FONT_FAMILY}"`;

  const measured = mCtx.measureText(text).width;
  let finalFontSize = FONT_SIZE;
  let finalWidth = Math.min(measured + PADDING_X * 2, MAX_WIDTH);

  if (measured + PADDING_X * 2 > MAX_WIDTH) {
    const ratio = (MAX_WIDTH - PADDING_X * 2) / measured;
    finalFontSize = Math.max(Math.floor(FONT_SIZE * ratio), 28);
    mCtx.font = `bold ${finalFontSize}px "${FONT_FAMILY}"`;
    const remeasured = mCtx.measureText(text).width;
    finalWidth = Math.min(remeasured + PADDING_X * 2, MAX_WIDTH);
  }

  const finalHeight = Math.floor(finalFontSize * 1.6 + 18);
  const finalRadius = finalHeight / 2;

  const canvas = createCanvas(finalWidth, finalHeight);
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, finalWidth, finalHeight);

  const r = parseInt(bgColorHex.slice(1, 3), 16);
  const g = parseInt(bgColorHex.slice(3, 5), 16);
  const b = parseInt(bgColorHex.slice(5, 7), 16);

  const grad = ctx.createLinearGradient(0, 0, 0, finalHeight);
  grad.addColorStop(0,   `rgba(${Math.min(r+40,255)},${Math.min(g+40,255)},${Math.min(b+40,255)},0.97)`);
  grad.addColorStop(0.5, `rgba(${r},${g},${b},0.95)`);
  grad.addColorStop(1,   `rgba(${Math.max(r-20,0)},${Math.max(g-20,0)},${Math.max(b-20,0)},0.98)`);

  ctx.beginPath();
  ctx.moveTo(finalRadius, 0);
  ctx.arcTo(finalWidth, 0, finalWidth, finalHeight, finalRadius);
  ctx.arcTo(finalWidth, finalHeight, 0, finalHeight, finalRadius);
  ctx.arcTo(0, finalHeight, 0, 0, finalRadius);
  ctx.arcTo(0, 0, finalWidth, 0, finalRadius);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  const gloss = ctx.createLinearGradient(0, 0, 0, finalHeight * 0.5);
  gloss.addColorStop(0, 'rgba(255,255,255,0.18)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gloss;
  ctx.fill();

  ctx.shadowColor   = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur    = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  ctx.font         = `bold ${finalFontSize}px "${FONT_FAMILY}"`;
  ctx.fillStyle    = '#FFFFFF';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction    = 'rtl';

  ctx.fillText(text, finalWidth / 2, finalHeight * 0.50);

  return canvas.toBuffer('image/png');
}

// ============================================================
// 3 VARIANTS
// ============================================================
async function makeThreeVariants(cutPath, tmpDir, job, bannerPath) {
  const variants = [
    {
      out:       `${tmpDir}/v1.mp4`,
      hook:      job.hook1 || '',
      hookColor: '#FF0000',
      hookPos:   'top',
      bannerPos: 'bottom',
    },
    {
      out:       `${tmpDir}/v2.mp4`,
      hook:      job.hook2 || '',
      hookColor: '#0066FF',
      hookPos:   'top',
      bannerPos: 'bottom',
    },
    {
      out:       `${tmpDir}/v3.mp4`,
      hook:      job.hook3 || '',
      hookColor: '#8A2BE2',
      hookPos:   'bottom',
      bannerPos: 'top',
    }
  ];

  for (const v of variants) {
    await applyOverlay(cutPath, v, bannerPath);
  }
  return variants;
}

// ============================================================
// APPLY OVERLAY
// ============================================================
function applyOverlay(input, config, bannerPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const tmpHookPath   = config.out.replace('.mp4', '_hook.png');
      const tmpBannerPath = config.out.replace('.mp4', '_banner_scaled.png');

      // Server khud hook image banata hai
      let overlayExists = false;
      const safeHook = (config.hook || '').trim();
      if (safeHook) {
        const hookBuf = await createHookImage(safeHook, config.hookColor, 1080);
        if (hookBuf) {
          fs.writeFileSync(tmpHookPath, hookBuf);
          overlayExists = true;
        }
      }

      // Banner scale
      let bannerExists = false;
      if (bannerPath && fs.existsSync(bannerPath)) {
        await sharp(bannerPath)
          .resize({ width: 900, fit: 'inside' })
          .png()
          .toFile(tmpBannerPath);
        bannerExists = true;
      }

      const hookY   = config.hookPos   === 'top' ? '(H*0.21)-(h/2)' : '(H*0.65)-(h/2)';
      const bannerY = config.bannerPos === 'top' ? '(H*0.21)-(h/2)' : '(H*0.65)-(h/2)';

      const cmd = ffmpeg(input);
      const inputsList = [];
      if (overlayExists) inputsList.push({ path: tmpHookPath,   y: hookY });
      if (bannerExists)  inputsList.push({ path: tmpBannerPath, y: bannerY });

      inputsList.forEach(inp => cmd.input(inp.path));

      let filterChain = '';
      if (inputsList.length === 0) {
        filterChain = '[0:v]copy[out]';
      } else if (inputsList.length === 1) {
        filterChain = `[0:v][1:v]overlay=(W-w)/2:${inputsList[0].y}[out]`;
      } else {
        filterChain =
          `[0:v][1:v]overlay=(W-w)/2:${inputsList[0].y}[tmp];` +
          `[tmp][2:v]overlay=(W-w)/2:${inputsList[1].y}[out]`;
      }

      cmd
        .complexFilter(filterChain)
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
          if (fs.existsSync(tmpHookPath))   fs.unlinkSync(tmpHookPath);
          if (fs.existsSync(tmpBannerPath)) fs.unlinkSync(tmpBannerPath);
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          reject(err);
        })
        .run();

    } catch (err) {
      reject(err);
    }
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
// SAVE TO FEED
// ============================================================
async function saveToFeed(urls, job) {
  const uid = Date.now();

  const hookClasses   = ['hook-v1', 'hook-v2', 'hook-v3'];
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
