#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import * as readline from 'readline';
import { promises as fs } from 'fs';
import * as https from 'https';
import * as http from 'http';

const execAsync = promisify(exec);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query: string): Promise<string> => 
  new Promise((resolve) => rl.question(query, resolve));

// Spinner characters
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval: NodeJS.Timeout | null = null;

function startSpinner(message: string): void {
  let i = 0;
  process.stdout.write('\n');
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${spinnerFrames[i]} ${message}`);
    i = (i + 1) % spinnerFrames.length;
  }, 80);
}

function stopSpinner(finalMessage: string): void {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
  process.stdout.write(`\r✓ ${finalMessage}\n`);
}

function updateSpinner(message: string): void {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
  }
  let i = 0;
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${spinnerFrames[i]} ${message}`);
    i = (i + 1) % spinnerFrames.length;
  }, 80);
}

async function checkFFmpeg(): Promise<boolean> {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch (error) {
    return false;
  }
}

async function fetchM3U8Content(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    
    client.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

function countM3U8Segments(m3u8Content: string): number {
  // Count .ts or .m4s segments in the playlist
  const lines = m3u8Content.split('\n');
  let count = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Count actual segment files (not comments or metadata)
    if (trimmed && !trimmed.startsWith('#') && 
        (trimmed.endsWith('.ts') || trimmed.endsWith('.m4s') || 
         trimmed.endsWith('.aac') || trimmed.endsWith('.mp4'))) {
      count++;
    }
  }
  
  return count;
}

async function getSegmentCount(m3u8Url: string): Promise<number | null> {
  try {
    const content = await fetchM3U8Content(m3u8Url);
    const count = countM3U8Segments(content);
    return count > 0 ? count : null;
  } catch (error) {
    // If we can't fetch the playlist, return null
    return null;
  }
}

async function downloadVideo(m3u8Url: string, outputName: string): Promise<boolean> {
  const startTime = Date.now();
  
  startSpinner('Analyzing M3U8 playlist...\n');
  
  // Try to get segment count
  const totalSegments = await getSegmentCount(m3u8Url);
  
  if (totalSegments) {
    stopSpinner(`Found ${totalSegments} segments\n`);
  } else {
    stopSpinner('Playlist analyzed\n');
  }
  
  // Ensure output has .mp4 extension
  if (!outputName.endsWith('.mp4')) {
    outputName += '.mp4';
  }

  // Check if output file already exists
  try {
    await fs.access(outputName);
    const overwrite = await question(`File "${outputName}" already exists. Overwrite? (y/n): `);
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Download cancelled.');
      return false;
    }
  } catch {
    // File doesn't exist, continue
  }

  startSpinner('Starting download...');

  const ffmpegCommand = `ffmpeg -i "${m3u8Url}" -c copy -bsf:a aac_adtstoasc "downloads/${outputName}" -y -progress pipe:1 -loglevel error`;

  return new Promise((resolve) => {
    const process = exec(ffmpegCommand);
    
    let currentSegment = 0;
    let lastUpdate = Date.now();
    
    if (process.stdout) {
      process.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        
        // FFmpeg progress output contains frame, fps, bitrate, time, etc.
        const progressMatch = output.match(/frame=\s*(\d+)/);
        
        if (progressMatch) {
          const now = Date.now();
          
          // Update every 200ms
          if (now - lastUpdate > 200) {
            // Estimate segment from frame count (rough approximation)
            const frames = parseInt(progressMatch[1] || "0");
            currentSegment = Math.floor(frames / 30); // Assume ~30 frames per segment
            
            if (totalSegments) {
              const percentage = Math.min(100, Math.floor((currentSegment / totalSegments) * 100));
              const segmentInfo = `${Math.min(currentSegment, totalSegments)}/${totalSegments}`;
              updateSpinner(`Downloading... ${segmentInfo} segments (${percentage}%)`);
            } else {
              updateSpinner(`Downloading... ${currentSegment} segments processed`);
            }
            
            lastUpdate = now;
          }
        }
      });
    }
    
    if (process.stderr) {
      process.stderr.on('data', (data: Buffer) => {
        // Error output
        const errorMsg = data.toString();
        if (errorMsg.includes('error') || errorMsg.includes('Error')) {
          console.error('\n' + errorMsg);
        }
      });
    }

    process.on('close', (code) => {
      const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
      
      if (code === 0) {
        stopSpinner(`Download complete! (${elapsedTime}s) → ${outputName}`);
        resolve(true);
      } else {
        stopSpinner('Download failed!');
        console.error('\n❌ Error: FFmpeg process failed. Please check the URL and try again.');
        resolve(false);
      }
    });

    process.on('error', (error) => {
      stopSpinner('Download failed!');
      console.error('\n❌ Error:', error.message);
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║   M3U8 Video Downloader (FFmpeg)     ║');
  console.log('╚═══════════════════════════════════════╝\n');

  // Check if FFmpeg is installed
  const hasFFmpeg = await checkFFmpeg();
  if (!hasFFmpeg) {
    console.error('❌ Error: FFmpeg is not installed or not in PATH.');
    console.error('Please install FFmpeg: https://ffmpeg.org/download.html\n');
    rl.close();
    return;
  }

  while (true) {
    console.log('\n' + '─'.repeat(40));
    
    const url = await question('\n📹 Enter M3U8 URL (or "exit" to quit): ');
    
    if (url.toLowerCase() === 'exit' || url.toLowerCase() === 'quit' || !url.trim()) {
      console.log('\n👋 Goodbye!\n');
      break;
    }

    // Basic URL validation
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      console.error('❌ Invalid URL. Please provide a valid HTTP/HTTPS URL.\n');
      continue;
    }

    if (!url.includes('.m3u8')) {
      console.warn('⚠️  Warning: URL does not appear to be an M3U8 file.\n');
      const proceed = await question('Continue anyway? (y/n): ');
      if (proceed.toLowerCase() !== 'y') {
        continue;
      }
    }

    const videoName = await question('💾 Enter output filename (without extension): ');
    
    if (!videoName.trim()) {
      console.error('❌ Invalid filename. Please try again.\n');
      continue;
    }

    await downloadVideo(url, videoName.trim());
  }

  rl.close();
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  if (spinnerInterval) {
    stopSpinner('Download cancelled by user');
  }
  console.log('\n\n👋 Goodbye!\n');
  process.exit(0);
});

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  rl.close();
  process.exit(1);
});