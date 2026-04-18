import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { replaceInvalidChars, buildTargetOutputDir } from '../src/utils.js';

describe('replaceInvalidChars', () => {
    it('should replace backslash and colon', () => {
        assert.equal(replaceInvalidChars('a\\b:c'), 'a b c');
    });

    it('should replace all invalid chars', () => {
        assert.equal(replaceInvalidChars('a*b?c"d<e>f|g'), 'a b c d e f g');
    });

    it('should keep normal characters', () => {
        assert.equal(replaceInvalidChars('hello world'), 'hello world');
    });

    it('should handle empty string', () => {
        assert.equal(replaceInvalidChars(''), '');
    });

    it('should handle non-string input', () => {
        assert.equal(replaceInvalidChars(123), '123');
    });
});

describe('buildTargetOutputDir', () => {
    it('should return outputRootDir when file is in inputRootDir', () => {
        const result = buildTargetOutputDir('/input/file.xm', '/input', '/output');
        assert.equal(result, '/output');
    });

    it('should preserve relative subdirectory', () => {
        const result = buildTargetOutputDir('/input/sub/file.xm', '/input', '/output');
        assert.equal(result, '/output/sub');
    });

    it('should preserve nested subdirectories', () => {
        const result = buildTargetOutputDir('/input/a/b/file.xm', '/input', '/output');
        assert.equal(result, '/output/a/b');
    });
});
