# AWS_web

เว็บ Chicago Crime สำหรับบันทึกเหตุการณ์และดูข้อมูลอาชญากรรมผ่าน Dashboard ใช้ Node.js/Express, PostgreSQL บน RDS, PostGIS และไฟล์พยากรณ์ใน S3

## หน้าจอและการทำงาน

| ไฟล์ | หน้าที่ |
| --- | --- |
| `login.html` | เข้าสู่ระบบด้วยบัญชีที่มีอยู่ใน `public.app_users` |
| `operation.html` | หน้าทำงานของ operator |
| `report.html` | ฟอร์มบันทึกเหตุการณ์ พร้อม Idempotency-Key ป้องกันการส่งซ้ำ |
| `dash.html` | Dashboard สำหรับ commander: แผนที่, KPI, กราฟ และตาราง |
| `server.js` | Express API, authentication และ query ข้อมูล |
| `web-ingestion.js` | บันทึกเหตุการณ์และ outbox เพื่อส่งข้อมูลไป S3 พร้อม retry |

### Actual Crime

- เลือกชั่วโมงที่มีข้อมูลพร้อมจำนวนคดี หรือพิมพ์วันเวลาเองได้ เริ่มต้นที่ชั่วโมงล่าสุดที่มีข้อมูล
- รายการแนะนำดึงข้อมูลย้อนหลัง 30 วันนับจากเหตุการณ์ล่าสุดของ Community Area ที่เลือก; เวลาเก่ากว่านั้นพิมพ์ค้นหาเองได้
- KPI, แผนที่, Crime Report Chart และตารางใช้ช่วงเดียวกัน โดยรวมเวลาเริ่มและไม่รวมเวลาสิ้นสุด:

  ```sql
  crime_date >= selected_at
  AND crime_date < selected_at + INTERVAL '1 hour'
  ```

- Crime Analysis เป็น line chart 24 จุด: 23 ชั่วโมงก่อนหน้าและชั่วโมงที่เลือก เติมชั่วโมงว่างเป็น 0 และไฮไลต์ชั่วโมงที่เลือก
- ทุกส่วนของ Actual ใช้ Community Area ที่ Apply แล้ว ตารางแสดงหน้าละ 20 รายการ
- ถ้าพิมพ์ `14:30` ช่วงที่เลือกคือ `14:30–15:30` และจุดย้อนหลังห่างกันหนึ่งชั่วโมง
- ชั่วโมงที่ไม่มีคดีแสดงข้อความและล้างผลของชั่วโมงเดิม โดยกราฟย้อนหลังยังอาจมีคดีในชั่วโมงก่อนหน้า

### Forecast

อ่าน CSV จาก S3 แสดง probability เป็นเปอร์เซ็นต์ พร้อมแผนที่, KPI, ตาราง และกราฟแนวโน้ม 24 ชั่วโมงถัดไป ค่าความน่าจะเป็นไม่ใช่จำนวนคดี และช่วงเวลาที่เลือกต้องมีอยู่ในไฟล์พยากรณ์

### Timezone

ใช้ `America/Chicago` และกำหนด timezone ของ PostgreSQL session ให้ตรงกัน ช่องวันเวลาใช้เวลา Chicago โดยไม่แปลงตาม timezone ของเครื่องผู้ใช้ หาก `crime_date` เป็น `timestamp without time zone` ข้อมูลต้องเก็บเป็นเวลา Chicago อยู่แล้ว ช่อง `datetime-local` ไม่สามารถแยกชั่วโมงที่ซ้ำกันในวันสิ้นสุด DST ได้

## ตั้งค่าและรัน

ต้องมี Node.js และ npm (ชุดทดสอบเคยรันผ่านบน Node.js 22), การเชื่อมต่อ PostgreSQL และ AWS credentials ผ่าน credential provider chain เช่น IAM role ของ EC2

Repository ปัจจุบันยังไม่มี `package.json` หรือ lockfile สำหรับติดตั้งแบบกำหนดเวอร์ชันตายตัว ติดตั้ง dependencies ในเครื่องที่จะรันได้ด้วย:

```bash
npm install --no-save --package-lock=false express cors dotenv pg @aws-sdk/client-s3
```

สร้าง `.env` ในโฟลเดอร์โปรเจกต์ โดยแทนค่าตัวอย่างด้วยค่าของระบบ:

```dotenv
PORT=3000
DB_HOST=YOUR_RDS_HOST
DB_PORT=5432
DB_NAME=chicagocrime
DB_USER=postgres
DB_PASSWORD=YOUR_DB_PASSWORD
JWT_SECRET=YOUR_LONG_RANDOM_SECRET
AWS_REGION=us-east-1
PREDICTION_BUCKET=YOUR_FORECAST_BUCKET
PREDICTION_KEY=predictions/YOUR_FORECAST.csv
RAW_BUCKET=YOUR_RAW_BUCKET
```

