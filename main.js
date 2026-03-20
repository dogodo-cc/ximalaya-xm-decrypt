#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import logUpdate from 'log-update';
import { parseBuffer } from 'music-metadata';
import NodeID3 from 'node-id3';
import pLimit from 'p-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const COLORIZE_RE = /(\x1b\[[0-9;]*m(?:(?!\x1b\[0m)[\s\S])*\x1b\[0m)|(mp3|flac|m4a|wav)|(\b\d+\.?\d*\b)/gi;
const XM_KEY = Buffer.from('ximalayaximalayaximalayaximalaya', 'utf8');

let xmEncryptorPromise;

function colorize(message) {
    return message.replace(COLORIZE_RE, (match, coloredSpan, formatName, numberText) => {
        if (coloredSpan) {
            return coloredSpan;
        }
        if (formatName) {
            return `${GREEN}${formatName}${RESET}`;
        }
        return `${BLUE}${numberText}${RESET}`;
    });
}

function formatPath(filePath) {
    return ` "${YELLOW}${filePath}${RESET}"`;
}

function logInfo(message) {
    console.log(colorize(message));
}

function logWarn(message) {
    console.warn(`${YELLOW}${message}${RESET}`);
}

function logError(message) {
    console.error(`${RED}${message}${RESET}`);
}

class XMInfo {
    constructor(fields = {}) {
        this.title = fields.title || '';
        this.artist = fields.artist || '';
        this.album = fields.album || '';
        this.tracknumber = fields.tracknumber || 0;
        this.size = fields.size || 0;
        this.headerSize = fields.headerSize || 0;
        this.ISRC = fields.ISRC || '';
        this.encodedby = fields.encodedby || '';
        this.encodingTechnology = fields.encodingTechnology || '';
    }

    iv() {
        const source = this.ISRC !== '' ? this.ISRC : this.encodedby;
        if (!source || source.length % 2 !== 0) {
            throw new Error('无法从 TSRC/TENC 构造 AES IV');
        }
        return Buffer.from(source, 'hex');
    }
}

function decodeSyncSafeInteger(buffer) {
    return ((buffer[0] & 0x7f) << 21) | ((buffer[1] & 0x7f) << 14) | ((buffer[2] & 0x7f) << 7) | (buffer[3] & 0x7f);
}

function decodeFrameSize(buffer, versionMajor) {
    if (versionMajor === 4) {
        return decodeSyncSafeInteger(buffer);
    }
    return buffer.readUInt32BE(0);
}

function removeUnsynchronization(data) {
    const output = [];
    for (let index = 0; index < data.length; index += 1) {
        const current = data[index];
        if (current === 0xff && index + 1 < data.length && data[index + 1] === 0x00) {
            output.push(0xff);
            index += 1;
            continue;
        }
        output.push(current);
    }
    return Buffer.from(output);
}

function parseId3Header(rawData) {
    if (rawData.length < 10 || rawData.subarray(0, 3).toString('ascii') !== 'ID3') {
        throw new Error('XM 文件头中缺少 ID3 标签');
    }

    const versionMajor = rawData[3];
    const flags = rawData[5];
    const tagPayloadSize = decodeSyncSafeInteger(rawData.subarray(6, 10));
    const hasFooter = versionMajor === 4 && (flags & 0x10) !== 0;
    const totalTagSize = 10 + tagPayloadSize + (hasFooter ? 10 : 0);

    return {
        versionMajor,
        totalTagSize,
        tagPayloadStart: 10,
        tagPayloadEnd: 10 + tagPayloadSize,
        unsynchronized: (flags & 0x80) !== 0,
        hasExtendedHeader: (flags & 0x40) !== 0,
    };
}

function getExtendedHeaderSize(tagData, versionMajor) {
    if (tagData.length < 4) {
        throw new Error('ID3 扩展头长度不足');
    }

    if (versionMajor === 4) {
        return decodeSyncSafeInteger(tagData.subarray(0, 4));
    }

    return tagData.readUInt32BE(0);
}

