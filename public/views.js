// ---------- Dashboard ----------
VIEWS.dashboard = async function () {
  const [contactsRes, clientTypesRes, campaignsRes, sendJobsRes, enrollmentsRes] = await Promise.all([
    api('/api/contacts?limit=500'),
    api('/api/client-types'),
    api('/api/campaigns'),
    api('/api/send-jobs'),
    api('/api/enrollments?status=active')
  ]);
  const activeJobs = sendJobsRes.jobs.filter(j => j.status === 'queued' || j.status === 'running');
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="num">${contactsRes.contacts.length}</div><div class="label">Contacts</div></div>
      <div class="stat"><div class="num">${clientTypesRes.clientTypes.length}</div><div class="label">Client types</div></div>
      <div class="stat"><div class="num">${campaignsRes.campaigns.length}</div><div class="label">Campaigns</div></div>
      <div class="stat"><div class="num">${activeJobs.length}</div><div class="label">Send jobs running</div></div>
      <div class="stat"><div class="num">${enrollmentsRes.enrollments.length}</div><div class="label">Active follow-ups</div></div>
    </div>
    <div class="panel">
      <div class="panel-header"><h2>Recent campaigns</h2></div>
      <div class="panel-body" id="recentCampaigns"></div>
    </div>
    <div class="panel">
      <div class="panel-header"><h2>Recent send jobs</h2></div>
      <div class="panel-body" id="recentJobs"></div>
    </div>`;

  const recentCampaigns = campaignsRes.campaigns.slice(0, 5);
  document.getElementById('recentCampaigns').innerHTML = recentCampaigns.length
    ? `<table><thead><tr><th>Name</th><th>Status</th><th>Contacts</th><th>Created</th></tr></thead><tbody>
        ${recentCampaigns.map(c => `<tr><td><a href="#" data-campaign="${c.id}">${esc(c.name)}</a></td><td>${statusBadge(c.status)}</td><td>${c.contact_count}</td><td>${fmtDate(c.created_at)}</td></tr>`).join('')}
       </tbody></table>`
    : `<div class="empty-state"><div class="empty-title">No campaigns yet</div>Create one from the Campaigns tab.</div>`;
  document.querySelectorAll('[data-campaign]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); navigate('campaigns'); setTimeout(() => openCampaignDetail(el.dataset.campaign), 50); });
  });

  const recentJobs = sendJobsRes.jobs.slice(0, 5);
  document.getElementById('recentJobs').innerHTML = recentJobs.length
    ? `<table><thead><tr><th>Status</th><th>Progress</th><th>Created</th></tr></thead><tbody>
        ${recentJobs.map(j => `<tr><td>${statusBadge(j.status)}</td><td>${j.sent_count}/${j.total} sent${j.failed_count ? `, ${j.failed_count} failed` : ''}</td><td>${fmtDate(j.created_at)}</td></tr>`).join('')}
       </tbody></table>`
    : `<div class="empty-state"><div class="empty-title">No send jobs yet</div>Bulk sends will show up here.</div>`;
};

// ---------- Mailboxes ----------
VIEWS.mailboxes = async function () {
  const { mailboxes } = await api('/api/mailboxes');
  document.getElementById('topbarActions').innerHTML = `<button class="primary" id="addMailboxBtn">Add mailbox</button>`;
  document.getElementById('addMailboxBtn').addEventListener('click', showAddMailboxModal);

  const content = document.getElementById('content');
  content.innerHTML = `<div class="panel"><div class="panel-body" id="mbxTableWrap"></div></div>`;
  renderMailboxTable(mailboxes);
};

function renderMailboxTable(mailboxes) {
  const wrap = document.getElementById('mbxTableWrap');
  if (!mailboxes.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-title">No mailbox connected yet</div>Connect a Spacemail (or any IMAP/SMTP) mailbox to start sending.</div>`;
    return;
  }
  wrap.innerHTML = `<table><thead><tr><th>Label</th><th>From</th><th>IMAP host</th><th>Daily cap</th><th>Default</th><th></th></tr></thead><tbody>
    ${mailboxes.map(m => `<tr>
      <td>${esc(m.label)}</td>
      <td class="mono">${esc(m.from_email)}</td>
      <td class="mono">${esc(m.imap_host)}</td>
      <td>${m.daily_send_cap}</td>
      <td>${m.is_default ? badge('default', 'signal') : ''}</td>
      <td>
        <button class="ghost" data-test="${m.id}">Test</button>
        <button class="ghost danger" data-del="${m.id}">Delete</button>
      </td>
    </tr>`).join('')}
  </tbody></table>`;
  wrap.querySelectorAll('[data-test]').forEach(btn => btn.addEventListener('click', async () => {
    btn.textContent = 'Testing…'; btn.disabled = true;
    try {
      await api(`/api/mailboxes/${btn.dataset.test}/test`, { method: 'POST' });
      toast('Connection OK — SMTP and IMAP both verified.');
    } catch (e) {
      toast(e.message, true);
    }
    btn.textContent = 'Test'; btn.disabled = false;
  }));
  wrap.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Remove this mailbox connection?')) return;
    await api(`/api/mailboxes/${btn.dataset.del}`, { method: 'DELETE' });
    navigate('mailboxes');
  }));
}

