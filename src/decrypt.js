import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getXmInfo } from './id3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const XM_KEY = Buffer.from('ximalayaximalayaximalayaximalaya', 'utf8');

let xmEncryptorPromise;

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
            const wasmPath = path.join(__dirname, '..', 'xm_encryptor.wasm');
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

export async function xmDecrypt(rawData) {
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
