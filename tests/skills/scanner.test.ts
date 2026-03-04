import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseFrontmatter,
  buildSkillIndex,
  initSkillIndex,
  getSkillIndex,
  getUserSkillIndex,
  invalidateUserSkillCache,
  getRawSkillPaths,
  reloadSkillIndex,
  resetSkillIndex,
  formatTopLevelListing,
  formatSkillsetResponse,
  readNodeContent,
} from '../../src/skills/scanner.js';
import { createLogger, destroyLogger } from '../../src/logger/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 在指定目录下创建一个 skill（SKILL.md）。 */
function createSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
}

/** 在指定目录下创建一个 skillset（SKILLSET.md）。 */
function createSkillset(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILLSET.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('skills/scanner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-scanner-test-'));
    mkdirSync(join(tmpDir, 'logs'), { recursive: true });
    createLogger({
      level: 'info',
      directory: join(tmpDir, 'logs'),
      maxSize: '10m',
      maxFiles: 5,
      replyLogMaxLength: 200,
    });
    resetSkillIndex();
  });

  afterEach(async () => {
    resetSkillIndex();
    destroyLogger();
    // 等待 pino 线程流刷完后再删临时目录，避免异步写入 ENOENT。
    await new Promise((r) => setTimeout(r, 100));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // parseFrontmatter
  // -------------------------------------------------------------------------

  describe('parseFrontmatter', () => {
    it('should parse standard frontmatter', () => {
      const content = `---
name: my-skill
description: A useful skill
---

# Content here`;
      const fm = parseFrontmatter(content);
      expect(fm.name).toBe('my-skill');
      expect(fm.description).toBe('A useful skill');
    });

    it('should handle quoted values', () => {
      const content = `---
name: "quoted-name"
description: 'single-quoted description'
---`;
      const fm = parseFrontmatter(content);
      expect(fm.name).toBe('quoted-name');
      expect(fm.description).toBe('single-quoted description');
    });

    it('should return empty defaults when no frontmatter', () => {
      const content = '# Just a heading\n\nSome content.';
      const fm = parseFrontmatter(content);
      expect(fm.name).toBe('');
      expect(fm.description).toBe('');
    });

    it('should handle extra custom fields', () => {
      const content = `---
name: test
description: test desc
user-invocable: false
---`;
      const fm = parseFrontmatter(content);
      expect(fm['user-invocable']).toBe('false');
    });

    it('should handle colons in values', () => {
      const content = `---
name: test
description: A skill for doing this: and that
---`;
      const fm = parseFrontmatter(content);
      expect(fm.description).toBe('A skill for doing this: and that');
    });
  });

  // -------------------------------------------------------------------------
  // buildSkillIndex — with test fixtures
  // -------------------------------------------------------------------------

  describe('buildSkillIndex (fixtures)', () => {
    const fixturesPath = join(__dirname, '..', 'fixtures', 'skills');

    it('should discover top-level nodes from fixtures', () => {
      const index = buildSkillIndex([fixturesPath]);
      // fixtures has: coding (skillset), data-science (skillset), standalone-skill (skill)
      expect(index.topLevel).toContain('coding');
      expect(index.topLevel).toContain('data-science');
      expect(index.topLevel).toContain('standalone-skill');
      expect(index.topLevel.length).toBe(3);
    });

    it('should classify nodes correctly', () => {
      const index = buildSkillIndex([fixturesPath]);
      expect(index.nodes.get('coding')?.type).toBe('skillset');
      expect(index.nodes.get('data-science')?.type).toBe('skillset');
      expect(index.nodes.get('standalone-skill')?.type).toBe('skill');
    });

    it('should discover nested children', () => {
      const index = buildSkillIndex([fixturesPath]);
      const coding = index.nodes.get('coding');
      expect(coding?.children).toContain('coding/typescript');

      const ds = index.nodes.get('data-science');
      expect(ds?.children).toContain('data-science/python-ml');
      expect(ds?.children).toContain('data-science/r-stats');
    });

    it('should parse frontmatter for all nodes', () => {
      const index = buildSkillIndex([fixturesPath]);
      const pythonMl = index.nodes.get('data-science/python-ml');
      expect(pythonMl?.frontmatter.name).toBe('python-ml');
      expect(pythonMl?.frontmatter.description).toContain('scikit-learn');
    });

    it('should use directory name as fallback for missing name', () => {
      // Create a SKILL.md without a name field.
      const noNameDir = join(tmpDir, 'skills', 'no-name');
      mkdirSync(noNameDir, { recursive: true });
      writeFileSync(join(noNameDir, 'SKILL.md'), '---\ndescription: test\n---\n# Test');

      const index = buildSkillIndex([join(tmpDir, 'skills')]);
      expect(index.nodes.get('no-name')?.frontmatter.name).toBe('no-name');
    });
  });

  // -------------------------------------------------------------------------
  // buildSkillIndex — dynamic temp dirs
  // -------------------------------------------------------------------------

  describe('buildSkillIndex (dynamic)', () => {
    it('should handle non-existent paths gracefully', () => {
      const index = buildSkillIndex(['/nonexistent/path']);
      expect(index.nodes.size).toBe(0);
      expect(index.topLevel.length).toBe(0);
    });

    it('should skip directories without SKILL.md or SKILLSET.md', () => {
      const emptyDir = join(tmpDir, 'skills', 'empty-dir');
      mkdirSync(emptyDir, { recursive: true });
      writeFileSync(join(emptyDir, 'README.md'), '# Not a skill');

      const index = buildSkillIndex([join(tmpDir, 'skills')]);
      expect(index.nodes.size).toBe(0);
    });

    it('should skip hidden directories', () => {
      const hiddenDir = join(tmpDir, 'skills', '.hidden');
      mkdirSync(hiddenDir, { recursive: true });
      writeFileSync(join(hiddenDir, 'SKILL.md'), '---\nname: hidden\ndescription: test\n---');

      const index = buildSkillIndex([join(tmpDir, 'skills')]);
      expect(index.nodes.has('.hidden')).toBe(false);
    });

    it('should merge multiple paths', () => {
      const root1 = join(tmpDir, 'root1');
      const root2 = join(tmpDir, 'root2');

      // root1 has skill-a
      const a = join(root1, 'skill-a');
      mkdirSync(a, { recursive: true });
      writeFileSync(join(a, 'SKILL.md'), '---\nname: skill-a\ndescription: from root1\n---');

      // root2 has skill-b
      const b = join(root2, 'skill-b');
      mkdirSync(b, { recursive: true });
      writeFileSync(join(b, 'SKILL.md'), '---\nname: skill-b\ndescription: from root2\n---');

      const index = buildSkillIndex([root1, root2]);
      expect(index.nodes.size).toBe(2);
      expect(index.topLevel).toContain('skill-a');
      expect(index.topLevel).toContain('skill-b');
    });

    it('should give priority to first path on name conflicts', () => {
      const root1 = join(tmpDir, 'root1');
      const root2 = join(tmpDir, 'root2');

      // Both roots have same name 'conflict'
      for (const root of [root1, root2]) {
        const dir = join(root, 'conflict');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'SKILL.md'),
          `---\nname: conflict\ndescription: from ${root === root1 ? 'root1' : 'root2'}\n---`,
        );
      }

      const index = buildSkillIndex([root1, root2]);
      expect(index.nodes.size).toBe(1);
      expect(index.nodes.get('conflict')?.frontmatter.description).toBe('from root1');
    });

    it('should handle nested skillset → skill hierarchy', () => {
      const root = join(tmpDir, 'skills');
      const parent = join(root, 'parent');
      const child1 = join(parent, 'child1');
      const child2 = join(parent, 'child2');

      mkdirSync(child1, { recursive: true });
      mkdirSync(child2, { recursive: true });

      writeFileSync(
        join(parent, 'SKILLSET.md'),
        '---\nname: parent\ndescription: parent set\n---',
      );
      writeFileSync(join(child1, 'SKILL.md'), '---\nname: child1\ndescription: first\n---');
      writeFileSync(join(child2, 'SKILL.md'), '---\nname: child2\ndescription: second\n---');

      const index = buildSkillIndex([root]);
      expect(index.nodes.size).toBe(3);
      expect(index.nodes.get('parent')?.type).toBe('skillset');
      expect(index.nodes.get('parent')?.children).toEqual(
        expect.arrayContaining(['parent/child1', 'parent/child2']),
      );
      expect(index.nodes.get('parent/child1')?.type).toBe('skill');
      expect(index.nodes.get('parent/child2')?.type).toBe('skill');
    });

    it('should handle deeply nested skillsets', () => {
      const root = join(tmpDir, 'skills');
      const l1 = join(root, 'l1');
      const l2 = join(l1, 'l2');
      const l3 = join(l2, 'l3');

      mkdirSync(l3, { recursive: true });

      writeFileSync(join(l1, 'SKILLSET.md'), '---\nname: l1\ndescription: level 1\n---');
      writeFileSync(join(l2, 'SKILLSET.md'), '---\nname: l2\ndescription: level 2\n---');
      writeFileSync(join(l3, 'SKILL.md'), '---\nname: l3\ndescription: level 3\n---');

      const index = buildSkillIndex([root]);
      expect(index.nodes.size).toBe(3);
      expect(index.topLevel).toEqual(['l1']);
      expect(index.nodes.get('l1')?.children).toEqual(['l1/l2']);
      expect(index.nodes.get('l1/l2')?.children).toEqual(['l1/l2/l3']);
      expect(index.nodes.get('l1/l2/l3')?.children).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // initSkillIndex / getSkillIndex / resetSkillIndex
  // -------------------------------------------------------------------------

  describe('index lifecycle', () => {
    it('should throw if getSkillIndex called before init', () => {
      expect(() => getSkillIndex()).toThrow('Skill index not initialized');
    });

    it('should return index after init', () => {
      initSkillIndex([join(__dirname, '..', 'fixtures', 'skills')]);
      const index = getSkillIndex();
      expect(index.nodes.size).toBeGreaterThan(0);
    });

    it('should reset cleanly', () => {
      initSkillIndex([]);
      resetSkillIndex();
      expect(() => getSkillIndex()).toThrow();
    });

    it('should store raw config paths via getRawSkillPaths', () => {
      const paths = ['~/.claude/skills', './skills', '${userDir}/skills'];
      initSkillIndex(paths);
      expect(getRawSkillPaths()).toEqual(paths);
    });

    it('should exclude ${userDir} paths from global index', () => {
      // 全局路径有 fixture skills，用户路径用 ${userDir} 占位符
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'global-skill'), 'global-skill', 'from global');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      const globalIndex = getSkillIndex();
      expect(globalIndex.nodes.has('global-skill')).toBe(true);
      // 全局索引不应包含 ${userDir} 路径下的任何内容
      expect(globalIndex.nodes.size).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getUserSkillIndex — per-user skill index
  // -------------------------------------------------------------------------

  describe('getUserSkillIndex', () => {
    it('should return global index when no ${userDir} paths configured', () => {
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'global-skill'), 'global-skill', 'from global');

      // 仅全局路径，无 ${userDir}
      initSkillIndex([globalRoot]);

      const userDir = join(tmpDir, 'users', 'user-a');
      const index = getUserSkillIndex('user-a', userDir);

      // 应与全局索引是同一个引用
      expect(index).toBe(getSkillIndex());
      expect(index.nodes.has('global-skill')).toBe(true);
    });

    it('should merge global and user-specific skills', () => {
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'global-skill'), 'global-skill', 'from global');

      const userDir = join(tmpDir, 'users', 'user-a');
      const userSkillsDir = join(userDir, 'skills');
      createSkill(join(userSkillsDir, 'user-skill'), 'user-skill', 'from user-a');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      const index = getUserSkillIndex('user-a', userDir);
      expect(index.nodes.has('global-skill')).toBe(true);
      expect(index.nodes.has('user-skill')).toBe(true);
      expect(index.topLevel).toContain('global-skill');
      expect(index.topLevel).toContain('user-skill');
    });

    it('should give global skills priority over user skills on name conflict', () => {
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'conflict'), 'conflict', 'from global');

      const userDir = join(tmpDir, 'users', 'user-a');
      createSkill(join(userDir, 'skills', 'conflict'), 'conflict', 'from user');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      const index = getUserSkillIndex('user-a', userDir);
      expect(index.nodes.get('conflict')?.frontmatter.description).toBe('from global');
      // 冲突时只保留一个
      expect(index.topLevel.filter((p) => p === 'conflict').length).toBe(1);
    });

    it('should isolate skills between different users', () => {
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'shared'), 'shared', 'global');

      const userDirA = join(tmpDir, 'users', 'user-a');
      createSkill(join(userDirA, 'skills', 'skill-a'), 'skill-a', 'only for user-a');

      const userDirB = join(tmpDir, 'users', 'user-b');
      createSkill(join(userDirB, 'skills', 'skill-b'), 'skill-b', 'only for user-b');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      const indexA = getUserSkillIndex('user-a', userDirA);
      const indexB = getUserSkillIndex('user-b', userDirB);

      // user-a 看得到 shared + skill-a，看不到 skill-b
      expect(indexA.nodes.has('shared')).toBe(true);
      expect(indexA.nodes.has('skill-a')).toBe(true);
      expect(indexA.nodes.has('skill-b')).toBe(false);

      // user-b 看得到 shared + skill-b，看不到 skill-a
      expect(indexB.nodes.has('shared')).toBe(true);
      expect(indexB.nodes.has('skill-b')).toBe(true);
      expect(indexB.nodes.has('skill-a')).toBe(false);
    });

    it('should cache per-user index', () => {
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'g'), 'g', 'global');

      const userDir = join(tmpDir, 'users', 'user-a');
      createSkill(join(userDir, 'skills', 'u'), 'u', 'user');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      const first = getUserSkillIndex('user-a', userDir);
      const second = getUserSkillIndex('user-a', userDir);

      // 缓存应返回同一引用
      expect(first).toBe(second);
    });

    it('should return global index when user has no skills directory', () => {
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'g'), 'g', 'global');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      // 用户目录不存在
      const userDir = join(tmpDir, 'users', 'nonexistent');
      const index = getUserSkillIndex('nonexistent', userDir);

      // 应返回全局索引（无用户专属 skill）
      expect(index).toBe(getSkillIndex());
    });

    it('should handle user skillset with children', () => {
      const globalRoot = join(tmpDir, 'global');
      mkdirSync(globalRoot, { recursive: true }); // 空的全局目录

      const userDir = join(tmpDir, 'users', 'user-a');
      const userSkills = join(userDir, 'skills');
      const ssDir = join(userSkills, 'my-set');
      createSkillset(ssDir, 'my-set', 'user skillset');
      createSkill(join(ssDir, 'child-a'), 'child-a', 'first child');
      createSkill(join(ssDir, 'child-b'), 'child-b', 'second child');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      const index = getUserSkillIndex('user-a', userDir);
      expect(index.nodes.get('my-set')?.type).toBe('skillset');
      expect(index.nodes.get('my-set')?.children).toEqual(
        expect.arrayContaining(['my-set/child-a', 'my-set/child-b']),
      );
      expect(index.nodes.get('my-set/child-a')?.type).toBe('skill');
    });
  });

  // -------------------------------------------------------------------------
  // invalidateUserSkillCache
  // -------------------------------------------------------------------------

  describe('invalidateUserSkillCache', () => {
    it('should clear cache for specific user', () => {
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'g'), 'g', 'global');

      const userDir = join(tmpDir, 'users', 'user-a');
      createSkill(join(userDir, 'skills', 'u'), 'u', 'user');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      const first = getUserSkillIndex('user-a', userDir);
      invalidateUserSkillCache('user-a');
      const second = getUserSkillIndex('user-a', userDir);

      // 缓存被清除后应重建，不再是同一引用
      expect(first).not.toBe(second);
      // 但内容应相同
      expect(second.nodes.has('g')).toBe(true);
      expect(second.nodes.has('u')).toBe(true);
    });

    it('should not affect other users cache', () => {
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'g'), 'g', 'global');

      const userDirA = join(tmpDir, 'users', 'user-a');
      createSkill(join(userDirA, 'skills', 'a'), 'a', 'user-a');

      const userDirB = join(tmpDir, 'users', 'user-b');
      createSkill(join(userDirB, 'skills', 'b'), 'b', 'user-b');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      const indexA = getUserSkillIndex('user-a', userDirA);
      const indexB = getUserSkillIndex('user-b', userDirB);

      invalidateUserSkillCache('user-a');

      // user-b 的缓存不受影响
      expect(getUserSkillIndex('user-b', userDirB)).toBe(indexB);
      // user-a 被重建
      expect(getUserSkillIndex('user-a', userDirA)).not.toBe(indexA);
    });
  });

  // -------------------------------------------------------------------------
  // reloadSkillIndex — 清除所有缓存
  // -------------------------------------------------------------------------

  describe('reloadSkillIndex', () => {
    it('should rebuild global index and clear all user caches', () => {
      const globalRoot = join(tmpDir, 'global');
      createSkill(join(globalRoot, 'g'), 'g', 'global');

      const userDir = join(tmpDir, 'users', 'user-a');
      createSkill(join(userDir, 'skills', 'u'), 'u', 'user');

      initSkillIndex([globalRoot, '${userDir}/skills']);

      const cachedUser = getUserSkillIndex('user-a', userDir);
      const cachedGlobal = getSkillIndex();

      // 添加新的全局 skill
      createSkill(join(globalRoot, 'new-g'), 'new-g', 'newly added');

      reloadSkillIndex([globalRoot, '${userDir}/skills']);

      // 全局索引应包含新 skill
      expect(getSkillIndex().nodes.has('new-g')).toBe(true);
      expect(getSkillIndex()).not.toBe(cachedGlobal);

      // 用户缓存应已清除，重建后包含新 skill
      const rebuiltUser = getUserSkillIndex('user-a', userDir);
      expect(rebuiltUser).not.toBe(cachedUser);
      expect(rebuiltUser.nodes.has('new-g')).toBe(true);
      expect(rebuiltUser.nodes.has('u')).toBe(true);
    });

    it('should update raw paths', () => {
      initSkillIndex(['./old-path']);
      expect(getRawSkillPaths()).toEqual(['./old-path']);

      reloadSkillIndex(['./new-path', '${userDir}/skills']);
      expect(getRawSkillPaths()).toEqual(['./new-path', '${userDir}/skills']);
    });
  });

  // -------------------------------------------------------------------------
  // formatTopLevelListing
  // -------------------------------------------------------------------------

  describe('formatTopLevelListing', () => {
    it('should return empty string for empty index without paths', () => {
      const index = buildSkillIndex([]);
      expect(formatTopLevelListing(index)).toBe('');
    });

    it('should list all top-level entries', () => {
      const fixturesPath = join(__dirname, '..', 'fixtures', 'skills');
      const index = buildSkillIndex([fixturesPath]);
      const listing = formatTopLevelListing(index);

      expect(listing).toContain('## Available Skill Sets');
      expect(listing).toContain('coding');
      expect(listing).toContain('data-science');
      expect(listing).toContain('standalone-skill');
      expect(listing).toContain('(skillset)');
      expect(listing).toContain('(skill)');
    });

    it('should include resolved paths when provided', () => {
      const fixturesPath = join(__dirname, '..', 'fixtures', 'skills');
      const index = buildSkillIndex([fixturesPath]);
      const paths = ['/home/user/.claude/skills', '/app/skills', '/data/users/user-a/skills'];
      const listing = formatTopLevelListing(index, paths);

      expect(listing).toContain('Skill search paths');
      for (const p of paths) {
        expect(listing).toContain(p);
      }
      expect(listing).toContain('SKILL.md');
    });

    it('should show "no skills installed" when empty index but has paths', () => {
      const index = buildSkillIndex([]);
      const paths = ['/some/path'];
      const listing = formatTopLevelListing(index, paths);

      expect(listing).toContain('## Available Skill Sets');
      expect(listing).toContain('/some/path');
      expect(listing).toContain('No skills or skill sets are currently installed');
    });
  });

  // -------------------------------------------------------------------------
  // formatSkillsetResponse
  // -------------------------------------------------------------------------

  describe('formatSkillsetResponse', () => {
    it('should include SKILLSET.md content and children list', () => {
      const fixturesPath = join(__dirname, '..', 'fixtures', 'skills');
      const index = buildSkillIndex([fixturesPath]);
      const ds = index.nodes.get('data-science')!;
      const response = formatSkillsetResponse(ds, index);

      // Should contain the SKILLSET.md content
      expect(response).toContain('Data Science Skills');
      // Should contain children
      expect(response).toContain('**Children**');
      expect(response).toContain('python-ml');
      expect(response).toContain('r-stats');
      expect(response).toContain('(skill)');
    });
  });

  // -------------------------------------------------------------------------
  // readNodeContent
  // -------------------------------------------------------------------------

  describe('readNodeContent', () => {
    it('should return full markdown content', () => {
      const fixturesPath = join(__dirname, '..', 'fixtures', 'skills');
      const index = buildSkillIndex([fixturesPath]);
      const node = index.nodes.get('standalone-skill')!;
      const content = readNodeContent(node);

      expect(content).toContain('---');
      expect(content).toContain('name: standalone-skill');
      expect(content).toContain('# Standalone Skill');
    });
  });
});
