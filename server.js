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

    // ✅ FIX: Server sirf client se aaye hue PNGs use karega
    // کوئی نیا ٹیکسٹ رینڈر نہیں، کوئی فونٹ لوڈنگ نہیں

    // 3 variants banayein - client ke PNGs ke saath
    const variants = await makeThreeVariantsWithClientPNGs(cutPath, tmpDir, job);

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
  } catch (e) {}
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
// ✅ FIX: Sirf client se aaye hue PNGs use karein
// کوئی createHookImage nahi, کوئی font nahi
// ============================================================
async function makeThreeVariants(cutPath, tmpDir, job, bannerPath) {
  const variants = [
    {
      out:       `${tmpDir}/v1.mp4`,
      hook:      job.hook1 || '',
      hookColor: '#FF0000',
      hookPos:   'top',
      bannerPos: 'bottom',
      pngUrl:    job.hook1PngData || '',
    },
    {
      out:       `${tmpDir}/v2.mp4`,
      hook:      job.hook2 || '',
      hookColor: '#0066FF',
      hookPos:   'top',
      bannerPos: 'bottom',
      pngUrl:    job.hook2PngData || '',
    },
    {
      out:       `${tmpDir}/v3.mp4`,
      hook:      job.hook3 || '',
      hookColor: '#8A2BE2',
      hookPos:   'bottom',
      bannerPos: 'top',
      pngUrl:    job.hook3PngData || '',
    }
  ];

  for (const v of variants) {
    await applyOverlay(cutPath, v, bannerPath, tmpDir);
  }
  return variants;
}

// ============================================================
// ✅ SIMPLE: Sirf existing PNGs ko overlay karein - no text rendering
// ============================================================
function applyOverlay(input, config, bannerPath, tmpDir) {
  return new Promise(async (resolve, reject) => {
    try {
      const tmpOverlayPath = config.out.replace('.mp4', '_overlay.png');
      const tmpBannerPath  = config.out.replace('.mp4', '_banner_scaled.png');

      // ── 1. Browser se aayi PNG download karo (hook + banner already burned) ──
      let overlayExists = false;
      if (config.pngUrl && config.pngUrl.startsWith('http')) {
        try {
          await downloadFile(config.pngUrl, tmpOverlayPath);
          overlayExists = fs.existsSync(tmpOverlayPath);
        } catch(e) {
          console.warn('Overlay PNG download failed:', e.message);
        }
      }

      // ── 2. Agar browser PNG nahi aayi to server side banao (fallback) ──
      if (!overlayExists) {
        const safeHook = (config.hook || '').trim();
        if (safeHook) {
          const hookBuf = await createHookImage(safeHook, config.hookColor, 1080);
          if (hookBuf) {
            fs.writeFileSync(tmpOverlayPath, hookBuf);
            overlayExists = true;
          }
        }
      }

      // ── 3. Banner scale karo ──
      let bannerExists = false;
      if (bannerPath && fs.existsSync(bannerPath)) {
        await sharp(bannerPath)
          .resize({ width: 900, fit: 'inside' })
          .png()
          .toFile(tmpBannerPath);
        bannerExists = true;
      }

      // ── 4. Overlay positions ──
      // Browser PNG (1080x1920) — poori video size ka hai, isliye x=0, y=0
      // Agar fallback hook pill hai to center karo
      const isPngFullFrame = config.pngUrl && config.pngUrl.startsWith('http') && overlayExists;

      const overlayX = isPngFullFrame ? '0' : '(W-w)/2';
      const overlayY = isPngFullFrame ? '0' : (config.hookPos === 'top' ? '(H*0.21)-(h/2)' : '(H*0.65)-(h/2)');
      const bannerY  = config.bannerPos === 'top' ? '(H*0.21)-(h/2)' : '(H*0.65)-(h/2)';

      // ── 5. FFmpeg command ──
      const cmd = ffmpeg(input);

      const inputsList = [];
      if (overlayExists) inputsList.push({ path: tmpOverlayPath, x: overlayX, y: overlayY });
      if (bannerExists)  inputsList.push({ path: tmpBannerPath,  x: '(W-w)/2', y: bannerY  });

      inputsList.forEach(inp => cmd.input(inp.path));

      let filterChain = '';
      if (inputsList.length === 0) {
        filterChain = '[0:v]copy[out]';
      } else if (inputsList.length === 1) {
        filterChain = `[0:v][1:v]overlay=${inputsList[0].x}:${inputsList[0].y}[out]`;
      } else {
        filterChain =
          `[0:v][1:v]overlay=${inputsList[0].x}:${inputsList[0].y}[tmp];` +
          `[tmp][2:v]overlay=${inputsList[1].x}:${inputsList[1].y}[out]`;
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
          if (fs.existsSync(tmpOverlayPath)) fs.unlinkSync(tmpOverlayPath);
          if (fs.existsSync(tmpBannerPath))  fs.unlinkSync(tmpBannerPath);
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
      url: `${bunnyCdn}/${filename}`,
      hook: v.hook,
      hookPos: v.hookPos,
      bannerPos: v.bannerPos
    });
  }
  return urls;
}

async function saveToFeed(urls, job) {
  const uid = Date.now();
  const hookClasses = ['hook-v1', 'hook-v2', 'hook-v3'];
  const textClasses = ['hook-top', 'hook-top', 'hook-bottom'];
  const bannerClasses = ['banner-bottom', 'banner-bottom', 'banner-top'];

  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    await db.collection('marketing_feed').add({
      id: `sv${i + 1}_${uid}`,
      mediaUrl: u.url,
      mediaType: 'video',
      hookText: u.hook || '',
      caption: job.captions ? (job.captions[i] || '') : '',
      bannerUrl: job.bannerUrl || '',
      textPositionClass: `${textClasses[i]} ${hookClasses[i]}`,
      bannerPositionClass: bannerClasses[i],
      timestamp: uid - i,
      extCaps: job.extCaps || {}
    });
  }
}

app.get('/', (req, res) => res.send('Aaspaas Server Running ✓'));
watchJobs();
app.listen(3000, () => console.log('Server on port 3000'));
