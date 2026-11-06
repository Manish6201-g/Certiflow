/**
 * CertiFlow — CodeZen Engine Client Application
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

  // Audit Tab State (Preloaded historical data)
  const auditData = window.CERT_DATA || { participants: [], coordinators: [] };
  const allAuditRecords = [
    ...auditData.participants.map(p => ({ ...p, category: 'Participant' })),
    ...auditData.coordinators.map(c => ({ ...c, category: 'Coordinator' }))
  ];
  let auditFilter = 'all';
  let auditSearchQuery = '';

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

      if (targetId === 'tab-studio') {
        renderCanvas();
      }
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
      const data = await res.json();
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
      const data = await res.json();
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
      const data = await res.json();
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
      uploadPdfFiles(e.dataTransfer.files);
    }
  });

  pdfFileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
      uploadPdfFiles(e.target.files);
    }
  });

  document.getElementById('mount-participant-pdfs').addEventListener('click', () => loadSample('participants'));
  document.getElementById('mount-coordinator-pdfs').addEventListener('click', () => loadSample('coordinators'));

  async function uploadPdfFiles(fileList) {
    const fd = new FormData();
    for (let i = 0; i < fileList.length; i++) {
      fd.append('pdfs', fileList[i]);
    }
    try {
      step2Badge.textContent = 'Processing PDFs...';
      const res = await fetch('/api/upload-pdfs', {
        method: 'POST',
        body: fd
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to upload PDFs');
      onPdfsUploaded(data.file_count);
    } catch (err) {
      alert(`Error uploading PDFs: ${err.message}`);
      step2Badge.textContent = 'Upload Failed';
    }
  }

  function onPdfsUploaded(count) {
    pdfFileCountSpan.textContent = count;
    pdfSummaryPill.style.display = 'block';
    step2Badge.textContent = `${count} Files Mounted`;
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

  runMatchBtn.addEventListener('click', async () => {
    runMatchBtn.disabled = true;
    runMatchBtn.innerHTML = `
      <svg class="spin-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-linecap="round"/></svg>
      Analyzing Font Streams...
    `;

    try {
      const res = await fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name_col: mapNameCol.value,
          email_col: mapEmailCol.value,
          extra_col: mapExtraCol.value
        })
      });
      const data = await res.json();
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
      const data = await res.json();
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

    try {
      btnDispatchAll.disabled = true;
      btnDispatchAll.textContent = 'Dispatching in Progress...';
      document.getElementById('dispatch-hud-card').style.display = 'block';
      document.getElementById('dispatch-hud-card').scrollIntoView({ behavior: 'smooth' });

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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start dispatch');

      // Start polling dispatch status
      startDispatchPolling();
    } catch (err) {
      alert(`Dispatch error: ${err.message}`);
      btnDispatchAll.disabled = false;
      btnDispatchAll.textContent = '🚀 Dispatch All Verified Certificates';
    }
  });

  // =========================================================
  // STEP 5: LIVE DISPATCH HUD & POLLING
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

  function startDispatchPolling() {
    if (dispatchPollTimer) clearInterval(dispatchPollTimer);
    dispatchPollTimer = setInterval(pollDispatchStatus, 1000);
  }

  async function pollDispatchStatus() {
    try {
      const res = await fetch('/api/dispatch-status');
      const data = await res.json();

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
    const isPaused = hudPauseBtn.textContent.includes('Resume');
    await fetch('/api/dispatch-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: isPaused ? 'resume' : 'pause' })
    });
  });

  hudAbortBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to stop the dispatch process?')) {
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
    pdfModalIframe.src = `/api/preview-pdf/${filename}`;
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
    a.download = 'CodeZen_Certificate_Dispatch_Audit.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

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
  // TAB 3: CANVAS TYPOGRAPHY STUDIO
  // =========================================================
  const canvas = document.getElementById('cert-canvas');
  const ctx = canvas.getContext('2d');
  const nameInput = document.getElementById('custom-name');
  const fontPreset = document.getElementById('font-preset');
  const fontSizeSlider = document.getElementById('font-size');
  const sizeVal = document.getElementById('size-val');
  const fontWeight = document.getElementById('font-weight');
  const textColor = document.getElementById('text-color');
  const colorHexLabel = document.getElementById('color-hex-label');
  const yOffsetSlider = document.getElementById('vertical-offset');
  const yVal = document.getElementById('y-val');
  const downloadBtn = document.getElementById('download-cert-btn');
  const resetBtn = document.getElementById('reset-canvas-btn');

  const bgImage = new Image();
  bgImage.src = 'assets/certificate_without_name.png';
  let imageLoaded = false;

  bgImage.onload = () => {
    imageLoaded = true;
    renderCanvas();
  };

  function renderCanvas() {
    if (!imageLoaded) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);

    const name = nameInput.value.trim() || 'Your Name Here';
    const weight = fontWeight.value;
    const size = fontSizeSlider.value;
    const family = fontPreset.value;
    const color = textColor.value;
    const yPos = parseInt(yOffsetSlider.value, 10);

    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    const xPos = canvas.width / 2;
    ctx.fillText(name, xPos, yPos);
  }

  [nameInput, fontPreset, fontWeight].forEach(el => el.addEventListener('input', renderCanvas));

  fontSizeSlider.addEventListener('input', (e) => {
    sizeVal.textContent = e.target.value;
    renderCanvas();
  });

  yOffsetSlider.addEventListener('input', (e) => {
    yVal.textContent = e.target.value;
    renderCanvas();
  });

  textColor.addEventListener('input', (e) => {
    colorHexLabel.textContent = e.target.value.toUpperCase();
    renderCanvas();
  });

  resetBtn.addEventListener('click', () => {
    nameInput.value = 'Prabhdeep Singh';
    fontPreset.value = "'Plus Jakarta Sans', sans-serif";
    fontWeight.value = '800';
    fontSizeSlider.value = 34;
    sizeVal.textContent = '34';
    textColor.value = '#0a3771';
    colorHexLabel.textContent = '#0A3771';
    yOffsetSlider.value = 338;
    yVal.textContent = '338';
    renderCanvas();
  });

  downloadBtn.addEventListener('click', () => {
    const link = document.createElement('a');
    const nameSlug = (nameInput.value.trim() || 'Certificate').replace(/\s+/g, '_');
    link.download = `Certificate_${nameSlug}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  });

  // =========================================================
  // UTILITIES & CONFIG
  // =========================================================
  async function fetchConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        serverConfig = await res.json();
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
