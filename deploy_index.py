"""
Deploy index.html to Firebase Hosting (camphisierraapp)
Usage:
  1. Move the downloaded index.html next to this script, OR pass the path as an argument:
       python deploy_index.py
       python deploy_index.py "C:\\Users\\Michael\\Downloads\\index.html"
  2. Run from PowerShell — takes ~10 seconds.
"""

import sys, json, os, time, hashlib, base64, mimetypes
sys.path.insert(0, r'C:\Users\Michael\Documents\Claude\Projects\CHS app')

# ── Config ────────────────────────────────────────────────────────────────────
SERVICE_ACCOUNT = r'C:\Users\Michael\Documents\Claude\Projects\CHS app\serviceAccountKey.json'
SITE_ID = 'camphisierraapp'

# Where is the new index.html?
if len(sys.argv) > 1:
    INDEX_PATH = sys.argv[1]
else:
    # Default: same folder as this script
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, 'index.html'),
        os.path.expanduser(r'~\Downloads\index.html'),
    ]
    INDEX_PATH = next((p for p in candidates if os.path.exists(p)), None)
    if not INDEX_PATH:
        print("ERROR: index.html not found. Place it next to this script or pass the path as an argument.")
        sys.exit(1)

print(f"Deploying: {INDEX_PATH}  ({os.path.getsize(INDEX_PATH)//1024}KB)")

# ── Auth ──────────────────────────────────────────────────────────────────────
import google.auth
import google.auth.transport.requests
from google.oauth2 import service_account

SCOPES = ['https://www.googleapis.com/auth/firebase', 'https://www.googleapis.com/auth/cloud-platform']
creds = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT, scopes=SCOPES)
creds.refresh(google.auth.transport.requests.Request())
token = creds.token

import urllib.request, urllib.error

def api(method, url, body=None, extra_headers=None, raw=False):
    data = json.dumps(body).encode() if body else None
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return r.read() if raw else json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        raise

BASE = 'https://firebasehosting.googleapis.com/v1beta1'

# ── 1. Create a new version ───────────────────────────────────────────────────
print("1/4  Creating hosting version...")
version = api('POST', f'{BASE}/sites/{SITE_ID}/versions',
              {'config': {'headers': [{'glob': '**', 'headers': {'Cache-Control': 'no-cache, max-age=0'}}]}})
version_name = version['name']  # projects/.../sites/.../versions/xxx
version_id = version_name.split('/')[-1]
print(f"     Version: {version_id}")

# ── 2. Gzip + SHA256 of all files ────────────────────────────────────────────
import gzip

def gzip_file(path):
    with open(path, 'rb') as f:
        raw = f.read()
    compressed = gzip.compress(raw, compresslevel=9)
    return compressed, hashlib.sha256(compressed).hexdigest()

content, sha256 = gzip_file(INDEX_PATH)

# Also deploy sw.js and admin.html from the same directory as index.html
pub_dir = os.path.dirname(INDEX_PATH)
SW_PATH = os.path.join(pub_dir, 'sw.js')
sw_content, sw_sha256 = gzip_file(SW_PATH) if os.path.exists(SW_PATH) else (None, None)
if sw_content:
    print(f"     Also deploying: {SW_PATH}")

# admin.html lives next to deploy_index.py (CHS app folder), not in public/
ADMIN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'admin.html')
admin_content, admin_sha256 = gzip_file(ADMIN_PATH) if os.path.exists(ADMIN_PATH) else (None, None)
if admin_content:
    print(f"     Also deploying: {ADMIN_PATH}")

# assets/ lives in the camphisierraapp/public/assets/ directory
ASSETS_DIR = r'C:\Users\Michael\Documents\camphisierraapp\public\assets'
asset_files = {}  # web path → (content, sha256)
if os.path.isdir(ASSETS_DIR):
    for fname in os.listdir(ASSETS_DIR):
        fpath = os.path.join(ASSETS_DIR, fname)
        if os.path.isfile(fpath):
            fc, fsha = gzip_file(fpath)
            asset_files[f'/assets/{fname}'] = (fc, fsha)
    print(f"     Also deploying: {len(asset_files)} asset(s) from {ASSETS_DIR}")
else:
    print(f"     WARNING: assets dir not found at {ASSETS_DIR} — skipping")

# ── 3. Populate files ─────────────────────────────────────────────────────────
print("2/4  Registering files...")
files_map = {'/index.html': sha256}
if sw_content:
    files_map['/sw.js'] = sw_sha256
if admin_content:
    files_map['/admin.html'] = admin_sha256
for web_path, (fc, fsha) in asset_files.items():
    files_map[web_path] = fsha
populate_resp = api('POST', f'{BASE}/{version_name}:populateFiles', {'files': files_map})

# Upload any needed files
required = populate_resp.get('uploadRequiredHashes', [])
upload_url = populate_resp.get('uploadUrl', '')

uploads = [('/index.html', content, sha256)]
if sw_content:
    uploads.append(('/sw.js', sw_content, sw_sha256))
if admin_content:
    uploads.append(('/admin.html', admin_content, admin_sha256))
for web_path, (fc, fsha) in asset_files.items():
    uploads.append((web_path, fc, fsha))
for name, file_content, file_sha in uploads:
    if file_sha in required and upload_url:
        print(f"3/4  Uploading {name}...")
        up_url = f"{upload_url}/{file_sha}"
        up_req = urllib.request.Request(
            up_url, data=file_content,
            headers={'Authorization': f'Bearer {token}',
                     'Content-Type': 'application/octet-stream'},
            method='POST')
        try:
            with urllib.request.urlopen(up_req) as r:
                r.read()
        except urllib.error.HTTPError as e:
            print(f"HTTP {e.code}: {e.read().decode()}")
            raise

# ── 4. Finalize the version and release it ─────────────────────────────────────
print("4/4  Finalizing & releasing...")
api('PATCH', f'{BASE}/{version_name}?update_mask=status', {'status': 'FINALIZED'})
api('POST', f'{BASE}/sites/{SITE_ID}/releases?versionName={version_name}')
print(f"Deployed! https://{SITE_ID}.web.app/  (version {version_id})")
