// Dev convenience (ADR 0003 D4): one command to review the cost UI on screen against LocalStack.
// Brings the container up, waits for it, seeds the fixture, then launches `tauri dev` with
// AWS_ENDPOINT_URL set so every AWS SDK call in the core hits LocalStack instead of real AWS.
// Zero dependencies — plain Node spawning docker / bash / npm.
//
//   npm run tauri:dev:localstack
//
// Stop it with Ctrl+C (the app closes). The container keeps running — `npm run localstack:down`.

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const COMPOSE = ['compose', '-f', 'docker-compose.localstack.yml'];
const ENDPOINT = 'http://localhost:4566';
const onWindows = process.platform === 'win32';

function must(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: onWindows, ...opts });
  if (r.status !== 0) {
    console.error(`\n"${cmd} ${args.join(' ')}" failed (exit ${r.status ?? 'signal'}).`);
    process.exit(r.status ?? 1);
  }
}

function healthy() {
  return (
    spawnSync(
      'docker',
      [...COMPOSE, 'exec', '-T', 'localstack', 'curl', '-sf', `${ENDPOINT}/_localstack/health`],
      { stdio: 'ignore', shell: onWindows },
    ).status === 0
  );
}

console.log('• starting LocalStack …');
must('docker', [...COMPOSE, 'up', '-d']);

process.stdout.write('• waiting for it to be ready ');
for (let i = 0; i < 30 && !healthy(); i++) {
  process.stdout.write('.');
  await sleep(2000);
}
if (!healthy()) {
  console.error('\nLocalStack did not become ready — check `docker compose -f docker-compose.localstack.yml logs`.');
  process.exit(1);
}
console.log(' ok');

console.log('• seeding the fixture …');
must('bash', ['scripts/localstack-seed.sh']);

console.log(`• launching the app against ${ENDPOINT} — connect with test / test, region sa-east-1\n`);
const app = spawn('npm', ['run', 'tauri:dev'], {
  stdio: 'inherit',
  shell: onWindows,
  env: { ...process.env, AWS_ENDPOINT_URL: ENDPOINT },
});
app.on('exit', (code) => process.exit(code ?? 0));
