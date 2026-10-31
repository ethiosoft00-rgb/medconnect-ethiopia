const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// ---- Load .env ----
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing environment variables.');
  process.exit(1);
}

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

/* ---------------- HTML Renderer ---------------- */
function renderApp(res, branchSlug = '') {
  let html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  html = html.replace(/__SUPABASE_URL__/g, SUPABASE_URL || '');
  html = html.replace(/__SUPABASE_ANON_KEY__/g, SUPABASE_ANON_KEY || '');
  html = html.replace(/__BRANCH_SLUG__/g, branchSlug || '');
  res.send(html);
}

/* ---------------- Public Routes ---------------- */
app.get('/', (req, res) => renderApp(res, ''));

app.get('/b/:slug', async (req, res) => {
  renderApp(res, req.params.slug);
});

app.get('/api/branch/:slug', async (req, res) => {
  const { slug } = req.params;
  let data = null;
  try {
    const r = await adminClient.from('branches').select('id, name, location, slug').eq('slug', slug).maybeSingle();
    data = r.data;
  } catch (_) {}
  if (!data) {
    try {
      const r = await adminClient.from('branches').select('id, name, location, slug').eq('id', slug).maybeSingle();
      data = r.data;
    } catch (_) {}
  }
  if (!data) return res.status(404).json({ error: 'Branch not found' });
  res.json(data);
});

/* ---------------- Auth Middleware ---------------- */
async function requireUser(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  const { data: { user }, error } = await adminClient.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  const { data: profile, error: pErr } = await adminClient
    .from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (pErr || !profile) return res.status(403).json({ error: 'No profile' });
  req.user = user;
  req.profile = profile;
  next();
}

