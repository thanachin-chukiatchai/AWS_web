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

// ค่าที่อนุญาตของแต่ละ drop down (ตรวจซ้ำฝั่ง server อีกชั้น)
const ALLOWED = {
    primaryType: ['WEAPONS VIOLATION', 'ROBBERY'],
    locationDescription: ['Apartment', 'Street'],
    beat: [413, 1124],
    district: [...Array.from({ length: 22 }, (_, i) => i + 1), 24, 25, 31, 61],
    ward: Array.from({ length: 51 }, (_, i) => i),          // 0 - 50
    communityArea: Array.from({ length: 77 }, (_, i) => i + 1), // 1 - 77
    fbiCode: ['03', '06','14','02','08B','26','11','07','04B','05','17','08A','04A','09','18','24','15','20','19','10','01A','22','16','13','01B','12'
    ]
};

// API สำหรับรับข้อมูลจากหน้าเว็บแล้วบันทึกลง RDS
app.post('/api/add-crime', async (req, res) => {
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
            !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))
        ) {
            return res.status(400).json({ success: false, error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
        }

        // คำสั่ง SQL INSERT ข้อมูลคดีใหม่
        const queryText = `
            INSERT INTO chicago_crime (
                primary_type,
                description,
                location_description,
                beat,
                district,
                ward,
                community_area,
                fbi_code,
                arrest,
                domestic,
                latitude,
                longitude,
                date
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
            RETURNING *;
        `;

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