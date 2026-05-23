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
async function makeThreeVariantsWithClientPNGs(cutPath, tmpDir, job) {
  const variants = [];
  
  // Client already created PNGs for each hook
  const hookPNGs = [
    job.hook1PngData || '',
    job.hook2PngData || '',
    job.hook3PngData || ''
  ];
  
  // Positions - client ke mutabiq
  const configs = [
    { hookPos: 'top', bannerPos: 'bottom' },    // V1
    { hookPos: 'top', bannerPos: 'bottom' },    // V2
    { hookPos: 'bottom', bannerPos: 'top' }     // V3
  ];
  
  for (let i = 0; i < 3; i++) {
    const outPath = `${tmpDir}/v${i+1}.mp4`;
    
    // Download hook PNG from URL if it exists
    let hookPath = null;
    if (hookPNGs[i]) {
      hookPath = `${tmpDir}/hook${i+1}.png`;
      await downloadFile(hookPNGs[i], hookPath);
    }
    
    // Download banner if exists
    let bannerPath = null;
    if (job.bannerUrl && job.bannerUrl.startsWith('http')) {
      bannerPath = `${tmpDir}/banner.png`;
      await downloadFile(job.bannerUrl, bannerPath);
    } else if (job.bannerUrl && job.bannerUrl.startsWith('data:image')) {
      bannerPath = `${tmpDir}/banner.png`;
      const base64Data = job.bannerUrl.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(bannerPath, Buffer.from(base64Data, 'base64'));
    }
    
    // Apply overlay using FFmpeg with the PNGs
    await applyOverlayWithPNG(cutPath, outPath, hookPath, bannerPath, configs[i]);
    
    variants.push({
      out: outPath,
      hook: job[`hook${i+1}`] || '',
      hookPos: configs[i].hookPos,
      bannerPos: configs[i].bannerPos
    });
  }
  
  return variants;
}

// ============================================================
// ✅ SIMPLE: Sirf existing PNGs ko overlay karein - no text rendering
// ============================================================
function applyOverlayWithPNG(input, output, hookPath, bannerPath, config) {
  return new Promise((resolve, reject) => {
    try {
      const hookY   = config.hookPos === 'top' 
        ? '(H*0.21)-(h/2)' 
        : '(H*0.65)-(h/2)';
      const bannerY = config.bannerPos === 'top' 
        ? '(H*0.21)-(h/2)' 
        : '(H*0.65)-(h/2)';
      
      const inputs = [input];
      let filterParts = [];
      
      if (hookPath && fs.existsSync(hookPath)) {
        inputs.push(hookPath);
        filterParts.push(`[${inputs.length-1}:v]overlay=(W-w)/2:${hookY}`);
      }
      
      if (bannerPath && fs.existsSync(bannerPath)) {
        inputs.push(bannerPath);
        filterParts.push(`[${inputs.length-1}:v]overlay=(W-w)/2:${bannerY}`);
      }
      
      let filterChain = '';
      if (filterParts.length === 0) {
        filterChain = '[0:v]copy[out]';
      } else if (filterParts.length === 1) {
        filterChain = `[0:v]${filterParts[0]}[out]`;
      } else {
        // Chain multiple overlays
        let chain = `[0:v]${filterParts[0]}[tmp1]`;
        for (let i = 1; i < filterParts.length; i++) {
          const prev = i === 1 ? 'tmp1' : `tmp${i}`;
          const next = i === filterParts.length - 1 ? 'out' : `tmp${i+1}`;
          chain += `;[${prev}]${filterParts[i]}[${next}]`;
        }
        filterChain = chain;
      }
      
      const cmd = ffmpeg();
      inputs.forEach(inp => cmd.input(inp));
      
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
        .output(output)
        .on('end', resolve)
        .on('error', reject)
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
