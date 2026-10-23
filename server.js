const fs = require('fs');
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

// Forecast CSV in S3 (the EC2 instance must have s3:GetObject and kms:Decrypt).
let S3Client, GetObjectCommand;
try {
    ({ S3Client, GetObjectCommand } = require('@aws-sdk/client-s3'));
} catch (_) {}
const PREDICTION_BUCKET = process.env.PREDICTION_BUCKET || 'predict-data-kong';
const PREDICTION_KEY = process.env.PREDICTION_KEY || 'predictions/chicago_crime_predictions_30days_2026-09-07.csv';

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) console.warn('JWT_SECRET is not set; login tokens will be disabled until configured.');
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, salt, expected) {
    const actual = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function signToken(payload) {
    if (!JWT_SECRET) return null;
    const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ ...payload, exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 })}`;
    return `${body}.${crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`;
}
function auth(requiredRole) {
    return (req, res, next) => {
        try {
            const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (!JWT_SECRET || !token) throw new Error('missing token');
            const [header, body, signature] = token.split('.');
            const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
            if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('bad token');
            const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
            if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) throw new Error('expired token');
            if (requiredRole && claims.role !== requiredRole) return res.status(403).json({ error: 'Insufficient role' });
            req.user = claims;
            next();
        } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
    };
}

// เปิดให้บริการไฟล์ HTML, CSS, JS ในโฟลเดอร์ปัจจุบัน
app.use(express.static(__dirname));

// กำหนดการเชื่อมต่อฐานข้อมูล PostgreSQL บน RDS
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'chicago-crime-rds.c1laumrbxyfl.us-east-1.rds.amazonaws.com',
    database: process.env.DB_NAME || 'chicagocrime',
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
    connectionTimeoutMillis: 10000,
    options: '-c timezone=America/Chicago',
    ssl: { rejectUnauthorized: false } // อนุญาตการเชื่อมต่อ SSL กับ RDS
});

// PostGIS owns authoritative area boundaries; incident counts still use the
// existing community_area/date indexes rather than a full spatial join.
app.get('/api/community-areas.geojson', auth('commander'), async (_req, res) => {
    try {
        const result = await pool.query(`SELECT community_area, name,
            ST_AsGeoJSON(geom)::json AS geometry
            FROM public.community_areas ORDER BY community_area`);
        if (result.rows.length !== 77) return res.status(503).json({ error: 'Import all 77 community boundaries before using the map' });
        res.json({ type: 'FeatureCollection', features: result.rows.map(row => ({
            type: 'Feature', id: row.community_area, geometry: row.geometry,
            properties: { community_area: row.community_area, name: row.name }
        })) });
    } catch (error) {
        console.error('Community boundary query failed:', error.message);
        res.status(503).json({ error: 'Community boundaries unavailable; run the PostGIS setup and import' });
    }
});

async function ensureAuthSchema() {
    await pool.query(`CREATE TABLE IF NOT EXISTS public.app_users (
        id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('operator', 'commander')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const [username, role, password] of [
        ['operator', 'operator', process.env.OPERATOR_PASSWORD],
        ['commander', 'commander', process.env.COMMANDER_PASSWORD]
    ]) {
        if (!password) continue;
        const { salt, hash } = hashPassword(password);
        await pool.query(`INSERT INTO public.app_users (username, password_hash, password_salt, role)
            VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING`, [username, hash, salt, role]);
    }
}

// หน้าหลัก เปิดไฟล์ report.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'report.html'));
});

