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

// Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ==============================
// JOB LISTENER — Firebase watch
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
    await updateJob(jobId, 'processing', 5, 'ویڈیو ڈاؤن لوڈ ہو رہی ہے');

    // 1. Download video
    const videoPath = `${tmpDir}/input.mp4`;
    await downloadFile(job.videoUrl, videoPath);
    await updateJob(jobId, 'processing', 15, 'کٹنگ ہو رہی ہے');

    // 2. Cut video
    const cutPath = `${tmpDir}/cut.mp4`;
    await cutVideo(videoPath, cutPath, job.startTime, job.endTime);
    await updateJob(jobId, 'processing', 30, '3 ویریئنٹ بن رہے ہیں');

    // 3. Make 3 variants
    const variants = await makeThreeVariants(cutPath, tmpDir, job);
    await updateJob(jobId, 'processing', 70, 'میوزک لگ رہا ہے');

    // 4. Add background music
    const musicVariants = await addMusicToVariants(variants, tmpDir);
    await updateJob(jobId, 'processing', 85, 'Bunny پر اپلوڈ ہو رہا ہے');

    // 5. Upload to Bunny
    const urls = await uploadVariantsToBunny(musicVariants, job);
    await updateJob(jobId, 'processing', 95, 'Firebase میں محفوظ ہو رہا ہے');

    // 6. Save to feed
    await saveToFeed(urls, job);
    await updateJob(jobId, 'done', 100, 'مکمل ✓');

    // 7. Cleanup
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
    const res = await axios({ url, method:'GET', responseType:'stream' });
    const writer = fs.createWriteStream(dest);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function cutVideo(input, output, start, end) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .setStartTime(start || 0)
      .setDuration((end || 15) - (start || 0))
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function makeThreeVariants(cutPath, tmpDir, job) {
  const configs = [
    // V1: zoom 1.05, warm filter
    { out: `${tmpDir}/v1.mp4`, zoom:'1.05', filter:'curves=vintage', hook: job.hook1, hookPos:'top', bannerPos:'bottom' },
    // V2: zoom 1.08, cool filter
    { out: `${tmpDir}/v2.mp4`, zoom:'1.08', filter:'hue=s=1.2', hook: job.hook2, hookPos:'top', bannerPos:'bottom' },
    // V3: zoom 1.03, cinematic filter
    { out: `${tmpDir}/v3.mp4`, zoom:'1.03', filter:'colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3', hook: job.hook3, hookPos:'bottom', bannerPos:'top' },
  ];

  const results = [];
  for (const c of configs) {
    await applyVariantFilter(cutPath, c, job, tmpDir);
    results.push(c);
  }
  return results;
}

function applyVariantFilter(input, config, job, tmpDir) {
  return new Promise((resolve, reject) => {
    // Hook text overlay + banner overlay + zoom + filter
    const hookY = config.hookPos === 'top' ? 'h*0.21' : 'h*0.65';
    const bannerY = config.bannerPos === 'top' ? 'h*0.21' : 'h*0.65';
    const hookText = (config.hook || '').replace(/'/g, "\\'").replace(/:/g, "\\:");

    let filterComplex = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z=${config.zoom}:d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',${config.filter}`;

    if (hookText) {
      filterComplex += `,drawtext=text='${hookText}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=${hookY}:box=1:boxcolor=0xff6600@0.85:boxborderw=12:font=Noto Sans Urdu`;
    }

    filterComplex += `[vout]`;

    ffmpeg(input)
      .complexFilter(filterComplex, 'vout')
      .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac', '-b:a 128k', '-movflags +faststart'])
      .output(config.out)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function addMusicToVariants(variants, tmpDir) {
  // Use royalty-free music URLs (stored in Firebase settings)
  const musicUrls = [
    'https://www.bensound.com/bensound-music/bensound-ukulele.mp3',
    'https://www.bensound.com/bensound-music/bensound-sunny.mp3',
    'https://www.bensound.com/bensound-music/bensound-creativeminds.mp3'
  ];

  const results = [];
  for (let i = 0; i < variants.length; i++) {
    const musicPath = `${tmpDir}/music${i}.mp3`;
    await downloadFile(musicUrls[i % musicUrls.length], musicPath);
    const outPath = `${tmpDir}/final_v${i+1}.mp4`;
    await mixMusicWithVideo(variants[i].out, musicPath, outPath);
    results.push({ ...variants[i], finalOut: outPath });
  }
  return results;
}

function mixMusicWithVideo(videoPath, musicPath, outPath) {
  return new Promise((resolve, reject) => {
    // sidechaining: music lowers when voice is loud
    ffmpeg()
      .input(videoPath)
      .input(musicPath)
      .complexFilter([
        '[0:a]aformat=fltp:44100:stereo,asplit=2[orig][detector]',
        '[detector]ebur128=peak=true[measured]',
        '[1:a]aformat=fltp:44100:stereo,volume=0.15[bglow]',
        '[orig][bglow]amix=inputs=2:duration=first:dropout_transition=2[aout]'
      ], 'aout')
      .outputOptions(['-map 0:v', '-map [aout]', '-c:v copy', '-c:a aac', '-b:a 128k', '-shortest'])
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
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
    const fileBuffer = fs.readFileSync(v.finalOut);

    await axios.put(
      `https://${bunnyHost}/${bunnyZone}/${filename}`,
      fileBuffer,
      { headers: { AccessKey: bunnyKey, 'Content-Type': 'video/mp4' } }
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
