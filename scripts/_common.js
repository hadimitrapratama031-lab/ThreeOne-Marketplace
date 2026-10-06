import readline from 'node:readline/promises';

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(); const values = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const i = a.indexOf('=');   // pisah di '=' PERTAMA saja: URI MongoDB sendiri memuat '=' (mis. ?appName=...)
    if (i === -1) flags.add(a.slice(2)); else values[a.slice(2, i)] = a.slice(i + 1);
  }
  return { flags, values };
}

export const hostOf = (uri) => { try { const u = new URL(String(uri).replace(/^mongodb(\+srv)?:/, 'http:')); return `${u.hostname}${u.port ? ':' + u.port : ''}`; } catch { return '(tidak terbaca)'; } };

export async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

export const line = (c = '─') => console.log(c.repeat(64));
export const rowOut = (label, value) => console.log(`  ${String(label).padEnd(34)} ${value}`);