app.get('/api/health', async (_req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ ok: true });
    } catch (err) {
        res.status(503).json({ ok: false, error: 'Database unavailable' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
        const result = await pool.query('SELECT username, password_hash, password_salt, role FROM public.app_users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
        const token = signToken({ sub: user.username, role: user.role });
        if (!token) return res.status(503).json({ error: 'JWT_SECRET is not configured' });
        res.json({ token, user: { username: user.username, role: user.role } });
    } catch (err) { console.error('Login error:', err); res.status(500).json({ error: 'Login unavailable' }); }
});

// ดึงข้อมูลสำหรับ Dashboard/Heatmap จากตารางที่ Glue โหลดเข้า RDS
app.get('/api/crimes', auth('commander'), async (req, res) => {
    try {
        const year = Number(req.query.year);
        const communityArea = Number(req.query.community_area);
        const values = [];
        const conditions = ['latitude IS NOT NULL', 'longitude IS NOT NULL'];
        if (Number.isInteger(year)) {
            values.push(year);
            conditions.push(`year = $${values.length}`);
        }
        if (Number.isInteger(communityArea)) {
            values.push(communityArea);
            conditions.push(`community_area = $${values.length}`);
        }
        const limit = Math.min(Math.max(Number(req.query.limit) || 10000, 1), 50000);
        values.push(limit);
        const result = await pool.query(`
            SELECT id, crime_date, primary_type, community_area,
                   latitude, longitude, arrest
            FROM public.crimes
            WHERE ${conditions.join(' AND ')}
            ORDER BY crime_date DESC NULLS LAST
            LIMIT $${values.length}
        `, values);
        res.json({ count: result.rowCount, data: result.rows });
    } catch (err) {
        console.error('Error reading crimes:', err);
        res.status(500).json({ success: false, error: 'Unable to read crime data' });
    }
});

// Aggregate historical incidents by community area for the actual-data layer.
// Keeping this aggregation in PostgreSQL avoids sending thousands of rows to
// the browser just to calculate the heatmap intensity.
function normalizeDateTime(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const normalized = String(value).trim().replace('T', ' ');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(normalized)) return null;
    const [year, month, day, hour, minute, second = 0] = normalized.split(/[- :]/).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
    return normalized.length === 16 ? `${normalized}:00` : normalized;
}

app.get('/api/crime-area-summary', auth('commander'), async (req, res) => {
    try {
        const currentYear = new Date().getFullYear();
        const rawAt = req.query.at;
        const rawFrom = req.query.from;
        const rawTo = req.query.to;
        const at = normalizeDateTime(rawAt);
        const from = normalizeDateTime(rawFrom);
        const to = normalizeDateTime(rawTo);
        if ((rawAt && !at) || (rawFrom && !from) || (rawTo && !to)) {
            return res.status(400).json({ error: 'Invalid datetime; use YYYY-MM-DDTHH:mm' });
        }
        if ((from && !to) || (!from && to)) {
            return res.status(400).json({ error: 'Both from and to are required' });
        }
        const fromYear = Number(req.query.from_year) || 2001;
        const toYear = Number(req.query.to_year) || currentYear;
        if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
            return res.status(400).json({ error: 'Invalid year range' });
        }
        let whereClause = `community_area BETWEEN 1 AND 77`;
        let values = [];
        let range = { from_year: fromYear, to_year: toYear };
        if (at) {
            values = [at];
            whereClause += ` AND crime_date >= $1::timestamp
              AND crime_date < $1::timestamp + INTERVAL '1 hour'`;
            range = { at };
        } else if (from && to) {
            values = [from, to];
            whereClause += ` AND crime_date >= $1::timestamp AND crime_date < $2::timestamp`;
            range = { from, to };
        } else {
            values = [fromYear, toYear];
            whereClause += ` AND year BETWEEN $1 AND $2`;
        }
        if (req.query.community_area) {
            const area = Number(req.query.community_area);
            if (!Number.isInteger(area) || area < 1 || area > 77) return res.status(400).json({ error: 'Invalid community area' });
            values.push(area);
            whereClause += ` AND community_area = $${values.length}`;
        }
        const result = await pool.query(`
            SELECT community_area, COUNT(*)::int AS crime_count
            FROM public.crimes
            WHERE ${whereClause}
            GROUP BY community_area
            ORDER BY community_area
        `, values);
        res.json({ ...range, data: result.rows });
    } catch (err) {
        console.error('Error reading crime area summary:', err);
        res.status(500).json({ error: 'Unable to read crime area summary' });
    }
});

