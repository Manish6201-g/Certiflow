#!/usr/bin/env python3
"""
CertiFlow Backend Server
Automated Certificate Sorting, PDF Name Extraction, Fuzzy Matching, and Gmail SMTP Dispatch Hub.
Optimized for local standalone execution and cloud serverless deployment (Vercel / Lambda).
"""

import os
import sys
import csv
import json
import time
import zlib
import re
import glob
import zipfile
import threading
import difflib
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from io import StringIO
import requests
from flask import Flask, request, jsonify, send_from_directory, send_file, Response
from flask_cors import CORS
import pypdf

# Environment Detection (Local vs Serverless / Vercel)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = BASE_DIR
IS_VERCEL = bool(os.environ.get('VERCEL') or os.environ.get('AWS_LAMBDA_FUNCTION_NAME') or os.path.exists('/var/task'))

# On Vercel / serverless, filesystem is read-only except /tmp
if IS_VERCEL:
    TMP_ROOT = '/tmp'
    UPLOAD_DIR = os.path.join(TMP_ROOT, 'uploads')
    PDF_UPLOAD_DIR = os.path.join(UPLOAD_DIR, 'pdfs')
    CSV_UPLOAD_DIR = os.path.join(UPLOAD_DIR, 'csvs')
    LOGS_DIR = os.path.join(UPLOAD_DIR, 'logs')
    ENV_PATH = '/tmp/.env'
else:
    UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
    PDF_UPLOAD_DIR = os.path.join(UPLOAD_DIR, 'pdfs')
    CSV_UPLOAD_DIR = os.path.join(UPLOAD_DIR, 'csvs')
    LOGS_DIR = os.path.join(UPLOAD_DIR, 'logs')
    ENV_PATH = os.path.join(BASE_DIR, '.env') if os.path.exists(os.path.join(BASE_DIR, '.env')) else os.path.join(os.path.dirname(BASE_DIR), '.env')

SAMPLE_DIR = os.path.join(BASE_DIR, 'sample_data')

# Safely initialize directories (never crash if read-only)
for d in [UPLOAD_DIR, PDF_UPLOAD_DIR, CSV_UPLOAD_DIR, LOGS_DIR]:
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass

app = Flask(__name__, static_folder=BASE_DIR, static_url_path='')
app.url_map.strict_slashes = False
CORS(app)

class VercelPathMiddleware:
    """
    Middleware ensuring Vercel serverless rewrites restore the original incoming path.
    """
    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        from urllib.parse import parse_qs, urlencode, unquote
        
        # 1. Check HTTP headers provided by Vercel proxy
        matched_path = environ.get('HTTP_X_MATCHED_PATH') or environ.get('HTTP_X_VERCEL_MATCHED_PATH')
        if matched_path and matched_path.startswith('/api') and matched_path != '/api/index':
            environ['PATH_INFO'] = matched_path

        # 2. Check __route__ query parameter injected by vercel.json rewrite
        query_str = environ.get('QUERY_STRING', '')
        if '__route__' in query_str:
            qs = parse_qs(query_str)
            if '__route__' in qs:
                route_val = unquote(qs['__route__'][0])
                if route_val:
                    if not route_val.startswith('/'):
                        route_val = '/' + route_val
                    if not route_val.startswith('/api'):
                        route_val = '/api' + route_val
                    environ['PATH_INFO'] = route_val
                qs.pop('__route__', None)
                environ['QUERY_STRING'] = urlencode(qs, doseq=True)

        return self.wsgi_app(environ, start_response)

app.wsgi_app = VercelPathMiddleware(app.wsgi_app)

KNOWN_STATIC_PHRASES = {
    'dr. ashwani', 'ashwani k. sharma', 'ashwani sharma',
    'dr. anish', 'anish gupta',
    'dr. vinay', 'vinay kumar goyal', 'vinay goyal',
    'dr. madhu', 'madhu shukla',
    'certificate', 'coordination', 'participation', 'participating', 'participated',
    'award', 'codezen', 'cgc university', 'mohali', 'department of applied sciences',
    'applied sciences', 'hod', 'dean engineering', 'dean', 'pro vice chancellor',
    'vice chancellor', 'academics', 'international affairs', 'real-world api',
    'workshop', 'proudly presented', 'dedication', 'this certificate is',
    'student coordinator', 'faculty coordinator', 'convener', 'organizing committee',
    'head of department', 'principal', 'director', 'presented to', 'in recognition'
}

def is_static_phrase(text):
    low = text.lower()
    for phrase in KNOWN_STATIC_PHRASES:
        if re.search(r'\b' + re.escape(phrase) + r'\b', low):
            return True
    return False

# Global State for active batch & dispatch
BATCH_STATE = {
    'csv_rows': [],
    'columns': [],
    'detected_cols': {'name': '', 'email': '', 'extra': ''},
    'pdf_files': [],
    'matched_records': [],
    'dispatch': {
        'is_running': False,
        'is_paused': False,
        'should_abort': False,
        'current_index': 0,
        'total': 0,
        'success_count': 0,
        'skip_count': 0,
        'fail_count': 0,
        'logs': [],
        'start_time': None,
        'completed_time': None
    }
}

