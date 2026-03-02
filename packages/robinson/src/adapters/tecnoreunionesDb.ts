/**
 * Direct MySQL connection to the Tecnoreuniones database.
 *
 * This adapter allows Robinson to query the database directly,
 * bypassing API limitations (e.g. service 5 deriving idAsamblea from the session token).
 *
 * Connection: n1.tecnoreuniones.com / tecno / reuniones / Tecnoreuniones
 * READ-ONLY — Robinson must never write to this database.
 */

import mysql from 'mysql2/promise';
import { getEnvConfig, createLogger } from '@transcriptor/shared';
import type { Pool, RowDataPacket } from 'mysql2/promise';

const logger = createLogger('robinson:db');

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const env = getEnvConfig();
    pool = mysql.createPool({
      host: env.tecnoreunionesDbHost,
      user: env.tecnoreunionesDbUser,
      password: env.tecnoreunionesDbPass,
      database: env.tecnoreunionesDbName,
      port: 3306,
      waitForConnections: true,
      connectionLimit: 3, // keep it low — we're a guest
      queueLimit: 10,
      connectTimeout: 10_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 30_000,
    });
    logger.info('MySQL pool created for Tecnoreuniones');
  }
  return pool;
}

/**
 * Execute a read-only SQL query against the Tecnoreuniones database.
 * Returns the rows as an array of objects.
 *
 * IMPORTANT: Only SELECT queries are allowed. Any write attempt will be rejected.
 */
export async function queryTecnoreuniones(
  sql: string,
  params: (string | number)[] = [],
): Promise<Record<string, unknown>[]> {
  // Safety: reject anything that isn't a SELECT
  const normalized = sql.trim().toUpperCase();
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('SHOW') && !normalized.startsWith('DESCRIBE')) {
    throw new Error('Only SELECT/SHOW/DESCRIBE queries are allowed on the Tecnoreuniones database');
  }

  const db = getPool();
  logger.info('Executing query on Tecnoreuniones DB', { sql: sql.substring(0, 200), params });

  try {
    const [rows] = await db.execute<RowDataPacket[]>(sql, params);
    logger.info(`Query returned ${rows.length} rows`);
    return rows as Record<string, unknown>[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Tecnoreuniones DB query failed', { error: msg });
    throw err;
  }
}

// ── Convenience query functions ──

/**
 * Get all questions for an assembly directly from the database.
 * This bypasses service 5's session-based idAsamblea limitation.
 */
export async function dbFetchQuestions(idAsamblea: number): Promise<Record<string, unknown>[]> {
  return queryTecnoreuniones(
    'SELECT p.*, GROUP_CONCAT(CONCAT(po.idRespuesta, ":", po.texto) ORDER BY po.idRespuesta SEPARATOR " | ") as opciones_texto ' +
    'FROM preguntas p LEFT JOIN preguntasOpciones po ON p.idAsamblea = po.idAsamblea AND p.idPregunta = po.idPregunta ' +
    'WHERE p.idAsamblea = ? GROUP BY p.idAsamblea, p.idPregunta ORDER BY p.idPregunta',
    [idAsamblea],
  );
}

/**
 * Get assembly status from the estadoasamblea view.
 */