function decodeTextFrame(frameData) {
    if (!frameData || frameData.length === 0) {
        return '';
    }

    const encoding = frameData[0];
    const body = frameData.subarray(1);

    if (encoding === 0) {
        return Buffer.from(body).toString('latin1').replace(/\0+$/g, '').trim();
    }

    if (encoding === 3) {
        return Buffer.from(body).toString('utf8').replace(/\0+$/g, '').trim();
    }

    if (encoding === 1) {
        if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
            return new TextDecoder('utf-16be').decode(body.subarray(2)).replace(/\0+$/g, '').trim();
        }
        if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
            return new TextDecoder('utf-16le').decode(body.subarray(2)).replace(/\0+$/g, '').trim();
        }
        return new TextDecoder('utf-16le').decode(body).replace(/\0+$/g, '').trim();
    }

    if (encoding === 2) {
        return new TextDecoder('utf-16be').decode(body).replace(/\0+$/g, '').trim();
    }

    return Buffer.from(body).toString('utf8').replace(/\0+$/g, '').trim();
}

function parseTrackNumber(text) {
    const match = String(text || '').match(/\d+/);
    return match ? Number.parseInt(match[0], 10) : 0;
}

function getRawTagString(tags, frameName) {
    const rawValue = tags?.raw?.[frameName];
    if (Array.isArray(rawValue)) {
        return String(rawValue[0] || '').trim();
    }
    if (rawValue == null) {
        return '';
    }
    return String(rawValue).trim();
}

function getManualTagMap(rawData, id3Header) {
    let tagData = rawData.subarray(id3Header.tagPayloadStart, id3Header.tagPayloadEnd);
    if (id3Header.unsynchronized) {
        tagData = removeUnsynchronization(tagData);
    }

    let offset = 0;
    if (id3Header.hasExtendedHeader) {
        const extendedHeaderSize = getExtendedHeaderSize(tagData, id3Header.versionMajor);
        if (extendedHeaderSize <= 0 || extendedHeaderSize > tagData.length) {
            throw new Error('ID3 扩展头长度非法');
        }
        offset += extendedHeaderSize;
    }

    const tagMap = new Map();
    while (offset + 10 <= tagData.length) {
        const frameId = tagData.subarray(offset, offset + 4).toString('ascii');
        if (!frameId.trim() || /^\x00+$/.test(frameId)) {
            break;
        }

        const frameSize = decodeFrameSize(tagData.subarray(offset + 4, offset + 8), id3Header.versionMajor);
        const frameDataStart = offset + 10;
        const frameDataEnd = frameDataStart + frameSize;
        if (frameSize <= 0 || frameDataEnd > tagData.length) {
            break;
        }

        tagMap.set(frameId, decodeTextFrame(tagData.subarray(frameDataStart, frameDataEnd)));
        offset = frameDataEnd;
    }

    return tagMap;
}

function getXmInfo(rawData) {
    const id3Header = parseId3Header(rawData);
    let parsedTags = {};

    try {
        parsedTags = NodeID3.read(rawData, { noRaw: false }) || {};
    } catch {
        parsedTags = {};
    }

    const manualTagMap = getManualTagMap(rawData, id3Header);

    const info = new XMInfo({
        headerSize: id3Header.totalTagSize,
        title: String(parsedTags.title || manualTagMap.get('TIT2') || ''),
        album: String(parsedTags.album || manualTagMap.get('TALB') || ''),
        artist: String(parsedTags.artist || manualTagMap.get('TPE1') || ''),
        tracknumber: parseTrackNumber(parsedTags.trackNumber || manualTagMap.get('TRCK') || ''),
        ISRC: String(parsedTags.ISRC || getRawTagString(parsedTags, 'TSRC') || manualTagMap.get('TSRC') || ''),
        encodedby: String(parsedTags.encodedBy || getRawTagString(parsedTags, 'TENC') || manualTagMap.get('TENC') || ''),
        size: Number.parseInt(String(parsedTags.size || getRawTagString(parsedTags, 'TSIZ') || manualTagMap.get('TSIZ') || '0'), 10) || 0,
        encodingTechnology: String(parsedTags.encodingTechnology || getRawTagString(parsedTags, 'TSSE') || manualTagMap.get('TSSE') || ''),
    });

    if (!info.size) {
        throw new Error('无法从 TSIZ 读取加密音频长度');
    }

    if (!info.encodingTechnology) {
        throw new Error('无法从 TSSE 读取 base64 前缀');
    }

    return info;
}

