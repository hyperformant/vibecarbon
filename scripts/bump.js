#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const bumpType = args[0];

if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: node bump.js [patch|minor|major]');
  process.exit(1);
}

// Parse semver version
function parseVersion(versionString) {
  const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid version string: ${versionString}`);
  }
  return { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3]) };
}

// Format version back to string
function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

// Increment version based on bump type
function bumpVersion(currentVersion, type) {
  const v = parseVersion(currentVersion);
  if (type === 'major') {
    return formatVersion({ major: v.major + 1, minor: 0, patch: 0 });
  } else if (type === 'minor') {
    return formatVersion({ major: v.major, minor: v.minor + 1, patch: 0 });
  } else if (type === 'patch') {
    return formatVersion({ major: v.major, minor: v.minor, patch: v.patch + 1 });
  }
}

const projectRoot = path.resolve(import.meta.dirname, '..');

// Read current version from package.json
const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const currentVersion = packageJson.version;
const newVersion = bumpVersion(currentVersion, bumpType);

console.log(`\n📦 Bumping version: ${currentVersion} → ${newVersion}\n`);

// Update package.json
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`✅ Updated package.json`);

// Update src/lib/version.js
const versionJsPath = path.join(projectRoot, 'src', 'lib', 'version.js');
const versionJs = fs.readFileSync(versionJsPath, 'utf-8');
const updatedVersionJs = versionJs.replace(
  /export const VERSION = '[^']+';/,
  `export const VERSION = '${newVersion}';`
);
fs.writeFileSync(versionJsPath, updatedVersionJs);
console.log(`✅ Updated src/lib/version.js`);

// Update carbon/package.json
const carbonPackageJsonPath = path.join(projectRoot, 'carbon', 'package.json');
const carbonPackageJson = JSON.parse(fs.readFileSync(carbonPackageJsonPath, 'utf-8'));
carbonPackageJson.version = newVersion;
fs.writeFileSync(carbonPackageJsonPath, JSON.stringify(carbonPackageJson, null, 2) + '\n');
console.log(`✅ Updated carbon/package.json`);

console.log(`\n📝 Next steps:`);
console.log(`1. Update CHANGELOG.md with changes for v${newVersion}`);
console.log(`2. Commit: git add -A && git commit -m "chore: bump to v${newVersion}"`);
console.log(`3. Tag: git tag v${newVersion}`);
console.log(`4. Publish: pnpm publish\n`);
