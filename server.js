const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ==============================
// JOB LISTENER
// ==============================
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

// ==============================
// MAIN PROCESSOR
// ==============================
async function processJob(jobId, job) {
  const tmpDir = `/tmp/${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await updateJob(jobId, 'processing', 10, 'ویڈیو ڈاؤن لوڈ ہو رہی ہے');

    // 1. Download video
    const videoPath = `${tmpDir}/input.mp4`;
    await downloadFile(job.videoUrl, videoPath);
    await updateJob(jobId, 'processing', 25, 'کٹنگ ہو رہی ہے');

    // 2. Cut video
    const cutPath = `${tmpDir}/cut.mp4`;
    await cutVideo(videoPath, cutPath, job.startTime, job.endTime);
    await updateJob(jobId, 'processing', 40, '3 ویریئنٹ بن رہے ہیں');

    // 3. Make 3 variants (no music - keeps it fast and reliable)
    const variants = await makeThreeVariants(cutPath, tmpDir, job);
    await updateJob(jobId, 'processing', 80, 'Bunny پر اپلوڈ ہو رہا ہے');

    // 4. Upload to Bunny
    const urls = await uploadVariantsToBunny(variants, job);
    await updateJob(jobId, 'processing', 92, 'Firebase میں محفوظ ہو رہا ہے');

    // 5. Save to feed
    await saveToFeed(urls, job);
    await updateJob(jobId, 'done', 100, 'مکمل ✓');

    // 6. Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

  } catch (err) {
    console.error(err);
    await updateJob(jobId, 'error', 0, 'خرابی: ' + err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ==============================
// HELPERS
// ==============================
async function updateJob(jobId, status, progress, message) {
  await db.collection('editing_jobs').doc(jobId).update({
    status, progress, message,
    updatedAt: Date.now()
  });
}

function downloadFile(url, dest) {
  return new Promise(async (resolve, reject) => {
    const res = await axios({ url, method:'GET', responseType:'stream', timeout: 60000 });
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

async function makeThreeVariants(cutPath, tmpDir, job) {
  // Read admin editing config from Firebase (optional)
  let adminConfig = {};
  try {
    const cfgSnap = await db.collection('marketing_settings').doc('editing_config').get();
    if (cfgSnap.exists) adminConfig = cfgSnap.data();
  } catch(e) { console.log('No admin editing config, using defaults'); }

  const configs = [
    {
      out: `${tmpDir}/v1.mp4`,
      zoom: adminConfig.v1Zoom || '1.05',
      filter: adminConfig.v1Filter || 'curves=vintage',
      hook: job.hook1,
      hookPos: 'top',
      bannerPos: 'bottom'
    },
    {
      out: `${tmpDir}/v2.mp4`,
      zoom: adminConfig.v2Zoom || '1.08',
      filter: adminConfig.v2Filter || 'hue=s=1.2',
      hook: job.hook2,
      hookPos: 'top',
      bannerPos: 'bottom'
    },
    {
      out: `${tmpDir}/v3.mp4`,
      zoom: adminConfig.v3Zoom || '1.03',
      filter: adminConfig.v3Filter || 'colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3',
      hook: job.hook3,
      hookPos: 'bottom',
      bannerPos: 'top'
    },
  ];

  const results = [];
  for (const c of configs) {
    console.log('Making variant:', c.out);
    await applyVariantFilter(cutPath, c, job, tmpDir);
    results.push(c);
  }
  return results;
}

function applyVariantFilter(input, config, job, tmpDir) {
  return new Promise((resolve, reject) => {
    const hookY    = config.hookPos    === 'top' ? 'h*0.21' : 'h*0.65';
    const hookText = (config.hook || '').replace(/\\/g, '\\\\').replace(/'/g, "\u2019").replace(/:/g, '\\:');

    let vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z=${config.zoom}:d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',${config.filter}`;

    if (hookText) {
      vf += `,drawtext=text='${hookText}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=${hookY}:box=1:boxcolor=0xff6600@0.85:boxborderw=12`;
    }

    ffmpeg(input)
      .videoFilter(vf)
      .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a copy', '-movflags +faststart'])
      .output(config.out)
      .on('end', resolve)
      .on('error', (err) => {
        console.error('FFmpeg error for', config.out, err.message);
        reject(err);
      })
      .run();
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
      bannerPos: v.bannerPos
    });

    console.log('Uploaded variant', i+1, filename);
  }
  return urls;
}

async function saveToFeed(urls, job) {
  const uid = Date.now();
  const hookClasses = ['hook-v1','hook-v2','hook-v3'];

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

// ==============================
// START
// ==============================
app.get('/', (req, res) => res.send('Aaspaas Server Running ✓'));
watchJobs();
app.listen(3000, () => console.log('Server on port 3000'));
