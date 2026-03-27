#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus']);

function logInfo(message) {
    console.log(message);
}

function logWarn(message) {
    console.warn(message);
}

function logError(message) {
    console.error(message);
}

// 递归扫描目录，只收集当前脚本支持合并的音频扩展名。
function collectAudioFiles(rootDir) {
    const files = [];
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectAudioFiles(fullPath));
        } else if (entry.isFile() && SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            files.push(fullPath);
        }
    }
    return files.sort();
}

function replaceInvalidChars(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, ' ');
}

function buildConcatOutputPath(inputDir) {
    const normalizedInputDir = path.resolve(inputDir);
    const inputDirName = path.basename(normalizedInputDir);
    if (!inputDirName) {
        throw new Error('不支持直接使用根目录作为输入目录');
    }
    return path.join(path.dirname(normalizedInputDir), `${inputDirName}_concat`);
}

function buildTargetOutputDir(filePath, inputRootDir, outputRootDir) {
    const relativeDir = path.dirname(path.relative(inputRootDir, filePath));
    return relativeDir === '.' ? outputRootDir : path.join(outputRootDir, relativeDir);
}

// 统一校验输入路径，并返回后续分组所需的根目录和候选音频文件列表。
function resolveInputFiles(inputPath) {
    const normalizedInputPath = path.resolve(inputPath);

    if (!fs.existsSync(normalizedInputPath)) {
        throw new Error(`路径不存在: ${normalizedInputPath}`);
    }

    if (!fs.statSync(normalizedInputPath).isDirectory()) {
        throw new Error(`输入路径不是目录: ${normalizedInputPath}`);
    }

    const inputRootDir = normalizedInputPath;
    const filesToConcat = collectAudioFiles(inputRootDir);
    if (filesToConcat.length === 0) {
        throw new Error(`在 ${inputRootDir} 及其子目录中找不到可合并的音频文件`);
    }

    return { inputRootDir, filesToConcat };
}

function printUsage() {
    logInfo('使用方法:');
    logInfo('  node audio-concat.js <audio_directory> [--preview]');
    logInfo('');
    logInfo('说明:');
    logInfo('  递归扫描目录下可被识别的音频文件，识别同名分段并合并');
    logInfo('  支持 xxx1/xxx2、xxx(1)/(2)、xxx（1）/（2）、xxx(上)/(中)/(下)、xxx（上）（中）（下）');
    logInfo(`  支持扩展名: ${Array.from(SUPPORTED_AUDIO_EXTENSIONS).join(', ')}`);
    logInfo('  输出目录固定为输入目录同级的 *_concat 目录');
}

function parseCliArgs(args) {
    let preview = false;
    let filteredArgs = [...args];

    if (filteredArgs.includes('--preview')) {
        preview = true;
        filteredArgs = filteredArgs.filter((arg) => arg !== '--preview');
    }

    if (filteredArgs.length !== 1) {
        printUsage();
        process.exit(1);
    }

    return { inputPath: filteredArgs[0], preview };
}

function findExecutable(binaryName) {
    const result = spawnSync('which', [binaryName], { encoding: 'utf8' });
    if (result.status !== 0) {
        return null;
    }
    const executable = (result.stdout || '').trim();
    return executable || null;
}

// 从文件名尾部解析分段信息，支持裸数字、括号数字以及 上/中/下 三种风格。
function parsePartInfo(filePath) {
    const parsedPath = path.parse(filePath);
    const name = parsedPath.name;

    let match = name.match(/^(.*?)(\d+)$/);
    if (match) {
        return {
            baseStem: match[1].trim(),
            style: 'plain-number',
            partIndex: Number.parseInt(match[2], 10),
        };
    }

    match = name.match(/^(.*)[(（](\d+)[)）]$/);
    if (match) {
        return {
            baseStem: match[1].trim(),
            style: 'paren-number',
            partIndex: Number.parseInt(match[2], 10),
        };
    }

    match = name.match(/^(.*)[(（](上|中|下)[)）]$/);
    if (match) {
        const indexMap = { 上: 1, 中: 2, 下: 3 };
        return {
            baseStem: match[1].trim(),
            style: 'cn-order',
            partIndex: indexMap[match[2]],
        };
    }

    return null;
}

function compareDisplayNames(left, right) {
    return left.localeCompare(right, 'zh-Hans-CN-u-kn-true', {
        numeric: true,
        sensitivity: 'base',
    });
}

// 按“所在目录 + 去掉分段后缀后的主标题”分组，避免跨目录误合并。
function buildGroups(filesToConcat) {
    const groups = new Map();

    for (const filePath of filesToConcat) {
        const partInfo = parsePartInfo(filePath);
        if (!partInfo || !partInfo.baseStem) {
            continue;
        }

        const dirPath = path.dirname(filePath);
        const key = `${dirPath}\u0000${partInfo.baseStem}`;
        if (!groups.has(key)) {
            groups.set(key, {
                dirPath,
                baseStem: partInfo.baseStem,
                items: [],
            });
        }

        groups.get(key).items.push({
            filePath,
            extension: path.extname(filePath).toLowerCase(),
            style: partInfo.style,
            partIndex: partInfo.partIndex,
        });
    }

    return Array.from(groups.values()).filter((group) => group.items.length >= 2);
}

