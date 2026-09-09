#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

const AGENT_REL = {
  user: {
    claude: '.claude/skills',
    codex: '.codex/skills',
    cursor: '.cursor/skills',
    opencode: '.config/opencode/skills',
    copilot: '.copilot/skills',
    gemini: '.gemini/skills',
  },
  project: {
    claude: '.claude/skills',
    codex: '.agents/skills',
    cursor: '.cursor/skills',
    opencode: '.opencode/skills',
    copilot: '.github/skills',
    gemini: '.gemini/skills',
  },
};

const MANIFEST_NAME = '.jekardah-writer-install.json';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function listSkills() {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')))
    .sort();
}

function parseArgs(argv) {
  const opts = { scope: 'user', method: 'copy', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--agent':
        opts.agent = argv[++i];
        break;
      case '--scope':
        opts.scope = argv[++i];
        break;
      case '--prefix':
        opts.prefix = argv[++i];
        break;
      case '--copy':
        opts.method = 'copy';
        break;
      case '--symlink':
        opts.method = 'symlink';
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }
  if (!opts.agent) fail('--agent is required');
  if (!AGENT_REL[opts.scope]) fail(`Unsupported scope: ${opts.scope}`);
  if (!AGENT_REL[opts.scope][opts.agent]) fail(`Unsupported agent: ${opts.agent}`);
  return opts;
}

function resolveDest(opts) {
  const base = opts.prefix
    ? path.resolve(opts.prefix)
    : opts.scope === 'user'
    ? os.homedir()
    : process.cwd();
  if (!path.isAbsolute(base)) fail('Prefix must be an absolute path');
  const rel = AGENT_REL[opts.scope][opts.agent];
  return path.join(base, rel);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function treeDigest(dir) {
  const files = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relPath);
      else files.push(relPath);
    }
  })(dir, '');
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
    hash.update(`${f}\t${fileHash}\n`);
  }
  return hash.digest('hex');
}

function cmdInstall(argv) {
  const opts = parseArgs(argv);
  const dest = resolveDest(opts);
  const manifestPath = path.join(dest, MANIFEST_NAME);
  const skills = listSkills();

  for (const skill of skills) {
    const target = path.join(dest, skill);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      fail(`Refusing to overwrite existing path: ${target}`);
    }
  }

  if (opts.dryRun) {
    console.log(`Would install ${skills.length} skills to ${dest} using ${opts.method}`);
    return;
  }

  fs.mkdirSync(dest, { recursive: true });
  const manifest = { schema: 'jekardah-writer-v1', agent: opts.agent, scope: opts.scope, method: opts.method, skills: {} };
  for (const skill of skills) {
    const source = path.join(SKILLS_DIR, skill);
    const target = path.join(dest, skill);
    if (opts.method === 'symlink') {
      fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      copyDir(source, target);
    }
    manifest.skills[skill] = { target, digest: treeDigest(target) };
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Installed Jekardah Writer (${skills.length} skills) for ${opts.agent} (${opts.scope}) at ${dest}`);
}

function readManifest(dest, opts) {
  const manifestPath = path.join(dest, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) fail(`Installation manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'jekardah-writer-v1' || manifest.agent !== opts.agent || manifest.scope !== opts.scope) {
    fail('Installation manifest is malformed or tampered; nothing was removed.');
  }
  return { manifest, manifestPath };
}

function cmdVerify(argv) {
  const opts = parseArgs(argv);
  const dest = resolveDest(opts);
  const { manifest } = readManifest(dest, opts);
  for (const [skill, info] of Object.entries(manifest.skills)) {
    if (!fs.existsSync(path.join(info.target, 'SKILL.md'))) fail(`Missing installed skill: ${skill}`);
    const actual = treeDigest(info.target);
    if (actual !== info.digest) fail(`Installed skill was modified: ${skill}`);
  }
  console.log(`Verified Jekardah Writer at ${dest}`);
}

function cmdUninstall(argv) {
  const opts = parseArgs(argv);
  const dest = resolveDest(opts);
  const { manifest, manifestPath } = readManifest(dest, opts);
  for (const [skill, info] of Object.entries(manifest.skills)) {
    const actual = treeDigest(info.target);
    if (actual !== info.digest) {
      fail(`Installed skill was modified: ${skill}. Nothing was removed.`);
    }
  }
  for (const [, info] of Object.entries(manifest.skills)) {
    fs.rmSync(info.target, { recursive: true, force: true });
  }
  fs.rmSync(manifestPath, { force: true });
  console.log(`Uninstalled Jekardah Writer from ${dest}`);
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'install':
      return cmdInstall(rest);
    case 'verify':
      return cmdVerify(rest);
    case 'uninstall':
      return cmdUninstall(rest);
    default:
      console.log(
        [
          'Usage: npx jekardah-writer <install|verify|uninstall> --agent <claude|codex|cursor|opencode|copilot|gemini> [--scope user|project] [--prefix DIR] [--copy|--symlink] [--dry-run]',
          '',
          'Examples:',
          '  npx jekardah-writer install --agent claude --scope user',
          '  npx jekardah-writer install --agent claude --scope project --prefix .',
          '  npx jekardah-writer verify --agent claude --scope user',
          '  npx jekardah-writer uninstall --agent claude --scope user',
        ].join('\n')
      );
      process.exit(cmd ? 1 : 0);
  }
}

main();