// Aggregate all matching records; only the detail table is paginated.
app.get('/api/dashboard', auth('commander'), async (req, res) => {
    try {
        const at = normalizeDateTime(req.query.at);
        if (req.query.at && !at) return res.status(400).json({ error: 'Invalid datetime' });
        const area = req.query.community_area ? Number(req.query.community_area) : null;
        if (area !== null && (!Number.isInteger(area) || area < 1 || area > 77)) {
            return res.status(400).json({ error: 'Invalid community area' });
        }
        const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
        const pageSize = 20;
        const values = [];
        const conditions = ['community_area BETWEEN 1 AND 77'];
        if (at) {
            values.push(at);
            conditions.push(`crime_date >= $1::timestamp AND crime_date < $1::timestamp + INTERVAL '1 hour'`);
        }
        if (area !== null) {
            values.push(area);
            conditions.push(`community_area = $${values.length}`);
        }
        const where = conditions.join(' AND ');
        const summary = await pool.query(`SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE primary_type = 'THEFT') AS theft,
            COUNT(*) FILTER (WHERE arrest IS TRUE) AS arrested FROM public.crimes WHERE ${where}`, values);
        const types = await pool.query(`SELECT COALESCE(primary_type, 'Unknown') AS label, COUNT(*) AS value
            FROM public.crimes WHERE ${where} GROUP BY primary_type ORDER BY value DESC`, values);
        // Include the applied one-hour window as the final point, plus 23 previous
        // windows. Anchor to the input even when the user types nonzero minutes.
        const trend = at ? await pool.query(`
            SELECT to_char(h.hour_at, 'YYYY-MM-DD HH24:MI') AS label,
                COUNT(c.crime_date)::int AS value, h.hour_at = $1::timestamp AS selected
            FROM generate_series($1::timestamp - INTERVAL '23 hours',
                $1::timestamp, INTERVAL '1 hour') AS h(hour_at)
            LEFT JOIN public.crimes c ON c.crime_date >= h.hour_at
                AND c.crime_date < h.hour_at + INTERVAL '1 hour'
                AND c.community_area BETWEEN 1 AND 77
                ${area !== null ? 'AND c.community_area = $2' : ''}
            GROUP BY h.hour_at ORDER BY h.hour_at`, values)
            : await pool.query(`SELECT to_char(date_trunc('month', crime_date), 'YYYY-MM-DD HH24:MI') AS label,
            COUNT(*) AS value FROM public.crimes WHERE ${where} AND crime_date IS NOT NULL
            GROUP BY date_trunc('month', crime_date) ORDER BY date_trunc('month', crime_date)`, values);
        const details = await pool.query(`SELECT id, to_char(crime_date, 'YYYY-MM-DD HH24:MI:SS') AS crime_date,
            primary_type, community_area, description, arrest FROM public.crimes WHERE ${where}
            ORDER BY crime_date DESC NULLS LAST, id DESC NULLS LAST
            LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, pageSize, (page - 1) * pageSize]);
        res.json({ summary: summary.rows[0], types: types.rows, trend: trend.rows,
            data: details.rows, page, page_size: pageSize });
    } catch (error) {
        console.error('Dashboard query failed:', error);
        res.status(500).json({ error: 'Unable to load dashboard statistics' });
    }
});

function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const headers = lines.shift().split(',').map(v => v.trim().replace(/^\"|\"$/g, ''));
    return lines.map(line => {
        const values = line.match(/(?:\"[^\"]*\"|[^,])+/g) || [];
        return Object.fromEntries(headers.map((h, i) => [h, (values[i] || '').trim().replace(/^\"|\"$/g, '')]));
    });
}

// Return only timestamps that actually exist in the selected data source.
// The dashboard uses these values to prevent selecting empty time windows.
app.get('/api/available-times', auth('commander'), async (req, res) => {
    try {
        const mode = String(req.query.mode || 'actual').toLowerCase();
        const selectedArea = req.query.community_area ? Number(req.query.community_area) : null;
        if (selectedArea !== null && (!Number.isInteger(selectedArea) || selectedArea < 1 || selectedArea > 77)) {
            return res.status(400).json({ error: 'Invalid community area' });
        }
        const limit = Math.min(Math.max(Number(req.query.limit) || 5000, 1), 20000);
        if (mode === 'forecast') {
            if (!S3Client) return res.status(503).json({ error: 'AWS S3 SDK is not installed' });
            const client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
            const object = await client.send(new GetObjectCommand({ Bucket: PREDICTION_BUCKET, Key: PREDICTION_KEY }));
            const text = await object.Body.transformToString();
            const values = [...new Set(parseCsv(text)
                .filter(row => selectedArea === null || Number(row.community_area ?? row.Community ?? row.community ?? row.communityArea) === selectedArea)
                .map(row => row.date || row.datetime || row.timestamp || null)
                .filter(Boolean)
                .map(value => String(value).slice(0, 16).replace(' ', 'T')))]
                .sort()
                .slice(0, limit);
            return res.json({ mode, count: values.length, values, trend_default: values.at(-25) || values.at(0) || null });
        }

        // A full-table hourly GROUP BY blocks initial loading on this RDS instance.
        // Restrict suggestions to the latest 30 days; manual date entry remains available.
        const result = await pool.query(`
            WITH latest AS (
                SELECT crime_date AS selected_at FROM public.crimes
                WHERE crime_date IS NOT NULL
                  AND community_area BETWEEN 1 AND 77
                  AND ($2::integer IS NULL OR community_area = $2)
                ORDER BY crime_date DESC LIMIT 1
            )
            SELECT COUNT(*)::int AS crime_count,
                   to_char(date_trunc('hour', c.crime_date), 'YYYY-MM-DD"T"HH24:MI') AS value
            FROM public.crimes c CROSS JOIN latest
            WHERE c.crime_date >= latest.selected_at - INTERVAL '30 days'
              AND c.crime_date <= latest.selected_at
              AND c.community_area BETWEEN 1 AND 77
              AND ($2::integer IS NULL OR c.community_area = $2)
            GROUP BY date_trunc('hour', c.crime_date)
            ORDER BY date_trunc('hour', c.crime_date) DESC
            LIMIT $1
        `, [limit, selectedArea]);
        res.json({ mode: 'actual', timezone: 'America/Chicago', count: result.rowCount,
            latest: result.rows[0]?.value || null, hours: result.rows,
            values: result.rows.map(row => row.value) });
    } catch (err) {
        console.error('Error reading available times:', err);
        res.status(500).json({ error: 'Unable to read available times' });
    }
});

app.get('/api/predictions', auth('commander'), async (req, res) => {
    try {
        if (!S3Client) return res.status(503).json({ error: 'AWS S3 SDK is not installed' });
        const client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
        const object = await client.send(new GetObjectCommand({ Bucket: PREDICTION_BUCKET, Key: PREDICTION_KEY }));
        const text = await object.Body.transformToString();
        let rows = parseCsv(text).map(row => ({
            date: row.date || row.datetime || row.timestamp || null,
            community_area: Number(row.community_area ?? row.Community ?? row.community ?? row.communityArea),
            probability: Number(row.crime_probability ?? row.probability ?? row.risk ?? row.predicted_risk),
            prediction: Number(row.crime_prediction ?? row.prediction ?? row.predicted)
        })).filter(row => Number.isInteger(row.community_area) && Number.isFinite(row.probability));
        const area = Number(req.query.community_area);
        if (Number.isInteger(area)) rows = rows.filter(r => Number(r.community_area) === area);
        const requestedAt = normalizeDateTime(req.query.at || req.query.datetime);
        if ((req.query.at || req.query.datetime) && !requestedAt) {
            return res.status(400).json({ error: 'Invalid datetime; use YYYY-MM-DDTHH:mm' });
        }
        if (requestedAt) {
            const requestedMinute = requestedAt.slice(0, 16).replace(' ', 'T');
            rows = rows.filter(r => String(r.date || '').slice(0, 16).replace(' ', 'T') === requestedMinute);
        } else if (req.query.from || req.query.to) {
            const from = normalizeDateTime(req.query.from);
            const to = normalizeDateTime(req.query.to);
            if (!from || !to || from >= to) {
                return res.status(400).json({ error: 'Invalid forecast range; use from < to' });
            }
            rows = rows.filter(r => {
                const date = normalizeDateTime(r.date);
                return date && date >= from && date < to;
            });
        } else if (req.query.date) {
            rows = rows.filter(r => String(r.date || '').startsWith(String(req.query.date)));
        }
        const allDates = rows.map(row => row.date).filter(Boolean).sort();
        res.json({
            bucket: PREDICTION_BUCKET,
            key: PREDICTION_KEY,
            count: rows.length,
            available_from: allDates[0] || null,
            available_to: allDates[allDates.length - 1] || null,
            data: rows
        });
    } catch (err) {
        console.error('Error reading predictions:', err);
        res.status(500).json({ error: 'Unable to read prediction data from S3' });
    }
});

// Community-area centroids let the dashboard render area-level heatmaps even
// when prediction rows do not contain latitude/longitude values.
app.get('/api/community-areas', auth('commander'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT community_area,
                   MIN(latitude) AS min_latitude,
                   MAX(latitude) AS max_latitude,
                   MIN(longitude) AS min_longitude,
                   MAX(longitude) AS max_longitude
            FROM public.crimes
            WHERE community_area IS NOT NULL
              AND latitude IS NOT NULL
              AND longitude IS NOT NULL
              AND latitude BETWEEN 41.5 AND 42.2
              AND longitude BETWEEN -88.0 AND -87.3
            GROUP BY community_area
            ORDER BY community_area
        `);
        res.json({ data: result.rows });
    } catch (err) {
        console.error('Error reading community areas:', err);
        res.status(500).json({ error: 'Unable to read community areas' });
    }
});

