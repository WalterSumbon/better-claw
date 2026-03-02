import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseFrontmatter,
  buildSkillIndex,
  initSkillIndex,
  getSkillIndex,
  resetSkillIndex,
  formatTopLevelListing,
  formatSkillsetResponse,
  readNodeContent,
} from '../../src/skills/scanner.js';
import { createLogger, destroyLogger } from '../../src/logger/index.js';

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
  });

  // -------------------------------------------------------------------------
  // formatTopLevelListing
  // -------------------------------------------------------------------------

  describe('formatTopLevelListing', () => {
    it('should return empty string for empty index', () => {
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
