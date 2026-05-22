import express from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { createServer as createViteServer } from 'vite';
import ytdl from '@distube/ytdl-core';
import dotenv from 'dotenv';
import { Job } from './src/types';

dotenv.config();

// Helper to parse either JSON array or Netscape cookies.txt format
function parseCookies(cookiesInput: string): any[] | null {
  if (!cookiesInput || !cookiesInput.trim()) return null;

  // 1. Try parsing as JSON array
  try {
    const parsed = JSON.parse(cookiesInput);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    // Not JSON, continue to Netscape format
  }

  // 2. Try parsing as Netscape cookies.txt format
  try {
    const lines = cookiesInput.split(/\r?\n/);
    const cookies: any[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const parts = trimmed.split(/\s+/); // split by tabs or spaces
      if (parts.length >= 7) {
        const [domain, , path, secureStr, expiresStr, name, value] = parts;
        cookies.push({
          domain: domain.startsWith('.') ? domain : `.${domain}`,
          path,
          secure: secureStr.toUpperCase() === 'TRUE',
          expires: parseInt(expiresStr, 10) || undefined,
          name,
          value,
        });
      }
    }
    if (cookies.length > 0) {
      console.log(`[Cookies] Successfully parsed ${cookies.length} cookies from Netscape format.`);
      return cookies;
    }
  } catch (err) {
    console.error('[Cookies] Netscape format parse error:', err);
  }

  return null;
}

// Load global cookies from cookies.json or environment variables if present
let globalAgent: any = null;

function loadGlobalCookies() {
  try {
    // A. Check config cookies.json
    const cookiesJsonPath = path.join(process.cwd(), 'cookies.json');
    if (fs.existsSync(cookiesJsonPath)) {
      const content = fs.readFileSync(cookiesJsonPath, 'utf8');
      const parsed = parseCookies(content);
      if (parsed) {
        globalAgent = ytdl.createAgent(parsed);
        console.log('[Cookies] Initialized global agent from cookies.json successfully.');
        return;
      }
    }

    // B. Check environment variables
    const envCookies = process.env.YT_COOKIES || process.env.YOUTUBE_COOKIES;
    if (envCookies) {
      const parsed = parseCookies(envCookies);
      if (parsed) {
        globalAgent = ytdl.createAgent(parsed);
        console.log('[Cookies] Initialized global agent from environment variables successfully.');
        return;
      }
    }
  } catch (err) {
    console.error('[Cookies] Global agent setup error:', err);
  }
}

loadGlobalCookies();

const app = express();
const PORT = 3000;

app.use(express.json());

// Ensure downloads directory exists
const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// In-memory jobs store
const jobs: Record<string, Job> = {};

// Check if FFmpeg is available on the system
let hasFfmpeg = false;
exec('ffmpeg -version', (err) => {
  hasFfmpeg = !err;
  console.log(`FFmpeg detection: ${hasFfmpeg ? 'AVAILABLE' : 'NOT AVAILABLE (using high-quality source container fallback)'}`);
});

// Clean up files older than 15 minutes on server startup and periodically
function cleanOldFiles() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return;
  fs.readdir(DOWNLOADS_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const file of files) {
      if (file === '.gitkeep') continue;
      const filePath = path.join(DOWNLOADS_DIR, file);
      fs.stat(filePath, (statErr, stats) => {
        if (statErr) return;
        // Delete static elements older than 15 minutes
        if (now - stats.mtimeMs > 15 * 60 * 1000) {
          fs.unlink(filePath, (unlinkErr) => {
            if (!unlinkErr) {
              console.log(`Auto-cleaned stale file: ${file}`);
            }
          });
        }
      });
    }
  });
}

// Run cleanup immediately and then every 5 minutes
cleanOldFiles();
setInterval(cleanOldFiles, 5 * 60 * 1000);

// API Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasFfmpeg });
});

