'use strict';
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// The outbox commits together with the incident. A failed S3 request is retried
// without inserting another incident. Historical crimes are never scanned.
module.exports = function createIngestion(pool) {
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
    const bucket = process.env.RAW_BUCKET || 'main-raw-data-kong';
    let schemaReady;
    function ready() {
        if (!schemaReady) schemaReady = pool.query(`CREATE TABLE IF NOT EXISTS public.web_crime_outbox (
        event_id UUID PRIMARY KEY, request_hash TEXT NOT NULL,
        record JSONB NOT NULL, s3_key TEXT NOT NULL UNIQUE,
        published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`).catch(error => { schemaReady = null; throw error; });
        return schemaReady;
    }
    async function publish(row) {
        try {
            await s3.send(new PutObjectCommand({ Bucket: bucket, Key: row.s3_key,
                Body: JSON.stringify(row.record) + '\n', ContentType: 'application/json',
                IfNoneMatch: '*' }));
        } catch (error) {
            if (error.$metadata?.httpStatusCode !== 412) throw error;
        }
        await pool.query('UPDATE public.web_crime_outbox SET published_at = NOW() WHERE event_id = $1', [row.event_id]);
    }
    async function ingest(eventId, values, username, testMode = false) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId || '')) {
            const error = new Error('A UUID v4 Idempotency-Key is required'); error.status = 400; throw error;
        }
        await ready();
        const hash = crypto.createHash('sha256').update(JSON.stringify({values, username, testMode})).digest('hex');
        const db = await pool.connect();
        let row;
        try {
            await db.query('BEGIN');
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [eventId]);
            row = (await db.query('SELECT * FROM public.web_crime_outbox WHERE event_id = $1', [eventId])).rows[0];
            if (row && row.request_hash !== hash) {
                const error = new Error('This request ID already belongs to different data'); error.status = 409; throw error;
            }
            if (!row) {
                let record;
                if (testMode) {
                    const [primary_type, description, location_description, beat, district, ward,
                        community_area, fbi_code, arrest, domestic, latitude, longitude] = values;
                    record = {primary_type, description, location_description, beat, district, ward,
                        community_area, fbi_code, arrest, domestic, latitude, longitude,
                        crime_date: new Date().toISOString(), year: new Date().getUTCFullYear()};
                } else {
                    record = (await db.query(`INSERT INTO public.crimes
                        (primary_type, description, location_description, beat, district, ward,
                         community_area, fbi_code, arrest, domestic, latitude, longitude,
                         crime_date, year, updated_on, case_number)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                                NOW(), EXTRACT(YEAR FROM NOW())::integer, NOW(), $13)
                        RETURNING *`, [...values, 'WEB-' + eventId])).rows[0];
                }
                record = {...record, event_id: eventId, source: 'web', submitted_by: username,
                    is_test: testMode, schema_version: 1};
                const date = new Date().toISOString().slice(0,10).replace(/-/g,'/');
                const key = `${testMode ? 'validation/web' : 'web'}/${date}/${eventId}.json`;
                row = (await db.query(`INSERT INTO public.web_crime_outbox
                    (event_id, request_hash, record, s3_key) VALUES ($1,$2,$3,$4) RETURNING *`,
                    [eventId, hash, JSON.stringify(record), key])).rows[0];
            }
            await db.query('COMMIT');
        } catch (error) { await db.query('ROLLBACK'); throw error; }
        finally { db.release(); }
        let published = Boolean(row.published_at);
        if (!published) {
            try { await publish(row); published = true; }
            catch (error) { console.error('Raw publish pending:', eventId, error.name); }
        }
        return {success: true, event_id: eventId, raw_status: published ? 'published' : 'pending',
            s3_bucket: bucket, s3_key: row.s3_key, insertedData: row.record};
    }
    let busy = false;
    const timer = setInterval(async () => {
        if (busy) return; busy = true;
        try {
            await ready();
            const pending = await pool.query(`SELECT * FROM public.web_crime_outbox
                WHERE published_at IS NULL ORDER BY created_at LIMIT 25`);
            for (const row of pending.rows) await publish(row);
        } catch (error) { console.error('Outbox retry:', error.name); }
        finally { busy = false; }
    }, 60000);
    timer.unref();
    ready().catch(error => console.error('Outbox setup:', error.message));
    return {ingest};
};
