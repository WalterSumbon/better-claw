import { join, relative, basename } from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import AdmZip from 'adm-zip';

/** 导出时排除的文件名。 */
const EXCLUDED_FILES = new Set(['restart-pending.json']);

/** 导出时排除的顶层目录名。 */
const EXCLUDED_DIRS = new Set(['logs']);

/** 导入时识别的有效顶层条目。 */
const VALID_TOP_ENTRIES = new Set(['users', 'config.yaml']);

/** 导出摘要信息。 */
export interface ExportSummary {
  /** 导出的用户数。 */
  userCount: number;
  /** 导出的文件总数。 */
  fileCount: number;
  /** zip 文件的绝对路径。 */
  outputPath: string;
}

/** 导入摘要信息。 */
export interface ImportSummary {
  /** 导入的用户数。 */
  userCount: number;
  /** 导入的文件总数。 */
  fileCount: number;
  /** 是否导入了 config.yaml。 */
  configImported: boolean;
}

/**
 * 递归将目录中的文件添加到 zip，跳过排除项。
 *
 * @param zip - AdmZip 实例。
 * @param dirPath - 要添加的目录绝对路径。
 * @param zipBasePath - zip 内的基路径前缀。
 * @returns 添加的文件数。
 */
function addDirectoryToZip(zip: AdmZip, dirPath: string, zipBasePath: string): number {
  let count = 0;
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (EXCLUDED_FILES.has(entry.name)) {
      continue;
    }

    const fullPath = join(dirPath, entry.name);
    const zipPath = zipBasePath ? `${zipBasePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      count += addDirectoryToZip(zip, fullPath, zipPath);
    } else if (entry.isFile()) {
      // adm-zip 的 addLocalFile 第二个参数是 zip 内的目录路径。
      zip.addLocalFile(fullPath, zipBasePath || '');
      count++;
    }
  }

  return count;
}

/**
 * 将 agent data 目录打包为 zip 文件。
 *
 * @param dataDir - agent data 目录的绝对路径。
 * @param outputPath - 输出 zip 文件的绝对路径。
 * @returns 导出摘要。
 * @throws 当 data 目录不存在或没有用户数据时抛出错误。
 */
export function exportData(dataDir: string, outputPath: string): ExportSummary {
  if (!existsSync(dataDir)) {
    throw new Error(`Data directory does not exist: ${dataDir}`);
  }

  const usersDir = join(dataDir, 'users');
  if (!existsSync(usersDir)) {
    throw new Error(`No users directory found in: ${dataDir}`);
  }

  const zip = new AdmZip();
  let fileCount = 0;

  // 打包 config.yaml（如果存在）。
  const configPath = join(dataDir, 'config.yaml');
  if (existsSync(configPath)) {
    zip.addLocalFile(configPath, '');
    fileCount++;
  }

  // 打包 users/ 目录。
  fileCount += addDirectoryToZip(zip, usersDir, 'users');

  // 统计用户数。
  const userCount = readdirSync(usersDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .length;

  zip.writeZip(outputPath);

  return {
    userCount,
    fileCount,
    outputPath,
  };
}

/**
 * 验证 zip 文件是否为有效的 better-claw 数据包。
 *
 * @param zip - AdmZip 实例。
 * @returns 是否包含 users/ 目录。
 */
function validateZipStructure(zip: AdmZip): boolean {
  const entries = zip.getEntries();
  return entries.some((entry) => entry.entryName.startsWith('users/'));
}

/**
 * 检查目标 data 目录是否已有用户数据。
 *
 * @param dataDir - 目标 data 目录。
 * @returns 是否已存在用户数据。
 */
export function hasExistingData(dataDir: string): boolean {
  const usersDir = join(dataDir, 'users');
  if (!existsSync(usersDir)) {
    return false;
  }
  const entries = readdirSync(usersDir, { withFileTypes: true });
  return entries.some((e) => e.isDirectory());
}

/**
 * 从 zip 文件导入 agent data 到指定目录。
 *
 * @param zipPath - zip 文件的绝对路径。
 * @param dataDir - 目标 data 目录的绝对路径。
 * @returns 导入摘要。
 * @throws 当 zip 文件不存在或结构无效时抛出错误。
 */
export function importData(zipPath: string, dataDir: string): ImportSummary {
  if (!existsSync(zipPath)) {
    throw new Error(`Zip file does not exist: ${zipPath}`);
  }

  const zip = new AdmZip(zipPath);

  if (!validateZipStructure(zip)) {
    throw new Error('Invalid data package: missing users/ directory in zip.');
  }

  const entries = zip.getEntries();
  let fileCount = 0;
  let configImported = false;
  const userIds = new Set<string>();

  for (const entry of entries) {
    // 跳过目录条目本身（只处理文件）。
    if (entry.isDirectory) {
      continue;
    }

    // 只解压有效的顶层条目。
    const topLevel = entry.entryName.split('/')[0];
    if (!VALID_TOP_ENTRIES.has(topLevel)) {
      continue;
    }

    // 跳过排除的文件。
    const fileName = basename(entry.entryName);
    if (EXCLUDED_FILES.has(fileName)) {
      continue;
    }

    // 统计用户 ID。
    if (entry.entryName.startsWith('users/')) {
      const parts = entry.entryName.split('/');
      if (parts.length >= 2 && parts[1]) {
        userIds.add(parts[1]);
      }
    }

    if (entry.entryName === 'config.yaml') {
      configImported = true;
    }

    zip.extractEntryTo(entry, dataDir, true, true);
    fileCount++;
  }

  return {
    userCount: userIds.size,
    fileCount,
    configImported,
  };
}
