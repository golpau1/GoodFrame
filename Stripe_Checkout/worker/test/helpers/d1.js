import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../migrations/0001_product_codes.sql', import.meta.url), 'utf8');

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
    this.database.exec(migration);
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