function showAddMailboxModal() {
  openModal(`
    <h2>Add mailbox</h2>
    <p class="helptext">For Spacemail: IMAP is <span class="mono">mail.spacemail.com:993</span> with TLS on.
    For SMTP, prefer <span class="mono">mail.spacemail.com:587</span> with TLS off (STARTTLS) — port 465 (implicit TLS) is the
    other documented option, but many hosts block outbound 465 by default while leaving 587 open, so 587 is the safer default here.</p>
    <div class="field"><label>Label</label><input id="f_label" placeholder="Spacemail — sales@yourcompany.com" /></div>
    <div class="field-row">
      <div class="field"><label>IMAP host</label><input id="f_imapHost" placeholder="mail.spacemail.com" /></div>
      <div class="field" style="max-width:90px;"><label>Port</label><input id="f_imapPort" value="993" /></div>
      <div class="field" style="max-width:110px;"><label>&nbsp;</label><label style="font-weight:400;"><input type="checkbox" id="f_imapSecure" checked style="width:auto;display:inline-block;margin-right:6px;" />TLS on</label></div>
    </div>
    <div class="field-row">
      <div class="field"><label>SMTP host</label><input id="f_smtpHost" placeholder="mail.spacemail.com" /></div>
      <div class="field" style="max-width:90px;"><label>Port</label><input id="f_smtpPort" value="587" /></div>
      <div class="field" style="max-width:110px;"><label>&nbsp;</label><label style="font-weight:400;"><input type="checkbox" id="f_smtpSecure" style="width:auto;display:inline-block;margin-right:6px;" />TLS on</label></div>
    </div>
    <p class="helptext" style="margin-top:-8px;">"TLS on" = implicit TLS (typically ports 993, 465). Leave it off for STARTTLS ports (typically 587, 143, 25) — the connection starts plain and upgrades to TLS automatically.</p>
    <div class="field-row">
      <div class="field"><label>Username</label><input id="f_username" placeholder="sales@yourcompany.com" /></div>
      <div class="field"><label>Password</label><input type="password" id="f_password" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>From name</label><input id="f_fromName" placeholder="Sara from Acme" /></div>
      <div class="field"><label>From email</label><input id="f_fromEmail" placeholder="sales@yourcompany.com" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Sent folder</label><input id="f_sentFolder" value="Sent" /></div>
      <div class="field"><label>Daily send cap</label><input id="f_dailyCap" value="150" /></div>
    </div>
    <div class="field"><label><input type="checkbox" id="f_isDefault" style="width:auto;display:inline-block;margin-right:6px;" />Make this the default mailbox</label></div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="saveBtn">Add mailbox</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const body = {
      label: document.getElementById('f_label').value,
      imapHost: document.getElementById('f_imapHost').value,
      imapPort: parseInt(document.getElementById('f_imapPort').value, 10),
      imapSecure: document.getElementById('f_imapSecure').checked,
      smtpHost: document.getElementById('f_smtpHost').value,
      smtpPort: parseInt(document.getElementById('f_smtpPort').value, 10),
      smtpSecure: document.getElementById('f_smtpSecure').checked,
      username: document.getElementById('f_username').value,
      password: document.getElementById('f_password').value,
      fromName: document.getElementById('f_fromName').value,
      fromEmail: document.getElementById('f_fromEmail').value,
      sentFolder: document.getElementById('f_sentFolder').value,
      dailySendCap: parseInt(document.getElementById('f_dailyCap').value, 10),
      isDefault: document.getElementById('f_isDefault').checked
    };
    try {
      await api('/api/mailboxes', { method: 'POST', body });
      closeModal();
      toast('Mailbox added.');
      navigate('mailboxes');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

// ---------- Settings ----------
VIEWS.settings = async function () {
  const s = await api('/api/settings');
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="panel">
      <div class="panel-header"><h2>AI generation</h2></div>
      <div class="panel-body">
        <p class="small">${s.hasOwnOpenrouterKey ? 'An OpenRouter key is on file for this account.' : 'No OpenRouter key on file — generation will use the platform default key, if one is configured, or fail with a clear error.'}</p>
        <div class="field"><label>OpenRouter API key</label><input type="password" id="f_key" placeholder="sk-or-..." /></div>
        <div class="field"><label>Model</label><input id="f_model" value="${esc(s.openrouterModel || 'anthropic/claude-3.5-sonnet')}" /></div>
        <button class="primary" id="saveKeyBtn">Save</button>
      </div>
    </div>`;
  document.getElementById('saveKeyBtn').addEventListener('click', async () => {
    try {
      await api('/api/settings/openrouter', { method: 'POST', body: { apiKey: document.getElementById('f_key').value, model: document.getElementById('f_model').value } });
      toast('Settings saved.');
      navigate('settings');
    } catch (e) {
      toast(e.message, true);
    }
  });
};

// ---------- Client Types ----------
VIEWS.clientTypes = async function () {
  const { clientTypes } = await api('/api/client-types');
  document.getElementById('topbarActions').innerHTML = `<button class="primary" id="addCtBtn">Add client type</button>`;
  document.getElementById('addCtBtn').addEventListener('click', showAddClientTypeModal);
  const content = document.getElementById('content');
  if (!clientTypes.length) {
    content.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty-state"><div class="empty-title">No client types yet</div>Client types carry the generation skeleton and example emails each segment uses — start with one or two.</div></div></div>`;
    return;
  }
  content.innerHTML = `<div class="panel"><div class="panel-body" id="ctWrap"></div></div>`;
  document.getElementById('ctWrap').innerHTML = `<table><thead><tr><th>Name</th><th>Contacts</th><th>Tone notes</th><th></th></tr></thead><tbody>
    ${clientTypes.map(ct => `<tr>
      <td><a href="#" data-open="${ct.id}">${esc(ct.name)}</a></td>
      <td>${ct.contact_count}</td>
      <td class="small">${esc((ct.tone_notes || '').slice(0, 60))}</td>
      <td><button class="ghost danger" data-del="${ct.id}">Delete</button></td>
    </tr>`).join('')}
  </tbody></table>`;
  document.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); openClientTypeDetail(el.dataset.open); }));
  document.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this client type? Contacts assigned to it will keep their other data but lose this segment.')) return;
    await api(`/api/client-types/${btn.dataset.del}`, { method: 'DELETE' });
    navigate('clientTypes');
  }));
};

