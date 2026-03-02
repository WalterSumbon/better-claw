---
name: skillset-authoring
description: Guide for authoring Better-Claw skill sets and skills — directory structure, SKILL.md/SKILLSET.md format, frontmatter fields, best practices, and testing methods.
---

# Skillset Authoring Guide

This guide covers how to create and organize skills and skill sets for the Better-Claw skill tree system.

## Core Concepts

**Skill**（叶子节点）: A directory containing `SKILL.md`. Represents a concrete, loadable piece of expertise that the agent can directly use.

**Skill Set**（中间节点）: A directory containing `SKILLSET.md`. Represents a category or topic grouping that organizes child skills and nested skill sets. It cannot be "used" directly — it serves as a navigation hub.

The system forms a tree: skill sets branch into children (more skill sets or skills), and skills are always leaves.

## Directory Structure

```
skills/
├── my-skill/                    ← Leaf skill (contains SKILL.md)
│   └── SKILL.md
│
├── my-topic/                    ← Skill set (contains SKILLSET.md)
│   ├── SKILLSET.md
│   ├── sub-skill-a/             ← Child skill
│   │   └── SKILL.md
│   ├── sub-skill-b/             ← Child skill
│   │   └── SKILL.md
│   └── nested-topic/            ← Nested skill set
│       ├── SKILLSET.md
│       ├── leaf-1/
│       │   └── SKILL.md
│       └── leaf-2/
│           └── SKILL.md
```

Rules:
- A directory must contain **exactly one** of `SKILL.md` or `SKILLSET.md` (not both).
- Only directories with `SKILLSET.md` are recursively scanned for children.
- Directories without either file are ignored by the scanner.
- Hidden directories (starting with `.`) and `node_modules` are skipped.

## SKILLSET.md Format (Intermediate Node)

SKILLSET.md serves as the index page for a category. When loaded via `load_skillset`, the agent sees this content plus a list of child nodes.

### Frontmatter (Required)

```yaml
---
name: deep-learning
description: Deep learning frameworks, techniques, and best practices for training and deploying neural networks.
---
```

- **name** (required): Short kebab-case identifier. Used in navigation paths (e.g., `deep-learning/pytorch`).
- **description** (required): One-sentence summary of what this category covers. This appears in parent listings and the system prompt, so make it informative enough for the agent to decide whether to explore this branch.

### Body Content

The body after the frontmatter is free-form Markdown. Use it to:

- Provide an overview of the topic area
- Explain how the child skills relate to each other
- Offer guidance on which child to load for common scenarios
- Include cross-references or decision trees

Example:

```markdown
---
name: deep-learning
description: Deep learning frameworks, techniques, and best practices.
---

# Deep Learning

Covers major frameworks and training techniques.

## When to Load Which Child

- **pytorch**: General PyTorch training, custom models, low-level control
- **transformers**: HuggingFace Transformers for NLP/multimodal tasks
- **fine-tuning**: Parameter-efficient fine-tuning (LoRA, QLoRA, etc.)
```

## SKILL.md Format (Leaf Node)

SKILL.md contains the actual expertise content that gets injected into the agent's context when loaded.

### Frontmatter (Required)

```yaml
---
name: pytorch-fsdp
description: Adds PyTorch FSDP2 distributed training to scripts with correct sharding, mixed precision, and checkpointing.
---
```

- **name** (required): Short identifier. Used in navigation and display.
- **description** (required): One-sentence summary. Must be specific enough for the agent to judge relevance from the listing alone (without loading the full content).

### Body Content

The body is the skill's actual instructions — what the agent reads and follows when the skill is loaded. Write it as clear, actionable guidance.

For detailed guidance on writing high-quality SKILL.md content (structure, tone, progressive disclosure, bundled resources, validation), refer to the **Anthropic official skill-development skill**:

```
/skill-development
```

This skill is available from the `plugin-dev` plugin and covers SKILL.md authoring comprehensively, including:
- Skill anatomy and progressive disclosure patterns
- Frontmatter fields for invocation control (`disable-model-invocation`, `user-invocable`, `allowed-tools`, `context`)
- Bundled resources (scripts, templates, references, examples)
- Writing style (imperative form, third-person descriptions)
- Common mistakes and validation checklist

## Best Practices

### Naming

- Use **kebab-case** for directory names: `my-skill-name/`, not `MySkillName/` or `my_skill_name/`.
- Keep names concise but descriptive: `pytorch-fsdp` > `fsdp` > `pytorch-fully-sharded-data-parallel-v2`.
- The `name` field in frontmatter should match the directory name.

### Description Quality

Descriptions are the agent's primary signal for deciding which skill to load. They appear in:
1. The system prompt (top-level nodes)
2. Parent skillset child listings
3. `load_skillset` tool output

Write descriptions that answer: **"When should the agent load this?"**

Good:
```yaml
description: Adds PyTorch FSDP2 distributed training to scripts with correct sharding, mixed precision, and checkpointing.
```

Bad:
```yaml
description: PyTorch FSDP stuff
```

### Tree Depth

- Keep the tree **shallow** (2-3 levels max). Deep nesting forces the agent to make multiple `load_skillset` calls to reach a leaf.
- If a skill set has only 1-2 children, consider flattening.

### Granularity

- Each skill should be **self-contained**: loading it gives the agent everything needed for that topic.
- Avoid skills that are too narrow (single function) or too broad (entire textbook).
- A good skill is roughly 100-500 lines of focused, actionable content.

### SKILLSET.md Body

- Keep SKILLSET.md bodies **brief** — they're navigation aids, not reference material.
- Include a "when to load which child" section if the children serve different but related purposes.
- Don't duplicate child content in the parent.

### Separation of Concerns

- A **skill** contains expertise (instructions, patterns, examples).
- A **skill set** contains organization (overview, navigation hints, child listings).
- Don't put detailed technical content in SKILLSET.md — that belongs in child SKILL.md files.

## Testing a Skill or Skill Set

### 1. Verify Scanner Discovery

After creating the files, confirm the scanner picks them up:

```bash
# Restart the service and check logs for skill index
# Look for: "Skill index built" with correct node counts

# Or use the load_skillset tool in chat:
# load_skillset(path="") → should list your new top-level entry
# load_skillset(path="my-topic") → should show SKILLSET.md content + children
# load_skillset(path="my-topic/my-skill") → should show full SKILL.md content
```

### 2. Verify Frontmatter Parsing

Common issues:
- Missing `---` delimiters (must be the very first line of the file)
- Missing `name` or `description` field
- Indentation errors in YAML
- Quotes not properly matched

If `name` is missing from frontmatter, the scanner falls back to the directory name.

### 3. Verify Navigation

Test the full navigation path:
1. Check system prompt shows the top-level entry with correct type label (skill vs skillset)
2. Load the skillset and verify children are listed with their types
3. Load each child skill and verify content renders correctly

### 4. Verify Agent Behavior

The ultimate test: does the agent load and use the skill appropriately?
- Mention the topic in conversation and check if the agent explores the skill tree
- Verify the agent's response quality improves with the skill loaded
- Check that the agent doesn't load the skill unnecessarily (description should be specific enough to prevent false matches)

## Quick Reference

| Aspect | SKILL.md (Leaf) | SKILLSET.md (Intermediate) |
|--------|-----------------|---------------------------|
| Purpose | Loadable expertise | Navigation hub / category |
| Required fields | name, description | name, description |
| Body content | Detailed instructions | Brief overview + navigation |
| Children | None (leaf) | Other skills or skill sets |
| Scanner behavior | Not recursed into | Recursed to find children |
| Agent interaction | Content loaded directly | Shows content + child listing |
