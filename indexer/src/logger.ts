/**
 * Minimal structured-but-readable logger. No external dependency.
 */
import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const RULE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

export type Fields = Record<string, unknown>;

function fmt(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Error) return `${v.name}: ${v.message.split('\n')[0] ?? ''}`;
  if (typeof v === 'object' && v !== null) {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
  }
  return String(v);
}

export class Logger {
  constructor(private level: LogLevel = 'info') {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  enabled(level: LogLevel): boolean {
    return ORDER[level] >= ORDER[this.level];
  }

  private write(level: LogLevel, msg: string, fields?: Fields): void {
    if (!this.enabled(level)) return;
    const ts = new Date().toISOString();
    const extra = fields
      ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')
      : '';
    const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  }

  debug(msg: string, fields?: Fields): void { this.write('debug', msg, fields); }
  info(msg: string, fields?: Fields): void { this.write('info', msg, fields); }
  warn(msg: string, fields?: Fields): void { this.write('warn', msg, fields); }
  error(msg: string, fields?: Fields): void { this.write('error', msg, fields); }

  /** Print an aligned key/value block framed by rules. */
  block(title: string, rows: ReadonlyArray<readonly [string, unknown]>, level: LogLevel = 'info'): void {
    if (!this.enabled(level)) return;
    const width = Math.max(...rows.map(([k]) => k.length));
    const out = [RULE, title, RULE, ...rows.map(([k, v]) => `${k.padEnd(width)} : ${fmt(v)}`), RULE];
    console.log(out.join('\n'));
  }
}

export const logger = new Logger();
