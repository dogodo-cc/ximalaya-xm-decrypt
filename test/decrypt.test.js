import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmDecrypt } from '../src/decrypt.js';
import { findExt } from '../src/audio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_XM = path.join(__dirname, '绯儿.xm');
const TMP_OUTPUT_DIR = path.join(__dirname, '..', 'node_modules', '.test-output');

describe('xmDecrypt', () => {
    after(() => {
        fs.rmSync(TMP_OUTPUT_DIR, { recursive: true, force: true });
    });

    it('should decrypt a .xm file and produce valid audio', async () => {
        const rawData = fs.readFileSync(SAMPLE_XM);
        const { xmInfo, finalData } = await xmDecrypt(rawData);

        assert.ok(Buffer.isBuffer(finalData), 'finalData should be a Buffer');
        assert.ok(finalData.length > 0, 'finalData should not be empty');
        assert.ok(xmInfo.size > 0, 'xmInfo.size should be positive');

        const ext = await findExt(finalData);
        assert.ok(['mp3', 'm4a', 'flac', 'wav'].includes(ext), `detected format should be valid audio, got: ${ext}`);

        fs.mkdirSync(TMP_OUTPUT_DIR, { recursive: true });
        const outputPath = path.join(TMP_OUTPUT_DIR, `绯儿.${ext}`);
        fs.writeFileSync(outputPath, finalData);
        assert.ok(fs.statSync(outputPath).size > 0, 'output file should not be empty');
    });

    it('should decrypt all test files successfully', async () => {
        const testFiles = fs.readdirSync(__dirname, { withFileTypes: true, recursive: true })
            .filter((e) => e.isFile() && e.name.endsWith('.xm'))
            .map((e) => path.join(e.parentPath, e.name));

        assert.ok(testFiles.length > 0, 'should have test .xm files');

        for (const file of testFiles) {
            const rawData = fs.readFileSync(file);
            const { finalData } = await xmDecrypt(rawData);
            const ext = await findExt(finalData);
            assert.ok(finalData.length > 0, `${path.basename(file)} should produce non-empty output`);
            assert.ok(ext, `${path.basename(file)} should have a detectable audio format`);
        }
    });
});
