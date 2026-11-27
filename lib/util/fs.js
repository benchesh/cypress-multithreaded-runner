const fs = require('fs-extra');
const path = require('path');

const mkdirSyncIfMissing = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

/**
 * Write to a file, creating any missing parent directories
 */
const writeFileSyncRecursive = (filepath, content = '') => {
    mkdirSyncIfMissing(path.dirname(filepath));
    fs.writeFileSync(filepath, content, { flag: 'w' });
};

const writeJsonSyncRecursive = (filepath, obj) => {
    writeFileSyncRecursive(filepath, `${JSON.stringify(obj, null, 4)}\n`);
};

const readJsonSafe = (filepath, fallback = null) => {
    try {
        return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch {
        return fallback;
    }
};

/**
 * Files (not directories) directly within a directory. Returns [] if the directory doesn't exist
 */
const getFiles = (dir) => {
    if (!dir || !fs.existsSync(dir)) {
        return [];
    }

    return fs.readdirSync(dir)
        .map((file) => path.join(dir, file))
        .filter((filepath) => !fs.statSync(filepath).isDirectory());
};

/**
 * All files within a directory, recursively, in a stable (alphabetical) order.
 * If `srcpath` is a file, it's returned on its own
 */
const getFilesRecursive = (srcpath) => {
    if (!srcpath || !fs.existsSync(srcpath)) {
        return [];
    }

    if (!fs.statSync(srcpath).isDirectory()) {
        return [srcpath];
    }

    return fs.readdirSync(srcpath)
        .sort()
        .flatMap((file) => getFilesRecursive(path.join(srcpath, file)));
};

/**
 * Recursively delete empty directories (ignoring .DS_Store files)
 */
const deleteEmptyFoldersRecursively = (folder) => {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        return;
    }

    const listContents = () => fs.readdirSync(folder).filter((file) => file !== '.DS_Store');

    listContents().forEach((file) => deleteEmptyFoldersRecursively(path.join(folder, file)));

    if (!listContents().length) {
        fs.rmSync(folder, { recursive: true });
    }
};

/**
 * A path relative to the current working directory, always using forward slashes
 */
const toPosixRelative = (filepath, from = process.cwd()) => path.relative(from, path.resolve(filepath)).split(path.sep).join('/');

module.exports = {
    mkdirSyncIfMissing,
    writeFileSyncRecursive,
    writeJsonSyncRecursive,
    readJsonSafe,
    getFiles,
    getFilesRecursive,
    deleteEmptyFoldersRecursively,
    toPosixRelative,
};