function getPrintablePrefix(data) {
    for (let index = 0; index < data.length; index += 1) {
        const value = data[index];
        if (value < 0x20 || value > 0x7e) {
            return data.subarray(0, index);
        }
    }
    return data;
}

function pkcs7Pad(buffer, blockSize) {
    const remainder = buffer.length % blockSize;
    const padLength = remainder === 0 ? blockSize : blockSize - remainder;
    return Buffer.concat([buffer, Buffer.alloc(padLength, padLength)]);
}

async function getXmEncryptor() {
    if (!xmEncryptorPromise) {
        xmEncryptorPromise = (async () => {
            const wasmPath = path.join(__dirname, 'xm_encryptor.wasm');
            const wasmBytes = await fs.promises.readFile(wasmPath);
            const { instance } = await WebAssembly.instantiate(wasmBytes, {});
            return instance;
        })();
    }
    return xmEncryptorPromise;
}

function writeBytesToMemory(memory, offset, data) {
    if (!data || data.length === 0) {
        return;
    }
    const view = new Uint8Array(memory.buffer, offset, data.length);
    view.set(data);
}

async function xmDecrypt(rawData) {
    const xmInfo = getXmInfo(rawData);
    const encryptedData = rawData.subarray(xmInfo.headerSize, xmInfo.headerSize + xmInfo.size);

    const cipher = crypto.createDecipheriv('aes-256-cbc', XM_KEY, xmInfo.iv());
    cipher.setAutoPadding(false);
    let decryptedStage1 = Buffer.concat([cipher.update(pkcs7Pad(encryptedData, 16)), cipher.final()]);

    decryptedStage1 = getPrintablePrefix(decryptedStage1);
    const trackId = Buffer.from(String(xmInfo.tracknumber), 'utf8');
    const instance = await getXmEncryptor();
    const wasmExports = instance.exports;
    const stackPointer = wasmExports.a(-16);
    const decryptedOffset = wasmExports.c(decryptedStage1.length);
    const trackIdOffset = wasmExports.c(trackId.length);
    const wasmMemory = wasmExports.i;

    writeBytesToMemory(wasmMemory, decryptedOffset, decryptedStage1);
    writeBytesToMemory(wasmMemory, trackIdOffset, trackId);
    wasmExports.g(stackPointer, decryptedOffset, decryptedStage1.length, trackIdOffset, trackId.length);

    const metadataBuffer = wasmMemory.buffer;
    const resultMeta = new Int32Array(metadataBuffer, stackPointer, 4);
    const resultPointer = resultMeta[0];
    const resultLength = resultMeta[1];
    if (resultMeta[2] !== 0 || resultMeta[3] !== 0) {
        throw new Error(`XM wasm 校验失败: flags[2]=${resultMeta[2]}, flags[3]=${resultMeta[3]}`);
    }

    const resultBuffer = wasmMemory.buffer;
    const resultBytes = Buffer.from(new Uint8Array(resultBuffer, resultPointer, resultLength));
    const resultData = resultBytes.toString('utf8');
    const decryptedData = Buffer.from(xmInfo.encodingTechnology + resultData, 'base64');
    const finalData = Buffer.concat([decryptedData, rawData.subarray(xmInfo.headerSize + xmInfo.size)]);

    return { xmInfo, finalData };
}

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