// 严格校验每个候选组：扩展名必须一致、命名风格必须一致、序号必须完整，且输出文件不能冲突。
function validateGroup(group, inputRootDir, outputRootDir) {
    const extensionSet = new Set(group.items.map((item) => item.extension));
    if (extensionSet.size !== 1) {
        return { ok: false };
    }

    const styleSet = new Set(group.items.map((item) => item.style));
    if (styleSet.size !== 1) {
        return { ok: false };
    }

    const style = group.items[0].style;
    const sortedItems = [...group.items].sort((a, b) => a.partIndex - b.partIndex || a.filePath.localeCompare(b.filePath));

    if (style === 'cn-order') {
        const sequence = sortedItems.map((item) => item.partIndex).join(',');
        if (sequence !== '1,3' && sequence !== '1,2,3') {
            return { ok: false };
        }
    } else {
        for (let i = 0; i < sortedItems.length; i += 1) {
            if (sortedItems[i].partIndex !== i + 1) {
                return { ok: false };
            }
        }
    }

    const sampleFile = sortedItems[0].filePath;
    const targetOutputDir = buildTargetOutputDir(sampleFile, inputRootDir, outputRootDir);
    const outputExtension = sortedItems[0].extension || '.mp3';
    const outputFileName = `${replaceInvalidChars(group.baseStem).trim()}${outputExtension}`;
    if (!outputFileName || outputFileName === outputExtension) {
        return { ok: false };
    }

    const outputFilePath = path.join(targetOutputDir, outputFileName);
    const sourceConflictPath = path.join(group.dirPath, `${group.baseStem}${outputExtension}`);
    if (fs.existsSync(sourceConflictPath)) {
        return { ok: false };
    }

    if (fs.existsSync(outputFilePath)) {
        return { ok: false };
    }

    return {
        ok: true,
        style,
        outputFilePath,
        sortedItems,
    };
}

// 通过 ffmpeg concat demuxer 合并同一组音频；先写临时 list.txt，完成后清理临时目录。
function mergeGroup(ffmpegPath, group, outputFilePath) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-concat-'));

    try {
        const listFilePath = path.join(tempDir, 'list.txt');
        const listContent = group.sortedItems
            .map((item) => `file '${item.filePath.replace(/'/g, `'\\''`)}'`)
            .join('\n');
        fs.writeFileSync(listFilePath, `${listContent}\n`, 'utf8');

        fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
        const result = spawnSync(
            ffmpegPath,
            ['-y', '-f', 'concat', '-safe', '0', '-i', listFilePath, '-c', 'copy', outputFilePath],
            { encoding: 'utf8' },
        );

        if (result.status !== 0) {
            const message = (result.stderr || '').trim() || 'ffmpeg 合并失败';
            throw new Error(message);
        }

        if (!fs.existsSync(outputFilePath) || fs.statSync(outputFilePath).size === 0) {
            throw new Error('ffmpeg 已执行，但输出文件不存在或为空');
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function formatGroupPreview(group, outputFilePath) {
    const outputName = path.basename(outputFilePath);
    const sourceLines = group.sortedItems.map((item) => `- ${path.basename(item.filePath)}`).join('\n');
    return [`=> ${outputName}`, sourceLines, `将合并到: ${outputFilePath}`].join('\n');
}

// 主流程：扫描 -> 分组 -> 校验 -> 预览或实际合并。
async function main() {
    const { inputPath, preview } = parseCliArgs(process.argv.slice(2));

    let inputRootDir;
    let filesToConcat;
    let outputRootDir;

    try {
        ({ inputRootDir, filesToConcat } = resolveInputFiles(inputPath));
        outputRootDir = buildConcatOutputPath(inputRootDir);
    } catch (error) {
        logError(`错误: ${error.message}`);
        process.exit(1);
    }

    const allGroups = buildGroups(filesToConcat);
    const validatedGroups = [];
    const plannedOutputs = new Set();

    for (const group of allGroups) {
        const validation = validateGroup(group, inputRootDir, outputRootDir);
        if (!validation.ok) {
            continue;
        }

        if (plannedOutputs.has(validation.outputFilePath)) {
            continue;
        }

        plannedOutputs.add(validation.outputFilePath);
        validatedGroups.push({
            ...group,
            sortedItems: validation.sortedItems,
            outputFilePath: validation.outputFilePath,
        });
    }

    validatedGroups.sort((a, b) => compareDisplayNames(path.basename(a.outputFilePath), path.basename(b.outputFilePath)));

    logInfo(`扫描到 ${filesToConcat.length} 个音频文件`);
    logInfo(`识别到 ${allGroups.length} 组候选分段`);

    if (validatedGroups.length === 0) {
        logWarn('没有可合并的有效分组');
        return;
    }

    if (preview) {
        logInfo('以下为识别到的可合并分组:');
        for (const group of validatedGroups) {
            logInfo(formatGroupPreview(group, group.outputFilePath));
            logInfo('');
        }
        return;
    }

    const ffmpegPath = findExecutable('ffmpeg');
    if (!ffmpegPath) {
        logError('错误: 未找到 ffmpeg，请先安装并确保其在 PATH 中');
        process.exit(1);
    }

    let mergedCount = 0;
    let failedCount = 0;

    for (const group of validatedGroups) {
        try {
            logInfo(`开始合并:\n${formatGroupPreview(group, group.outputFilePath)}`);
            mergeGroup(ffmpegPath, group, group.outputFilePath);
            mergedCount += 1;
            logInfo(`合并完成: ${group.outputFilePath}`);
        } catch (error) {
            failedCount += 1;
            logError(`合并失败 ${group.baseStem}: ${error.message}`);
        }
    }

    logInfo(`汇总: 候选组 ${allGroups.length}，可合并 ${validatedGroups.length}，成功 ${mergedCount}，失败 ${failedCount}`);

    if (failedCount > 0) {
        process.exit(1);
    }
}

main().catch((error) => {
    logError(`错误: ${error.message}`);
    process.exit(1);
});
