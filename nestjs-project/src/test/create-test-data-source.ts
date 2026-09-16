import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

type EntityConstructor = new (...args: any[]) => object;

export function createTestDataSource(
  entities: (EntityConstructor | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  // Deletion order follows FK dependencies (videos → tokens → channels → users).
  // Each table is deleted only when present, so the helper tolerates data
  // sources that register a subset of entities on a shared database.
  const tables = [
    'videos',
    'refresh_tokens',
    'verification_tokens',
    'channels',
    'users',
  ];
  for (const table of tables) {
    const result = await dataSource.query<{ exists: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)`,
      [table],
    );
    if (result[0]?.exists) {
      await dataSource.query(`DELETE FROM "${table}"`);
    }
  }
}
