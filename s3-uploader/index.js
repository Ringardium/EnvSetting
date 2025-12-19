const express = require('express');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-northeast-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET;
const DELETE_AFTER_UPLOAD = process.env.DELETE_LOCAL !== 'false';
const UPLOAD_HLS = process.env.UPLOAD_HLS !== 'false';
const UPLOAD_RECORDINGS = process.env.UPLOAD_RECORDINGS !== 'false';
const RECORDING_DELAY_MS = parseInt(process.env.RECORDING_DELAY_MINUTES || '10') * 60 * 1000; // 기본 10분

// 대기 중인 녹화 파일 타이머
const pendingRecordings = new Map();

// ==================== HLS 업로드 (실시간 감시) ====================
if (UPLOAD_HLS) {
  const hlsWatcher = chokidar.watch('/hls', {
    ignored: /^\./,
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  hlsWatcher
    .on('add', (filePath) => uploadHLS(filePath))
    .on('change', (filePath) => uploadHLS(filePath))
    .on('unlink', (filePath) => deleteHLS(filePath));

  console.log('[HLS] Watching /hls for changes...');
}

async function uploadHLS(filePath) {
  try {
    const relativePath = filePath.replace('/hls/', '');
    const s3Key = `hls/${relativePath}`;
    
    const fileBuffer = fs.readFileSync(filePath);
    const contentType = filePath.endsWith('.m3u8') 
      ? 'application/vnd.apple.mpegurl' 
      : 'video/mp2t';

    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: filePath.endsWith('.m3u8') ? 'no-cache, no-store' : 'max-age=31536000',
    }));

    console.log(`[HLS] Uploaded: ${s3Key}`);
  } catch (error) {
    console.error(`[HLS] Upload error: ${filePath}`, error.message);
  }
}

async function deleteHLS(filePath) {
  try {
    const relativePath = filePath.replace('/hls/', '');
    const s3Key = `hls/${relativePath}`;

    await s3Client.send(new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
    }));

    console.log(`[HLS] Deleted: ${s3Key}`);
  } catch (error) {
    console.error(`[HLS] Delete error: ${filePath}`, error.message);
  }
}

// ==================== Recording 업로드 (10분 지연 감시 방식) ====================
if (UPLOAD_RECORDINGS) {
  const recordingWatcher = chokidar.watch('/recordings', {
    ignored: /^\./,
    persistent: true,
    ignoreInitial: true, // 기존 파일은 무시
    awaitWriteFinish: {
      stabilityThreshold: 2000, // 녹화 파일은 더 긴 안정화 시간
      pollInterval: 500
    }
  });

  recordingWatcher.on('add', (filePath) => {
    // mp4, flv 파일만 처리
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.mp4' && ext !== '.flv') return;

    console.log(`[Recording] New file detected: ${filePath}`);
    console.log(`[Recording] Will upload in ${RECORDING_DELAY_MS / 1000 / 60} minutes`);

    // 기존 타이머가 있으면 취소 (파일이 덮어쓰기 되는 경우)
    if (pendingRecordings.has(filePath)) {
      clearTimeout(pendingRecordings.get(filePath));
    }

    // 지연 후 업로드 스케줄
    const timer = setTimeout(() => uploadRecording(filePath), RECORDING_DELAY_MS);
    pendingRecordings.set(filePath, timer);
  });

  console.log(`[Recording] Watching /recordings for changes (${RECORDING_DELAY_MS / 1000 / 60} min delay)...`);
}

async function uploadRecording(filePath) {
  pendingRecordings.delete(filePath);

  // 파일이 여전히 존재하는지 확인
  if (!fs.existsSync(filePath)) {
    console.log(`[Recording] File no longer exists, skipping: ${filePath}`);
    return;
  }

  try {
    const relativePath = filePath.replace('/recordings/', '');
    const s3Key = `recordings/${relativePath}`;

    const fileStream = fs.createReadStream(filePath);
    const fileStats = fs.statSync(filePath);

    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileStream,
      ContentType: 'video/mp4',
      ContentLength: fileStats.size,
      Metadata: {
        recorded_at: new Date().toISOString(),
      },
    }));

    console.log(`[Recording] Uploaded: s3://${BUCKET_NAME}/${s3Key}`);

    if (DELETE_AFTER_UPLOAD) {
      fs.unlinkSync(filePath);
      console.log(`[Local] Deleted: ${filePath}`);
      cleanEmptyDirs(path.dirname(filePath));
    }
  } catch (error) {
    console.error(`[Recording] Upload error:`, error.message);
  }
}

function cleanEmptyDirs(dirPath) {
  const baseDir = '/recordings';
  while (dirPath !== baseDir && dirPath.startsWith(baseDir)) {
    try {
      const files = fs.readdirSync(dirPath);
      if (files.length === 0) {
        fs.rmdirSync(dirPath);
        dirPath = path.dirname(dirPath);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    hls: UPLOAD_HLS,
    recordings: UPLOAD_RECORDINGS,
    recordingDelayMinutes: RECORDING_DELAY_MS / 1000 / 60,
    pendingRecordings: pendingRecordings.size,
    bucket: BUCKET_NAME
  });
});

// 대기 중인 녹화 파일 목록
app.get('/pending', (_, res) => {
  res.json({
    count: pendingRecordings.size,
    files: Array.from(pendingRecordings.keys()),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`S3 Uploader listening on port ${PORT}`);
  console.log(`  HLS Upload: ${UPLOAD_HLS}`);
  console.log(`  Recordings Upload: ${UPLOAD_RECORDINGS}`);
  console.log(`  Recording Delay: ${RECORDING_DELAY_MS / 1000 / 60} minutes`);
  console.log(`  S3 Bucket: ${BUCKET_NAME}`);
});