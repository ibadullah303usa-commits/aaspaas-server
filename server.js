const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function watchJobs() {
  db.collection('editing_jobs')
    .where('status', '==', 'pending')
    .onSnapshot(async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const jobId = change.doc.id;
          const job   = change.doc.data();
          console.log('New job:', jobId);
          await processJob(jobId, job);
        }
      });
    });
}

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

    // Banner download (if exists)
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

    // ✅ job مکمل ہونے پر editing_jobs سے ڈیلیٹ کریں
    await updateJob(jobId, 'done', 100, 'مکمل ✓');
    await db.collection('editing_jobs').doc(jobId).delete();

    fs.rmSync(tmpDir, { recursive: true, force: true });

  } catch (err) {
    console.error(err);
    await updateJob(jobId, 'error', 0, 'خرابی: ' + err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function updateJob(jobId, status, progress, message) {
  await db.collection('editing_jobs').doc(jobId).update({
    status, progress, message,
    updatedAt: Date.now()
  });
}

function downloadFile(url, dest) {
  return new Promise(async (resolve, reject) => {
    const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 60000 });
    const writer = fs.createWriteStream(dest);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
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

// ✅ تینوں ویریئنٹ — صرف overlay، کوئی zoom/filter/music نہیں
async function makeThreeVariants(cutPath, tmpDir, job, bannerPath) {
  const variants = [
    {
      out: `${tmpDir}/v1.mp4`,
      hook: job.hook1 || '',
      hookPos: 'top',     // h*0.21
      hookColor: 'f97316', // نارنجی
      bannerPos: 'bottom'  // h*0.65
    },
    {
      out: `${tmpDir}/v2.mp4`,
      hook: job.hook2 || '',
      hookPos: 'top',
      hookColor: 'dc2626', // لال
      bannerPos: 'bottom'
    },
    {
      out: `${tmpDir}/v3.mp4`,
      hook: job.hook3 || '',
      hookPos: 'bottom',   // h*0.65
      hookColor: '2563eb', // نیلا
      bannerPos: 'top'     // h*0.21
    }
  ];

  for (const v of variants) {
    await applyOverlay(cutPath, v, bannerPath);
  }
  return variants;
}

const sharp = require('sharp');

async function createHookImage(text, bgColor, videoWidth) {
  const fontSize = 52;
  const paddingX = 32;
  const paddingY = 16;
  
  // ہر حرف تقریباً 28px — estimate width
  const estimatedWidth = Math.min(
    Math.max(text.length * 30 + paddingX * 2, 200),
    videoWidth * 0.88
  );
  const height = fontSize + paddingY * 2 + 10;
  
  // hex color parse کریں
  const r = parseInt(bgColor.substring(0,2), 16);
  const g = parseInt(bgColor.substring(2,4), 16);
  const b = parseInt(bgColor.substring(4,6), 16);
  
  // Pill shape SVG
  const radius = height / 2;
  const svg = `
    <svg width="${estimatedWidth}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${estimatedWidth}" height="${height}" 
            rx="${radius}" ry="${radius}" 
            fill="rgb(${r},${g},${b})" opacity="0.93"/>
      <text 
        x="${estimatedWidth/2}" 
        y="${height/2 + fontSize*0.35}"
        font-family="Noto Naskh Arabic, Arial"
        font-size="${fontSize}"
        font-weight="bold"
        fill="white"
        text-anchor="middle"
        direction="rtl"
      >${text}</text>
    </svg>`;
  
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

function applyOverlay(input, config, bannerPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const tmpHookPath   = config.out.replace('.mp4', '_hook.png');
      const tmpBannerPath = config.out.replace('.mp4', '_banner_scaled.png');

      const safeHook = (config.hook || '').trim();

      // 1. Hook image بنائیں
      if (safeHook) {
        const hookBuf = await createHookImage(safeHook, config.hookColor, 1080);
        fs.writeFileSync(tmpHookPath, hookBuf);
      }

      // 2. Banner scale کریں
      let scaledBannerExists = false;
      if (bannerPath && fs.existsSync(bannerPath)) {
        await sharp(bannerPath)
          .resize({ width: 900, fit: 'inside' })
          .toFile(tmpBannerPath);
        scaledBannerExists = true;
      }

      // 3. FFmpeg — images overlay کریں
      const hookY   = config.hookPos   === 'top'    ? 'H*0.21-h/2' : 'H*0.65-h/2';
      const bannerY = config.bannerPos === 'bottom' ? 'H*0.65-h/2' : 'H*0.21-h/2';

      const cmd = ffmpeg(input);
      const inputs = [];

      if (safeHook && fs.existsSync(tmpHookPath)) {
        cmd.input(tmpHookPath);
        inputs.push({ type: 'hook', y: hookY });
      }
      if (scaledBannerExists) {
        cmd.input(tmpBannerPath);
        inputs.push({ type: 'banner', y: bannerY });
      }

      let filterChain = '';
      if (inputs.length === 0) {
        filterChain = '[0:v]copy[out]';
      } else if (inputs.length === 1) {
        const i = inputs[0];
        filterChain = `[0:v][1:v]overlay=(W-w)/2:${i.y}[out]`;
      } else {
        // hook اور banner دونوں
        const first  = inputs[0];
        const second = inputs[1];
        filterChain = 
          `[0:v][1:v]overlay=(W-w)/2:${first.y}[tmp];` +
          `[tmp][2:v]overlay=(W-w)/2:${second.y}[out]`;
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
          // temp files صاف کریں
          if (fs.existsSync(tmpHookPath))   fs.unlinkSync(tmpHookPath);
          if (fs.existsSync(tmpBannerPath)) fs.unlinkSync(tmpBannerPath);
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          reject(err);
        })
        .run();

    } catch(err) {
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
    const v = variants[i];
    const filename = `edited_${Date.now()}_v${i+1}.mp4`;
    const fileBuffer = fs.readFileSync(v.out);

    await axios.put(
      `https://${bunnyHost}/${bunnyZone}/${filename}`,
      fileBuffer,
      { headers: { AccessKey: bunnyKey, 'Content-Type': 'video/mp4' }, maxBodyLength: Infinity }
    );

    urls.push({
      url: `${bunnyCdn}/${filename}`,
      hook: v.hook,
      hookPos: v.hookPos,
      bannerPos: v.bannerPos,
      hookColor: v.hookColor
    });
  }
  return urls;
}

async function saveToFeed(urls, job) {
  const uid = Date.now();
  const hookClasses = ['hook-v1', 'hook-v2', 'hook-v3'];

  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    await db.collection('marketing_feed').add({
      id: `sv${i+1}_${uid}`,
      mediaUrl: u.url,
      mediaType: 'video',
      hookText: u.hook || '',
      caption: job.captions ? (job.captions[i] || '') : '',
      bannerUrl: job.bannerUrl || '',
      textPositionClass: `hook-${u.hookPos} ${hookClasses[i]}`,
      bannerPositionClass: `banner-${u.bannerPos}`,
      timestamp: uid - i,
      extCaps: job.extCaps || {}
    });
  }
}

app.get('/', (req, res) => res.send('Aaspaas Server Running ✓'));
watchJobs();
app.listen(3000, () => console.log('Server on port 3000'));