export async function dbFetchAssemblyStatus(idAsamblea: number): Promise<Record<string, unknown> | null> {
  const rows = await queryTecnoreuniones(
    'SELECT * FROM estadoasamblea WHERE idAsamblea = ?',
    [idAsamblea],
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Get attendance list from the listadelegados view.
 */
export async function dbFetchAttendanceList(idAsamblea: number): Promise<Record<string, unknown>[]> {
  return queryTecnoreuniones(
    'SELECT * FROM listadelegados WHERE idAsamblea = ?',
    [idAsamblea],
  );
}

/**
 * Get voting results for a question (aggregated).
 */
export async function dbFetchVotingResults(
  idAsamblea: number,
  idPregunta: number,
  opciones: number = 1,
): Promise<Record<string, unknown>[]> {
  if (opciones <= 1) {
    // Single-choice: from respuestas table
    return queryTecnoreuniones(
      'SELECT r.respuesta AS texto, COUNT(*) AS conteo, COUNT(*) AS nominal, ' +
      'ROUND(SUM(res.coeficiente), 4) AS coeficiente ' +
      'FROM respuestas r ' +
      'JOIN residentes res ON r.idAsamblea = res.idAsamblea AND r.idTorre = res.idtorre AND r.idUnidad = res.idunidad ' +
      'WHERE r.idAsamblea = ? AND r.idPregunta = ? ' +
      'GROUP BY r.respuesta ORDER BY conteo DESC',
      [idAsamblea, idPregunta],
    );
  } else {
    // Multi-choice: from respuestasmultiples table
    return queryTecnoreuniones(
      'SELECT r.respuesta AS texto, COUNT(*) AS conteo, COUNT(*) AS nominal, ' +
      'ROUND(SUM(res.coeficiente), 4) AS coeficiente ' +
      'FROM respuestasmultiples r ' +
      'JOIN residentes res ON r.idAsamblea = res.idAsamblea AND r.idTorre = res.idtorre AND r.idUnidad = res.idunidad ' +
      'WHERE r.idAsamblea = ? AND r.idPregunta = ? ' +
      'GROUP BY r.respuesta ORDER BY conteo DESC',
      [idAsamblea, idPregunta],
    );
  }
}

/**
 * Get quorum snapshot for a closed question.
 */
export async function dbFetchQuorumSnapshot(
  idAsamblea: number,
  idPregunta: number,
): Promise<Record<string, unknown> | null> {
  const rows = await queryTecnoreuniones(
    'SELECT quorum, asistentes, fhoperacion, listaAsistentes ' +
    'FROM quorumRespuestas WHERE idAsamblea = ? AND idPregunta = ? ' +
    'ORDER BY fhoperacion DESC LIMIT 1',
    [idAsamblea, idPregunta],
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Get assembly metadata.
 */
export async function dbFetchAssemblyMetadata(idAsamblea: number): Promise<Record<string, unknown> | null> {
  const rows = await queryTecnoreuniones(
    'SELECT * FROM asambleas WHERE idAsamblea = ?',
    [idAsamblea],
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Get voting scrutiny (per-unit detail).
 */
export async function dbFetchVotingScrutiny(
  idAsamblea: number,
  idPregunta: number,
): Promise<Record<string, unknown>[]> {
  return queryTecnoreuniones(
    'SELECT * FROM escrutiniovotacion WHERE idAsamblea = ? AND idPregunta = ?',
    [idAsamblea, idPregunta],
  );
}

/**
 * Get the last answered question for an assembly.
 * Looks at the asistentes.ultimarespuesta field.
 */
export async function dbFetchLastAnsweredQuestion(idAsamblea: number): Promise<Record<string, unknown> | null> {
  const rows = await queryTecnoreuniones(
    'SELECT MAX(a.ultimarespuesta) as lastQuestion FROM asistentes a WHERE a.idAsamblea = ? AND a.ultimarespuesta > 0',
    [idAsamblea],
  );
  if (!rows.length || rows[0].lastQuestion === null) return null;
  const lastQ = Number(rows[0].lastQuestion);

  // Now get the question details
  const questions = await queryTecnoreuniones(
    'SELECT * FROM preguntas WHERE idAsamblea = ? AND idPregunta = ?',
    [idAsamblea, lastQ],
  );
  return questions.length > 0 ? questions[0] : null;
}

/**
 * List all tables in the database (for exploration).
 */
export async function dbListTables(): Promise<string[]> {
  const rows = await queryTecnoreuniones('SHOW TABLES');
  return rows.map((r) => Object.values(r)[0] as string);
}

/**
 * Describe a table schema.
 */
export async function dbDescribeTable(tableName: string): Promise<Record<string, unknown>[]> {
  // Sanitize table name to prevent injection
  const safeName = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  return queryTecnoreuniones(`DESCRIBE ${safeName}`);
}

/**
 * Close the pool (for cleanup).
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('MySQL pool closed');
  }
}
