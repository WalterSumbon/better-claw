import { readdirSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getLogger } from '../logger/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 仓库内 skills 目录的绝对路径。 */
const REPO_SKILLS_DIR = resolve(__dirname, '../../skills');

/** 全局 Claude Code skills 目录。 */
const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills');

/**
 * 将仓库内的 skills 通过 symlink 安装到 ~/.claude/skills/。
 *
 * 规则：
 * - 仅处理 skills/ 下包含 SKILL.md 的子目录。
 * - 如果目标已是指向当前仓库的 symlink，跳过（幂等）。
 * - 如果目标已是指向其他位置的 symlink，更新为当前仓库。
 * - 如果目标已是非 symlink 的目录/文件，跳过（不覆盖用户自定义）。
 */
export function installSkills(): void {
  const log = getLogger();

  if (!existsSync(REPO_SKILLS_DIR)) {
    log.debug('No skills directory found in repository, skipping skill installation');
    return;
  }

  mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });

  let entries: string[];
  try {
    entries = readdirSync(REPO_SKILLS_DIR);
  } catch {
    log.warn('Failed to read skills directory');
    return;
  }

  for (const skillName of entries) {
    const sourcePath = join(REPO_SKILLS_DIR, skillName);
    const sourceStat = lstatSync(sourcePath, { throwIfNoEntry: false });
    if (!sourceStat || !sourceStat.isDirectory()) continue;

    if (!existsSync(join(sourcePath, 'SKILL.md'))) {
      log.debug({ skillName }, 'Skipping directory without SKILL.md');
      continue;
    }

    const targetPath = join(GLOBAL_SKILLS_DIR, skillName);

    // 检查目标是否已存在（lstat 不会跟随 symlink）。
    const stat = lstatSync(targetPath, { throwIfNoEntry: false });

    if (stat) {
      if (stat.isSymbolicLink()) {
        const currentTarget = resolve(dirname(targetPath), readlinkSync(targetPath));
        if (currentTarget === sourcePath) {
          log.debug({ skillName }, 'Skill symlink already up to date');
          continue;
        }
        // 指向其他位置，更新 symlink。
        log.info({ skillName, oldTarget: currentTarget }, 'Updating skill symlink');
        unlinkSync(targetPath);
      } else {
        // 非 symlink 目录/文件，跳过。
        log.info({ skillName }, 'Skill directory exists and is not a symlink, skipping');
        continue;
      }
    }

    try {
      symlinkSync(sourcePath, targetPath, 'dir');
      log.info({ skillName, source: sourcePath, target: targetPath }, 'Skill installed');
    } catch (err) {
      log.warn({ err, skillName }, 'Failed to install skill');
    }
  }
}