function showAddClientTypeModal() {
  openModal(`
    <h2>Add client type</h2>
    <div class="field"><label>Name</label><input id="f_name" placeholder="Immigration consultancies — cold" /></div>
    <div class="field"><label>Description</label><input id="f_desc" placeholder="Small/mid immigration law firms, first outreach" /></div>
    <div class="field"><label>Tone notes</label><textarea id="f_tone" placeholder="Direct, no fluff, under 100 words, no exclamation points"></textarea></div>
    <div class="field"><label>Skeleton (structure the AI fills in)</label><textarea id="f_skeleton" placeholder="1) Hook referencing their firm/situation&#10;2) One-sentence value prop&#10;3) One proof point&#10;4) Single clear CTA"></textarea></div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="saveBtn">Add</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', async () => {
    try {
      await api('/api/client-types', { method: 'POST', body: {
        name: document.getElementById('f_name').value,
        description: document.getElementById('f_desc').value,
        toneNotes: document.getElementById('f_tone').value,
        skeleton: document.getElementById('f_skeleton').value
      }});
      closeModal();
      toast('Client type added.');
      navigate('clientTypes');
    } catch (e) { toast(e.message, true); }
  });
}

async function openClientTypeDetail(id) {
  const { clientType } = await api(`/api/client-types/${id}`);
  openModal(`
    <h2>${esc(clientType.name)}</h2>
    <p class="small">${esc(clientType.description || '')}</p>
    <div class="field"><label>Tone notes</label><div class="small">${esc(clientType.tone_notes || '(none)')}</div></div>
    <div class="field"><label>Skeleton</label><div class="small" style="white-space:pre-wrap;">${esc(clientType.skeleton || '(none)')}</div></div>
    <div class="field">
      <label>Example emails (${clientType.examples.length}) — these ground generation quality for this client type</label>
      <div id="examplesWrap"></div>
      <button class="ghost" id="addExampleBtn" style="margin-top:8px;">Add example</button>
    </div>
    <div class="modal-actions"><button class="ghost" id="closeBtn">Close</button></div>
  `);
  renderExamples(clientType.examples, id);
  document.getElementById('closeBtn').addEventListener('click', closeModal);
  document.getElementById('addExampleBtn').addEventListener('click', () => showAddExampleForm(id));
}

function renderExamples(examples, ctId) {
  const wrap = document.getElementById('examplesWrap');
  wrap.innerHTML = examples.length ? examples.map(ex => `
    <div class="draft-preview" style="margin-bottom:8px;">
      <div class="subject">${esc(ex.subject)} <button class="ghost danger" style="float:right;padding:2px 8px;" data-del-ex="${ex.id}">Remove</button></div>
      <div class="body">${esc(ex.body)}</div>
    </div>`).join('') : '<div class="small">No examples yet.</div>';
  wrap.querySelectorAll('[data-del-ex]').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/api/client-types/${ctId}/examples/${btn.dataset.delEx}`, { method: 'DELETE' });
    openClientTypeDetail(ctId);
  }));
}

