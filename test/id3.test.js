import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getXmInfo } from '../src/id3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_XM = path.join(__dirname, '绯儿.xm');

describe('getXmInfo', () => {
    it('should parse XM info from a real .xm file', () => {
        const rawData = fs.readFileSync(SAMPLE_XM);
        const info = getXmInfo(rawData);

        assert.ok(info.headerSize > 0, 'headerSize should be positive');
        assert.ok(info.size > 0, 'encrypted size should be positive');
        assert.ok(info.encodingTechnology, 'encodingTechnology (TSSE) should not be empty');
        assert.ok(info.iv().length === 16, 'IV should be 16 bytes');
    });

    it('should throw on non-ID3 data', () => {
        const fakeData = Buffer.from('not an id3 file');
        assert.throws(() => getXmInfo(fakeData), /ID3/);
    });
});
