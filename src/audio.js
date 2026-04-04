import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseBuffer } from 'music-metadata';
import NodeID3 from 'node-id3';

import { logWarn } from './logger.js';

async function detectAudioFormatWithMetadata(data) {
    try {
        const metadata = await parseBuffer(data, { size: data.length }, { duration: false, skipPostHeaders: true });
        const container = String(metadata.format.container || '').toLowerCase();
        const codec = String(metadata.format.codec || '').toLowerCase();
        const mimeType = String(metadata.format.mimeType || '').toLowerCase();

        if (container.includes('mpeg') || mimeType.includes('mpeg')) {
            return 'mp3';
        }
        if (container.includes('flac')) {
            return 'flac';
        }
        if (container.includes('wave') || container.includes('wav')) {
            return 'wav';
        }
        if (container.includes('mp4') || container.includes('m4a') || mimeType.includes('mp4') || codec.includes('aac')) {
            return 'm4a';
        }
    } catch {
        return null;
    }

    return null;
}

function detectAudioFormatBySignature(data) {
    if (data.length < 4) {
        throw new Error('数据过短，无法识别音频格式');
    }

    if (data.subarray(0, 3).equals(Buffer.from('ID3')) || data.subarray(0, 2).equals(Buffer.from([0xff, 0xfb])) || data.subarray(0, 2).equals(Buffer.from([0xff, 0xfa]))) {
        return 'mp3';
    }

    if (data.subarray(0, 4).equals(Buffer.from('fLaC'))) {
        return 'flac';
    }

    if (data.subarray(0, 4).equals(Buffer.from('RIFF')) && data.length >= 12 && data.subarray(8, 12).equals(Buffer.from('WAVE'))) {
        return 'wav';
    }

    if (data.length >= 12 && data.subarray(4, 8).equals(Buffer.from('ftyp'))) {
        const brand = data.subarray(8, 12).toString('latin1');
        if (['M4A', 'isom', 'iso2', 'mp42'].some((signature) => brand.includes(signature))) {
            return 'm4a';
        }
    }

    throw new Error('无法根据文件签名识别音频格式');
}

export async function findExt(data) {
    try {
        return detectAudioFormatBySignature(data.subarray(0, Math.min(data.length, 4096)));
    } catch {
        // magic bytes 识别失败，回退到 metadata 解析
    }

    const detectedByMetadata = await detectAudioFormatWithMetadata(data);
    if (detectedByMetadata) {
        return detectedByMetadata;
    }

    throw new Error('无法识别音频格式');
}

function spawnAsync(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderrText = '';
        child.stderr.on('data', (chunk) => {
            stderrText += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(stderrText.trim() || `exit code ${code}`));
            }
        });
    });
}

const executableCache = new Map();

export function findExecutable(binaryName) {
    if (executableCache.has(binaryName)) {
        return executableCache.get(binaryName);
    }
    const result = spawnSync('which', [binaryName], { encoding: 'utf8' });
    const executable = result.status === 0 ? (result.stdout || '').trim() || null : null;
    executableCache.set(binaryName, executable);
    return executable;
}

export async function convertToMp3(audioData, sourceExt) {
    const ffmpegPath = findExecutable('ffmpeg');
    if (!ffmpegPath) {
        throw new Error('未找到 ffmpeg，请先安装 ffmpeg 后再使用 -mp3 参数');
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-decrypt-'));
    const inputFile = path.join(tempRoot, `input.${sourceExt}`);
    const outputFile = path.join(tempRoot, 'output.mp3');

    try {
        fs.writeFileSync(inputFile, audioData);
        await spawnAsync(ffmpegPath, ['-y', '-i', inputFile, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', outputFile]);
        return fs.readFileSync(outputFile);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function buildAudioTags(info, fileStem) {
    return {
        title: fileStem,
        album: String(info.album || '').trim(),
        artist: String(info.artist || '').trim(),
    };
}

async function writeContainerTagsWithFfmpeg(audioData, outputExt, tags) {
    const ffmpegPath = findExecutable('ffmpeg');
    if (!ffmpegPath) {
        throw new Error(`未找到 ffmpeg，无法为 ${outputExt} 写入标签`);
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-decrypt-tags-'));
    const inputFile = path.join(tempRoot, `input.${outputExt}`);
    const outputFile = path.join(tempRoot, `output.${outputExt}`);
    const ffmpegArgs = ['-y', '-i', inputFile, '-map', '0', '-c', 'copy'];

    if (tags.title) {
        ffmpegArgs.push('-metadata', `title=${tags.title}`);
    }
    if (tags.artist) {
        ffmpegArgs.push('-metadata', `artist=${tags.artist}`);
    }
    if (tags.album) {
        ffmpegArgs.push('-metadata', `album=${tags.album}`);
    }

    ffmpegArgs.push(outputFile);

    try {
        fs.writeFileSync(inputFile, audioData);
        await spawnAsync(ffmpegPath, ffmpegArgs);
        return fs.readFileSync(outputFile);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

export async function writeAudioTags(audioData, info, fileStem, outputExt) {
    const tags = buildAudioTags(info, fileStem);

    if (outputExt === 'mp3') {
        const taggedAudio = NodeID3.update(
            {
                title: tags.title,
                album: tags.album,
                artist: tags.artist,
            },
            audioData,
        );
        if (Buffer.isBuffer(taggedAudio)) {
            return taggedAudio;
        }

        const rewrittenAudio = NodeID3.write(
            {
                title: tags.title,
                album: tags.album,
                artist: tags.artist,
            },
            audioData,
        );
        if (Buffer.isBuffer(rewrittenAudio)) {
            return rewrittenAudio;
        }

        throw new Error('node-id3 写入 mp3 标签失败');
    }

    if (outputExt === 'flac' || outputExt === 'm4a') {
        return await writeContainerTagsWithFfmpeg(audioData, outputExt, tags);
    }

    logWarn(`暂不支持为 ${outputExt} 写入标签，将保留原始音频数据`);
    return audioData;
}
