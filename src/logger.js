const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const COLORIZE_RE = /(\x1b\[[0-9;]*m(?:(?!\x1b\[0m)[\s\S])*\x1b\[0m)|(mp3|flac|m4a|wav)|(\b\d+\.?\d*\b)/gi;

export function colorize(message) {
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

export function formatPath(filePath) {
    return ` "${YELLOW}${filePath}${RESET}"`;
}

export function logInfo(message) {
    console.log(colorize(message));
}

export function logWarn(message) {
    console.warn(`${YELLOW}${message}${RESET}`);
}

export function logError(message) {
    console.error(`${RED}${message}${RESET}`);
}