// Check if a YouTube URL is valid and start background downloading
app.post('/api/convert', async (req, res): Promise<any> => {
  const { url, cookies } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'YouTube URL is required.' });
  }

  // Basic regex validation for YouTube
  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|embed\/|shorts\/)?([a-zA-Z0-9_-]{11})/;
  if (!ytRegex.test(url)) {
    return res.status(400).json({ error: 'Please enter a valid YouTube URL.' });
  }

  const jobId = Math.random().toString(36).substring(2, 15);

  try {
    // Initial fetch metadata
    console.log(`[Job ${jobId}] Fetching metadata for ${url}`);
    
    // Register temporary info in jobs list immediately with fetching state
    jobs[jobId] = {
      id: jobId,
      url,
      title: 'Fetching details...',
      thumbnail: 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=128&q=80',
      duration: 0,
      status: 'fetching',
      progress: 5,
    };

    // Return job ID immediately to the client to avoid request Timeout
    res.json({ jobId });

    // Run the details retrieval and downstream fetch asynchronously
    processConversionJob(jobId, url, cookies);

  } catch (error: any) {
    console.error(`Error initializing job ${jobId}:`, error);
    jobs[jobId] = {
      id: jobId,
      url,
      title: 'Failed to fetch',
      thumbnail: '',
      duration: 0,
      status: 'failed',
      progress: 0,
      error: error.message || 'Failed to initialize YouTube video extraction.',
    };
  }
});

