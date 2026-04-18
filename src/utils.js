import path from 'node:path';

export function replaceInvalidChars(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, ' ');
}

export function buildTargetOutputDir(filePath, inputRootDir, outputRootDir) {
    const relativeDir = path.dirname(path.relative(inputRootDir, filePath));
    return relativeDir === '.' ? outputRootDir : path.join(outputRootDir, relativeDir);
}
