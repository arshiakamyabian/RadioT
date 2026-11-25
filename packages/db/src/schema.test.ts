import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { profiles, settings, users } from './schema/index.js';

describe('db schema', () => {
  it('uses plural Better Auth table names', () => {
    expect(getTableConfig(users).name).toBe('users');
  });

  it('keys profiles by user and settings as a singleton', () => {
    expect(
      getTableConfig(profiles).primaryKeys.length +
        getTableConfig(profiles).columns.filter((c) => c.primary).length,
    ).toBe(1);
    expect(getTableConfig(settings).name).toBe('settings');
  });
});