def load_env_creds():
    # 1. First priority: Environment Variables (e.g. from Vercel Project Settings)
    creds = {
        'GMAIL_USER': os.environ.get('GMAIL_USER', 'manish001yadav0@gmail.com'),
        'GMAIL_APP_PASSWORD': os.environ.get('GMAIL_APP_PASSWORD', ''),
        'DEFAULT_SENDER_NAME': os.environ.get('DEFAULT_SENDER_NAME', 'CodeZen Club'),
        'DEFAULT_REGARDS': os.environ.get('DEFAULT_REGARDS', 'CodeZen Club')
    }

    # 2. Check local disk .env files
    env_paths = [
        ENV_PATH,
        '/tmp/.env',
        os.path.join(BASE_DIR, '.env'),
        os.path.join(os.path.dirname(BASE_DIR), '.env')
    ]
    for p in env_paths:
        if os.path.exists(p):
            try:
                with open(p, 'r') as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#') and '=' in line:
                            k, v = line.split('=', 1)
                            # Only set if not already provided by real environment variables
                            if not creds.get(k.strip()):
                                creds[k.strip()] = v.strip()
                break
            except Exception:
                pass
    return creds

def save_env_creds(user, app_password, sender_name='CodeZen Club', regards='CodeZen Club'):
    os.environ['GMAIL_USER'] = user
    os.environ['GMAIL_APP_PASSWORD'] = app_password
    os.environ['DEFAULT_SENDER_NAME'] = sender_name
    os.environ['DEFAULT_REGARDS'] = regards

    target = '/tmp/.env' if IS_VERCEL else ENV_PATH
    try:
        with open(target, 'w') as f:
            f.write(f"GMAIL_USER={user}\nGMAIL_APP_PASSWORD={app_password}\nDEFAULT_SENDER_NAME={sender_name}\nDEFAULT_REGARDS={regards}\n")
    except Exception as e:
        print(f"Notice: Could not write .env to disk ({e}), credentials kept in memory.")

# -------------------------------------------------------------
# Dual-Layer PDF Name Extraction Engine
# -------------------------------------------------------------
def extract_name_from_pdf(pdf_path):
    """
    Extracts the recipient name from a certificate PDF.
    Layer 1: pypdf layout lines inspection (filtered against known static terms).
    Layer 2: Direct PDF stream decoding using ToUnicode CMap lookup tables.
    """
    # Layer 1: pypdf lines
    try:
        reader = pypdf.PdfReader(pdf_path)
        for page in reader.pages:
            text = page.extract_text()
            if text:
                lines = [l.strip() for l in text.splitlines() if l.strip()]
                for line in reversed(lines):
                    clean = re.sub(r'[^a-zA-Z\s\.]', '', line).strip()
                    if not clean or len(clean) < 3 or len(clean) > 45:
                        continue
                    if is_static_phrase(clean):
                        continue
                    words = clean.split()
                    if 1 <= len(words) <= 5:
                        return clean
    except Exception:
        pass

    # Layer 2: CMap font stream extraction
    try:
        with open(pdf_path, 'rb') as f:
            data = f.read()

        cmaps = {}
        for m in re.finditer(rb'(\d+)\s+0\s+obj.*?stream\r?\n(.*?)\r?\nendstream', data, re.DOTALL):
            if b'begincmap' in m.group(2):
                txt = m.group(2).decode('latin1', errors='ignore')
                mapping = {}
                for line in txt.splitlines():
                    cm = re.search(r'<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>', line)
                    if cm:
                        mapping[int(cm.group(1), 16)] = chr(int(cm.group(2), 16))
                cmaps[int(m.group(1))] = mapping

        # Scan text streams
        for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', data, re.DOTALL):
            try:
                dec = zlib.decompress(m.group(1))
            except Exception:
                continue

            if b'BT' in dec and b'ET' in dec:
                for b in re.findall(rb'BT\r?\n(.*?)\r?\nET', dec, re.DOTALL):
                    if any(sz in b for sz in [b'24.0000', b'22.0000', b'20.0000', b'26.0000', b'28.0000', b'18.0000']):
                        hexes = re.findall(rb'<([0-9A-Fa-f]+)>', b)
                        for cmap in cmaps.values():
                            decoded = ''
                            for h in hexes:
                                for k in range(0, len(h), 4):
                                    cid = int(h[k:k+4], 16)
                                    decoded += cmap.get(cid, '')
                            clean = decoded.strip()
                            if len(clean) >= 3 and not is_static_phrase(clean):
                                return clean
    except Exception:
        pass

    return "Unknown Recipient"

# -------------------------------------------------------------
# Name Matching & Normalization Engine
# -------------------------------------------------------------
def normalize_name(name):
    if not name:
        return ""
    clean = re.sub(r'^(mr\.|ms\.|mrs\.|dr\.|prof\.)\s+', '', name.strip(), flags=re.IGNORECASE)
    clean = re.sub(r'[^a-zA-Z\s]', '', clean).lower()
    return ' '.join(clean.split())

def match_extracted_name(extracted_name, csv_rows, name_col, email_col, extra_col):
    norm_ext = normalize_name(extracted_name)
    if not norm_ext:
        return None, 0.0, 'UNMATCHED', 'Name could not be extracted from PDF'

    ext_tokens = set(norm_ext.split())
    candidates = []

    for row in csv_rows:
        sheet_name = row.get(name_col, '')
        norm_sheet = normalize_name(sheet_name)
        if not norm_sheet:
            continue

        sheet_tokens = set(norm_sheet.split())

        # Exact match
        if norm_ext == norm_sheet:
            return row, 1.0, 'EXACT', 'Exact 100% name match'

        # Token set match
        if ext_tokens == sheet_tokens:
            candidates.append((row, 0.98, 'TOKEN_EXACT', 'Tokens match exactly'))
            continue

        if ext_tokens.issubset(sheet_tokens) or sheet_tokens.issubset(ext_tokens):
            score = 0.90 if len(ext_tokens & sheet_tokens) >= 2 else 0.85
            candidates.append((row, score, 'SUBSET', f'Subset match ({len(ext_tokens & sheet_tokens)} words)'))
            continue

        # Sequence fuzzy match
        ratio = difflib.SequenceMatcher(None, norm_ext, norm_sheet).ratio()
        if ratio >= 0.78:
            candidates.append((row, round(ratio, 2), 'FUZZY', f'Fuzzy similarity {int(ratio*100)}%'))

    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        top_row, top_score, top_type, top_reason = candidates[0]
        if len(candidates) > 1 and candidates[0][1] == candidates[1][1]:
            top_type = 'AMBIGUOUS'
            top_reason = 'Multiple rows in sheet match this name with equal confidence'
        return top_row, top_score, top_type, top_reason

    return None, 0.0, 'UNMATCHED', 'No matching recipient found in sheet'

