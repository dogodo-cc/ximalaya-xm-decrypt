#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import logUpdate from 'log-update';
import pLimit from 'p-limit';

import { colorize, formatPath, logInfo, logWarn, logError } from './src/logger.js';
import { xmDecrypt } from './src/decrypt.js';
import { findExt, convertToMp3, writeAudioTags } from './src/audio.js';

function replaceInvalidChars(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, ' ');
}

function collectXmFiles(rootDir) {
    return fs.readdirSync(rootDir, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.xm'))
        .map((entry) => path.join(entry.parentPath, entry.name))
        .sort();
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
        outputData = await convertToMp3(outputData, detectedExt);
        outputExt = 'mp3';
    }

    const taggedAudio = await writeAudioTags(outputData, xmInfo, fileStem, outputExt);
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${fileStem}.${outputExt}`);
    await fs.promises.writeFile(outputPath, taggedAudio);

    if (verbose) {
        logInfo(`解密成功，文件保存至${formatPath(outputPath)}！`);
    }

    return outputPath;
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

                let ok = true;
                let errorMessage = '';
                try {
                    await decryptXmFile(filePath, targetOutputDir, forceMp3, false);
                } catch (error) {
                    ok = false;
                    errorMessage = error.message;
                }

                completedCount += 1;
                currentFile = processingFile;

                if (showProgressBar) {
                    logUpdate(renderBatchProgress(totalFiles, outputPath, currentFile, completedCount));
                } else if (ok) {
                    logInfo(`处理完成：${processingFile} (${index + 1}/${totalFiles})`);
                }

                return { ok, filePath, errorMessage };
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

async function main() {
    const rawArgs = process.argv.slice(2);
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
