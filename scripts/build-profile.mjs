import { spawnSync } from 'node:child_process';

const profile = process.argv[2] === 'cloud' ? 'cloud' : 'strict';
const env = {
  ...process.env,
  VITE_CLOUD_PROFILE: profile === 'cloud' ? 'enabled' : 'strict',
};

console.log(`[CipherMask Build] Profile: ${profile.toUpperCase()} (VITE_CLOUD_PROFILE=${env.VITE_CLOUD_PROFILE})`);

const tsc = spawnSync('npx', ['tsc', '--noEmit'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const vite = spawnSync('npx', ['vite', 'build'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(vite.status ?? 1);
