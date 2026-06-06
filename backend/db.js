const sql = require("mssql");
require("dotenv").config();

const config = {
  server: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_NAME || "demirbase",
  user: process.env.DB_USER || "sa",
  password: process.env.DB_PASSWORD || "",
  options: {
    encrypt: String(process.env.DB_ENCRYPT).toLowerCase() === "true",
    trustServerCertificate:
      String(process.env.DB_TRUST_CERT).toLowerCase() === "true",
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool;

async function getPool() {
  if (!pool) {
    pool = await sql.connect(config);
  }
  return pool;
}

async function query(text, params = []) {
  const p = await getPool();
  const request = p.request();

  params.forEach((value, index) => {
    request.input(`p${index + 1}`, value);
  });

  const convertedSql = text.replace(/\$(\d+)/g, (_, n) => `@p${n}`);
  const result = await request.query(convertedSql);

  return {
    rows: result.recordset || [],
    rowCount: result.rowsAffected?.[0] || 0,
    recordset: result.recordset || [],
    rowsAffected: result.rowsAffected || [],
  };
}

module.exports = {
  sql,
  query,
  getPool,
};
