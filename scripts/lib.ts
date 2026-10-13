import { randomBytes } from 'node:crypto';

export function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const [name = '', inline] = arg.slice(2).split('=', 2);
    const next = argv[index + 1];
    if (inline !== undefined) {
      args.set(name, inline);
    } else if (next !== undefined && !next.startsWith('--')) {
      args.set(name, next);
      index += 1;
    } else {
      args.set(name, 'true');
    }
  }
  return args;
}

/** Cryptographically random, URL-safe text. 32 bytes gives 43 characters. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function fail(message: string): never {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}
