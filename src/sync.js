#!/usr/bin/env node
'use strict';
/**
 * sync.js: push Instantly cold-email repliers who showed interest into the
 * right MailerLite nurture group. Runs in GitHub Actions on weekdays.
 *
 *   node src/sync.js [--dry-run]
 *
 * What counts as a lead: a reply that shows interest. That means the Instantly
 * lead labels Interested, Meeting booked, Meeting completed and Closed.
 * Out-of-office, neutral and Not-interested repliers are never synced.
 *
 * Routing (config/routing.json):
 *   - campaigns: pinned campaign ID -> segment
 *   - nameRules: regex on the campaign name -> segment, for campaigns launched
 *     after the config was written. Auto-routed campaigns are flagged in the
 *     summary email so a new wave never gets silently skipped or misrouted.
 *   - groups: segment -> MailerLite group ID (an env var can override each)
 *
 * MailerLite POST /api/subscribers upserts by email, so reruns are safe: an
 * existing subscriber just gets the group added. state/synced.json records
 * every email pushed (key email|segment).
 *
 * Required env: INSTANTLY_API_KEY, MAILERLITE_API_KEY
 * Optional:     MAILERLITE_GROUP_<SEGMENT> to override a group ID,
 *               GMAIL_USER + GMAIL_APP_PASSWORD (summary email when something
 *               was added or failed), EMAIL_NOTIFY
 */

const fs   = require('fs');
const path = require('path');

const INSTANTLY_API = 'https://api.instantly.ai/api/v2';
const ML_API        = 'https://connect.mailerlite.com/api';

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }); } catch { /* dotenv is optional in CI */ }