function showAddExampleForm(ctId) {
  openModal(`
    <h2>Add example email</h2>
    <p class="helptext">A real email you consider a good example — generation uses this to match your quality bar.</p>
    <div class="field"><label>Subject</label><input id="f_subject" /></div>
    <div class="field"><label>Body</label><textarea id="f_body" style="min-height:140px;"></textarea></div>
    <div class="field"><label>Note (why it's good, optional)</label><input id="f_note" /></div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="saveBtn">Add example</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', () => openClientTypeDetail(ctId));
  document.getElementById('saveBtn').addEventListener('click', async () => {
    try {
      await api(`/api/client-types/${ctId}/examples`, { method: 'POST', body: {
        subject: document.getElementById('f_subject').value,
        body: document.getElementById('f_body').value,
        note: document.getElementById('f_note').value
      }});
      toast('Example added.');
      openClientTypeDetail(ctId);
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- Assets ----------
VIEWS.assets = async function () {
  const { assets } = await api('/api/assets');
  document.getElementById('topbarActions').innerHTML = `
    <button id="addLinkBtn">Add link</button>
    <button class="primary" id="addFileBtn">Upload file</button>`;
  document.getElementById('addLinkBtn').addEventListener('click', showAddLinkAssetModal);
  document.getElementById('addFileBtn').addEventListener('click', showAddFileAssetModal);

  const content = document.getElementById('content');
  if (!assets.length) {
    content.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty-state"><div class="empty-title">No assets yet</div>Add your demo link, booking link, or a case study PDF — generation will pull these in automatically when relevant.</div></div></div>`;
    return;
  }
  content.innerHTML = `<div class="panel"><div class="panel-body">
    <table><thead><tr><th>Label</th><th>Kind</th><th>Category</th><th>Value</th><th></th></tr></thead><tbody>
    ${assets.map(a => `<tr>
      <td>${esc(a.label)}</td>
      <td>${a.kind}</td>
      <td>${badge(a.category)}</td>
      <td class="mono small">${a.kind === 'link' ? esc(a.url) : `<a href="/api/assets/${a.id}/file" target="_blank">${esc(a.file_name)}</a>`}</td>
      <td><button class="ghost danger" data-del="${a.id}">Delete</button></td>
    </tr>`).join('')}
    </tbody></table>
  </div></div>`;
  document.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this asset?')) return;
    await api(`/api/assets/${btn.dataset.del}`, { method: 'DELETE' });
    navigate('assets');
  }));
};

const ASSET_CATEGORIES = ['demo', 'booking', 'case_study', 'pricing', 'one_pager', 'other'];

