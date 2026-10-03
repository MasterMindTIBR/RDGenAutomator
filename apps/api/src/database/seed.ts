import bcrypt from 'bcryptjs';
import { loadEnvironment, loadSeedEnvironment } from '@rdgen/domain';
import pg from 'pg';

const environment = loadEnvironment();
const administrator = loadSeedEnvironment();
const pool = new pg.Pool({ connectionString: environment.DATABASE_URL });
try {
  const hash = await bcrypt.hash(administrator.password, 12);
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, role, status)
     VALUES ($1, $2, 'administrator', 'active')
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [administrator.email, hash]
  );
  console.log(result.rowCount === 1 ? `Seeded administrator ${administrator.email}` : `Administrator ${administrator.email} already exists; unchanged`);
} finally { await pool.end(); }