const INSTANTLY_KEY = process.env.INSTANTLY_API_KEY;
const ML_KEY        = process.env.MAILERLITE_API_KEY;
const CONFIG_DIR    = process.env.CONFIG_DIR || path.join(ROOT, 'config');
const STATE_DIR     = process.env.STATE_DIR  || path.join(ROOT, 'state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// config/routing.json wins; the committed routing.example.json is the fallback
function loadRouting() {
  for (const file of ['routing.json', 'routing.example.json']) {
    const p = path.join(CONFIG_DIR, file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('Missing config/routing.json');
}
const routing = loadRouting();

// Group IDs: env first (MAILERLITE_GROUP_WHOLESALE), else routing.json.
// A repo secret left empty falls through to the config value.
const GROUPS = {};
for (const [segment, id] of Object.entries(routing.groups || {})) {
  GROUPS[segment] = process.env[`MAILERLITE_GROUP_${segment.toUpperCase()}`] || id;
}
const EMAIL_NOTIFY = process.env.EMAIL_NOTIFY || process.env.GMAIL_USER;
const STATE_FILE   = path.join(STATE_DIR, 'synced.json');
const dryRun       = process.argv.includes('--dry-run');

// Pinned campaign -> segment. New campaigns are picked up by NAME_RULES below.
const CAMPAIGN_SEGMENTS = routing.campaigns || {};
const NAME_RULES = (routing.nameRules || []).map(r => ({ test: new RegExp(r.pattern, 'i'), segment: r.segment }));

const INTEREST_FILTERS = {
  FILTER_LEAD_INTERESTED:        'Interested',
  FILTER_LEAD_MEETING_BOOKED:    'Meeting booked',
  FILTER_LEAD_MEETING_COMPLETED: 'Meeting completed',
  FILTER_LEAD_CLOSED:            'Closed',
};

function die(msg) { console.error('✖ ' + msg); process.exit(1); }
if (!INSTANTLY_KEY) die('INSTANTLY_API_KEY missing');
if (!ML_KEY) die('MAILERLITE_API_KEY missing');
for (const [segment, id] of Object.entries(GROUPS)) if (!id) die(`MailerLite group ID missing for segment "${segment}"`);
if (!Object.keys(GROUPS).length) die('No segments configured in config/routing.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = v => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// ── Instantly ─────────────────────────────────────────────────────────────────
async function instantly(method, endpoint, body) {
  const res = await fetch(`${INSTANTLY_API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${INSTANTLY_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Instantly ${method} ${endpoint} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function listCampaigns() {
  const out = [];
  let starting_after;
  do {
    const qs = new URLSearchParams({ limit: '100', ...(starting_after ? { starting_after } : {}) });
    const page = await instantly('GET', `/campaigns?${qs}`);
    out.push(...(page.items || []));
    starting_after = page.next_starting_after;
  } while (starting_after);
  return out;
}

async function listLeads(campaign, filter) {
  const out = [];
  let starting_after;
  do {
    const page = await instantly('POST', '/leads/list', { campaign, filter, limit: 100, distinct_contacts: true, ...(starting_after ? { starting_after } : {}) });
    out.push(...(page.items || []));
    starting_after = page.next_starting_after;
    if (!page.items || page.items.length < 100) break;
  } while (starting_after);
  return out;
}

function segmentFor(campaign) {
  if (CAMPAIGN_SEGMENTS[campaign.id] && GROUPS[CAMPAIGN_SEGMENTS[campaign.id]]) return { segment: CAMPAIGN_SEGMENTS[campaign.id], auto: false };
  const rule = NAME_RULES.find(r => r.test.test(campaign.name || ''));
  return rule && GROUPS[rule.segment] ? { segment: rule.segment, auto: true } : { segment: null, auto: false };
}

// ── MailerLite ────────────────────────────────────────────────────────────────
function toFields(lead) {
  const f = {};
  const name = clean(lead.first_name), last = clean(lead.last_name);
  if (name) f.name = name;
  if (last) f.last_name = last;
  const company = clean(lead.company_name); if (company) f.company = company;
  const phone   = clean(lead.phone);        if (phone)   f.phone   = phone.replace(/[^\d+\-() ]/g, '').trim();
  const country = clean(lead.payload && (lead.payload.country || lead.payload.Country)); if (country) f.country = country;
  return f;
}

async function upsert(lead, groupId) {
  const res = await fetch(`${ML_API}/subscribers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ML_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: lead.email.toLowerCase(), fields: toFields(lead), groups: [groupId] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MailerLite ${res.status} ${text.slice(0, 200)}`);
  return res.status; // 201 created, 200 existed → group added
}

// ── Notify ────────────────────────────────────────────────────────────────────
async function notify(subject, lines) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) { console.log('(no Gmail creds: summary not emailed)'); return; }
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch { console.log('(nodemailer missing: summary not emailed)'); return; }
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: process.env.GMAIL_USER, to: EMAIL_NOTIFY, subject, text: lines.join('\n') });
  console.log(`📧 summary sent to ${EMAIL_NOTIFY}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  let state;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = { synced: {} }; }
  state.synced = state.synced || {};
  const today = new Date().toISOString().slice(0, 10);

  const campaigns = await listCampaigns();
  const targets = [];
  const autoDetected = [];
  for (const c of campaigns) {
    const { segment, auto } = segmentFor(c);
    if (!segment) continue;
    // pinned campaigns always; auto-detected only if active (status 1) or paused (2)
    if (auto && ![1, 2].includes(c.status)) continue;
    targets.push({ id: c.id, name: c.name, segment });
    if (auto) autoDetected.push(`${c.name} (${c.id}) → ${segment}`);
  }
  console.log('Campaigns:', targets.map(t => `${t.name} → ${t.segment}`).join(' | '));

  const summary = { created: [], updated: [], already: 0, failed: [] };

  for (const t of targets) {
    const seen = new Set();
    for (const [filter, label] of Object.entries(INTEREST_FILTERS)) {
      let leads;
      try { leads = await listLeads(t.id, filter); }
      catch (err) { summary.failed.push(`${t.name} / ${filter}: ${err.message}`); continue; }
      for (const lead of leads) {
        const email = (lead.email || '').toLowerCase().trim();
        if (!email.includes('@') || seen.has(email)) continue;
        seen.add(email);
        const key = `${email}|${t.segment}`;
        if (state.synced[key]) { summary.already++; continue; }
        const desc = `${email} → ${t.segment}  (${lead.company_name || '-'}, ${label}, ${t.name})`;
        if (dryRun) { summary.created.push(desc + ' [dry-run]'); continue; }
        try {
          const status = await upsert(lead, GROUPS[t.segment]);
          (status === 201 ? summary.created : summary.updated).push(desc);
          state.synced[key] = { date: today, segment: t.segment, campaign: t.name, interest: label, company: lead.company_name || null };
        } catch (err) {
          summary.failed.push(`${email}: ${err.message}`);
        }
        await sleep(150);
      }
    }
  }

  if (!dryRun) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');

  const lines = [];
  if (summary.created.length) lines.push(`Added to MailerLite (${summary.created.length}):`, ...summary.created.map(s => '  ' + s), '');
  if (summary.updated.length) lines.push(`Already in MailerLite, group added (${summary.updated.length}):`, ...summary.updated.map(s => '  ' + s), '');
  if (summary.failed.length)  lines.push(`FAILED (${summary.failed.length}):`, ...summary.failed.map(s => '  ' + s), '');
  if (autoDetected.length)    lines.push('Auto-detected campaigns (not pinned in CAMPAIGN_SEGMENTS: check routing):', ...autoDetected.map(s => '  ' + s), '');
  lines.push(`Previously synced, skipped: ${summary.already}`);
  console.log(lines.join('\n'));

  const newCount = summary.created.length + summary.updated.length;
  if (!dryRun && (newCount || summary.failed.length)) {
    const subj = summary.failed.length
      ? `⚠️ Instantly → MailerLite: ${newCount} added, ${summary.failed.length} failed`
      : `Instantly → MailerLite: ${newCount} new interested lead${newCount === 1 ? '' : 's'} added`;
    try { await notify(subj, lines); } catch (err) { console.error('notify failed:', err.message); }
  }
  process.exit(summary.failed.length ? 2 : 0);
})().catch(err => { console.error(err); process.exit(1); });
