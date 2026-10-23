// Run on EC2 after setup-postgis.sql. Uses the same DB settings as server.js.
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({
    host: process.env.DB_HOST, user: process.env.DB_USER || 'postgres',
    database: process.env.DB_NAME || 'postgres', password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT || 5432), ssl: { rejectUnauthorized: false }
});
async function main() {
    if (!process.env.DB_HOST || !process.env.DB_PASSWORD) throw new Error('Set DB_HOST and DB_PASSWORD in .env');
    let document;
    if (process.argv[2]) document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    else {
        const response = await fetch('https://data.cityofchicago.org/api/v3/views/igwz-8jzy/query.geojson?$limit=100', { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error(`Boundary download failed: HTTP ${response.status}`);
        document = await response.json();
    }
    const rows = (document.features || []).map(feature => {
        const p = feature.properties || {};
        return { area: Number(p.area_num_1 ?? p.area_numbe ?? p.community_area ?? p.comarea ?? p.comarea_id),
            name: p.community || p.name || '', geometry: feature.geometry };
    });
    if (rows.length !== 77 || new Set(rows.map(r => r.area)).size !== 77 ||
        rows.some(r => !Number.isInteger(r.area) || r.area < 1 || r.area > 77 || !r.geometry || !['Polygon', 'MultiPolygon'].includes(r.geometry.type))) {
        throw new Error('Expected exactly 77 unique Community Area polygons; nothing imported');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const row of rows) await client.query(`INSERT INTO public.community_areas (community_area, name, geom)
            VALUES ($1, $2, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)))
            ON CONFLICT (community_area) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom`,
            [row.area, row.name || `Community Area ${row.area}`, JSON.stringify(row.geometry)]);
        const check = await client.query('SELECT COUNT(*) AS total, bool_and(ST_IsValid(geom)) AS valid FROM public.community_areas');
        if (Number(check.rows[0].total) !== 77 || !check.rows[0].valid) throw new Error('Boundary validation failed');
        await client.query('COMMIT');
        await client.query('ANALYZE public.community_areas');
        console.log('Imported and validated all 77 Community Areas');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
