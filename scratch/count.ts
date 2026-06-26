import postgres from "https://deno.land/x/postgresjs@v3.3.5/mod.js";
const sql = postgres("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
console.log(await sql`SELECT count(*) FROM memory_records`);
Deno.exit(0);