// Asymmetric processing pipeline
async function processConversionJob(jobId: string, url: string, cookiesInput?: string) {
  let tempFilePath = '';
  let outputFilePath = '';

  try {
    // Determine the active agent to bypass bot verification checks
    let activeAgent = globalAgent;
    if (cookiesInput) {
      const parsed = parseCookies(cookiesInput);
      if (parsed) {
        try {
          activeAgent = ytdl.createAgent(parsed);
          console.log(`[Cookies] Created dynamic ytdl Agent for Job ${jobId}`);
        } catch (err: any) {
          console.error(`[Cookies] Failed to create dynamic agent for Job ${jobId}:`, err);
        }
      }
    }

    const ytdlOptions: any = {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        }
      }
    };

    if (activeAgent) {
      ytdlOptions.agent = activeAgent;
    }

    const info = await ytdl.getInfo(url, ytdlOptions);
    const details = info.videoDetails;

    // Check duration limit (1 hour = 3600 seconds)
    const durationSec = parseInt(details.lengthSeconds || '0', 10);
    if (durationSec > 3600) {
      jobs[jobId].status = 'failed';
      jobs[jobId].title = details.title || 'Unknown Video';
      jobs[jobId].error = 'Video duration exceeds 1 hour. Maximum permitted limit is 60 minutes.';
      return;
    }

    if (durationSec === 0) {
      jobs[jobId].status = 'failed';
      jobs[jobId].title = details.title || 'Unknown Video';
      jobs[jobId].error = 'Live streams or empty content are not supported for audio download.';
      return;
    }

    // Capture clean metadata
    const thumbnail = details.thumbnails && details.thumbnails.length > 0 
      ? details.thumbnails[details.thumbnails.length - 1].url 
      : 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=128&q=80';
    
    const cleanTitle = (details.title || 'youtube_audio')
      .replace(/[\/\\\?\:\*\"\<\|\>]/g, '') // strip prohibited filesystem symbols
      .substring(0, 100); // keep within sensible bounds

    // Choose highest audio format
    const format = ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' });
    const container = format.container || 'm4a';

    // Update job metadata
    jobs[jobId].title = details.title;
    jobs[jobId].thumbnail = thumbnail;
    jobs[jobId].duration = durationSec;
    jobs[jobId].status = 'downloading';
    jobs[jobId].progress = 10;

    tempFilePath = path.join(DOWNLOADS_DIR, `temp_${jobId}.${container}`);
    
    console.log(`[Job ${jobId}] Starting audio download. Format: ${container}`);

    // Stream download with progress callback
    const downloadStream = ytdl(url, { ...ytdlOptions, filter: 'audioonly', quality: 'highestaudio' });
    const writeStream = fs.createWriteStream(tempFilePath);

    downloadStream.pipe(writeStream);

    downloadStream.on('progress', (_, downloaded, total) => {
      if (total) {
        const percent = Math.round((downloaded / total) * 75); // allocate 0-75% for downloading phase
        jobs[jobId].progress = Math.min(80, 10 + percent);
      }
    });

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      downloadStream.on('error', reject);
      writeStream.on('error', reject);
    });

    console.log(`[Job ${jobId}] Download complete. Checking conversion possibilities.`);

    if (hasFfmpeg) {
      // Convert to MP3
      jobs[jobId].status = 'converting';
      jobs[jobId].progress = 85;
      
      outputFilePath = path.join(DOWNLOADS_DIR, `${cleanTitle}-${jobId}.mp3`);
      
      console.log(`[Job ${jobId}] Starting FFmpeg transcode to MP3`);
      
      exec(`ffmpeg -y -i "${tempFilePath}" -vn -ar 44100 -ac 2 -b:a 192k "${outputFilePath}"`, (ffmpegErr) => {
        // Safe delete temp file
        try {
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        } catch (delError) {
          console.error(`Error deleting temp file ${tempFilePath}:`, delError);
        }

        if (ffmpegErr) {
          console.error(`[Job ${jobId}] FFmpeg failed:`, ffmpegErr);
          jobs[jobId].status = 'failed';
          jobs[jobId].error = 'Audio extraction failed during MP3 conversion.';
          return;
        }

        // Complete job
        console.log(`[Job ${jobId}] FFmpeg convert complete.`);
        const stats = fs.statSync(outputFilePath);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);

        jobs[jobId].status = 'completed';
        jobs[jobId].progress = 100;
        jobs[jobId].fileName = `${cleanTitle}.mp3`;
        jobs[jobId].filePath = outputFilePath;
        jobs[jobId].fileSize = `${sizeMb} MB`;
      });

    } else {
      // Fallback mode: serve downloaded high quality container (m4a or webm) directly
      console.log(`[Job ${jobId}] Static fallback used (No FFmpeg). Container: ${container}`);
      const stats = fs.statSync(tempFilePath);
      const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
      
      outputFilePath = path.join(DOWNLOADS_DIR, `${cleanTitle}-${jobId}.${container}`);
      fs.renameSync(tempFilePath, outputFilePath);

      jobs[jobId].status = 'completed';
      jobs[jobId].progress = 100;
      jobs[jobId].fileName = `${cleanTitle}.${container}`;
      jobs[jobId].filePath = outputFilePath;
      jobs[jobId].fileSize = `${sizeMb} MB`;
    }

  } catch (error: any) {
    console.error(`[Job ${jobId}] Process failed:`, error);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = error.message || 'Failed to parse and extract audio.';
    
    // Clean up files on error
    try {
      if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      if (outputFilePath && fs.existsSync(outputFilePath)) fs.unlinkSync(outputFilePath);
    } catch (ignore) {}
  }
}

// Get job status
app.get('/api/job/:id', (req, res): any => {
  const job = jobs[req.params.id];
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  res.json({ job, hasFfmpeg });
});

// Serves file as direct download and purges files directly after completion
app.get('/api/download/:id', (req, res): any => {
  const job = jobs[req.params.id];
  if (!job || job.status !== 'completed' || !job.filePath || !job.fileName) {
    return res.status(404).send('Audio file is not ready or has expired.');
  }

  const { filePath, fileName } = job;

  if (!fs.existsSync(filePath)) {
    return res.status(410).send('This download file has expired or was already deleted from the server.');
  }

  console.log(`Streaming secure audio delivery to user for file: ${fileName}`);

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
  
  res.download(filePath, fileName, (err) => {
    if (err) {
      console.error('File delivery stream error:', err);
    }

    // Auto delete file from server memory/drive immediately to maintain strict privacy & storage safety
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up downloaded file: ${filePath}`);
        }
      } catch (cleanErr) {
        console.error('Stale storage purge issue:', cleanErr);
      }
    }, 1000); // 1 second buffer to allow stream to fully shut down
  });
});

// Vite dev integration
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve production build files
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Youtube MP3 Downloader running at http://localhost:${PORT}`);
  });
}

startServer();