function loadLocations() {
    return JSON.parse(
        fs.readFileSync(path.join(__dirname, 'location_descriptions.json'), 'utf-8')
    );
}

// ค่าที่อนุญาตของแต่ละ drop down (ตรวจซ้ำฝั่ง server อีกชั้น)
const ALLOWED = {
    primaryType: ['WEAPONS VIOLATION', 'ROBBERY' , 
'THEFT',
'CRIMINAL DAMAGE',
'CRIMINAL SEXUAL ASSAULT',
'BATTERY',
'CRIMINAL TRESPASS',
'OTHER OFFENSE',
'DECEPTIVE PRACTICE',
'MOTOR VEHICLE THEFT',
'BURGLARY',
'SEX OFFENSE',
'ASSAULT',
'ARSON',
'NARCOTICS',
'PUBLIC PEACE VIOLATION',
'CONCEALED CARRY LICENSE VIOLATION',
'OFFENSE INVOLVING CHILDREN',
'GAMBLING',
'HUMAN TRAFFICKING',
'STALKING',
'INTERFERENCE WITH PUBLIC OFFICER',
'HOMICIDE',
'INTIMIDATION',
'OBSCENITY',
'KIDNAPPING',
'LIQUOR LAW VIOLATION',
'PROSTITUTION',
'PUBLIC INDECENCY',
'OTHER NARCOTIC VIOLATION',
'NON-CRIMINAL',
'RITUALISM',
'CRIM SEXUAL ASSAULT',
'DOMESTIC VIOLENCE'],
    locationDescription: loadLocations(),
    beat: [413, 1124],
    district: [...Array.from({ length: 22 }, (_, i) => i + 1), 24, 25, 31, 61],
    ward: Array.from({ length: 51 }, (_, i) => i),          // 0 - 50
    communityArea: Array.from({ length: 77 }, (_, i) => i + 1), // 1 - 77
    fbiCode: ['03', '06','14','02','08B','26','11','07','04B','05','17','08A','04A','09','18','24','15','20','19','10','01A','22','16','13','01B','12'
    ]
};