`.env`, private keys, dependencies, logs และไฟล์ backup ถูก ignore ไว้แล้ว ห้ามใส่ credentials จริงในไฟล์ที่ commit

ก่อนรันต้องมีตาราง `public.crimes`, `public.app_users` พร้อมบัญชีที่ hash รหัสผ่านตรงกับระบบ และ `public.community_areas` พร้อมขอบเขตครบ 77 พื้นที่ การเรียก `ensureAuthSchema()` อัตโนมัติถูกปิดไว้ จึงไม่สร้างบัญชีจาก `OPERATOR_PASSWORD` หรือ `COMMANDER_PASSWORD` ตอนเริ่มระบบ

**การรันเซิร์ฟเวอร์จริงมีผลต่อระบบภายนอก:** `web-ingestion.js` ยังสร้างตาราง `public.web_crime_outbox` หากไม่มี และ retry รายการค้างไป S3 ทุก 60 วินาที จึงควรใช้ฐานข้อมูล/bucket สำหรับพัฒนาเมื่อต้องการทดลอง ไม่ควรถือว่าการ start server เป็น read-only

```bash
node server.js
```

เปิด `http://localhost:3000/login.html` เมื่อใช้ `PORT=3000` หากไม่ได้กำหนด `PORT` เซิร์ฟเวอร์ใช้ port 80 ส่วน `/` เปิดฟอร์ม `report.html`

Forecast ต้องมีสิทธิ์ `s3:GetObject` และ `kms:Decrypt` เมื่อไฟล์เข้ารหัสด้วย KMS ส่วน ingestion ต้องมีสิทธิ์เขียนลง raw bucket

### ขอบเขต Community Area

`setup-postgis.sql` และ `import-community-areas.js` ใช้เตรียม PostGIS และนำเข้าขอบเขต ทั้งสองรายการเปลี่ยน schema หรือข้อมูล จึงไม่จำเป็นต้องรันซ้ำสำหรับการแก้ Dashboard หากระบบมีข้อมูลพร้อมแล้ว

เมื่อจัดเตรียมฐานข้อมูลใหม่ สามารถรัน SQL ผ่านเครื่องมือ PostgreSQL แล้วนำเข้า GeoJSON ที่ตรวจสอบแล้ว:

```bash
node import-community-areas.js /path/to/community-areas.geojson
```

ต้องกำหนด `DB_NAME` ให้ตรงกับเซิร์ฟเวอร์ด้วย เพราะค่าเริ่มต้นใน import script คือ `postgres` หากไม่ส่ง path สคริปต์จะดาวน์โหลดขอบเขตจาก Chicago Data Portal

## ตรวจ syntax และทดสอบ

รันจากโฟลเดอร์โปรเจกต์:

```bash
node --check server.js
node --check web-ingestion.js
node --check import-community-areas.js
node dash.datetime.test.cjs
node server.datetime.test.cjs
```

ชุดทดสอบใช้ Node.js built-ins และจำลอง DOM, HTTP และฐานข้อมูล จึงไม่ต้องรันเซิร์ฟเวอร์จริง ครอบคลุมการเลือกเวลา, ข้อมูลว่าง, pagination, Forecast, กราฟ 24 จุด และโครงสร้าง SQL แต่ไม่ได้ยืนยันผล query บน PostgreSQL จริง, สิทธิ์ AWS, ความเร็ว RDS หรือหน้าตาในเบราว์เซอร์

## Deploy บน EC2

ใช้ [ขั้นตอนสำรองไฟล์ อัปโหลด และ restart](DEPLOY-datetime.md) สำหรับการแก้ `dash.html` และ `server.js` บนระบบเดิม หากติดตั้งครั้งแรก ต้องมีไฟล์ runtime ทั้งหมด รวมถึง `web-ingestion.js`, `location_descriptions.json` และหน้า HTML พร้อม dependencies และ environment variables

หลังอัปเดตไฟล์ ตรวจ syntax ก่อน restart process เดิม โดยแทนชื่อ process ให้ตรงกับ `pm2 list`:

```bash
node --check server.js && pm2 restart EXISTING_APP_NAME --update-env
pm2 logs EXISTING_APP_NAME --lines 50 --nostream
curl --fail http://127.0.0.1/api/health
```

ปรับ port ของ health URL ให้ตรงกับ `PORT` ที่ตั้งไว้ Health endpoint ตรวจการเชื่อมต่อฐานข้อมูลเท่านั้น จากนั้นควรเข้าสู่ระบบตรวจ Actual, ชั่วโมงว่าง, Community Area และ Forecast บนเว็บจริงด้วย