# -------------------------------------------------------------
# Email Dispatch Engine
# -------------------------------------------------------------
def build_email_message(sender_email, sender_name, recipient_email, recipient_name, subject, body_template, regards, pdf_path, extra_vars=None):
    if extra_vars is None:
        extra_vars = {}

    msg = MIMEMultipart()
    from_header = f"{sender_name} <{sender_email}>" if sender_name else sender_email
    msg['From'] = from_header
    msg['To'] = recipient_email

    tokens = {
        'name': recipient_name,
        'email': recipient_email,
        'regards': regards,
        'sender': sender_name,
        **extra_vars
    }

    formatted_subject = subject
    for k, v in tokens.items():
        formatted_subject = re.sub(f'\\{{{k}\\}}', str(v), formatted_subject, flags=re.IGNORECASE)
    msg['Subject'] = formatted_subject

    formatted_body = body_template
    for k, v in tokens.items():
        formatted_body = re.sub(f'\\{{{k}\\}}', str(v), formatted_body, flags=re.IGNORECASE)

    if regards and regards not in formatted_body:
        formatted_body += f"\n\nWarm regards,\n{regards}"

    msg.attach(MIMEText(formatted_body, 'plain'))

    clean_name = f"Certificate_{re.sub(r'[^a-zA-Z0-9_]', '_', recipient_name)}.pdf"
    with open(pdf_path, 'rb') as f:
        part = MIMEApplication(f.read(), Name=clean_name)
        part['Content-Disposition'] = f'attachment; filename="{clean_name}"'
        msg.attach(part)

    return msg