// API สำหรับรับข้อมูลจากหน้าเว็บแล้วบันทึกลง RDS
const webIngestion = require('./web-ingestion')(pool);
app.post('/api/add-crime', auth('operator'), async (req, res) => {
    try {
        const {
            primaryType,
            description,
            locationDescription,
            beat,
            district,
            ward,
            communityArea,
            fbiCode,
            arrest,
            domestic,
            latitude,
            longitude
        } = req.body;

        // ตรวจสอบค่าที่ส่งมา
        const beatN = Number(beat);
        const districtN = Number(district);
        const wardN = Number(ward);
        const communityAreaN = Number(communityArea);

        if (
            !ALLOWED.primaryType.includes(primaryType) ||
            !ALLOWED.locationDescription.includes(locationDescription) ||
            !ALLOWED.beat.includes(beatN) ||
            !ALLOWED.district.includes(districtN) ||
            !ALLOWED.ward.includes(wardN) ||
            !ALLOWED.communityArea.includes(communityAreaN) ||
            !ALLOWED.fbiCode.includes(fbiCode) ||
            typeof description !== 'string' || description.trim() === '' ||
            typeof arrest !== 'boolean' || typeof domestic !== 'boolean' ||
            latitude === null || longitude === null || latitude === '' || longitude === '' ||
            !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude)) ||
            Number(latitude) < -90 || Number(latitude) > 90 ||
            Number(longitude) < -180 || Number(longitude) > 180
        ) {
            return res.status(400).json({ success: false, error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
        }

        // คำสั่ง SQL INSERT ข้อมูลคดีใหม่
        const values = [
            primaryType,
            description.trim(),
            locationDescription,
            beatN,
            districtN,
            wardN,
            communityAreaN,
            fbiCode,
            arrest,
            domestic,
            latitude,
            longitude
        ];

        const result = await webIngestion.ingest(req.headers['idempotency-key'], values,
            req.user.sub, req.body.testMode === true);
        res.status(result.raw_status === 'published' ? 201 : 202).json(result);
    } catch (err) {
        console.error('Error inserting into RDS:', err);
        res.status(err.status || 500).json({ success: false, error: err.message });
    }
});

// รันเซิร์ฟเวอร์ที่ Port 80 (HTTP)
const PORT = process.env.PORT || 80;
// Existing auth tables/users are provisioned separately; startup must not mutate RDS.
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
