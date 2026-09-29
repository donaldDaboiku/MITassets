// Supabase Edge Function: device-allocation
// Deploy: supabase functions deploy device-allocation --no-verify-jwt
//
// GET  ?workspace_id=main  → { ok, workspace_id }  (no device inventory to the public)
// POST create request (no device pick) → pending row
// POST { action: 'receipt_lookup' | 'confirm_receipt', token, ... }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function namesMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na.length > 0 && na === nb;
}

function getClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  const url = new URL(req.url);
  const workspaceId =
    (url.searchParams.get('workspace_id') || url.searchParams.get('workspace') || 'main')
      .trim() || 'main';

  try {
    if (req.method === 'GET') {
      // Public health check only — never expose available inventory
      return json({ ok: true, workspace_id: workspaceId });
    }

    if (req.method !== 'POST') {
      return json({ error: 'GET or POST required' }, 405);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const action = String(body.action || 'create').trim();
    const supabase = getClient();
    const ws =
      String(body.workspaceId || body.workspace_id || workspaceId || 'main').trim() || 'main';

    if (action === 'receipt_lookup') {
      const token = String(body.token || '').trim();
      if (!token) return json({ error: 'Token required' }, 400);
      const { data, error } = await supabase
        .from('mit_allocation_requests')
        .select('id, full_name, email, devices, status, receipt_status, receipt_token')
        .eq('workspace_id', ws)
        .eq('receipt_token', token)
        .maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: 'Invalid or expired confirmation link' }, 404);
      if (data.status !== 'approved') {
        return json({ error: 'This allocation is not ready for receipt confirmation' }, 409);
      }
      return json({
        fullName: data.full_name,
        email: data.email,
        devices: data.devices || [],
        receiptStatus: data.receipt_status || null,
      });
    }

    if (action === 'confirm_receipt') {
      const token = String(body.token || '').trim();
      const condition = String(body.condition || '').trim().toLowerCase();
      const signatureName = String(body.signatureName || body.signature_name || '').trim();
      const receiptNote = String(body.receiptNote || body.receipt_note || '').trim();
      if (!token) return json({ error: 'Token required' }, 400);
      if (condition !== 'good' && condition !== 'bad') {
        return json({ error: 'Condition must be good or bad' }, 400);
      }
      if (condition === 'bad' && !receiptNote) {
        return json({ error: 'Please describe the issue for a bad/damaged device' }, 400);
      }

      const { data: row, error: findErr } = await supabase
        .from('mit_allocation_requests')
        .select('id, full_name, status, receipt_status, receipt_token')
        .eq('workspace_id', ws)
        .eq('receipt_token', token)
        .maybeSingle();
      if (findErr) return json({ error: findErr.message }, 500);
      if (!row) return json({ error: 'Invalid or expired confirmation link' }, 404);
      if (row.status !== 'approved') {
        return json({ error: 'This allocation is not ready for receipt confirmation' }, 409);
      }
      if (row.receipt_status === 'good' || row.receipt_status === 'bad') {
        return json({ error: 'Receipt already confirmed', receiptStatus: row.receipt_status }, 409);
      }
      if (!namesMatch(row.full_name, signatureName)) {
        return json({ error: 'Signature must match full name on the request' }, 400);
      }

      const { error: updErr } = await supabase
        .from('mit_allocation_requests')
        .update({
          confirmed_receipt: true,
          receipt_status: condition,
          receipt_note: receiptNote || null,
          receipt_confirmed_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (updErr) return json({ error: updErr.message }, 500);
      return json({ ok: true, receiptStatus: condition });
    }

    // ── Create allocation request (no public device selection) ──────────────
    const fullName = String(body.fullName || body.full_name || '').trim();
    const email = String(body.email || '').trim();
    const department = String(body.department || '').trim();
    const subsidiary = String(body.subsidiary || body.company || '').trim();
    const jobRole = String(body.jobRole || body.job_role || '').trim();
    const preferredType = String(body.preferredType || body.preferred_type || '').trim();
    const notes = String(body.notes || '').trim();
    const signatureName = String(body.signatureName || body.signature_name || '').trim();

    if (!fullName) return json({ error: 'Full name is required' }, 400);
    if (!email || !email.includes('@')) return json({ error: 'Valid email is required' }, 400);
    if (!namesMatch(fullName, signatureName)) {
      return json({ error: 'Signature must match full name exactly' }, 400);
    }

    const row = {
      workspace_id: ws,
      full_name: fullName,
      email,
      department: department || null,
      subsidiary: subsidiary || null,
      job_role: jobRole || null,
      preferred_type: preferredType || null,
      notes: notes || null,
      signature_name: signatureName,
      confirmed_receipt: false,
      device_ids: [],
      devices: [],
      status: 'pending',
      receipt_status: null,
    };

    const { data, error } = await supabase
      .from('mit_allocation_requests')
      .insert(row)
      .select('id, status, created_at')
      .maybeSingle();

    if (error) {
      // Fallback if preferred_type / receipt columns not migrated yet
      if (/preferred_type|receipt_status|column/i.test(error.message || '')) {
        delete row.preferred_type;
        delete row.receipt_status;
        if (preferredType) {
          row.notes = [notes, preferredType ? `Preferred type: ${preferredType}` : '']
            .filter(Boolean)
            .join('\n') || null;
        }
        const retry = await supabase
          .from('mit_allocation_requests')
          .insert(row)
          .select('id, status, created_at')
          .maybeSingle();
        if (retry.error) return json({ error: retry.error.message }, 500);
        return json({ ok: true, request: retry.data }, 201);
      }
      return json({ error: error.message }, 500);
    }

    return json({ ok: true, request: data }, 201);
  } catch (err) {
    return json({ error: String(err?.message || err || 'Server error') }, 500);
  }
});
