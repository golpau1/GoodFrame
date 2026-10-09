import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

const migrationsUrl = new URL('../../migrations/', import.meta.url);
const migrations = readdirSync(migrationsUrl)
  .filter(filename => filename.endsWith('.sql'))
  .sort()
  .map(filename => readFileSync(new URL(filename, migrationsUrl), 'utf8'));

class D1StatementAdapter {
  constructor(database, sql) {
    this.statement = database.prepare(sql);
    this.bindings = [];
  }
  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }
  first() {
    return this.statement.get(...this.bindings) || null;
  }
  run() {
    const result = this.statement.run(...this.bindings);
    return { meta:{ changes:Number(result.changes) } };
  }
  all() {
    return { results:this.statement.all(...this.bindings) };
  }
}

class D1DatabaseAdapter {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    migrations.forEach(migration => this.database.exec(migration));
  }
  prepare(sql) {
    return new D1StatementAdapter(this.database, sql);
  }
  close() {
    this.database.close();
  }
}

function createProductCodeDatabase() {
  return new D1DatabaseAdapter();
}

export { createProductCodeDatabase };