function showAddLinkAssetModal() {
  openModal(`
    <h2>Add link asset</h2>
    <div class="field"><label>Label</label><input id="f_label" placeholder="Book a demo" /></div>
    <div class="field"><label>URL</label><input id="f_url" placeholder="https://cal.com/you/demo" /></div>
    <div class="field"><label>Category</label><select id="f_category">${ASSET_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="saveBtn">Add</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', async () => {
    try {
      await api('/api/assets/link', { method: 'POST', body: {
        label: document.getElementById('f_label').value,
        url: document.getElementById('f_url').value,
        category: document.getElementById('f_category').value
      }});
      closeModal(); toast('Link added.'); navigate('assets');
    } catch (e) { toast(e.message, true); }
  });
}

function showAddFileAssetModal() {
  openModal(`
    <h2>Upload file asset</h2>
    <div class="field"><label>Label</label><input id="f_label" placeholder="Case study — Acme Immigration" /></div>
    <div class="field"><label>Category</label><select id="f_category">${ASSET_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
    <div class="field"><label>File</label><input type="file" id="f_file" /></div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="saveBtn">Upload</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('f_file');
    if (!fileInput.files[0]) { toast('Choose a file first.', true); return; }
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    fd.append('label', document.getElementById('f_label').value);
    fd.append('category', document.getElementById('f_category').value);
    try {
      await apiUpload('/api/assets/file', fd);
      closeModal(); toast('File uploaded.'); navigate('assets');
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- Contacts ----------
VIEWS.contacts = async function () {
  const [{ contacts }, { clientTypes }] = await Promise.all([api('/api/contacts?limit=300'), api('/api/client-types')]);
  document.getElementById('topbarActions').innerHTML = `
    <button id="importBtn">Import CSV/XLSX</button>
    <button class="primary" id="addContactBtn">Add contact</button>`;
  document.getElementById('addContactBtn').addEventListener('click', () => showAddContactModal(clientTypes));
  document.getElementById('importBtn').addEventListener('click', () => showImportModal(clientTypes));

  const ctById = Object.fromEntries(clientTypes.map(ct => [ct.id, ct.name]));
  const content = document.getElementById('content');
  if (!contacts.length) {
    content.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty-state"><div class="empty-title">No contacts yet</div>Add one, or import a CSV/XLSX list.</div></div></div>`;
    return;
  }
  content.innerHTML = `<div class="panel"><div class="panel-body">
    <table><thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Client type</th><th></th></tr></thead><tbody>
    ${contacts.map(c => `<tr>
      <td>${esc(c.name || '—')}</td>
      <td class="mono">${esc(c.email)}</td>
      <td>${esc(c.company || '—')}</td>
      <td>${c.client_type_id ? esc(ctById[c.client_type_id] || '—') : '—'}</td>
      <td>
        <button class="ghost" data-gen="${c.id}" data-ct="${c.client_type_id || ''}">Generate email</button>
        <button class="ghost danger" data-del="${c.id}">Delete</button>
      </td>
    </tr>`).join('')}
    </tbody></table>
  </div></div>`;
  document.querySelectorAll('[data-gen]').forEach(btn => btn.addEventListener('click', () => showGenerateModal(btn.dataset.gen, btn.dataset.ct, clientTypes)));
  document.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this contact?')) return;
    await api(`/api/contacts/${btn.dataset.del}`, { method: 'DELETE' });
    navigate('contacts');
  }));
};

function clientTypeOptions(clientTypes, selectedId) {
  return clientTypes.map(ct => `<option value="${ct.id}" ${ct.id === selectedId ? 'selected' : ''}>${esc(ct.name)}</option>`).join('');
}

function showAddContactModal(clientTypes) {
  openModal(`
    <h2>Add contact</h2>
    <div class="field-row">
      <div class="field"><label>Name</label><input id="f_name" /></div>
      <div class="field"><label>Email</label><input id="f_email" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Company</label><input id="f_company" /></div>
      <div class="field"><label>Client type</label><select id="f_ct"><option value="">—</option>${clientTypeOptions(clientTypes)}</select></div>
    </div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="saveBtn">Add</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', async () => {
    try {
      await api('/api/contacts', { method: 'POST', body: {
        name: document.getElementById('f_name').value,
        email: document.getElementById('f_email').value,
        company: document.getElementById('f_company').value,
        clientTypeId: document.getElementById('f_ct').value || null
      }});
      closeModal(); toast('Contact added.'); navigate('contacts');
    } catch (e) { toast(e.message, true); }
  });
}

function showImportModal(clientTypes) {
  openModal(`
    <h2>Import contacts</h2>
    <p class="helptext">CSV or XLSX with an email column (name/company columns optional, matched loosely).</p>
    <div class="field"><label>File</label><input type="file" id="f_file" accept=".csv,.xlsx" /></div>
    <div class="field"><label>Assign client type (optional)</label><select id="f_ct"><option value="">—</option>${clientTypeOptions(clientTypes)}</select></div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="saveBtn">Import</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('f_file');
    if (!fileInput.files[0]) { toast('Choose a file first.', true); return; }
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    if (document.getElementById('f_ct').value) fd.append('clientTypeId', document.getElementById('f_ct').value);
    try {
      const result = await apiUpload('/api/contacts/import', fd);
      closeModal();
      toast(`Imported ${result.importedCount} of ${result.results.length} rows.`);
      navigate('contacts');
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- Generate & review (single contact) ----------
function showGenerateModal(contactId, clientTypeId, clientTypes) {
  openModal(`
    <h2>Generate email</h2>
    <div class="field"><label>Client type</label><select id="f_ct">${clientTypeOptions(clientTypes, clientTypeId)}</select></div>
    <div class="field"><label>Angle</label><input id="f_angle" value="full pitch, first touch" /></div>
    <div id="genArea"></div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="genBtn">Generate draft</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('genBtn').addEventListener('click', async () => {
    const genBtn = document.getElementById('genBtn');
    genBtn.textContent = 'Generating…'; genBtn.disabled = true;
    try {
      const result = await api('/api/generate', { method: 'POST', body: {
        contactId,
        clientTypeId: document.getElementById('f_ct').value,
        angle: document.getElementById('f_angle').value
      }});
      renderDraftReview(result);
    } catch (e) {
      toast(e.message, true);
    }
    genBtn.textContent = 'Generate draft'; genBtn.disabled = false;
  });
}

function renderDraftReview(result) {
  const area = document.getElementById('genArea');
  area.innerHTML = `
    <div class="field"><label>Subject</label><input id="f_subject" value="${esc(result.subject)}" /></div>
    <div class="field"><label>Body</label><textarea id="f_body" style="min-height:180px;">${esc(result.body)}</textarea></div>
    <div id="sendMbxArea"></div>
  `;
  api('/api/mailboxes').then(({ mailboxes }) => {
    document.getElementById('sendMbxArea').innerHTML = mailboxes.length
      ? `<div class="field"><label>Send from</label><select id="f_mbx">${mailboxes.map(m => `<option value="${m.id}" ${m.is_default ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
         <button class="primary" id="sendBtn">Send now</button>`
      : `<p class="helptext">No mailbox connected yet — add one under Mailboxes first.</p>`;
    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) sendBtn.addEventListener('click', async () => {
      sendBtn.textContent = 'Sending…'; sendBtn.disabled = true;
      try {
        await api(`/api/messages/${result.messageId}/send`, { method: 'POST', body: {
          subject: document.getElementById('f_subject').value,
          body: document.getElementById('f_body').value,
          mailboxConnectionId: document.getElementById('f_mbx').value
        }});
        closeModal();
        toast('Sent.');
      } catch (e) {
        toast(e.message, true);
        sendBtn.textContent = 'Send now'; sendBtn.disabled = false;
      }
    });
  });
}

// ---------- Sequences ----------
VIEWS.sequences = async function () {
  const [{ sequences: seqs }, { clientTypes }] = await Promise.all([api('/api/sequences'), api('/api/client-types')]);
  document.getElementById('topbarActions').innerHTML = `<button class="primary" id="addSeqBtn">New sequence</button>`;
  document.getElementById('addSeqBtn').addEventListener('click', () => showAddSequenceModal(clientTypes));
  const content = document.getElementById('content');
  if (!seqs.length) {
    content.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty-state"><div class="empty-title">No sequences yet</div>A sequence is first touch + follow-up steps — each step generates and sends automatically when it comes due.</div></div></div>`;
    return;
  }
  content.innerHTML = `<div class="panel"><div class="panel-body">
    <table><thead><tr><th>Name</th><th>Client type</th><th>Steps</th><th></th></tr></thead><tbody>
    ${seqs.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.client_type_name || '—')}</td><td>${s.step_count}</td>
      <td><button class="ghost danger" data-del="${s.id}">Delete</button></td></tr>`).join('')}
    </tbody></table>
  </div></div>`;
  document.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this sequence? Active enrollments using it will stop generating new steps.')) return;
    await api(`/api/sequences/${btn.dataset.del}`, { method: 'DELETE' });
    navigate('sequences');
  }));
};

function showAddSequenceModal(clientTypes) {
  let stepCount = 1;
  const stepRow = (n) => `
    <div class="field-row" data-step="${n}" style="align-items:flex-end;">
      <div class="field"><label>Step ${n} angle</label><input class="step-angle" placeholder="${n === 1 ? 'full pitch, first touch' : 'short bump follow-up'}" /></div>
      <div class="field" style="max-width:110px;"><label>Days after prev.</label><input class="step-delay" value="${n === 1 ? '0' : '3'}" /></div>
    </div>`;
  openModal(`
    <h2>New sequence</h2>
    <div class="field"><label>Name</label><input id="f_name" placeholder="Immigration cold sequence" /></div>
    <div class="field"><label>Client type</label><select id="f_ct"><option value="">—</option>${clientTypeOptions(clientTypes)}</select></div>
    <div id="stepsWrap">${stepRow(1)}</div>
    <button class="ghost" id="addStepBtn" style="margin-top:6px;">Add step</button>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="saveBtn">Create sequence</button>
    </div>
  `);
  document.getElementById('addStepBtn').addEventListener('click', () => {
    stepCount++;
    document.getElementById('stepsWrap').insertAdjacentHTML('beforeend', stepRow(stepCount));
  });
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const angles = [...document.querySelectorAll('.step-angle')].map(el => el.value || 'follow-up');
    const delays = [...document.querySelectorAll('.step-delay')].map(el => parseInt(el.value, 10) || 0);
    const steps = angles.map((angle, i) => ({ angle, delayDays: delays[i] }));
    try {
      await api('/api/sequences', { method: 'POST', body: {
        name: document.getElementById('f_name').value,
        clientTypeId: document.getElementById('f_ct').value || null,
        steps
      }});
      closeModal(); toast('Sequence created.'); navigate('sequences');
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- Campaigns ----------
VIEWS.campaigns = async function () {
  const { campaigns: camps } = await api('/api/campaigns');
  document.getElementById('topbarActions').innerHTML = `<button class="primary" id="addCampaignBtn">New campaign</button>`;
  document.getElementById('addCampaignBtn').addEventListener('click', showAddCampaignModal);
  const content = document.getElementById('content');
  if (!camps.length) {
    content.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty-state"><div class="empty-title">No campaigns yet</div>A campaign ties a contact list to a client type, sequence, and sending mailbox.</div></div></div>`;
    return;
  }
  content.innerHTML = `<div class="panel"><div class="panel-body">
    <table><thead><tr><th>Name</th><th>Status</th><th>Client type</th><th>Sequence</th><th>Contacts</th></tr></thead><tbody>
    ${camps.map(c => `<tr><td><a href="#" data-open="${c.id}">${esc(c.name)}</a></td><td>${statusBadge(c.status)}</td><td>${esc(c.client_type_name || '—')}</td><td>${esc(c.sequence_name || '—')}</td><td>${c.contact_count}</td></tr>`).join('')}
    </tbody></table>
  </div></div>`;
  document.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); openCampaignDetail(el.dataset.open); }));
};