def dispatch_worker(sender_email, app_password, sender_name, subject, body, regards, delay_seconds=1.0):
    state = BATCH_STATE['dispatch']
    records = BATCH_STATE['matched_records']

    state['is_running'] = True
    state['is_paused'] = False
    state['should_abort'] = False
    state['current_index'] = 0
    state['total'] = len([r for r in records if r.get('included', True) and r.get('email')])
    state['success_count'] = 0
    state['skip_count'] = 0
    state['fail_count'] = 0
    state['logs'] = []
    state['start_time'] = time.strftime('%Y-%m-%d %H:%M:%S')

    def add_log(msg_type, text):
        entry = {
            'time': time.strftime('%H:%M:%S'),
            'type': msg_type,
            'text': text
        }
        state['logs'].append(entry)

    add_log('info', f"Connecting to Gmail SMTP server for {sender_email}...")
    server = None
    try:
        server = smtplib.SMTP('smtp.gmail.com', 587, timeout=30)
        server.starttls()
        server.login(sender_email, app_password)
        add_log('success', "SMTP connection established & authenticated successfully!")
    except Exception as e:
        add_log('error', f"SMTP Authentication failed: {str(e)}")
        state['is_running'] = False
        return

    for idx, r in enumerate(records):
        if state['should_abort']:
            add_log('warning', "Dispatch aborted by user.")
            break

        while state['is_paused'] and not state['should_abort']:
            time.sleep(0.5)

        if not r.get('included', True):
            continue

        email = (r.get('email') or '').strip()
        name = r.get('cert_name') or r.get('sheet_name') or 'Participant'
        pdf_path = r.get('pdf_path')
        pdf_file = r.get('pdf_file', os.path.basename(pdf_path) if pdf_path else 'cert.pdf')

        if not email:
            state['skip_count'] += 1
            add_log('warning', f"[{idx+1}/{len(records)}] Skipped {name} ({pdf_file}): No email address found.")
            r['delivery_status'] = 'SKIPPED_NO_EMAIL'
            continue

        if not pdf_path or not os.path.exists(pdf_path):
            state['fail_count'] += 1
            add_log('error', f"[{idx+1}/{len(records)}] Failed {name} <{email}>: Certificate PDF not found on disk.")
            r['delivery_status'] = 'FAILED_MISSING_FILE'
            continue

        retries = 2
        sent_ok = False
        while retries > 0 and not sent_ok:
            try:
                msg = build_email_message(
                    sender_email=sender_email,
                    sender_name=sender_name,
                    recipient_email=email,
                    recipient_name=name,
                    subject=subject,
                    body_template=body,
                    regards=regards,
                    pdf_path=pdf_path,
                    extra_vars={'roll': r.get('roll', ''), 'duty': r.get('duty', '')}
                )
                server.send_message(msg)
                sent_ok = True
                state['success_count'] += 1
                r['delivery_status'] = 'DELIVERED'
                r['delivered_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
                add_log('success', f"[{state['success_count']}/{state['total']}] Delivered to {name} <{email}> ({pdf_file})")
            except Exception as e:
                retries -= 1
                if retries > 0:
                    add_log('warning', f"Transient SMTP error for {name} ({str(e)}). Reconnecting...")
                    time.sleep(2)
                    try:
                        server.quit()
                    except Exception:
                        pass
                    try:
                        server = smtplib.SMTP('smtp.gmail.com', 587, timeout=30)
                        server.starttls()
                        server.login(sender_email, app_password)
                    except Exception as re_err:
                        add_log('error', f"Reconnection failed: {str(re_err)}")
                else:
                    state['fail_count'] += 1
                    r['delivery_status'] = 'FAILED'
                    add_log('error', f"Failed to send to {name} <{email}>: {str(e)}")

        state['current_index'] = idx + 1
        time.sleep(delay_seconds)

    if server:
        try:
            server.quit()
        except Exception:
            pass

    state['is_running'] = False
    state['completed_time'] = time.strftime('%Y-%m-%d %H:%M:%S')
    add_log('info', f"Dispatch finished! Delivered: {state['success_count']}, Skipped: {state['skip_count']}, Failed: {state['fail_count']}")

    try:
        log_file = os.path.join(LOGS_DIR, f"dispatch_{int(time.time())}.json")
        with open(log_file, 'w') as f:
            json.dump({
                'start_time': state['start_time'],
                'completed_time': state['completed_time'],
                'total_delivered': state['success_count'],
                'records': records
            }, f, indent=2)
    except Exception:
        pass

# -------------------------------------------------------------
# HTTP REST API Routes
# -------------------------------------------------------------

@app.route('/')
def serve_index():
    return send_file(os.path.join(BASE_DIR, 'index.html'))

@app.route('/api', methods=['GET', 'POST', 'OPTIONS'])
@app.route('/api/', methods=['GET', 'POST', 'OPTIONS'])
@app.route('/api/index', methods=['GET', 'POST', 'OPTIONS'])
def api_health():
    return jsonify({'status': 'ok', 'service': 'CertiFlow API Engine', 'version': '1.0'})

@app.route('/api/debug-env', methods=['GET', 'POST', 'OPTIONS'])
def api_debug_env():
    return jsonify({
        'status': 'ok',
        'path_info': request.environ.get('PATH_INFO'),
        'query_string': request.environ.get('QUERY_STRING'),
        'method': request.method,
        'headers': dict(request.headers),
        'is_vercel': IS_VERCEL
    })

@app.route('/api/config', methods=['GET', 'POST'])
@app.route('/config', methods=['GET', 'POST'])
def api_config():
    if request.method == 'POST':
        data = request.json or {}
        user = data.get('gmail_user', '').strip()
        pwd = data.get('gmail_password', '').strip()
        sname = data.get('sender_name', 'CodeZen Club').strip()
        reg = data.get('regards', 'CodeZen Club').strip()
        save_env_creds(user, pwd, sname, reg)
        return jsonify({'status': 'ok', 'message': 'Configuration saved successfully'})

    creds = load_env_creds()
    masked_pwd = creds.get('GMAIL_APP_PASSWORD', '')
    return jsonify({
        'gmail_user': creds.get('GMAIL_USER', ''),
        'has_password': bool(masked_pwd),
        'masked_password': (masked_pwd[:4] + '••••••••' + masked_pwd[-4:]) if len(masked_pwd) >= 8 else ('••••' if masked_pwd else ''),
        'raw_password': masked_pwd,
        'sender_name': creds.get('DEFAULT_SENDER_NAME', 'CodeZen Club'),
        'regards': creds.get('DEFAULT_REGARDS', 'CodeZen Club')
    })

@app.route('/api/upload-csv', methods=['POST'])
@app.route('/upload-csv', methods=['POST'])
def api_upload_csv():
    csv_text = ""
    url = request.form.get('sheet_url') or (request.json.get('sheet_url') if request.is_json else None)
    if url:
        url = url.strip()
        match = re.search(r'/spreadsheets/d/([a-zA-Z0-9-_]+)', url)
        if match:
            sheet_id = match.group(1)
            gid_match = re.search(r'gid=([0-9]+)', url)
            gid_param = f"&gid={gid_match.group(1)}" if gid_match else ""
            export_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv{gid_param}"
            try:
                resp = requests.get(export_url, timeout=15)
                if resp.status_code == 200:
                    csv_text = resp.text
                else:
                    return jsonify({'error': f'Failed to fetch Google Sheet: HTTP {resp.status_code}'}), 400
            except Exception as e:
                return jsonify({'error': f'Network error fetching Google Sheet: {str(e)}'}), 500
        else:
            return jsonify({'error': 'Invalid Google Sheets URL format'}), 400

    if not csv_text and 'file' in request.files:
        f = request.files['file']
        csv_text = f.read().decode('utf-8', errors='ignore')

    if not csv_text:
        csv_text = request.form.get('csv_content') or (request.json.get('csv_content') if request.is_json else "") or ""

    if not csv_text.strip():
        return jsonify({'error': 'No CSV data provided'}), 400

    try:
        reader = csv.reader(StringIO(csv_text))
        rows = list(reader)
        if not rows:
            return jsonify({'error': 'Empty spreadsheet provided'}), 400

        headers = [h.strip() for h in rows[0]]
        records = []
        for r in rows[1:]:
            if not any(r): continue
            item = {}
            for i, h in enumerate(headers):
                item[h] = r[i].strip() if i < len(r) else ''
            records.append(item)

        name_col = ""
        email_col = ""
        extra_col = ""

        for h in headers:
            lh = h.lower()
            if not name_col and any(k in lh for k in ['name', 'participant', 'coordinator', 'student']):
                name_col = h
            elif not email_col and any(k in lh for k in ['email', 'mail']):
                email_col = h
            elif not extra_col and any(k in lh for k in ['roll', 'duty', 'id', 'department', 'section']):
                extra_col = h

        if not name_col and headers:
            name_col = headers[0]
        if not email_col and len(headers) > 1:
            email_col = headers[1]

        BATCH_STATE['csv_rows'] = records
        BATCH_STATE['columns'] = headers
        BATCH_STATE['detected_cols'] = {'name': name_col, 'email': email_col, 'extra': extra_col}

        return jsonify({
            'status': 'ok',
            'row_count': len(records),
            'columns': headers,
            'detected': BATCH_STATE['detected_cols'],
            'rows': records,
            'preview': records[:5]
        })
    except Exception as e:
        return jsonify({'error': f'Error parsing CSV: {str(e)}'}), 400

@app.route('/api/extract-names', methods=['POST'])
@app.route('/extract-names', methods=['POST'])
def api_extract_names():
    files = request.files.getlist('pdfs') or request.files.getlist('file') or request.files.getlist('files')
    if not files:
        return jsonify({'error': 'No PDF files attached'}), 400

    extracted = []
    for f in files:
        fname = f.filename
        if not fname or not fname.lower().endswith('.pdf'):
            continue
        base_n = os.path.basename(fname)
        target_path = os.path.join(PDF_UPLOAD_DIR, base_n)
        try:
            f.save(target_path)
            extracted_name = extract_name_from_pdf(target_path)
            extracted.append({
                'filename': base_n,
                'name': extracted_name or '',
                'size': os.path.getsize(target_path)
            })
        except Exception as e:
            extracted.append({
                'filename': base_n,
                'name': '',
                'error': str(e)
            })

    return jsonify({
        'status': 'ok',
        'count': len(extracted),
        'extracted': extracted
    })

@app.route('/api/upload-pdfs', methods=['POST'])
@app.route('/upload-pdfs', methods=['POST'])
def api_upload_pdfs():
    files = request.files.getlist('pdfs') or request.files.getlist('file') or request.files.getlist('files')
    if not files:
        return jsonify({'error': 'No PDF files attached'}), 400

    uploaded = []
    for f in files:
        fname = f.filename
        if not fname:
            continue
        if fname.lower().endswith('.zip'):
            zpath = os.path.join(UPLOAD_DIR, fname)
            f.save(zpath)
            try:
                with zipfile.ZipFile(zpath, 'r') as zip_ref:
                    for zip_info in zip_ref.infolist():
                        if zip_info.filename.lower().endswith('.pdf') and not zip_info.filename.startswith('__MACOSX'):
                            base_n = os.path.basename(zip_info.filename)
                            if base_n:
                                target_path = os.path.join(PDF_UPLOAD_DIR, base_n)
                                with zip_ref.open(zip_info) as source, open(target_path, 'wb') as target:
                                    target.write(source.read())
                                uploaded.append({
                                    'filename': base_n,
                                    'path': target_path,
                                    'size': os.path.getsize(target_path)
                                })
            except Exception as e:
                return jsonify({'error': f'Failed to unzip file: {str(e)}'}), 400
        elif fname.lower().endswith('.pdf'):
            base_n = os.path.basename(fname)
            target_path = os.path.join(PDF_UPLOAD_DIR, base_n)
            f.save(target_path)
            uploaded.append({
                'filename': base_n,
                'path': target_path,
                'size': os.path.getsize(target_path)
            })

    BATCH_STATE['pdf_files'] = uploaded
    return jsonify({
        'status': 'ok',
        'file_count': len(uploaded),
        'files': [{'filename': u['filename'], 'size': u['size']} for u in uploaded]
    })

@app.route('/api/load-sample', methods=['POST'])
@app.route('/load-sample', methods=['POST'])
def api_load_sample():
    sample_type = (request.json or {}).get('type', 'participants')

    if sample_type == 'coordinators':
        csv_candidates = [
            os.path.join(SAMPLE_DIR, 'coordinators.csv'),
            os.path.join(SAMPLE_DIR, 'coordinators_sample.csv'),
            os.path.join(BASE_DIR, 'coordinators.csv'),
            os.path.join(os.path.dirname(BASE_DIR), 'coordinators.csv')
        ]
        pdf_candidates = [
            os.path.join(SAMPLE_DIR, 'coordinators'),
            os.path.join(BASE_DIR, 'coordinator_certificates'),
            os.path.join(os.path.dirname(BASE_DIR), 'coordinator_certificates')
        ]
        name_col = 'Coordinator Name'
        email_col = 'Email Address'
        extra_col = 'Assigned Duty'
    else:
        csv_candidates = [
            os.path.join(SAMPLE_DIR, 'participants.csv'),
            os.path.join(SAMPLE_DIR, 'participants_sample.csv'),
            os.path.join(BASE_DIR, 'participants.csv'),
            os.path.join(os.path.dirname(BASE_DIR), 'participants.csv')
        ]
        pdf_candidates = [
            os.path.join(SAMPLE_DIR, 'participants'),
            os.path.join(BASE_DIR, 'drive_certificates'),
            os.path.join(os.path.dirname(BASE_DIR), 'drive_certificates')
        ]
        name_col = 'Name'
        email_col = 'Email'
        extra_col = 'Roll No'

    csv_file = next((c for c in csv_candidates if os.path.exists(c)), None)
    pdf_dir = next((d for d in pdf_candidates if os.path.exists(d)), None)

    if not csv_file:
        return jsonify({'error': 'Sample CSV dataset not found'}), 404

    records = []
    with open(csv_file, 'r', encoding='utf-8', errors='ignore') as f:
        reader = csv.DictReader(f)
        for r in reader:
            records.append({k.strip(): v.strip() for k, v in r.items() if k})

    headers = list(records[0].keys()) if records else []

    pdfs = []
    if pdf_dir and os.path.exists(pdf_dir):
        pdf_paths = sorted(glob.glob(os.path.join(pdf_dir, '*.pdf')))
        pdfs = [{'filename': os.path.basename(p), 'path': p, 'size': os.path.getsize(p)} for p in pdf_paths]

    BATCH_STATE['csv_rows'] = records
    BATCH_STATE['columns'] = headers
    BATCH_STATE['detected_cols'] = {'name': name_col, 'email': email_col, 'extra': extra_col}
    BATCH_STATE['pdf_files'] = pdfs

    return jsonify({
        'status': 'ok',
        'type': sample_type,
        'row_count': len(records),
        'pdf_count': len(pdfs),
        'columns': headers,
        'detected': BATCH_STATE['detected_cols'],
        'rows': records
    })

@app.route('/api/match', methods=['POST'])
@app.route('/match', methods=['POST'])
def api_match():
    data = request.json or {}
    name_col = data.get('name_col') or BATCH_STATE['detected_cols'].get('name')
    email_col = data.get('email_col') or BATCH_STATE['detected_cols'].get('email')
    extra_col = data.get('extra_col') or BATCH_STATE['detected_cols'].get('extra')

    csv_rows = data.get('csv_rows') or BATCH_STATE['csv_rows']
    extracted_items = data.get('extracted_items')

    if not csv_rows:
        return jsonify({'error': 'No CSV spreadsheet loaded'}), 400

    if csv_rows and (not name_col or not email_col):
        headers = list(csv_rows[0].keys())
        for h in headers:
            lh = h.lower()
            if not name_col and any(k in lh for k in ['name', 'participant', 'coordinator', 'student']):
                name_col = h
            elif not email_col and any(k in lh for k in ['email', 'mail']):
                email_col = h
            elif not extra_col and any(k in lh for k in ['roll', 'duty', 'id', 'department', 'section']):
                extra_col = h
        if not name_col and headers:
            name_col = headers[0]
        if not email_col and len(headers) > 1:
            email_col = headers[1]

    results = []
    matched_sheet_rows = set()

    if extracted_items:
        for idx, item in enumerate(extracted_items):
            fname = item.get('filename') or f"cert_{idx+1}.pdf"
            extracted = item.get('name', '').strip()
            pdf_path = item.get('path', '')

            matched_row, conf, m_type, reason = match_extracted_name(
                extracted_name=extracted,
                csv_rows=csv_rows,
                name_col=name_col,
                email_col=email_col,
                extra_col=extra_col
            )

            email = ""
            sheet_name = ""
            extra_val = ""
            match_status = "MATCHED"

            if matched_row:
                sheet_name = matched_row.get(name_col, '')
                email = matched_row.get(email_col, '').strip()
                extra_val = matched_row.get(extra_col, '').strip()
                row_id = id(matched_row)
                matched_sheet_rows.add(row_id)

                if not email:
                    match_status = "MISSING_EMAIL"
                elif m_type == 'AMBIGUOUS':
                    match_status = "AMBIGUOUS"
                elif m_type == 'FUZZY':
                    match_status = "FUZZY_MATCH"
            else:
                match_status = "UNMATCHED"

            results.append({
                'id': idx + 1,
                'pdf_file': fname,
                'pdf_path': pdf_path,
                'cert_name': extracted,
                'sheet_name': sheet_name,
                'email': email,
                'extra': extra_val,
                'confidence': conf,
                'match_type': m_type,
                'match_status': match_status,
                'reason': reason,
                'included': match_status != 'UNMATCHED' and bool(email),
                'delivery_status': 'PENDING'
            })
    else:
        pdf_files = BATCH_STATE.get('pdf_files', [])
        if not pdf_files:
            if csv_rows:
                pdf_files = [{'filename': f"page-{i+1:03d}.pdf", 'path': '', 'name': r.get(name_col, '')} for i, r in enumerate(csv_rows)]
            else:
                return jsonify({'error': 'No PDF certificates uploaded'}), 400

        for idx, pdf in enumerate(pdf_files):
            pdf_path = pdf.get('path', '')
            fname = pdf.get('filename') or f"page-{idx+1:03d}.pdf"
            extracted = pdf.get('name') or (extract_name_from_pdf(pdf_path) if pdf_path and os.path.exists(pdf_path) else fname)

            matched_row, conf, m_type, reason = match_extracted_name(
                extracted_name=extracted,
                csv_rows=csv_rows,
                name_col=name_col,
                email_col=email_col,
                extra_col=extra_col
            )

            email = ""
            sheet_name = ""
            extra_val = ""
            match_status = "MATCHED"

            if matched_row:
                sheet_name = matched_row.get(name_col, '')
                email = matched_row.get(email_col, '').strip()
                extra_val = matched_row.get(extra_col, '').strip()
                row_id = id(matched_row)
                matched_sheet_rows.add(row_id)

                if not email:
                    match_status = "MISSING_EMAIL"
                elif m_type == 'AMBIGUOUS':
                    match_status = "AMBIGUOUS"
                elif m_type == 'FUZZY':
                    match_status = "FUZZY_MATCH"
            else:
                match_status = "UNMATCHED"

            results.append({
                'id': idx + 1,
                'pdf_file': fname,
                'pdf_path': pdf_path,
                'cert_name': extracted,
                'sheet_name': sheet_name,
                'email': email,
                'extra': extra_val,
                'confidence': conf,
                'match_type': m_type,
                'match_status': match_status,
                'reason': reason,
                'included': match_status != 'UNMATCHED' and bool(email),
                'delivery_status': 'PENDING'
            })

    BATCH_STATE['matched_records'] = results

    total = len(results)
    matched_count = sum(1 for r in results if r['match_status'] in ['MATCHED', 'FUZZY_MATCH'] and r['email'])
    missing_email_count = sum(1 for r in results if r['match_status'] == 'MISSING_EMAIL')
    unmatched_count = sum(1 for r in results if r['match_status'] == 'UNMATCHED')

    return jsonify({
        'status': 'ok',
        'total': total,
        'matched_count': matched_count,
        'missing_email_count': missing_email_count,
        'unmatched_count': unmatched_count,
        'records': results
    })

@app.route('/api/update-record', methods=['POST'])
@app.route('/update-record', methods=['POST'])
def api_update_record():
    data = request.json or {}
    record_id = data.get('id')
    for r in BATCH_STATE['matched_records']:
        if r['id'] == record_id:
            if 'email' in data:
                r['email'] = data['email'].strip()
                if r['email'] and r['match_status'] == 'MISSING_EMAIL':
                    r['match_status'] = 'MATCHED'
                    r['included'] = True
            if 'cert_name' in data:
                r['cert_name'] = data['cert_name'].strip()
            if 'included' in data:
                r['included'] = bool(data['included'])
            return jsonify({'status': 'ok', 'record': r})
    return jsonify({'error': 'Record not found'}), 404

@app.route('/api/preview-pdf/<path:filename>')
@app.route('/preview-pdf/<path:filename>')
def api_preview_pdf(filename):
    candidates = [
        os.path.join(PDF_UPLOAD_DIR, filename),
        os.path.join(SAMPLE_DIR, filename),
        os.path.join(SAMPLE_DIR, 'participants', filename),
        os.path.join(SAMPLE_DIR, 'coordinators', filename),
        os.path.join(BASE_DIR, 'drive_certificates', filename),
        os.path.join(BASE_DIR, 'coordinator_certificates', filename),
        os.path.join(os.path.dirname(BASE_DIR), 'drive_certificates', filename),
        os.path.join(os.path.dirname(BASE_DIR), 'coordinator_certificates', filename)
    ]
    target = next((c for c in candidates if os.path.exists(c)), None)
    if not target:
        return "PDF not found", 404

    return send_file(target, mimetype='application/pdf')

@app.route('/api/send-test', methods=['POST'])
@app.route('/send-test', methods=['POST'])
def api_send_test():
    data = request.json or {}
    test_email = data.get('test_email', '').strip()
    subject = data.get('subject', 'Certificate Test Delivery')
    body = data.get('body', 'This is a test certificate dispatch.')
    regards = data.get('regards', 'CodeZen Club')
    sender_name = data.get('sender_name', 'CodeZen Club')
    user = data.get('gmail_user')
    password = data.get('gmail_password')

    if not test_email:
        return jsonify({'error': 'Recipient test email is required'}), 400

    creds = load_env_creds()
    if not user:
        user = creds.get('GMAIL_USER')
    if not password:
        password = creds.get('GMAIL_APP_PASSWORD')

    if not user or not password:
        return jsonify({'error': 'Gmail User and App Password are required'}), 400

    records = BATCH_STATE['matched_records']
    sample_pdf = None
    sample_name = "Test Participant"
    if records:
        for r in records:
            if r.get('pdf_path') and os.path.exists(r['pdf_path']):
                sample_pdf = r['pdf_path']
                sample_name = r.get('cert_name', 'Test Participant')
                break

    if not sample_pdf:
        sample_candidates = glob.glob(os.path.join(SAMPLE_DIR, '*.pdf')) + glob.glob(os.path.join(BASE_DIR, 'drive_certificates', '*.pdf')) + glob.glob(os.path.join(os.path.dirname(BASE_DIR), 'drive_certificates', '*.pdf'))
        if sample_candidates:
            sample_pdf = sample_candidates[0]

    if not sample_pdf or not os.path.exists(sample_pdf):
        return jsonify({'error': 'No PDF certificate file available on server to attach'}), 400

    try:
        server = smtplib.SMTP('smtp.gmail.com', 587, timeout=20)
        server.starttls()
        server.login(user, password)
        msg = build_email_message(
            sender_email=user,
            sender_name=sender_name,
            recipient_email=test_email,
            recipient_name=sample_name,
            subject=f"[TEST] {subject}",
            body_template=f"[THIS IS A TEST DISPATCH]\n\n{body}",
            regards=regards,
            pdf_path=sample_pdf
        )
        server.send_message(msg)
        server.quit()
        return jsonify({
            'status': 'ok',
            'message': f"Test email sent successfully to {test_email} with certificate {os.path.basename(sample_pdf)} attached!"
        })
    except Exception as e:
        return jsonify({'error': f"Failed to send test email: {str(e)}"}), 500

@app.route('/api/send-single', methods=['POST'])
@app.route('/send-single', methods=['POST'])
def api_send_single():
    creds = load_env_creds()
    sender_email = request.form.get('gmail_user') or creds.get('GMAIL_USER')
    app_password = request.form.get('gmail_password') or creds.get('GMAIL_APP_PASSWORD')
    sender_name = request.form.get('sender_name') or creds.get('DEFAULT_SENDER_NAME', 'CodeZen Club')
    regards = request.form.get('regards') or creds.get('DEFAULT_REGARDS', 'CodeZen Club')

    if not sender_email or not app_password:
        return jsonify({'error': 'Gmail credentials not configured. Please check SMTP settings.'}), 400

    recipient_email = request.form.get('recipient_email', '').strip()
    recipient_name = request.form.get('recipient_name', '').strip()
    subject = request.form.get('subject', 'Certificate of Participation')
    body = request.form.get('body', '')

    if not recipient_email:
        return jsonify({'error': 'Missing recipient email'}), 400

    pdf_bytes = None
    clean_name = f"Certificate_{re.sub(r'[^a-zA-Z0-9_]', '_', recipient_name or 'Recipient')}.pdf"

    if 'pdf' in request.files or 'file' in request.files:
        f = request.files.get('pdf') or request.files.get('file')
        pdf_bytes = f.read()
    else:
        pdf_filename = request.form.get('filename')
        if pdf_filename:
            local_p = os.path.join(PDF_UPLOAD_DIR, os.path.basename(pdf_filename))
            if os.path.exists(local_p):
                with open(local_p, 'rb') as f:
                    pdf_bytes = f.read()

    if not pdf_bytes:
        return jsonify({'error': 'No PDF attachment found for this recipient'}), 400

    tokens = {
        'name': recipient_name,
        'email': recipient_email,
        'regards': regards,
        'sender': sender_name
    }

    fmt_subj = subject
    for k, v in tokens.items():
        fmt_subj = re.sub(f'\\{{{k}\\}}', str(v), fmt_subj, flags=re.IGNORECASE)

    fmt_body = body
    for k, v in tokens.items():
        fmt_body = re.sub(f'\\{{{k}\\}}', str(v), fmt_body, flags=re.IGNORECASE)

    if regards and regards not in fmt_body:
        fmt_body += f"\n\nWarm regards,\n{regards}"

    msg = MIMEMultipart()
    from_header = f"{sender_name} <{sender_email}>" if sender_name else sender_email
    msg['From'] = from_header
    msg['To'] = recipient_email
    msg['Subject'] = fmt_subj
    msg.attach(MIMEText(fmt_body, 'plain'))

    part = MIMEApplication(pdf_bytes, Name=clean_name)
    part['Content-Disposition'] = f'attachment; filename="{clean_name}"'
    msg.attach(part)

    try:
        clean_pwd = re.sub(r'\s+', '', app_password)
        with smtplib.SMTP('smtp.gmail.com', 587, timeout=20) as server:
            server.starttls()
            server.login(sender_email, clean_pwd)
            server.send_message(msg)

        return jsonify({
            'status': 'ok',
            'recipient': recipient_email,
            'name': recipient_name
        })
    except Exception as e:
        return jsonify({'error': f'SMTP Error: {str(e)}'}), 500

@app.route('/api/dispatch', methods=['POST'])
@app.route('/dispatch', methods=['POST'])
def api_start_dispatch():
    if BATCH_STATE['dispatch']['is_running']:
        return jsonify({'error': 'A dispatch job is already running'}), 400

    data = request.json or {}
    user = data.get('gmail_user')
    password = data.get('gmail_password')
    sender_name = data.get('sender_name', 'CodeZen Club')
    subject = data.get('subject', 'Certificate of Participation')
    body = data.get('body', '')
    regards = data.get('regards', 'CodeZen Club')
    delay = float(data.get('delay', 1.0))

    creds = load_env_creds()
    if not user:
        user = creds.get('GMAIL_USER')
    if not password:
        password = creds.get('GMAIL_APP_PASSWORD')

    if not user or not password:
        return jsonify({'error': 'Missing Gmail credentials. Enter them in the settings panel.'}), 400

    t = threading.Thread(
        target=dispatch_worker,
        args=(user, password, sender_name, subject, body, regards, delay),
        daemon=True
    )
    t.start()

    return jsonify({'status': 'ok', 'message': 'Dispatch started successfully'})

@app.route('/api/dispatch-status', methods=['GET'])
@app.route('/dispatch-status', methods=['GET'])
def api_dispatch_status():
    st = BATCH_STATE['dispatch']
    pct = round((st['current_index'] / st['total'] * 100) if st['total'] > 0 else 0, 1)
    return jsonify({
        'is_running': st['is_running'],
        'is_paused': st['is_paused'],
        'current_index': st['current_index'],
        'total': st['total'],
        'percentage': pct,
        'success_count': st['success_count'],
        'skip_count': st['skip_count'],
        'fail_count': st['fail_count'],
        'logs': st['logs'][-50:],
        'start_time': st['start_time'],
        'completed_time': st['completed_time']
    })

@app.route('/api/dispatch-control', methods=['POST'])
@app.route('/dispatch-control', methods=['POST'])
def api_dispatch_control():
    action = (request.json or {}).get('action')
    st = BATCH_STATE['dispatch']
    if action == 'pause':
        st['is_paused'] = True
    elif action == 'resume':
        st['is_paused'] = False
    elif action == 'abort':
        st['should_abort'] = True
        st['is_paused'] = False
    return jsonify({'status': 'ok', 'action': action})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5050))
    print(f"\n=======================================================")
    print(f"🚀 CertiFlow Server live on http://localhost:{port}")
    print(f"=======================================================\n")
    app.run(host='0.0.0.0', port=port, debug=False)
