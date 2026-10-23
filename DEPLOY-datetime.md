Datetime dashboard deployment

Local verification (PowerShell, C:\Projects\AWS_web):
```powershell
node --check server.js
node dash.datetime.test.cjs
node server.datetime.test.cjs
```

Passed locally with mocked DOM, HTTP responses, PostgreSQL and S3 SDK availability.
No live RDS/S3 request, database mutation, EC2 upload/restart, or browser visual test was performed.
Forecast populated/empty behavior was tested with fixtures, not the live S3 CSV.

Backups before the 24-hour chart edits use suffix .backup-20261023-214859
(dash.html, server.js and both datetime test files).

Actual uses America/Chicago wall-clock input and a PostgreSQL session timezone of
America/Chicago. Timestamp-without-time-zone values must already represent Chicago
local time; the live column type/storage convention has not been verified.
Repeated fall-back DST hours cannot be distinguished by a datetime-local input.
Available times show the latest 5,000 populated hours for valid community areas
1–77, including counts. Older hours remain manually searchable. All dashboard
KPI, map, report chart and detail table use the selected time inclusive to selected
time + one hour exclusive. Actual Analysis is a line chart of 24 one-hour windows:
selected time minus 23 hours through selected time plus one hour (exclusive).
The selected window is the final orange point. Empty windows count as zero.
All windows use the applied Community Area. Nonzero typed minutes anchor every
window to those minutes (e.g. 14:30 means the final window is 14:30–15:30).
Forecast retains probability percentages and its existing selected-time behavior.
Tests verify the generated history SQL structure and mocked 24-point SVG output;
they do not execute the SQL against PostgreSQL or measure live query latency.
Startup no longer calls ensureAuthSchema: existing auth tables/users must already
exist. This prevents schema/user writes on restart.

Upload from PowerShell after replacing the example values with the existing EC2
key, user/host and absolute application directory:
```powershell
$ec2Key = 'C:\path\existing-key.pem'
$ec2Target = 'ubuntu@YOUR_EC2_HOST'
$ec2AppDir = '/absolute/path/to/AWS_web'
scp -i $ec2Key .\dash.html .\server.js "${ec2Target}:${ec2AppDir}/"
ssh -i $ec2Key $ec2Target
```

Before uploading, make a backup on EC2 in a directory outside the served app:
```bash
APP_DIR='/absolute/path/to/AWS_web'
BACKUP_DIR="$HOME/aws-web-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp "$APP_DIR/dash.html" "$APP_DIR/server.js" "$BACKUP_DIR/"
```

After uploading, in the SSH session, use the existing PM2 application name from
`pm2 list` (do not create a second process):
```bash
cd '/absolute/path/to/AWS_web'
node --check server.js
pm2 list
# Only if syntax passed; replace EXISTING_APP_NAME:
pm2 restart EXISTING_APP_NAME --update-env
pm2 logs EXISTING_APP_NAME --lines 50 --nostream
curl --fail http://127.0.0.1/api/health
```

If EC2 uses systemd instead of PM2, restart its existing service with
`sudo systemctl restart EXISTING_SERVICE_NAME` after syntax passes, and inspect
`sudo journalctl -u EXISTING_SERVICE_NAME -n 50 --no-pager`.

Then sign in as commander and verify: Actual starts at the latest populated
hour; options display date/hour and counts; selecting an option synchronizes
map/KPIs/charts/table; an empty typed hour clears results and displays a message;
Forecast still loads its existing CSV timestamps. No schema migration or S3 upload
is needed for this change.