async function showAddCampaignModal() {
  const [{ clientTypes }, { sequences: seqs }, { mailboxes }, { contacts }] = await Promise.all([
    api('/api/client-types'), api('/api/sequences'), api('/api/mailboxes'), api('/api/contacts?limit=300')
  ]);
  openModal(`
    <h2>New campaign</h2>
    <div class="field"><label>Name</label><input id="f_name" placeholder="Immigration firms — September push" /></div>
    <div class="field-row">
      <div class="field"><label>Client type</label><select id="f_ct"><option value="">—</option>${clientTypeOptions(clientTypes)}</select></div>
      <div class="field"><label>Sequence (optional)</label><select id="f_seq"><option value="">—</option>${seqs.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Send from</label><select id="f_mbx"><option value="">—</option>${mailboxes.map(m => `<option value="${m.id}" ${m.is_default ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
    <div class="field"><label>Contacts (${contacts.length} total)</label>
      <div style="max-height:160px;overflow-y:auto;border:1px solid var(--line);border-radius:var(--radius);padding:8px;">
        ${contacts.map(c => `<label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-bottom:3px;"><input type="checkbox" class="contact-check" value="${c.id}" style="width:auto;" />${esc(c.name || c.email)} <span class="small mono">${esc(c.email)}</span></label>`).join('')}
      </div>
    </div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="saveBtn">Create campaign</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const contactIds = [...document.querySelectorAll('.contact-check:checked')].map(el => el.value);
    try {
      const result = await api('/api/campaigns', { method: 'POST', body: {
        name: document.getElementById('f_name').value,
        clientTypeId: document.getElementById('f_ct').value || null,
        sequenceId: document.getElementById('f_seq').value || null,
        mailboxConnectionId: document.getElementById('f_mbx').value || null,
        contactIds
      }});
      closeModal(); toast('Campaign created.'); navigate('campaigns');
      setTimeout(() => openCampaignDetail(result.campaign.id), 50);
    } catch (e) { toast(e.message, true); }
  });
}