async function findExt(data) {
    const detectedByMetadata = await detectAudioFormatWithMetadata(data);
    if (detectedByMetadata) {
        return detectedByMetadata;
    }

    return detectAudioFormatBySignature(data.subarray(0, Math.min(data.length, 4096)));
}

function convertToMp3(audioData, sourceExt) {
    const ffmpegPath = findExecutable('ffmpeg');
    if (!ffmpegPath) {
        throw new Error('未找到 ffmpeg，请先安装 ffmpeg 后再使用 -mp3 参数');
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-decrypt-'));
    const inputFile = path.join(tempRoot, `input.${sourceExt}`);
    const outputFile = path.join(tempRoot, 'output.mp3');

    try {
        fs.writeFileSync(inputFile, audioData);
        const result = spawnSync(ffmpegPath, ['-y', '-i', inputFile, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', outputFile], { encoding: 'utf8' });

        if (result.status !== 0) {
            throw new Error(`音频转码失败: ${(result.stderr || '').trim()}`);
        }

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

function writeContainerTagsWithFfmpeg(audioData, outputExt, tags) {
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
        const result = spawnSync(ffmpegPath, ffmpegArgs, { encoding: 'utf8' });
        if (result.status !== 0) {
            throw new Error(`ffmpeg 写入 ${outputExt} 标签失败: ${(result.stderr || '').trim()}`);
        }
        return fs.readFileSync(outputFile);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function writeAudioTags(audioData, info, fileStem, outputExt) {
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
        return writeContainerTagsWithFfmpeg(audioData, outputExt, tags);
    }

    logWarn(`暂不支持为 ${outputExt} 写入标签，将保留原始音频数据`);
    return audioData;
}

async function decryptXmFile(fromFile, outputDir = './output', forceMp3 = false, verbose = true) {
    if (verbose) {
        logInfo(`正在解密${formatPath(fromFile)}`);
    }

    const rawData = await fs.promises.readFile(fromFile);
    const { xmInfo, finalData } = await xmDecrypt(rawData);
    const detectedExt = await findExt(finalData);
    let outputExt = detectedExt;
    let outputData = finalData;
    const fileStem = replaceInvalidChars(path.parse(fromFile).name).trim();

    if (forceMp3 && detectedExt !== 'mp3') {
        if (verbose) {
            logInfo(`检测到格式为 ${detectedExt}，开始转码为 mp3`);
        }
        outputData = convertToMp3(outputData, detectedExt);
        outputExt = 'mp3';
    }

    const taggedAudio = writeAudioTags(outputData, xmInfo, fileStem, outputExt);
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${fileStem}.${outputExt}`);
    await fs.promises.writeFile(outputPath, taggedAudio);

    if (verbose) {
        logInfo(`解密成功，文件保存至${formatPath(outputPath)}！`);
    }

    return outputPath;
}

function collectXmFiles(rootDir) {
    const files = [];
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectXmFiles(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xm')) {
            files.push(fullPath);
        }
    }
    return files.sort();
}

function replaceInvalidChars(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, ' ');
}

function buildUnlockOutputPath(inputDir) {
    const normalizedInputDir = path.resolve(inputDir);
    const inputDirName = path.basename(normalizedInputDir);
    if (!inputDirName) {
        throw new Error('不支持直接使用根目录作为输入目录');
    }
    return path.join(path.dirname(normalizedInputDir), `${inputDirName}_unlock`);
}

function buildTargetOutputDir(filePath, inputRootDir, outputRootDir) {
    const relativeDir = path.dirname(path.relative(inputRootDir, filePath));
    return relativeDir === '.' ? outputRootDir : path.join(outputRootDir, relativeDir);
}

function resolveInputFiles(inputPath) {
    const normalizedInputPath = path.resolve(inputPath);
    if (fs.existsSync(normalizedInputPath) && fs.statSync(normalizedInputPath).isDirectory()) {
        const inputRootDir = normalizedInputPath;
        const filesToDecrypt = collectXmFiles(inputRootDir);
        if (filesToDecrypt.length === 0) {
            throw new Error(`在 ${inputRootDir} 及其子目录中找不到 .xm 文件`);
        }
        return { inputRootDir, filesToDecrypt };
    }

    if (!fs.existsSync(normalizedInputPath) || !fs.statSync(normalizedInputPath).isFile()) {
        throw new Error(`${inputPath} 不是有效的文件或目录`);
    }

    if (!normalizedInputPath.toLowerCase().endsWith('.xm')) {
        logWarn(`警告: ${normalizedInputPath} 可能不是 .xm 文件`);
    }

    return {
        inputRootDir: path.dirname(normalizedInputPath),
        filesToDecrypt: [normalizedInputPath],
    };
}

function printUsage() {
    logInfo('使用方法:');
    logInfo('  npm run decrypt -- <xm_file_path_or_directory> [-mp3]');
    logInfo('  node xm_decrypt.js <xm_file_path_or_directory> [-mp3]');
    logInfo('');
    logInfo('说明:');
    logInfo('  传入文件时，只处理该文件，并以其父目录作为输入目录');
    logInfo('  传入目录时，递归处理目录下所有 .xm 文件');
    logInfo('  输出目录固定为输入目录同级的 *_unlock 目录');
}

function buildProgressBar(completedCount, totalFiles, width = 30) {
    const safeTotal = Math.max(totalFiles, 1);
    const ratio = Math.min(Math.max(completedCount / safeTotal, 0), 1);
    const filledWidth = Math.round(ratio * width);
    const emptyWidth = Math.max(width - filledWidth, 0);
    return `${'█'.repeat(filledWidth)}${' '.repeat(emptyWidth)}`;
}

function renderBatchProgress(totalFiles, outputPath, currentFile, completedCount) {
    const percentage = Math.round((completedCount / Math.max(totalFiles, 1)) * 100);
    const progressBar = buildProgressBar(completedCount, totalFiles);

    return [
        colorize(`当前任务总数：${totalFiles}`),
        `当前输出路径：${outputPath}`,
        `当前完成任务：${currentFile}`,
        colorize(`当前任务进度：${progressBar} ${completedCount}/${totalFiles} (${percentage}%)`),
    ].join('\n');
}

function parseCliArgs(args) {
    let forceMp3 = false;
    let filteredArgs = [...args];

    if (filteredArgs.includes('-mp3')) {
        forceMp3 = true;
        filteredArgs = filteredArgs.filter((arg) => arg !== '-mp3');
    }

    if (filteredArgs.length !== 1) {
        if (filteredArgs.length > 1) {
            logError('错误: 不再支持自定义输出目录，输出会自动写入输入目录同级的 *_unlock 目录');
        }
        printUsage();
        process.exit(1);
    }

    return { inputPath: filteredArgs[0], forceMp3 };
}

function parseWorkerArgs(args) {
    const [workerMode, fromFile, outputDir, mp3Flag] = args;
    if (workerMode !== '--worker' || !fromFile || !outputDir) {
        throw new Error('无效的内部 worker 参数');
    }

    return {
        fromFile,
        outputDir,
        forceMp3: mp3Flag === '--worker-mp3',
    };
}

function runDecryptWorker(fromFile, outputDir, forceMp3) {
    return new Promise((resolve) => {
        const workerArgs = [__filename, '--worker', fromFile, outputDir];
        if (forceMp3) {
            workerArgs.push('--worker-mp3');
        }

        const child = spawn(process.execPath, workerArgs, {
            cwd: __dirname,
            stdio: ['ignore', 'ignore', 'pipe'],
        });

        let stderrText = '';
        child.stderr.on('data', (chunk) => {
            stderrText += chunk.toString('utf8');
        });

        child.on('error', (error) => {
            resolve({ ok: false, errorMessage: error.message });
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ ok: true, errorMessage: '' });
                return;
            }

            const cleaned = stderrText
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .at(-1);

            resolve({
                ok: false,
                errorMessage: cleaned || `worker 退出码 ${code}`,
            });
        });
    });
}

async function runBatchDecrypt(inputRootDir, filesToDecrypt, outputPath, forceMp3) {
    const totalFiles = filesToDecrypt.length;
    const concurrency = Math.min(Math.max(os.cpus().length, 1), totalFiles);
    const limit = pLimit(concurrency);
    const failedFiles = [];
    let successful = 0;
    let failed = 0;
    const showProgressBar = process.stdout.isTTY;
    let completedCount = 0;
    let currentFile = '等待中';

    if (showProgressBar) {
        logUpdate(renderBatchProgress(totalFiles, outputPath, currentFile, completedCount));
    } else {
        logInfo(`当前任务总数：${totalFiles}`);
        logInfo(`当前输出路径：${outputPath}`);
        logInfo(`当前批量并发数：${concurrency}`);
    }

    const results = await Promise.all(
        filesToDecrypt.map((filePath, index) =>
            limit(async () => {
                const targetOutputDir = buildTargetOutputDir(filePath, inputRootDir, outputPath);
                const processingFile = path.basename(filePath);
                if (!showProgressBar) {
                    logInfo(`开始处理：${processingFile} (${index + 1}/${totalFiles})`);
                }

                const workerResult = await runDecryptWorker(filePath, targetOutputDir, forceMp3);
                completedCount += 1;
                currentFile = processingFile;

                if (showProgressBar) {
                    logUpdate(renderBatchProgress(totalFiles, outputPath, currentFile, completedCount));
                } else if (workerResult.ok) {
                    logInfo(`处理完成：${processingFile} (${index + 1}/${totalFiles})`);
                }

                return {
                    ok: workerResult.ok,
                    filePath,
                    errorMessage: workerResult.errorMessage,
                };
            }),
        ),
    );

    if (showProgressBar) {
        logUpdate.done();
        logInfo(`当前批量并发数：${concurrency}`);
    }

    for (const result of results) {
        if (result.ok) {
            successful += 1;
            continue;
        }
        failed += 1;
        failedFiles.push([result.filePath, result.errorMessage]);
    }

    logInfo(`=====>> 解密完成！成功: ${successful}/${totalFiles}, 失败: ${failed}/${totalFiles}`);
    if (failedFiles.length > 0) {
        logError('以下文件解密失败:');
        for (const [failedFile, errorMessage] of failedFiles) {
            logError(`- ${failedFile}: ${errorMessage}`);
        }
    }
}

function findExecutable(binaryName) {
    const result = spawnSync('which', [binaryName], { encoding: 'utf8' });
    if (result.status !== 0) {
        return null;
    }
    const executable = (result.stdout || '').trim();
    return executable || null;
}

async function main() {
    const rawArgs = process.argv.slice(2);

    if (rawArgs[0] === '--worker') {
        const workerArgs = parseWorkerArgs(rawArgs);
        await decryptXmFile(workerArgs.fromFile, workerArgs.outputDir, workerArgs.forceMp3, false);
        return;
    }

    const { inputPath, forceMp3 } = parseCliArgs(rawArgs);
    let inputRootDir;
    let filesToDecrypt;
    let outputPath;

    try {
        ({ inputRootDir, filesToDecrypt } = resolveInputFiles(inputPath));
        outputPath = buildUnlockOutputPath(inputRootDir);
    } catch (error) {
        logError(`错误: ${error.message}`);
        process.exit(1);
    }

    await runBatchDecrypt(inputRootDir, filesToDecrypt, outputPath, forceMp3);
}

main().catch((error) => {
    logError(`程序执行失败: ${error.message}`);
    process.exit(1);
});
