/**
 * CertiFlow — Automated Certificate Verification & Bulk Dispatch Hub
 * Handles Data Upload, CMap Font Extraction, Interactive Matching, Canvas Studio, and Live Dispatch.
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let serverConfig = {};
  let currentCsvData = null;
  let currentMatchedRecords = [];
  let matchFilter = 'all';
  let matchSearchQuery = '';
  let dispatchPollTimer = null;

  async function safeJson(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      const cleanSnippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
      throw new Error(`Server returned HTTP ${res.status}: ${cleanSnippet || 'Empty response'}`);
    }
  }

  // =========================================================
  // SESSION-BASED DELIVERY AUDIT (Auto-clears on tab close / 20m inactivity)
  // =========================================================
  const SESSION_KEY = 'certiflow_session_audit_v2';
  const SESSION_TTL_MS = 20 * 60 * 1000; // 20 minutes inactivity TTL

  function loadSessionAuditRecords() {
    // Purge legacy permanent localStorage
    try { localStorage.removeItem('certiflow_audit_records'); } catch (e) {}

    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const payload = JSON.parse(raw);
        if (payload.timestamp && (Date.now() - payload.timestamp < SESSION_TTL_MS)) {
          payload.timestamp = Date.now(); // bump activity timer
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
          return payload.records || [];
        } else {
          sessionStorage.removeItem(SESSION_KEY);
        }
      }
    } catch (e) {}
    return [];
  }

  function saveSessionAuditRecords(records) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        timestamp: Date.now(),
        records: records
      }));
    } catch (e) {}
  }

  function clearSessionAudit() {
    allAuditRecords = [];
    try {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem('certiflow_audit_records');
    } catch (e) {}
    refreshHeaderStats();
    renderAuditTable();
  }

  function loadDemoAuditData() {
    const auditData = window.CERT_DATA || { participants: [], coordinators: [] };
    allAuditRecords = [
      ...auditData.participants.map(p => ({ ...p, category: 'Participant' })),
      ...auditData.coordinators.map(c => ({ ...c, category: 'Coordinator' }))
    ];
    saveSessionAuditRecords(allAuditRecords);
    refreshHeaderStats();
    renderAuditTable();
  }

  let allAuditRecords = loadSessionAuditRecords();
  let auditFilter = 'all';
  let auditSearchQuery = '';

  // Inactivity auto-expire interval: deletes session data after 20 minutes
  setInterval(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const payload = JSON.parse(raw);
        if (payload.timestamp && (Date.now() - payload.timestamp >= SESSION_TTL_MS)) {
          console.log('Session expired due to inactivity. Auto-clearing audit records.');
          clearSessionAudit();
        }
      }
    } catch (e) {}
  }, 30000);

  const statTotalEl = document.getElementById('stat-total');
  const statDeliveredEl = document.getElementById('stat-delivered');
  const statMissingEl = document.getElementById('stat-missing');
  const statAccuracyEl = document.getElementById('stat-accuracy');
  const auditTabCountEl = document.getElementById('audit-tab-count');

  function refreshHeaderStats() {
    const total = allAuditRecords.length;
    const delivered = allAuditRecords.filter(r => r.status === 'DELIVERED').length;
    const missing = allAuditRecords.filter(r => !r.email || r.status === 'MISSING_EMAIL').length;
    const accuracy = total > 0 ? Math.round(((total - missing) / total) * 100) : 100;

    if (statTotalEl) statTotalEl.textContent = total;
    if (statDeliveredEl) {
      if (parseInt(statDeliveredEl.textContent, 10) !== delivered) {
        statDeliveredEl.classList.remove('pulse');
        void statDeliveredEl.offsetWidth; // trigger reflow for pulse animation
        statDeliveredEl.classList.add('pulse');
      }
      statDeliveredEl.textContent = delivered;
    }
    if (statMissingEl) statMissingEl.textContent = missing;
    if (statAccuracyEl) statAccuracyEl.textContent = `${accuracy}%`;
    if (auditTabCountEl) auditTabCountEl.textContent = `${delivered} Delivered`;

    // Update filter chip counts
    const countAll = document.getElementById('count-all');
    const countPart = document.getElementById('count-participants');
    const countCoord = document.getElementById('count-coordinators');
    const countDel = document.getElementById('count-delivered');
    const countMiss = document.getElementById('count-missing');

    if (countAll) countAll.textContent = total;
    if (countPart) countPart.textContent = allAuditRecords.filter(r => r.category === 'Participant').length;
    if (countCoord) countCoord.textContent = allAuditRecords.filter(r => r.category === 'Coordinator').length;
    if (countDel) countDel.textContent = delivered;
    if (countMiss) countMiss.textContent = missing;

    // Missing Email Alert Banner
    const alertBanner = document.getElementById('audit-missing-alert');
    const alertText = document.getElementById('audit-missing-text');
    if (alertBanner && alertText) {
      const missingList = allAuditRecords.filter(r => !r.email || r.status === 'MISSING_EMAIL');
      if (missingList.length > 0) {
        alertBanner.style.display = 'flex';
        const names = missingList.map(r => r.cert_name || r.name).slice(0, 5).join(', ');
        alertText.innerHTML = `<strong>Action Required on ${missingList.length} Recipients:</strong> Missing email address for: ${escapeHtml(names)}${missingList.length > 5 ? '...' : ''}.`;
      } else {
        alertBanner.style.display = 'none';
      }
    }

    saveSessionAuditRecords(allAuditRecords);
  }

  function recordAuditDelivery(item) {
    const existingIdx = allAuditRecords.findIndex(r => 
      (item.email && r.email && r.email.toLowerCase() === item.email.toLowerCase()) ||
      (item.file && r.file && r.file.toLowerCase() === item.file.toLowerCase())
    );

    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (existingIdx >= 0) {
      allAuditRecords[existingIdx].status = 'DELIVERED';
      allAuditRecords[existingIdx].sent_at = nowStr;
      if (item.name) allAuditRecords[existingIdx].name = item.name;
      if (item.cert_name) allAuditRecords[existingIdx].cert_name = item.cert_name;
    } else {
      allAuditRecords.unshift({
        file: item.file || 'certificate.pdf',
        name: item.name || item.cert_name || 'Recipient',
        cert_name: item.cert_name || item.name || 'Recipient',
        email: item.email || '',
        category: item.category || 'Participant',
        roll: item.roll || item.duty || '—',
        duty: item.duty || item.roll || '—',
        status: 'DELIVERED',
        sent_at: nowStr
      });
    }

    refreshHeaderStats();
    renderAuditTable();
  }

  function updateMatchedRowDeliveryStatus(recordId, status) {
    const rowInput = matchedTableBody.querySelector(`input.row-chk[data-id="${recordId}"]`);
    if (rowInput) {
      const tr = rowInput.closest('tr');
      if (tr) {
        const statusTd = tr.querySelector('.td-status');
        if (statusTd) {
          statusTd.innerHTML = '<span class="badge-match delivered">✅ Delivered</span>';
        }
      }
    }
  }

  // Refresh header stats on page load
  refreshHeaderStats();

  // --- Initial Config Fetch ---
  fetchConfig();

  // --- Tab Navigation ---
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      tabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const targetId = btn.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');


    });
  });

  // --- Theme Toggle ---
  const themeToggle = document.getElementById('theme-toggle');
  themeToggle.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark-theme');
    document.body.classList.toggle('light-theme', !isDark);
    localStorage.setItem('certiflow-theme', isDark ? 'dark' : 'light');
  });

  if (localStorage.getItem('certiflow-theme') === 'light') {
    document.body.classList.remove('dark-theme');
    document.body.classList.add('light-theme');
  }

  // =========================================================
  // STEP 1: SPREADSHEET HANDLING
  // =========================================================
  const csvDropzone = document.getElementById('csv-dropzone');
  const csvFileInput = document.getElementById('csv-file-input');
  const sheetUrlInput = document.getElementById('sheet-url-input');
  const fetchSheetBtn = document.getElementById('fetch-sheet-btn');
  const mappingContainer = document.getElementById('mapping-container');
  const mapNameCol = document.getElementById('map-name-col');
  const mapEmailCol = document.getElementById('map-email-col');
  const mapExtraCol = document.getElementById('map-extra-col');
  const csvSummaryPill = document.getElementById('csv-summary-pill');
  const csvRowCountSpan = document.getElementById('csv-row-count');
  const step1Badge = document.getElementById('step1-status-badge');

  csvDropzone.addEventListener('click', () => csvFileInput.click());

  csvDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    csvDropzone.classList.add('dragover');
  });
  csvDropzone.addEventListener('dragleave', () => csvDropzone.classList.remove('dragover'));
  csvDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    csvDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      uploadCsvFile(e.dataTransfer.files[0]);
    }
  });

  csvFileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
      uploadCsvFile(e.target.files[0]);
    }
  });

  fetchSheetBtn.addEventListener('click', async () => {
    const url = sheetUrlInput.value.trim();
    if (!url) {
      alert('Please enter a valid Google Sheets URL');
      return;
    }
    fetchSheetBtn.disabled = true;
    fetchSheetBtn.textContent = 'Fetching...';
    try {
      const res = await fetch('/api/upload-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_url: url })
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || 'Failed to fetch Google Sheet');
      onCsvLoaded(data);
    } catch (err) {
      alert(`Error: ${err.message}`);
    } finally {
      fetchSheetBtn.disabled = false;
      fetchSheetBtn.textContent = 'Fetch Sheet';
    }
  });

  async function uploadCsvFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      step1Badge.textContent = 'Uploading...';
      const res = await fetch('/api/upload-csv', {
        method: 'POST',
        body: fd
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      onCsvLoaded(data);
    } catch (err) {
      alert(`Error uploading spreadsheet: ${err.message}`);
      step1Badge.textContent = 'Upload Failed';
    }
  }

  function onCsvLoaded(data) {
    currentCsvData = data;
    csvRowCountSpan.textContent = data.row_count;
    csvSummaryPill.style.display = 'block';
    step1Badge.textContent = `${data.row_count} Rows Ready`;
    step1Badge.classList.add('ready');

    // Populate Column Mapping Selects
    [mapNameCol, mapEmailCol, mapExtraCol].forEach(sel => sel.innerHTML = '');

    data.columns.forEach(col => {
      const opt1 = new Option(col, col);
      const opt2 = new Option(col, col);
      const opt3 = new Option(col, col);
      mapNameCol.add(opt1);
      mapEmailCol.add(opt2);
      mapExtraCol.add(opt3);
    });

    if (data.detected) {
      if (data.detected.name) mapNameCol.value = data.detected.name;
      if (data.detected.email) mapEmailCol.value = data.detected.email;
      if (data.detected.extra) mapExtraCol.value = data.detected.extra;
    }

    mappingContainer.style.display = 'grid';
  }

  // Quick Presets
  document.getElementById('load-sample-participants').addEventListener('click', () => loadSample('participants'));
  document.getElementById('load-sample-coordinators').addEventListener('click', () => loadSample('coordinators'));

  async function loadSample(type) {
    try {
      const res = await fetch('/api/load-sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || 'Failed to load sample');
      onCsvLoaded(data);
      onPdfsUploaded(data.pdf_count);
      // Auto switch template preset
      if (type === 'coordinators') {
        applyCoordinatorTemplate();
      } else {
        applyParticipantTemplate();
      }
    } catch (err) {
      alert(`Error loading sample: ${err.message}`);
    }
  }

  // =========================================================
  // STEP 2: PDF CERTIFICATES HANDLING
  // =========================================================
  const pdfDropzone = document.getElementById('pdf-dropzone');
  const pdfFileInput = document.getElementById('pdf-file-input');
  const step2Badge = document.getElementById('step2-status-badge');
  const pdfSummaryPill = document.getElementById('pdf-summary-pill');
  const pdfFileCountSpan = document.getElementById('pdf-file-count');

  pdfDropzone.addEventListener('click', () => pdfFileInput.click());

  pdfDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    pdfDropzone.classList.add('dragover');
  });
  pdfDropzone.addEventListener('dragleave', () => pdfDropzone.classList.remove('dragover'));
  pdfDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    pdfDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handlePdfFilesSelection(e.dataTransfer.files);
    }
  });

  let localPdfFiles = []; // [{ filename, file, size }]
  let localFileMap = new Map(); // filename -> File

  pdfFileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
      handlePdfFilesSelection(e.target.files);
    }
  });

  document.getElementById('mount-participant-pdfs').addEventListener('click', () => loadSample('participants'));
  document.getElementById('mount-coordinator-pdfs').addEventListener('click', () => loadSample('coordinators'));

  async function handlePdfFilesSelection(fileList) {
    step2Badge.textContent = 'Reading files...';
    const collectedFiles = [];

    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const lowerName = f.name.toLowerCase();

      if (lowerName.endsWith('.zip')) {
        if (window.JSZip) {
          step2Badge.textContent = 'Extracting ZIP...';
          try {
            const zip = await JSZip.loadAsync(f);
            const entries = Object.keys(zip.files);
            for (const relPath of entries) {
              const zipEntry = zip.files[relPath];
              if (!zipEntry.dir && zipEntry.name.toLowerCase().endsWith('.pdf') && !zipEntry.name.startsWith('__MACOSX')) {
                const blob = await zipEntry.async('blob');
                const cleanName = relPath.split('/').pop();
                if (cleanName) {
                  const unzippedFile = new File([blob], cleanName, { type: 'application/pdf' });
                  collectedFiles.push(unzippedFile);
                }
              }
            }
          } catch (zipErr) {
            console.error('ZIP extraction error:', zipErr);
            alert(`Error extracting ZIP archive: ${zipErr.message}`);
          }
        } else {
          alert('JSZip library not ready. Please select individual PDF files.');
        }
      } else if (lowerName.endsWith('.pdf')) {
        collectedFiles.push(f);
      }
    }

    if (collectedFiles.length === 0) {
      alert('No PDF files found in the selected files.');
      step2Badge.textContent = 'No PDFs Found';
      return;
    }

    for (const f of collectedFiles) {
      localFileMap.set(f.name, f);
      const existingIdx = localPdfFiles.findIndex(item => item.filename === f.name);
      const entry = {
        filename: f.name,
        file: f,
        size: f.size
      };
      if (existingIdx >= 0) {
        localPdfFiles[existingIdx] = entry;
      } else {
        localPdfFiles.push(entry);
      }
    }

    onPdfsUploaded(localPdfFiles.length);
  }

  function onPdfsUploaded(count) {
    pdfFileCountSpan.textContent = count;
    pdfSummaryPill.style.display = 'block';
    step2Badge.textContent = `${count} PDFs Ready`;
    step2Badge.classList.add('ready');
  }

  // =========================================================
  // STEP 3: SMART EXTRACTION & AUTO-MATCHING
  // =========================================================
  const runMatchBtn = document.getElementById('btn-run-match');
  const matchMetricsBar = document.getElementById('match-metrics-bar');
  const matchedControls = document.getElementById('matched-controls');
  const matchedTableWrapper = document.getElementById('matched-table-wrapper');
  const matchPlaceholder = document.getElementById('match-placeholder');
  const matchedTableBody = document.getElementById('matched-table-body');
  const masterSelectChk = document.getElementById('master-select-chk');
  const readyToSendText = document.getElementById('ready-to-send-text');

  // Fast Lookup Map for known certificates (instant client-side font resolution)
  function getKnownCertMap() {
    const map = new Map();
    if (window.CERT_DATA) {
      if (Array.isArray(window.CERT_DATA.participants)) {
        window.CERT_DATA.participants.forEach(p => {
          if (p.file) map.set(p.file.toLowerCase(), p.cert_name || p.csv_name || '');
        });
      }
      if (Array.isArray(window.CERT_DATA.coordinators)) {
        window.CERT_DATA.coordinators.forEach(c => {
          if (c.file) map.set(c.file.toLowerCase(), c.cert_name || c.csv_name || '');
        });
      }
    }
    return map;
  }

  // Client-side extraction via PDF.js (decodes CMap & font streams locally in milliseconds)
  async function extractNameWithPdfJs(file) {
    try {
      if (!window.pdfjsLib) return null;
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const textContent = await page.getTextContent();
      const items = textContent.items.map(i => i.str.trim()).filter(Boolean);

      const staticTerms = [
        'certificate', 'participation', 'awarded', 'presented', 'workshop',
        'university', 'cgc', 'department', 'applied sciences', 'codezen',
        'dean', 'vice chancellor', 'pro vice chancellor', 'hod', 'dr.', 'prof.',
        'award', 'participating'
      ];

      for (let i = items.length - 1; i >= 0; i--) {
        const line = items[i];
        const clean = line.replace(/[^a-zA-Z\s\.]/g, '').trim();
        if (clean.length < 3 || clean.length > 45) continue;
        const lower = clean.toLowerCase();
        if (staticTerms.some(t => lower === t || lower.startsWith(t + ' ') || lower.endsWith(' ' + t))) continue;
        const words = clean.split(/\s+/);
        if (words.length >= 1 && words.length <= 5) {
          return clean;
        }
      }
      return null;
    } catch (e) {
      console.warn('PDF.js client extraction error for file', file.name, e);
      return null;
    }
  }

  function inferNameFromFilename(filename) {
    let clean = filename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
    clean = clean.replace(/^(cert|certificate|participant|coord|coordinator|page)\s*\d+/i, '').trim();
    return clean || filename;
  }

  runMatchBtn.addEventListener('click', async () => {
    if (!currentCsvData || !currentCsvData.rows || currentCsvData.rows.length === 0) {
      alert('Please upload or load a spreadsheet first in Step 1.');
      return;
    }

    const hasLocalPdfs = localPdfFiles.length > 0;
    const presetCount = parseInt(pdfFileCountSpan.textContent, 10) || 0;

    if (!hasLocalPdfs && presetCount === 0) {
      alert('Please upload your PDF certificates in Step 2 first.');
      return;
    }

    runMatchBtn.disabled = true;
    runMatchBtn.innerHTML = `
      <svg class="spin-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-linecap="round"/></svg>
      Analyzing Font Streams...
    `;

    try {
      let extractedItems = [];

      if (hasLocalPdfs) {
        const knownMap = getKnownCertMap();
        const pendingFiles = [];
        const total = localPdfFiles.length;

        // Pass 1: Instant match against known certificate library (0ms latency)
        for (const item of localPdfFiles) {
          const lower = item.filename.toLowerCase();
          if (knownMap.has(lower)) {
            extractedItems.push({
              filename: item.filename,
              name: knownMap.get(lower),
              size: item.size
            });
          } else {
            pendingFiles.push(item);
          }
        }

        // Pass 2: Client-side PDF.js extraction for any unknown files
        const unparsedFiles = [];
        if (pendingFiles.length > 0) {
          for (let i = 0; i < pendingFiles.length; i++) {
            const item = pendingFiles[i];
            runMatchBtn.innerHTML = `
              <svg class="spin-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-linecap="round"/></svg>
              Decoding Font Stream (${i + 1}/${pendingFiles.length})...
            `;
            const name = await extractNameWithPdfJs(item.file);
            if (name) {
              extractedItems.push({
                filename: item.filename,
                name: name,
                size: item.size
              });
            } else {
              unparsedFiles.push(item);
            }
          }
        }

        // Pass 3: Server fallback for remaining unparsed files (with timeout & live percentage)
        if (unparsedFiles.length > 0) {
          const CHUNK_SIZE = 4;
          const totalUnparsed = unparsedFiles.length;

          for (let i = 0; i < totalUnparsed; i += CHUNK_SIZE) {
            const chunk = unparsedFiles.slice(i, i + CHUNK_SIZE);
            const currentCount = Math.min(i + CHUNK_SIZE, totalUnparsed);
            const pct = Math.round((currentCount / totalUnparsed) * 100);

            runMatchBtn.innerHTML = `
              <svg class="spin-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-linecap="round"/></svg>
              Server Font Analysis (${currentCount}/${totalUnparsed} — ${pct}%)...
            `;

            const fd = new FormData();
            for (const item of chunk) {
              fd.append('pdfs', item.file);
            }

            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 12000);

              const extRes = await fetch('/api/extract-names', {
                method: 'POST',
                body: fd,
                signal: controller.signal
              });
              clearTimeout(timeoutId);

              const extData = await safeJson(extRes);
              if (extData.extracted && extData.extracted.length) {
                extractedItems.push(...extData.extracted);
              }
            } catch (chunkErr) {
              console.warn('Fallback chunk extraction timed out or failed, inferring names:', chunkErr.message);
              for (const item of chunk) {
                extractedItems.push({
                  filename: item.filename,
                  name: inferNameFromFilename(item.filename),
                  size: item.size
                });
              }
            }
          }
        }
        step2Badge.textContent = `${total} PDFs Analyzed`;
      } else if (presetCount > 0 && window.CERT_DATA) {
        // Preset mode without local files: Use pre-extracted records from CERT_DATA
        const isCoordinator = (currentCsvData && currentCsvData.type === 'coordinators') || presetCount === 20;
        const sourceList = isCoordinator ? window.CERT_DATA.coordinators : window.CERT_DATA.participants;
        if (sourceList && sourceList.length) {
          extractedItems = sourceList.map(item => ({
            filename: item.file,
            name: item.cert_name || item.csv_name || '',
            size: 800000
          }));
        }
      }

      runMatchBtn.innerHTML = `
        <svg class="spin-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-linecap="round"/></svg>
        Cross-Matching with Sheet (${extractedItems.length} certs)...
      `;

      // Stateless Cross-Match
      const res = await fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name_col: mapNameCol.value,
          email_col: mapEmailCol.value,
          extra_col: mapExtraCol.value,
          csv_rows: currentCsvData ? currentCsvData.rows : null,
          extracted_items: extractedItems.length > 0 ? extractedItems : null
        })
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || 'Matching failed');

      currentMatchedRecords = data.records;
      renderMatchedMetrics(data);
      renderMatchedTable();

      matchMetricsBar.style.display = 'flex';
      matchedControls.style.display = 'flex';
      matchedTableWrapper.style.display = 'block';
      matchPlaceholder.style.display = 'none';

      updateSelectedCount();
    } catch (err) {
      alert(`Matching failed: ${err.message}`);
    } finally {
      runMatchBtn.disabled = false;
      runMatchBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        Re-Analyze & Match
      `;
    }
  });

  function renderMatchedMetrics(data) {
    document.getElementById('match-stat-total').textContent = data.total;
    document.getElementById('match-stat-exact').textContent = data.matched_count;
    document.getElementById('match-stat-missing').textContent = data.missing_email_count;
    document.getElementById('match-stat-unmatched').textContent = data.unmatched_count;

    document.getElementById('count-match-all').textContent = data.total;
    document.getElementById('count-match-ready').textContent = data.matched_count;
    document.getElementById('count-match-attention').textContent = data.missing_email_count + data.unmatched_count;
  }

  function getFilteredMatchedRecords() {
    return currentMatchedRecords.filter(r => {
      if (matchFilter === 'ready' && (!r.email || r.match_status === 'UNMATCHED')) return false;
      if (matchFilter === 'attention' && (r.email && r.match_status !== 'UNMATCHED' && r.match_status !== 'MISSING_EMAIL')) return false;

      if (matchSearchQuery) {
        const q = matchSearchQuery.toLowerCase();
        const cname = (r.cert_name || '').toLowerCase();
        const sname = (r.sheet_name || '').toLowerCase();
        const email = (r.email || '').toLowerCase();
        const file = (r.pdf_file || '').toLowerCase();
        return cname.includes(q) || sname.includes(q) || email.includes(q) || file.includes(q);
      }
      return true;
    });
  }

  function renderMatchedTable() {
    const list = getFilteredMatchedRecords();
    matchedTableBody.innerHTML = '';

    list.forEach(r => {
      const tr = document.createElement('tr');

      let badgeClass = 'badge-match exact';
      let badgeLabel = '100% Exact';

      if (r.match_status === 'FUZZY_MATCH') {
        badgeClass = 'badge-match fuzzy';
        badgeLabel = `${Math.round(r.confidence * 100)}% Fuzzy`;
      } else if (r.match_status === 'MISSING_EMAIL') {
        badgeClass = 'badge-match missing';
        badgeLabel = 'No Email in Sheet';
      } else if (r.match_status === 'UNMATCHED') {
        badgeClass = 'badge-match unmatched';
        badgeLabel = 'Unmatched PDF';
      }

      const emailClass = !r.email ? 'table-input warning-cell' : 'table-input';

      tr.innerHTML = `
        <td>
          <input type="checkbox" class="row-chk" data-id="${r.id}" ${r.included ? 'checked' : ''}>
        </td>
        <td class="td-file"><span class="file-pill">${r.pdf_file}</span></td>
        <th scope="row" class="td-name" style="color:#60a5fa; font-weight:700;">${escapeHtml(r.cert_name)}</th>
        <td class="td-name">${escapeHtml(r.sheet_name || '—')}</td>
        <td class="td-email">
          <input type="email" class="${emailClass}" value="${escapeHtml(r.email)}" placeholder="Enter email address" data-id="${r.id}">
        </td>
        <td class="td-roll">${escapeHtml(r.extra || '—')}</td>
        <td class="td-status"><span class="${badgeClass}">${badgeLabel}</span></td>
        <td class="td-action">
          <button class="btn btn-icon btn-preview-pdf" data-file="${r.pdf_file}" title="Preview PDF Certificate">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </td>
      `;

      matchedTableBody.appendChild(tr);
    });

    // Checkbox toggles
    matchedTableBody.querySelectorAll('.row-chk').forEach(chk => {
      chk.addEventListener('change', (e) => {
        const id = parseInt(e.target.getAttribute('data-id'), 10);
        const item = currentMatchedRecords.find(x => x.id === id);
        if (item) item.included = e.target.checked;
        updateSelectedCount();
      });
    });

    // Inline Email Editing
    matchedTableBody.querySelectorAll('.table-input').forEach(inp => {
      inp.addEventListener('change', async (e) => {
        const id = parseInt(e.target.getAttribute('data-id'), 10);
        const newEmail = e.target.value.trim();
        const item = currentMatchedRecords.find(x => x.id === id);
        if (item) {
          item.email = newEmail;
          if (newEmail) {
            item.included = true;
            e.target.classList.remove('warning-cell');
          }
          await fetch('/api/update-record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, email: newEmail })
          });
          updateSelectedCount();
        }
      });
    });

    // PDF Preview click
    matchedTableBody.querySelectorAll('.btn-preview-pdf').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.getAttribute('data-file');
        openPdfPreviewModal(file);
      });
    });
  }

  function updateSelectedCount() {
    const active = currentMatchedRecords.filter(r => r.included && r.email);
    readyToSendText.textContent = `${active.length} recipients selected for sending`;
  }

  // Filter chips on matched list
  document.querySelectorAll('[data-match-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-match-filter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      matchFilter = chip.getAttribute('data-match-filter');
      renderMatchedTable();
    });
  });

  document.getElementById('matched-search').addEventListener('input', (e) => {
    matchSearchQuery = e.target.value.trim();
    renderMatchedTable();
  });

  masterSelectChk.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    currentMatchedRecords.forEach(r => {
      if (r.email) r.included = isChecked;
    });
    renderMatchedTable();
    updateSelectedCount();
  });

  document.getElementById('select-all-btn').addEventListener('click', () => {
    masterSelectChk.checked = true;
    currentMatchedRecords.forEach(r => { if (r.email) r.included = true; });
    renderMatchedTable();
    updateSelectedCount();
  });

  document.getElementById('deselect-all-btn').addEventListener('click', () => {
    masterSelectChk.checked = false;
    currentMatchedRecords.forEach(r => r.included = false);
    renderMatchedTable();
    updateSelectedCount();
  });

  // =========================================================
  // STEP 4: EMAIL TEMPLATES & SENDING
  // =========================================================
  const gmailSenderInput = document.getElementById('gmail-sender');
  const gmailPasswordInput = document.getElementById('gmail-password');
  const senderNameInput = document.getElementById('sender-name-input');
  const regardsInput = document.getElementById('regards-input');
  const emailSubjectInput = document.getElementById('email-subject-input');
  const emailBodyInput = document.getElementById('email-body-input');
  const togglePwdBtn = document.getElementById('toggle-pwd-btn');
  const testEmailInput = document.getElementById('test-email-input');
  const btnSendTest = document.getElementById('btn-send-test');
  const testSendStatus = document.getElementById('test-send-status');
  const btnDispatchAll = document.getElementById('btn-dispatch-all');

  // Templates
  document.getElementById('template-preset-participant').addEventListener('click', applyParticipantTemplate);
  document.getElementById('template-preset-coordinator').addEventListener('click', applyCoordinatorTemplate);

  function applyParticipantTemplate() {
    senderNameInput.value = 'CodeZen Club';
    regardsInput.value = 'CodeZen Club & Department of Applied Sciences\nCGC University, Mohali';
    emailSubjectInput.value = 'Certificate of Participation – Real-World API Integration Workshop | CGC University';
    emailBodyInput.value = `Dear {name},

Thank you for actively participating in the workshop "Real-World API Integration Using Java", organised by the CodeZen Club and the Department of Applied Sciences, CGC University, Mohali.

Please find your official Certificate of Participation attached with this email.

We appreciate your enthusiasm and dedication, and we wish you continued success in your learning journey and future endeavours.

Warm regards,
{regards}`;
  }

  function applyCoordinatorTemplate() {
    senderNameInput.value = 'CodeZen';
    regardsInput.value = 'CodeZen';
    emailSubjectInput.value = 'Certificate of Coordination – Real-World API Integration Workshop | CGC University';
    emailBodyInput.value = `Dear {name},

Thank you for your valuable contribution and dedication as a coordinator for the workshop "Real-World API Integration Using Java", organised by the CodeZen Club and the Department of Applied Sciences, CGC University, Mohali.

Please find your official Certificate of Coordination attached with this email.

Warm regards,
{regards}`;
  }

  // Toggle Password Visibility
  togglePwdBtn.addEventListener('click', () => {
    if (gmailPasswordInput.type === 'password') {
      gmailPasswordInput.type = 'text';
      togglePwdBtn.textContent = 'Hide';
    } else {
      gmailPasswordInput.type = 'password';
      togglePwdBtn.textContent = 'Show';
    }
  });

  // Send Test Email
  btnSendTest.addEventListener('click', async () => {
    const targetEmail = testEmailInput.value.trim();
    if (!targetEmail) {
      alert('Please enter a recipient test email address');
      return;
    }
    btnSendTest.disabled = true;
    btnSendTest.textContent = 'Sending...';
    testSendStatus.style.display = 'block';
    testSendStatus.innerHTML = '<span style="color:#60a5fa;">Connecting to Gmail SMTP and sending test certificate...</span>';

    try {
      const res = await fetch('/api/send-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_email: targetEmail,
          gmail_user: gmailSenderInput.value.trim(),
          gmail_password: gmailPasswordInput.value.trim(),
          sender_name: senderNameInput.value.trim(),
          regards: regardsInput.value.trim(),
          subject: emailSubjectInput.value.trim(),
          body: emailBodyInput.value.trim()
        })
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || 'Test send failed');
      testSendStatus.innerHTML = `<span style="color:#34d399;">✅ ${data.message}</span>`;
    } catch (err) {
      testSendStatus.innerHTML = `<span style="color:#f87171;">❌ ${err.message}</span>`;
    } finally {
      btnSendTest.disabled = false;
      btnSendTest.textContent = '✉️ Send Test';
    }
  });

  // Bulk Dispatch
  btnDispatchAll.addEventListener('click', async () => {
    const active = currentMatchedRecords.filter(r => r.included && r.email);
    if (active.length === 0) {
      alert('No recipients selected to send! Make sure checkboxes are checked and emails are filled.');
      return;
    }

    const confirmMsg = `Are you sure you want to dispatch ${active.length} verified certificates via Gmail SMTP (${gmailSenderInput.value})?`;
    if (!confirm(confirmMsg)) {
      return;
    }

    btnDispatchAll.disabled = true;
    btnDispatchAll.textContent = 'Dispatching in Progress...';
    document.getElementById('dispatch-hud-card').style.display = 'block';
    document.getElementById('dispatch-hud-card').scrollIntoView({ behavior: 'smooth' });

    // Client-side dispatch: handles single-file attachments cleanly without serverless timeouts
    if (localFileMap.size > 0) {
      runClientSideDispatch(active);
    } else {
      try {
        const res = await fetch('/api/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gmail_user: gmailSenderInput.value.trim(),
            gmail_password: gmailPasswordInput.value.trim(),
            sender_name: senderNameInput.value.trim(),
            subject: emailSubjectInput.value.trim(),
            body: emailBodyInput.value.trim(),
            regards: regardsInput.value.trim(),
            delay: 1.0
          })
        });
        const data = await safeJson(res);
        if (!res.ok) throw new Error(data.error || 'Failed to start dispatch');

        // Start polling dispatch status
        startDispatchPolling();
      } catch (err) {
        alert(`Dispatch error: ${err.message}`);
        btnDispatchAll.disabled = false;
        btnDispatchAll.textContent = '🚀 Dispatch All Verified Certificates';
      }
    }
  });

  // =========================================================
  // STEP 5: LIVE DISPATCH HUD & CLIENT-SIDE OR SERVER WORKER
  // =========================================================
  const hudProgressFill = document.getElementById('hud-progress-fill');
  const hudPctText = document.getElementById('hud-pct-text');
  const hudCurrentNum = document.getElementById('hud-current-num');
  const hudTotalNum = document.getElementById('hud-total-num');
  const hudStatDelivered = document.getElementById('hud-stat-delivered');
  const hudStatSkipped = document.getElementById('hud-stat-skipped');
  const hudStatFailed = document.getElementById('hud-stat-failed');
  const hudConsole = document.getElementById('hud-console');
  const hudPauseBtn = document.getElementById('hud-pause-btn');
  const hudAbortBtn = document.getElementById('hud-abort-btn');

  let clientDispatchState = {
    isRunning: false,
    isPaused: false,
    shouldAbort: false
  };

  async function runClientSideDispatch(records) {
    clientDispatchState.isRunning = true;
    clientDispatchState.isPaused = false;
    clientDispatchState.shouldAbort = false;

    hudPauseBtn.textContent = '⏸️ Pause';
    hudConsole.innerHTML = '';

    const total = records.length;
    let successCount = 0;
    let failCount = 0;

    hudTotalNum.textContent = total;
    hudCurrentNum.textContent = 0;
    hudProgressFill.style.width = '0%';
    hudPctText.textContent = '0%';
    hudStatDelivered.textContent = 0;
    hudStatSkipped.textContent = 0;
    hudStatFailed.textContent = 0;

    appendConsoleLog('system', `Starting dispatch of ${total} certificates via Gmail SMTP...`);

    for (let i = 0; i < total; i++) {
      if (clientDispatchState.shouldAbort) {
        appendConsoleLog('system', 'Dispatch aborted by user.');
        break;
      }

      while (clientDispatchState.isPaused) {
        await new Promise(r => setTimeout(r, 200));
        if (clientDispatchState.shouldAbort) break;
      }
      if (clientDispatchState.shouldAbort) break;

      const rec = records[i];
      const recipientName = rec.cert_name || rec.sheet_name;
      const recipientEmail = rec.email;
      const localFile = localFileMap.get(rec.pdf_file);

      const fd = new FormData();
      fd.append('recipient_email', recipientEmail);
      fd.append('recipient_name', recipientName);
      fd.append('subject', emailSubjectInput.value.trim());
      fd.append('body', emailBodyInput.value.trim());
      fd.append('regards', regardsInput.value.trim());
      fd.append('sender_name', senderNameInput.value.trim());
      fd.append('gmail_user', gmailSenderInput.value.trim());
      fd.append('gmail_password', gmailPasswordInput.value.trim());

      if (localFile) {
        fd.append('pdf', localFile);
      } else {
        fd.append('filename', rec.pdf_file);
      }

      try {
        const res = await fetch('/api/send-single', {
          method: 'POST',
          body: fd
        });
        const result = await safeJson(res);
        if (!res.ok) throw new Error(result.error || 'Failed to send email');

        successCount++;
        rec.delivery_status = 'DELIVERED';
        appendConsoleLog('success', `Delivered to ${recipientEmail} (${recipientName}) — ${rec.pdf_file}`);

        // Live update in matched table row
        updateMatchedRowDeliveryStatus(rec.id, 'DELIVERED');

        // Immediately refresh top header stats and audit table after every mail sent
        recordAuditDelivery({
          file: rec.pdf_file,
          name: recipientName,
          cert_name: recipientName,
          email: recipientEmail,
          roll: rec.extra,
          duty: rec.extra,
          category: (currentCsvData && currentCsvData.type === 'coordinators') ? 'Coordinator' : 'Participant',
          status: 'DELIVERED'
        });
      } catch (err) {
        failCount++;
        rec.delivery_status = 'FAILED';
        appendConsoleLog('error', `Failed for ${recipientEmail}: ${err.message}`);
      }

      const currentIdx = i + 1;
      const pct = Math.round((currentIdx / total) * 100);

      hudCurrentNum.textContent = currentIdx;
      hudPctText.textContent = `${pct}%`;
      hudProgressFill.style.width = `${pct}%`;
      hudStatDelivered.textContent = successCount;
      hudStatFailed.textContent = failCount;

      // Polite rate limit delay between emails (1.0 second)
      if (i < total - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    clientDispatchState.isRunning = false;
    btnDispatchAll.disabled = false;
    btnDispatchAll.textContent = clientDispatchState.shouldAbort ? '🚀 Dispatch Stopped' : '🚀 Dispatch Complete!';
    appendConsoleLog('system', `Dispatch finished. Delivered: ${successCount}, Failed: ${failCount}.`);
  }

  function appendConsoleLog(type, text) {
    const timeStr = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'console-entry';
    entry.innerHTML = `
      <span class="console-time">[${timeStr}]</span>
      <span class="console-msg ${type}">${escapeHtml(text)}</span>
    `;
    hudConsole.appendChild(entry);
    hudConsole.scrollTop = hudConsole.scrollHeight;
  }

  function startDispatchPolling() {
    if (dispatchPollTimer) clearInterval(dispatchPollTimer);
    dispatchPollTimer = setInterval(pollDispatchStatus, 1000);
  }

  async function pollDispatchStatus() {
    try {
      const res = await fetch('/api/dispatch-status');
      const data = await safeJson(res);

      hudProgressFill.style.width = `${data.percentage}%`;
      hudPctText.textContent = `${data.percentage}%`;
      hudCurrentNum.textContent = data.current_index;
      hudTotalNum.textContent = data.total;
      hudStatDelivered.textContent = data.success_count;
      hudStatSkipped.textContent = data.skip_count;
      hudStatFailed.textContent = data.fail_count;

      // Update Pause button label
      hudPauseBtn.textContent = data.is_paused ? '▶️ Resume' : '⏸️ Pause';

      // Update terminal console
      if (data.logs && data.logs.length) {
        hudConsole.innerHTML = data.logs.map(log => `
          <div class="console-entry">
            <span class="console-time">[${log.time}]</span>
            <span class="console-msg ${log.type}">${escapeHtml(log.text)}</span>
          </div>
        `).join('');
        hudConsole.scrollTop = hudConsole.scrollHeight;
      }

      if (!data.is_running && data.current_index >= data.total && data.total > 0) {
        clearInterval(dispatchPollTimer);
        btnDispatchAll.disabled = false;
        btnDispatchAll.textContent = '🚀 Dispatch Complete!';
      }
    } catch (e) {
      console.warn('Status poll failed:', e);
    }
  }

  hudPauseBtn.addEventListener('click', async () => {
    if (clientDispatchState.isRunning) {
      clientDispatchState.isPaused = !clientDispatchState.isPaused;
      hudPauseBtn.textContent = clientDispatchState.isPaused ? '▶️ Resume' : '⏸️ Pause';
      appendConsoleLog('system', clientDispatchState.isPaused ? 'Dispatch paused.' : 'Dispatch resumed.');
      return;
    }
    const isPaused = hudPauseBtn.textContent.includes('Resume');
    await fetch('/api/dispatch-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: isPaused ? 'resume' : 'pause' })
    });
  });

  hudAbortBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to stop the dispatch process?')) {
      if (clientDispatchState.isRunning) {
        clientDispatchState.shouldAbort = true;
        return;
      }
      await fetch('/api/dispatch-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abort' })
      });
      clearInterval(dispatchPollTimer);
      btnDispatchAll.disabled = false;
      btnDispatchAll.textContent = '🚀 Dispatch All Verified Certificates';
    }
  });

  // =========================================================
  // PDF PREVIEW MODAL
  // =========================================================
  const pdfModal = document.getElementById('pdf-modal');
  const pdfModalTitle = document.getElementById('pdf-modal-title');
  const pdfModalIframe = document.getElementById('pdf-modal-iframe');
  const pdfModalClose = document.getElementById('pdf-modal-close');

  function openPdfPreviewModal(filename) {
    pdfModalTitle.textContent = `Certificate Preview: ${filename}`;
    const localFile = localFileMap.get(filename);
    if (localFile) {
      pdfModalIframe.src = URL.createObjectURL(localFile);
    } else {
      pdfModalIframe.src = `/api/preview-pdf/${encodeURIComponent(filename)}`;
    }
    pdfModal.style.display = 'flex';
    pdfModal.setAttribute('aria-hidden', 'false');
  }

  pdfModalClose.addEventListener('click', () => {
    pdfModal.style.display = 'none';
    pdfModal.setAttribute('aria-hidden', 'true');
    pdfModalIframe.src = 'about:blank';
  });

  pdfModal.addEventListener('click', (e) => {
    if (e.target === pdfModal) {
      pdfModal.style.display = 'none';
      pdfModal.setAttribute('aria-hidden', 'true');
      pdfModalIframe.src = 'about:blank';
    }
  });

  // =========================================================
  // TAB 2: AUDIT & DELIVERY DASHBOARD
  // =========================================================
  const auditTableBody = document.getElementById('table-body');
  const auditSearchInput = document.getElementById('table-search');
  const auditClearSearchBtn = document.getElementById('clear-search');
  const auditFilterChips = document.querySelectorAll('.filter-group .filter-chip[data-filter]');
  const auditNoResults = document.getElementById('no-results');

  function getFilteredAuditRecords() {
    return allAuditRecords.filter(item => {
      if (auditFilter === 'participants' && item.category !== 'Participant') return false;
      if (auditFilter === 'coordinators' && item.category !== 'Coordinator') return false;
      if (auditFilter === 'delivered' && item.status !== 'DELIVERED') return false;
      if (auditFilter === 'missing' && item.status !== 'MISSING_EMAIL') return false;

      if (auditSearchQuery) {
        const q = auditSearchQuery.toLowerCase();
        const name = (item.cert_name || item.name || '').toLowerCase();
        const email = (item.email || '').toLowerCase();
        const roll = (item.roll || item.duty || '').toLowerCase();
        const file = (item.file || '').toLowerCase();
        return name.includes(q) || email.includes(q) || roll.includes(q) || file.includes(q);
      }
      return true;
    });
  }

  function renderAuditTable() {
    const records = getFilteredAuditRecords();
    auditTableBody.innerHTML = '';

    if (records.length === 0) {
      auditNoResults.style.display = 'block';
      return;
    }
    auditNoResults.style.display = 'none';

    records.forEach((r, idx) => {
      const tr = document.createElement('tr');
      const isDelivered = r.status === 'DELIVERED';
      const statusBadge = isDelivered
        ? '<span class="status-badge delivered">Delivered</span>'
        : '<span class="status-badge missing">No Email</span>';

      const catBadge = r.category === 'Coordinator'
        ? '<span class="category-tag coordinator">Coordinator</span>'
        : '<span class="category-tag participant">Participant</span>';

      const displayName = r.cert_name || r.name;

      tr.innerHTML = `
        <td class="td-num">${idx + 1}</td>
        <td class="td-file"><span class="file-pill">${r.file}</span></td>
        <th scope="row" class="td-name">${escapeHtml(displayName)}</th>
        <td class="td-type">${catBadge}</td>
        <td class="td-email">${r.email ? escapeHtml(r.email) : '<em>(Empty in registration)</em>'}</td>
        <td class="td-roll">${escapeHtml(r.duty ? `Duty: ${r.duty}` : (r.roll || '—'))}</td>
        <td class="td-status">${statusBadge}</td>
        <td class="td-action">
          <button class="btn btn-icon btn-inspect" data-idx="${idx}" aria-label="Inspect details for ${escapeHtml(displayName)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </td>
      `;

      auditTableBody.appendChild(tr);
    });

    auditTableBody.querySelectorAll('.btn-inspect').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        openInspectModal(records[idx]);
      });
    });
  }

  auditFilterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      auditFilterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      auditFilter = chip.getAttribute('data-filter');
      renderAuditTable();
    });
  });

  auditSearchInput.addEventListener('input', (e) => {
    auditSearchQuery = e.target.value.trim();
    auditClearSearchBtn.style.display = auditSearchQuery ? 'inline-block' : 'none';
    renderAuditTable();
  });

  auditClearSearchBtn.addEventListener('click', () => {
    auditSearchInput.value = '';
    auditSearchQuery = '';
    auditClearSearchBtn.style.display = 'none';
    renderAuditTable();
  });

  document.getElementById('export-csv-btn').addEventListener('click', () => {
    const records = getFilteredAuditRecords();
    let csv = 'File,Verified Name,Category,Email,Roll or Duty,Status,Sent Timestamp\n';
    records.forEach(r => {
      csv += `"${r.file}","${r.cert_name || r.name}","${r.category}","${r.email || ''}","${r.duty || r.roll || ''}","${r.status}","${r.sent_at || ''}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'CertiFlow_Delivery_Audit.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  const clearAuditBtn = document.getElementById('clear-audit-btn');
  if (clearAuditBtn) {
    clearAuditBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all audit records for this session?')) {
        clearSessionAudit();
      }
    });
  }

  const loadSampleAuditBtn = document.getElementById('load-sample-audit-btn');
  if (loadSampleAuditBtn) {
    loadSampleAuditBtn.addEventListener('click', () => {
      loadDemoAuditData();
    });
  }

  // Modal Inspect
  const inspectModal = document.getElementById('inspect-modal');
  const modalBody = document.getElementById('modal-body');
  const modalClose = document.getElementById('modal-close');

  function openInspectModal(record) {
    const isDelivered = record.status === 'DELIVERED';
    const displayName = record.cert_name || record.name;

    modalBody.innerHTML = `
      <div class="modal-field">
        <div class="modal-field-label">Verified Name on PDF</div>
        <div class="modal-field-value" style="font-size:1.2rem; color:#60a5fa; font-weight:700;">${escapeHtml(displayName)}</div>
      </div>
      <div class="modal-field">
        <div class="modal-field-label">Matched File</div>
        <div class="modal-field-value mono">${record.file}</div>
      </div>
      <div class="modal-field">
        <div class="modal-field-label">Recipient Email</div>
        <div class="modal-field-value">${record.email ? escapeHtml(record.email) : '<em>No email address in sheet</em>'}</div>
      </div>
      <div class="modal-field">
        <div class="modal-field-label">${record.duty ? 'Assigned Duty' : 'Roll Number'}</div>
        <div class="modal-field-value">${escapeHtml(record.duty || record.roll || '—')}</div>
      </div>
      <div class="modal-field">
        <div class="modal-field-label">Delivery Status</div>
        <div class="modal-field-value">
          ${isDelivered
            ? `<span class="status-badge delivered">Delivered successfully</span> <span style="font-size:0.8rem; color:var(--text-muted); margin-left:8px;">(${record.sent_at || 'Recorded'})</span>`
            : `<span class="status-badge missing">Requires manual dispatch (blank email)</span>`}
        </div>
      </div>
    `;

    inspectModal.style.display = 'flex';
    inspectModal.setAttribute('aria-hidden', 'false');
  }

  modalClose.addEventListener('click', () => {
    inspectModal.style.display = 'none';
    inspectModal.setAttribute('aria-hidden', 'true');
  });

  inspectModal.addEventListener('click', (e) => {
    if (e.target === inspectModal) {
      inspectModal.style.display = 'none';
      inspectModal.setAttribute('aria-hidden', 'true');
    }
  });

  // Initial audit table render
  renderAuditTable();

  // =========================================================
  // UTILITIES & CONFIG
  // =========================================================
  async function fetchConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        serverConfig = await safeJson(res);
        if (serverConfig.gmail_user) {
          gmailSenderInput.value = serverConfig.gmail_user;
          testEmailInput.value = serverConfig.gmail_user;
        }
        if (serverConfig.raw_password) {
          gmailPasswordInput.value = serverConfig.raw_password;
        }
        if (serverConfig.sender_name) {
          senderNameInput.value = serverConfig.sender_name;
        }
        if (serverConfig.regards) {
          regardsInput.value = serverConfig.regards;
        }
      }
    } catch (e) {
      console.warn('Could not fetch server config:', e);
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
