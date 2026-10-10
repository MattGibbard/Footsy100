// Minimal D1Database stand-in backed by node:sqlite, so the real SQL can be
// exercised in plain vitest.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Val = string | number | null;

class Stmt {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    readonly params: Val[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : (a as Val))));
  }
  private returnsRows() {
    return /^\s*(SELECT|WITH)/i.test(this.sql) || /RETURNING/i.test(this.sql);
  }
  exec() {
    const s = this.db.prepare(this.sql);
    if (this.returnsRows()) {
      const results = s.all(...this.params) as Record<string, unknown>[];
      return { results, success: true, meta: { changes: results.length } };
    }
    const r = s.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
  async first(col?: string) {
    const row = this.exec().results[0];
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
  async all() {
    const r = this.exec();
    return { ...r, results: r.results.map((row) => ({ ...row })) };
  }
  async run() {
    return this.exec();
  }
}

export function createD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return d1 as unknown as D1Database;
}
