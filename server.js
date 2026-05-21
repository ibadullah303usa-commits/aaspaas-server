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

function applyOverlay(input, config, bannerPath) {
  return new Promise((resolve, reject) => {

    const hookY   = config.hookPos   === 'top'    ? 'h*0.21' : 'h*0.65';
    const bannerY = config.bannerPos === 'bottom' ? 'h*0.65' : 'h*0.21';

    // Urdu text safe کریں
    const safeHook = (config.hook || '')
      .replace(/\\/g, '')
      .replace(/'/g, '\u2019')
      .replace(/:/g, '\u02D0')
      .replace(/\[/g, '')
      .replace(/\]/g, '')
      .trim();

    const hasBanner = bannerPath && fs.existsSync(bannerPath);
    const hasHook   = safeHook.length > 0;

    // Font path — Railway پر یہ path ہوگا
    const fontPath = '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf';

    let filterComplex = '';

    if (hasBanner && hasHook) {

      filterComplex = [
        `[1:v]scale=-1:iw*0.22[banner]`,
        `[0:v][banner]overlay=(W-w)/2:${bannerY}[withbanner]`,
        `[withbanner]drawtext=` +
          `fontfile=${fontPath}:` +
          `text='${safeHook}':` +
          `fontcolor=white:` +
          `fontsize=52:` +
          `x=(w-text_w)/2:` +
          `y=${hookY}-text_h/2:` +
          `box=1:` +
          `boxcolor=0x${config.hookColor}@0.92:` +
          `boxborderw=22:` +
          `line_spacing=8` +
        `[out]`
      ].join(';');

    } else if (hasBanner && !hasHook) {

      filterComplex = [
        `[1:v]scale=-1:iw*0.22[banner]`,
        `[0:v][banner]overlay=(W-w)/2:${bannerY}[out]`
      ].join(';');

    } else if (!hasBanner && hasHook) {

      filterComplex = [
        `[0:v]drawtext=` +
          `fontfile=${fontPath}:` +
          `text='${safeHook}':` +
          `fontcolor=white:` +
          `fontsize=52:` +
          `x=(w-text_w)/2:` +
          `y=${hookY}-text_h/2:` +
          `box=1:` +
          `boxcolor=0x${config.hookColor}@0.92:` +
          `boxborderw=22` +
        `[out]`
      ].join('');

    } else {
      filterComplex = `[0:v]copy[out]`;
    }

    const cmd = ffmpeg(input);
    if (hasBanner) cmd.input(bannerPath);

    cmd
      .complexFilter(filterComplex)
      .map('[out]')
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a copy',
        '-movflags +faststart'
      ])
      .output(config.out)
      .on('end', resolve)
      .on('error', (err) => {
        console.error('FFmpeg error:', err.message);
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