async function openCampaignDetail(id) {
  const { campaign } = await api(`/api/campaigns/${id}`);
  openModal(`
    <h2>${esc(campaign.name)}</h2>
    <p class="small">${statusBadge(campaign.status)}</p>
    <div class="field-row">
      <button id="genAllBtn">Generate drafts for un-drafted contacts</button>
      <button id="importDraftsBtn">Import pre-written emails</button>
      ${campaign.sequence_id ? `<button id="enrollAllBtn">Enroll all in sequence (auto follow-ups)</button>` : ''}
    </div>
    <div id="draftsArea" class="small" style="margin-top:12px;">Loading…</div>
    <div class="modal-actions">
      <button id="sendAllBtn" class="primary">Send all drafted</button>
      <button class="ghost" id="closeBtn">Close</button>
    </div>
  `);
  document.getElementById('closeBtn').addEventListener('click', closeModal);
  document.getElementById('importDraftsBtn').addEventListener('click', () => showImportDraftsModal(campaign));
  await refreshCampaignDrafts(campaign);

  document.getElementById('genAllBtn').addEventListener('click', async (e) => {
    if (!campaign.client_type_id) { toast('Set a client type on this campaign first.', true); return; }
    const btn = e.target; btn.disabled = true; btn.textContent = 'Generating…';
    const contactRows = await api(`/api/campaigns/${campaign.id}/contacts`).then(r => r.contacts);
    const toGenerate = contactRows.filter(cc => !cc.message_id);
    let done = 0;
    for (const cc of toGenerate) {
      try {
        await api('/api/generate', { method: 'POST', body: { contactId: cc.contact_id, clientTypeId: campaign.client_type_id, angle: 'full pitch, first touch', campaignId: campaign.id } });
        done++;
      } catch (err) { console.error(err); }
    }
    toast(`Generated ${done} of ${toGenerate.length} draft(s).`);
    btn.disabled = false; btn.textContent = 'Generate drafts for un-drafted contacts';
    await refreshCampaignDrafts(campaign);
  });

  const enrollAllBtn = document.getElementById('enrollAllBtn');
  if (enrollAllBtn) enrollAllBtn.addEventListener('click', async () => {
    const contactRows = await api(`/api/campaigns/${campaign.id}/contacts`).then(r => r.contacts);
    const contactIds = contactRows.map(cc => cc.contact_id);
    const result = await api('/api/enrollments', { method: 'POST', body: { contactIds, sequenceId: campaign.sequence_id, campaignId: campaign.id } });
    const okCount = result.results.filter(r => r.ok).length;
    toast(`Enrolled ${okCount} contact(s) — follow-ups will send automatically on schedule.`);
  });

  document.getElementById('sendAllBtn').addEventListener('click', async () => {
    const contactRows = await api(`/api/campaigns/${campaign.id}/contacts`).then(r => r.contacts);
    const draftMessageIds = contactRows.filter(cc => cc.message_status === 'draft').map(cc => cc.message_id);
    if (!draftMessageIds.length) { toast('No drafts ready to send — generate some first.', true); return; }
    if (!campaign.mailbox_connection_id) { toast('Set a mailbox on this campaign to send from.', true); return; }
    try {
      await api('/api/send-jobs', { method: 'POST', body: { campaignId: campaign.id, mailboxConnectionId: campaign.mailbox_connection_id, messageIds: draftMessageIds } });
      toast(`Queued ${draftMessageIds.length} email(s) — see Send jobs for progress.`);
      closeModal();
    } catch (e) { toast(e.message, true); }
  });
}