/* ---------------- CREATE BRANCH & ADMIN (Bulletproof Endpoint) ---------------- */
app.post('/api/admin/create-branch-with-admin', requireUser, async (req, res) => {
  try {
    if (!['admin', 'super_admin'].includes(req.profile.role)) {
      return res.status(403).json({ error: 'Only System Admins can create branches.' });
    }

    const { 
      branchName, branchLocation, branchSlug, 
      adminName, adminStaffId, adminPassword 
    } = req.body;

    if (!branchName || !adminName || !adminStaffId || !adminPassword) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // 1. Create the Branch
    const generatedSlug = branchSlug || branchName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const { data: branch, error: bErr } = await adminClient.from('branches').insert([{
      name: branchName, 
      location: branchLocation, 
      slug: generatedSlug
    }]).select().single();

    if (bErr) return res.status(400).json({ error: 'Branch creation failed: ' + bErr.message });

    // 2. Create the Auth User for Branch Admin
    const email = `${adminStaffId}@medconnect.com`;
    
    // We try admin.createUser first. If it fails due to a trigger, we use a fallback.
    let createdUser = null;
    let authErr = null;

    const { data: adminData, error: adminError } = await adminClient.auth.admin.createUser({
      email,
      password: adminPassword,
      email_confirm: true,
      user_metadata: { full_name: adminName, staff_id: adminStaffId, role: 'branch_admin', branch_id: branch.id }
    });

    if (adminError) {
      console.log("admin.createUser failed, trying fallback...", adminError.message);
      // Fallback: Use signUp (sometimes bypasses strict DB triggers)
      const { data: signUpData, error: signUpError } = await adminClient.auth.signUp({
        email,
        password: adminPassword,
        options: {
          data: { full_name: adminName, staff_id: adminStaffId, role: 'branch_admin', branch_id: branch.id }
        }
      });
      createdUser = signUpData?.user;
      authErr = signUpError;
    } else {
      createdUser = adminData?.user;
    }

    if (authErr || !createdUser) {
      // Rollback branch creation if auth fails completely
      await adminClient.from('branches').delete().eq('id', branch.id);
      return res.status(400).json({ error: 'Admin account creation failed. Database Trigger error: ' + (authErr?.message || 'Unknown') });
    }

    // 3. Manually ensure the Profile is created (in case the DB trigger didn't do it)
    const { error: pErr } = await adminClient.from('profiles').upsert({
      id: createdUser.id,
      full_name: adminName,
      staff_id: adminStaffId,
      role: 'branch_admin',
      branch_id: branch.id
    }, { onConflict: 'id' });

    if (pErr) {
      // Rollback everything if profile fails
      await adminClient.auth.admin.deleteUser(createdUser.id);
      await adminClient.from('branches').delete().eq('id', branch.id);
      return res.status(500).json({ error: 'Profile creation failed: ' + pErr.message });
    }

    res.json({ ok: true, branch });
  } catch (e) {
    console.error('Create Branch Error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Worker Creation ---------------- */
app.post('/api/admin/create-user', requireUser, async (req, res) => {
  try {
    let { staffId, fullName, password, role, branchId } = req.body;
    if (!staffId || !fullName || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    const caller = req.profile;

    if (caller.role === 'branch_admin') {
      const allowedWorkerRoles = [
        'doctor', 'surgeon', 'nurse', 'midwife', 'lab_tech', 'radiologist', 
        'pharmacist', 'physiotherapist', 'dentist', 'receptionist', 
        'billing_staff', 'hr_manager', 'it_support', 'patient'
      ];
      if (!allowedWorkerRoles.includes(role)) {
        return res.status(403).json({ error: 'Branch admins can only create worker accounts.' });
      }
      branchId = caller.branch_id;
    } else if (!['admin', 'super_admin'].includes(caller.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!branchId) return res.status(400).json({ error: 'branchId required.' });

    const email = `${staffId}@medconnect.com`;

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, staff_id: staffId, role, branch_id: branchId }
    });
    if (createErr) return res.status(400).json({ error: createErr.message });

    const { error: pErr } = await adminClient.from('profiles').upsert({
      id: created.user.id,
      full_name: fullName,
      staff_id: staffId,
      role,
      branch_id: branchId
    }, { onConflict: 'id' });
    if (pErr) return res.status(500).json({ error: pErr.message });

    res.json({ ok: true, id: created.user.id, email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Delete User ---------------- */
app.post('/api/admin/delete-user', requireUser, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: target, error: tErr } = await adminClient.from('profiles')
      .select('*').eq('id', userId).maybeSingle();
    if (tErr || !target) return res.status(404).json({ error: 'User not found' });

    const caller = req.profile;
    const isSystemAdmin = ['admin', 'super_admin'].includes(caller.role);
    const isBranchAdmin =
      caller.role === 'branch_admin' &&
      target.branch_id === caller.branch_id &&
      !['admin', 'super_admin', 'branch_admin'].includes(target.role);

    if (!isSystemAdmin && !isBranchAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await adminClient.auth.admin.deleteUser(userId);
    await adminClient.from('profiles').delete().eq('id', userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Patient Registration ---------------- */
app.post('/api/public/register-patient', async (req, res) => {
  try {
    const { fullName, phone, password } = req.body;
    if (!fullName || !phone || !password) {
      return res.status(400).json({ error: 'Please fill in all fields.' });
    }
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 9) return res.status(400).json({ error: 'Invalid phone number.' });

    const email = `${cleanPhone}@medconnect.com`;

    const { data: existing } = await adminClient.from('profiles').select('id').eq('staff_id', cleanPhone).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Patient with this phone already exists.' });

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { full_name: fullName, staff_id: cleanPhone, role: 'patient' }
    });
    
    if (createErr) return res.status(400).json({ error: createErr.message });

    await adminClient.from('profiles').upsert({
      id: created.user.id, full_name: fullName, staff_id: cleanPhone, role: 'patient', branch_id: null 
    }, { onConflict: 'id' });

    res.json({ ok: true, message: 'Account created successfully. You can now log in.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Translation ---------------- */
app.post('/api/translate', async (req, res) => {
  const { text, targetLang } = req.body;
  const hasabKey = process.env.HASAB_API_KEY || 'HASAB_KEY_TFTb8SPDPAkTbzOIIJCHPWBHEjL5H1';

  if (hasabKey) {
    try {
      const langMap = { 'English': 'eng', 'Amharic': 'amh', 'Afaan Oromoo': 'orm', 'Tigrinya': 'tig' };
      const targetCode = langMap[targetLang] || 'amh';
      const response = await fetch('https://api.hasab.ai/v1/translate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${hasabKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, target_language: targetCode })
      });
      const data = await response.json();
      if (response.ok && data.translation) {
        return res.json({ choices: [{ message: { content: data.translation } }] });
      }
    } catch (err) {}
  }

  try {
    const langMap = { 'English': 'en', 'Amharic': 'am', 'Afaan Oromoo': 'om', 'Tigrinya': 'ti' };
    const targetCode = langMap[targetLang] || 'am';
    const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetCode}`);
    const data = await response.json();
    if (data.responseData && data.responseData.translatedText) {
      return res.json({ choices: [{ message: { content: data.responseData.translatedText } }] });
    }
    throw new Error('Fallback translation failed');
  } catch (error) {
    res.status(500).json({ error: 'Translation service unavailable' });
  }
});

/* ---------------- Catch-all ---------------- */
app.get('*', (req, res) => res.redirect('/'));

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));