import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

async function ensureParentDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function ensureJsonDir(dirPath) {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

export async function readJsonFile(filePath, {
  defaultValue = null,
  normalize = value => value,
} = {}) {
  if (!existsSync(filePath)) return cloneJson(defaultValue);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8'));
    return normalize(parsed);
  } catch {
    return cloneJson(defaultValue);
  }
}

export async function writeJsonFile(filePath, data, {
  normalize = value => value,
  atomic = true,
} = {}) {
  await ensureParentDir(filePath);
  const normalized = normalize(data);
  const content = JSON.stringify(normalized, null, 2);
  if (!atomic) {
    await writeFile(filePath, content);
    return normalized;
  }

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, filePath);
  return normalized;
}

export async function deleteJsonFile(filePath) {
  if (existsSync(filePath)) await unlink(filePath);
}

export async function listJsonFiles(dirPath) {
  await ensureJsonDir(dirPath);
  const files = await readdir(dirPath);
  return files.filter(file => file.endsWith('.json'));
}

export function createJsonFileStore({
  filePath,
  defaultValue,
  normalize = value => value,
  serialize = value => value,
}) {
  let writeQueue = Promise.resolve();

  async function ensureFile() {
    await ensureParentDir(filePath);
    if (!existsSync(filePath)) {
      await writeJsonFile(filePath, cloneJson(defaultValue), { normalize: serialize });
    }
  }

  async function read() {
    await ensureFile();
    return readJsonFile(filePath, {
      defaultValue,
      normalize: value => normalize(value),
    });
  }

  async function write(data) {
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await ensureFile();
      return writeJsonFile(filePath, data, { normalize: serialize });
    });
    return writeQueue;
  }

  async function update(mutator) {
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const data = await read();
      const result = await mutator(data);
      const stored = await writeJsonFile(filePath, data, { normalize: serialize });
      return { data: stored, result };
    });
    const { data, result } = await writeQueue;
    return result === undefined ? data : result;
  }

  return {
    filePath,
    read,
    write,
    update,
    ensureFile,
  };
}