async function refreshCampaignDrafts(campaign) {
  const area = document.getElementById('draftsArea');
  const contactRows = await api(`/api/campaigns/${campaign.id}/contacts`).then(r => r.contacts);
  if (!contactRows.length) {
    area.innerHTML = 'No contacts in this campaign yet.';
    return;
  }
  area.innerHTML = `<table><thead><tr><th>Contact</th><th>Draft status</th></tr></thead><tbody>
    ${contactRows.map(cc => `<tr><td>${esc(cc.name || cc.email)}</td><td>${cc.message_status ? statusBadge(cc.message_status) : badge('not generated')}</td></tr>`).join('')}
  </tbody></table>`;
}

// Imports pre-written emails (contact + subject + body per row) straight into this
// campaign's draft list — the fallback for when generation isn't producing good enough
// copy. These skip the AI pipeline entirely but flow through the exact same review/send
// steps as generated drafts afterward.
function showImportDraftsModal(campaign) {
  openModal(`
    <h2>Import pre-written emails</h2>
    <p class="helptext">CSV or XLSX with columns: <span class="mono">email</span>, <span class="mono">subject</span>, <span class="mono">body</span> — plus optional <span class="mono">name</span> / <span class="mono">company</span>.
    In the body or subject, write <span class="mono">{{asset:Book a demo}}</span> (matching an asset's exact label) to insert a saved link or attach a saved file — or just paste a raw link directly, which gets click-tracked automatically either way.
    Contacts are matched or created by email, and added to this campaign.</p>
    <div class="field"><label>File</label><input type="file" id="f_file" accept=".csv,.xlsx" /></div>
    <div class="modal-actions">
      <button class="ghost" id="cancelBtn">Cancel</button>
      <button class="primary" id="importBtn">Import</button>
    </div>
  `);
  document.getElementById('cancelBtn').addEventListener('click', () => openCampaignDetail(campaign.id));
  document.getElementById('importBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('f_file');
    if (!fileInput.files[0]) { toast('Choose a file first.', true); return; }
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    fd.append('campaignId', campaign.id);
    if (campaign.client_type_id) fd.append('clientTypeId', campaign.client_type_id);
    try {
      const result = await apiUpload('/api/messages/import', fd);
      toast(`Imported ${result.importedCount} of ${result.results.length} email(s) as drafts.`);
      openCampaignDetail(campaign.id);
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- Send Jobs ----------
let sendJobsPollTimer = null;

VIEWS.sendJobs = async function () {
  if (sendJobsPollTimer) clearInterval(sendJobsPollTimer);
  await renderSendJobsList();
  sendJobsPollTimer = setInterval(() => {
    if (currentRoute === 'sendJobs') renderSendJobsList(); else clearInterval(sendJobsPollTimer);
  }, 5000);
};

async function renderSendJobsList() {
  const { jobs } = await api('/api/send-jobs');
  const content = document.getElementById('content');
  if (!jobs.length) {
    content.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty-state"><div class="empty-title">No send jobs yet</div>Bulk sends from a campaign, or auto follow-ups from a sequence, show up here with live progress.</div></div></div>`;
    return;
  }
  content.innerHTML = `<div class="panel"><div class="panel-body">
    <table><thead><tr><th>Status</th><th>Progress</th><th>Created</th><th></th></tr></thead><tbody>
    ${jobs.map(j => `<tr>
      <td>${statusBadge(j.status)}</td>
      <td>${j.sent_count}/${j.total} sent${j.failed_count ? `, <span style="color:var(--alert)">${j.failed_count} failed</span>` : ''}</td>
      <td>${fmtDate(j.created_at)}</td>
      <td>${(j.status === 'queued' || j.status === 'running') ? `<button class="ghost danger" data-cancel="${j.id}">Cancel</button>` : ''}</td>
    </tr>`).join('')}
    </tbody></table>
    <p class="helptext" style="margin-top:10px;">Sends spread out automatically with randomized delays — a job with several emails will take a while to finish. This list refreshes every few seconds.</p>
  </div></div>`;
  document.querySelectorAll('[data-cancel]').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/api/send-jobs/${btn.dataset.cancel}/cancel`, { method: 'POST' });
    toast('Job cancelled.');
    renderSendJobsList();
  }));
}
