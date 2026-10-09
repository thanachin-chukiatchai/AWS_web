require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// เปิดให้บริการไฟล์ HTML, CSS, JS ในโฟลเดอร์ปัจจุบัน
app.use(express.static(__dirname));

// กำหนดการเชื่อมต่อฐานข้อมูล PostgreSQL บน RDS
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'ใส่_ENDPOINT_ของ_RDS',
    database: process.env.DB_NAME || 'postgres',
    password: process.env.DB_PASSWORD || 'ใส่_PASSWORD_ของ_RDS',
    port: process.env.DB_PORT || 5432,
    ssl: { rejectUnauthorized: false } // อนุญาตการเชื่อมต่อ SSL กับ RDS
});

// หน้าหลัก เปิดไฟล์ report.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'report.html'));
});

// API สำหรับรับข้อมูลจากหน้าเว็บแล้วบันทึกลง RDS
app.post('/api/add-crime', async (req, res) => {
    try {
        const {
            streetName,
            crimeType,
            description,
            locationIncident,
            arrest,
            domestic,
            latitude,
            longitude
        } = req.body;

        // คำสั่ง SQL INSERT ข้อมูลคดีใหม่
        const queryText = `
            INSERT INTO chicago_crime (
                block, 
                primary_type, 
                description, 
                location_description, 
                arrest, 
                domestic, 
                latitude, 
                longitude, 
                date
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            RETURNING *;
        `;

        const values = [
            streetName,
            crimeType,
            description,
            locationIncident,
            arrest,
            domestic,
            latitude,
            longitude
        ];

        const result = await pool.query(queryText, values);
        console.log('New crime inserted:', result.rows[0]);

        res.json({ success: true, insertedData: result.rows[0] });
    } catch (err) {
        console.error('Error inserting into RDS:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// รันเซิร์ฟเวอร์ที่ Port 80 (HTTP)
const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});