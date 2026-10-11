// Round 3 (ruling 34), updated round 4 (migrations 5 and 6): data-model.md §2 mirrors server/src/db/schema.sql + src/db/migrations.ts.
// usage: node --no-warnings test-ddl.cjs <data-model.md> [<server dir>]
//  1. extracts the ```sql blocks of §2 and runs them in order in node:sqlite (foreign_keys=ON);
//  2. with <server dir>: checks each block is byte-identical to schema.sql / the migration step, and that
//     the resulting sqlite_master equals the one built from the code files;
//  3. runs trigger / constraint smoke tests against the resulting schema.
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const [mdPath, srv] = process.argv.slice(2);
const md = fs.readFileSync(mdPath, 'utf8');
const sec = md.slice(md.indexOf('\n## 2.'), md.indexOf('\n## 3.'));
const blocks = [...sec.matchAll(/```sql\n([\s\S]*?)\n```/g)].map((m) => m[1]);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('FAIL', name, extra ?? ''); } };

function build(sqls) { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); for (const s of sqls) db.exec(s); return db; }
const master = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all().map((r) => JSON.stringify(r)).join('\n');

const db = build(blocks);
ok('blocks found (base + migrations)', blocks.length >= 2, blocks.length);
if (srv) {
  const schema = fs.readFileSync(path.join(srv, 'src/db/schema.sql'), 'utf8').replace(/\s+$/, '');
  const mig = fs.readFileSync(path.join(srv, 'src/db/migrations.ts'), 'utf8');
  const consts = {}; for (const m of mig.matchAll(/const (\w+) = `([\s\S]*?)`;/g)) consts[m[1]] = m[2];
  const steps = [...mig.matchAll(/\{ version: (\d+), name: '([^']*)', sql: (\w+) \}/g)].map((m) => consts[m[3]].replace(/^\n+/, '').replace(/\s+$/, ''));
  ok('block count = 1 + migration steps', blocks.length === 1 + steps.length, `${blocks.length} vs ${1 + steps.length}`);
  ok('base block identical to schema.sql', blocks[0] === schema);
  steps.forEach((s, i) => ok(`migration block ${i + 1} identical`, blocks[i + 1] === s));
  ok('sqlite_master identical to the code-built schema', master(db) === master(build([schema, ...steps])));
}

const t = (name, fn, expectErr) => {
  try { fn(); ok(name, !expectErr, 'expected an error'); }
  catch (e) { ok(name, !!expectErr && (expectErr === true || String(e.message).includes(expectErr)), e.message); }
};
const run = (sql, ...p) => db.prepare(sql).run(...p);
const H = (c) => c.padEnd(64, '0');
const now = '2026-10-10T00:00:00Z';

// ---- seed path (empty database)
t('seed version', () => run(`INSERT INTO dataset_versions VALUES ('2026.10.01-1',NULL,?, 'seed','seed',0,?,NULL)`, now, '0'.repeat(64)));
t('seed batch', () => run(`INSERT INTO seed_batches VALUES ('sb_1','2026.10.01-1',?,'{}')`, now));
for (const [c, l, p, ch, ty] of [['71', 2, null, '71', 'goods'], ['7113', 4, '71', '71', 'goods'], ['99', 2, null, '99', 'service'], ['99972', 5, '99', '99', 'service']])
  t(`seed hsn ${c}`, () => run(`INSERT INTO hsn_codes(code,level,parent,chapter,type,description,keywords,added_in_version) VALUES (?,?,?,?,?,?, '', '2026.10.01-1')`, c, l, p, ch, ty, 'desc ' + c));
t('hsn 3-digit code rejected', () => run(`INSERT INTO hsn_codes(code,level,parent,chapter,type,description,added_in_version) VALUES ('711',3,'71','71','goods','x','2026.10.01-1')`), true);
t('hsn 5-digit outside ch.99 rejected', () => run(`INSERT INTO hsn_codes(code,level,parent,chapter,type,description,added_in_version) VALUES ('71131',5,'7113','71','goods','x','2026.10.01-1')`), true);
const rule = (id, extra = {}) => {
  const r = { rule_id: id, hsn_prefix: '7113', igst_rate_bp: 300, effective_from: '2025-09-22', notification_ref: '9/2025-CT(Rate), Schedule IV', source_url: 'https://cbic-gst.gov.in/x', created_in_version: '2026.10.01-1', seed_batch_id: 'sb_1', ...extra };
  const k = Object.keys(r); run(`INSERT INTO rate_rules(${k}) VALUES (${k.map(() => '?')})`, ...Object.values(r));
};
t('seed rule', () => rule('rr_1'));
t('seed rule with citation_note', () => rule('rr_cn', { citation_note: 'gazette not read; S.No. not verified', hsn_prefix: '71' }));
t('citation_note edit refused (v6)', () => run(`UPDATE rate_rules SET citation_note='x' WHERE rule_id='rr_cn'`), 'citation_note');
t('citation_note clear without verify refused (v6)', () => run(`UPDATE rate_rules SET citation_note=NULL WHERE rule_id='rr_cn'`), 'citation_note');
t('rule with unknown prefix rejected', () => rule('rr_x', { hsn_prefix: '7114' }), 'existing hsn_prefix');
t('price rule needs bounds', () => rule('rr_y', { condition_kind: 'price', condition_text: 'x' }), true);
t('condition_code only on other', () => rule('rr_z', { condition_code: 'nil_rate_list' }), true);
t('seed synonym', () => run(`INSERT INTO synonyms(phrase,hsn_code,created_by,created_at) VALUES ('gold ring','7113','seed',?)`, now));
t('seed chapter keyword', () => run(`INSERT INTO chapter_keywords(keyword,chapter) VALUES ('gold','71')`));
t('seed category', () => run(`INSERT INTO category_map(source,category,hsn_prefix) VALUES ('open_food_facts','en:biscuits','71')`));
t('seal version (placeholder -> hash)', () => run(`UPDATE dataset_versions SET content_hash=?, rule_count=1 WHERE version='2026.10.01-1'`, H('a')));
t('sealed version immutable', () => run(`UPDATE dataset_versions SET content_hash=? WHERE version='2026.10.01-1'`, H('b')), 'immutable');
t('dataset_state', () => run(`INSERT INTO dataset_state VALUES (1,'2026.10.01-1',0,'fe_0123456789')`));
t('second seed batch refused', () => run(`INSERT INTO seed_batches VALUES ('sb_2','2026.10.01-1',?,'{}')`, now), 'empty database');
t('seed-path rule after seed refused', () => rule('rr_2'), 'approved proposal');
t('hsn insert after seed refused', () => run(`INSERT INTO hsn_codes(code,level,parent,chapter,type,description,added_in_version) VALUES ('711319',6,'7113','71','goods','x','2026.10.01-1')`), 'add_code');
t('synonym insert without proposal refused', () => run(`INSERT INTO synonyms(phrase,hsn_code,created_by,created_at) VALUES ('ring','7113','x',?)`, now), 'refdata_change');
t('rule rate edit refused', () => run(`UPDATE rate_rules SET igst_rate_bp=500 WHERE rule_id='rr_1'`), 'immutable');
t('rule delete refused', () => run(`DELETE FROM rate_rules WHERE rule_id='rr_1'`), 'delete not allowed');
t('hsn delete refused', () => run(`DELETE FROM hsn_codes WHERE code='99972'`), 'delete not allowed');

// ---- admin identity and keys
t('bootstrap actor 1', () => run(`INSERT INTO admin_actors(id,handle,created_at,created_via) VALUES ('act_1','amit',?,'bootstrap')`, now));
t('bootstrap actor 2', () => run(`INSERT INTO admin_actors(id,handle,created_at,created_via) VALUES ('act_2','priya',?,'bootstrap')`, now));
t('third bootstrap actor refused', () => run(`INSERT INTO admin_actors(id,handle,created_at,created_via) VALUES ('act_3','ravi',?,'bootstrap')`, now), 'first two');
t('upper-case handle refused', () => run(`INSERT INTO admin_actors(id,handle,created_at,created_via) VALUES ('act_4','Amit',?,'bootstrap')`, now), true);
const key = (id, prefix, scopes, actor, extra = {}) => {
  const r = { id, prefix, key_hash: H('c'), scopes, tenant: 'internal', actor_id: actor, created_at: now, expires_at: actor ? '2026-12-01T00:00:00Z' : null, ...extra };
  const k = Object.keys(r); run(`INSERT INTO api_keys(${k}) VALUES (${k.map(() => '?')})`, ...Object.values(r));
};
t('bootstrap admin key amit', () => key('key_1', 'hsk_aaaaaaa1', '["admin"]', 'act_1'));
t('bootstrap admin key priya', () => key('key_2', 'hsk_aaaaaaa2', '["admin"]', 'act_2'));
t('second key without grant refused', () => key('key_3', 'hsk_aaaaaaa3', '["admin"]', 'act_1'), 'admin_grant');
t('admin key > 90 days refused', () => key('key_4', 'hsk_aaaaaaa4', '["admin"]', 'act_1', { expires_at: '2027-06-01T00:00:00Z' }), true);
t('admin combined with read refused', () => key('key_5', 'hsk_aaaaaaa5', '["read","admin"]', 'act_1'), true);
t('client key', () => key('key_6', 'hsk_aaaaaaa6', '["read","classify"]', null));
t('client key with actor refused', () => key('key_7', 'hsk_aaaaaaa7', '["read"]', 'act_1'), true);
t('pepper_id default', () => ok('pepper_id default value', db.prepare(`SELECT pepper_id FROM api_keys WHERE id='key_6'`).get().pepper_id === 'default'));
t('pepper_id immutable', () => run(`UPDATE api_keys SET pepper_id='p2' WHERE id='key_6'`), 'pepper_id is immutable');
t('revoke once', () => run(`UPDATE api_keys SET revoked_at=? WHERE id='key_6'`, now));
t('un-revoke refused', () => run(`UPDATE api_keys SET revoked_at=NULL WHERE id='key_6'`), 'revoked_at');
t('api key delete refused', () => run(`DELETE FROM api_keys WHERE id='key_1'`), 'revoke instead');

// ---- proposals
const prop = (id, action, extra = {}) => {
  const r = { id, action, rationale: 'rationale text', content_sha256: H('d'), proposed_by: 'amit', proposed_by_actor_id: 'act_1', proposed_key_id: 'key_1', proposed_at: now, ...extra };
  const k = Object.keys(r); run(`INSERT INTO rate_proposals(${k}) VALUES (${k.map(() => '?')})`, ...Object.values(r));
};
const approve = (id, by = 'act_2', key = 'key_2', extra = '') => run(`UPDATE rate_proposals SET status='approved', decided_by='priya', decided_by_actor_id=?, decided_key_id=?, decided_at=? ${extra} WHERE id=?`, by, key, now, id);
t('self-approval refused (CHECK)', () => { prop('rp_s', 'refdata_change', { payload_json: '{"table":"synonym","op":"add"}' }); approve('rp_s', 'act_1', 'key_1'); }, true);
t('terminal proposal immutable', () => { approve('rp_s'); run(`UPDATE rate_proposals SET status='rejected' WHERE id='rp_s'`); }, 'decisions are final');
t('proposal delete refused', () => run(`DELETE FROM rate_proposals WHERE id='rp_s'`), 'delete not allowed');
t('create needs rule_json', () => prop('rp_c', 'create'), true);
t('proposal born decided refused (v5)', () => prop('rp_bd', 'refdata_change', { payload_json: '{"table":"synonym","op":"add"}', status: 'approved' }), true);
t('proposal with another actor key refused (v5)', () => prop('rp_ok', 'refdata_change', { payload_json: '{"table":"synonym","op":"add"}', proposed_key_id: 'key_2' }), 'own active admin key');
t('extra key for another actor refused (v5, not_self)', () => prop('rp_g', 'admin_grant', { payload_json: '{"handle":"priya","new_actor":false}' }), 'own active admin key');
t('grant for own extra key', () => { prop('rp_g2', 'admin_grant', { payload_json: '{"handle":"amit","new_actor":false}' }); approve('rp_g2'); });
t('grant key within 72 h', () => key('key_8', 'hsk_aaaaaaa8', '["admin"]', 'act_1', { admin_grant_id: 'rp_g2', created_at: '2026-10-12T00:00:00Z' }));
t('grant key after 72 h refused (v5)', () => { prop('rp_g3', 'admin_grant', { payload_json: '{"handle":"amit","new_actor":false}' }); approve('rp_g3'); key('key_9', 'hsk_aaaaaaa9', '["admin"]', 'act_1', { admin_grant_id: 'rp_g3', created_at: '2026-10-13T01:00:00Z' }); }, '72 h');

// ---- add_code (migration 3)
t('add_code proposal approved', () => { prop('rp_a', 'refdata_change', { payload_json: '{"table":"hsn_code","op":"add_code","code":"71131920","parent":"7113","type":"goods","description":"Gold jewellery","keywords":""}' }); approve('rp_a', 'act_2', 'key_2', ", resulting_version='2026.10.01-1'"); });
t('add_code: other description than the proposal refused (v5 bind)', () => run(`INSERT INTO hsn_codes(code,level,parent,chapter,type,description,added_in_version,added_by_proposal) VALUES ('71131920',8,'7113','71','goods','Silver jewellery','2026.10.01-1','rp_a')`), 'add_code');
t('add_code: wrong code refused', () => run(`INSERT INTO hsn_codes(code,level,parent,chapter,type,description,added_in_version,added_by_proposal) VALUES ('71131910',8,'7113','71','goods','x','2026.10.01-1','rp_a')`), 'add_code');
t('add_code: named code accepted', () => run(`INSERT INTO hsn_codes(code,level,parent,chapter,type,description,added_in_version,added_by_proposal) VALUES ('71131920',8,'7113','71','goods','Gold jewellery','2026.10.01-1','rp_a')`));
t('add_code: FTS sees the new code', () => ok('fts match', db.prepare(`SELECT code FROM hsn_fts WHERE hsn_fts MATCH 'jewellery'`).all().some((r) => r.code === '71131920')));
t('added_by_proposal immutable', () => run(`UPDATE hsn_codes SET added_by_proposal=NULL, changed_by_proposal='rp_s' WHERE code='71131920'`), 'descriptions change only');

// ---- hsn description: in-place update with history
t('description update needs approved proposal', () => run(`UPDATE hsn_codes SET description='y' WHERE code='7113'`), 'descriptions change only');
t('description update with proposal', () => { prop('rp_d', 'refdata_change', { payload_json: '{"table":"hsn_description","op":"update","code":"7113","description":"Articles of jewellery, hair ornaments","keywords":""}' }); approve('rp_d'); run(`UPDATE hsn_codes SET description='Articles of jewellery, hair ornaments', changed_by_proposal='rp_d' WHERE code='7113'`); });
t('history row written', () => ok('history', db.prepare(`SELECT COUNT(*) n FROM hsn_code_history WHERE code='7113' AND replaced_by_proposal='rp_d' AND description='desc 7113'`).get().n === 1));
t('FTS reflects new description', () => ok('fts hair', db.prepare(`SELECT code FROM hsn_fts WHERE hsn_fts MATCH 'hair'`).all().some((r) => r.code === '7113')));
t('description other than the proposal refused (v5 bind)', () => { prop('rp_d2', 'refdata_change', { payload_json: '{"table":"hsn_description","op":"update","code":"7113","description":"approved text","keywords":""}' }); approve('rp_d2'); run(`UPDATE hsn_codes SET description='other text', changed_by_proposal='rp_d2' WHERE code='7113'`); }, 'descriptions change only');
t('same proposal reused refused', () => run(`UPDATE hsn_codes SET description='z', changed_by_proposal='rp_d' WHERE code='7113'`), 'descriptions change only');
t('history append-only', () => run(`DELETE FROM hsn_code_history`), 'append-only');

// ---- reference data deactivation
t('synonym deactivate without proposal refused', () => run(`UPDATE synonyms SET active=0, deactivated_by_proposal='rp_c0' WHERE id=1`), true);
t('synonym deactivate with a proposal for another row refused (v5)', () => run(`UPDATE synonyms SET active=0, deactivated_by_proposal='rp_s' WHERE id=1`), 'deactivation needs');
t('synonym deactivate with approved proposal', () => { prop('rp_sd', 'refdata_change', { payload_json: '{"table":"synonym","op":"deactivate","id":1}' }); approve('rp_sd'); run(`UPDATE synonyms SET active=0, deactivated_by_proposal='rp_sd' WHERE id=1`); });
t('synonym reactivate refused', () => run(`UPDATE synonyms SET active=1, deactivated_by_proposal=NULL WHERE id=1`), true);

// ---- append-only logs and dataset pointer
t('audit insert', () => run(`INSERT INTO audit_log(at,actor,key_prefix,action,entity_type,entity_id,details_json,prev_hash,hash) VALUES (?,'amit','hsk_aaaaaaa1','x','product','00000000000000','{}',?,?)`, now, '0'.repeat(64), H('e')));
t('audit update refused', () => run(`UPDATE audit_log SET actor='x'`), 'append-only');
t('audit delete refused', () => run(`DELETE FROM audit_log`), 'append-only');
t('feed insert', () => run(`INSERT INTO change_feed(dataset_version,published_at,change_type,hsn_prefix,affected_prefix,summary) VALUES ('2026.10.01-1',?,'hsn_added','71131920','71131920','added')`, now));
t('feed update refused', () => run(`UPDATE change_feed SET summary='x'`), 'append-only');
t('second version', () => run(`INSERT INTO dataset_versions VALUES ('2026.10.02-1','2026.10.01-1',?, 'priya','p',1,?,NULL)`, now, H('f')));
t('pointer to an unpublished version refused (v5)', () => run(`UPDATE dataset_state SET current_version='2026.10.02-1', last_change_seq=1`), 'approved proposal that published it');
// ---- migration 8 (ruling 36): the first verify may replace an index-page citation, nothing else may
const DOC = 'https://taxinformation.cbic.gov.in/view-pdf/1010437/ENG/Notifications';
t('citation change without a verify refused (v8)', () => run(`UPDATE rate_rules SET source_url=? WHERE rule_id='rr_cn'`, DOC), 'immutable');
t('notification change without a verify refused (v8)', () => run(`UPDATE rate_rules SET notification_ref='10/2025-CT(Rate)' WHERE rule_id='rr_cn'`), 'immutable');
t('verify proposal with url + notification approved', () => { prop('rp_vf', 'verify', { supersedes_rule_id: 'rr_cn', payload_json: JSON.stringify({ source: { pdf_sha256: H('e'), schedule_serial: 'S.No. 1', url: DOC, notification: '10/2025-CT(Rate)' } }) }); approve('rp_vf'); });
const verifyUpd = (url, ref) => run(`UPDATE rate_rules SET verification_status='verified', verified_by='priya', last_verified_at=?, source_pdf_sha256=?, schedule_serial='S.No. 1', citation_note=NULL, source_url=?, notification_ref=? WHERE rule_id='rr_cn'`, now, H('e'), url, ref);
t('verify with a URL other than the approved one refused (v8)', () => verifyUpd('https://taxinformation.cbic.gov.in/view-pdf/999/ENG/Notifications', '10/2025-CT(Rate)'), 'immutable');
t('verify with the approved URL and notification accepted (v8)', () => verifyUpd(DOC, '10/2025-CT(Rate)'));
t('citation change after the rule is verified refused (v8)', () => run(`UPDATE rate_rules SET source_url='https://taxinformation.cbic.gov.in/view-pdf/1/ENG/Notifications' WHERE rule_id='rr_cn'`), 'immutable');
t('pointer forward', () => { prop('rp_v', 'refdata_change', { payload_json: '{"table":"synonym","op":"add","phrase":"x","hsn_code":"7113"}' }); approve('rp_v', 'act_2', 'key_2', ", resulting_version='2026.10.02-1'"); run(`UPDATE dataset_state SET current_version='2026.10.02-1', last_change_seq=1`); });
t('pointer backward refused', () => run(`UPDATE dataset_state SET current_version='2026.10.01-1'`), 'only move forward');

// ---- watcher (migration 3)
const wn = (id, key, extra = {}) => {
  const r = { id, notification_ref: '1/2026-CT(Rate)', source_url: 'https://cbic-gst.gov.in/central-tax-rate.html', affected_prefixes: '[]', detected_at: now, created_by: 'system:cbic-watcher', source: 'cbic_watcher', notification_key: key, ...extra };
  const k = Object.keys(r); run(`INSERT INTO watched_notifications(${k}) VALUES (${k.map(() => '?')})`, ...Object.values(r));
};
t('watcher row', () => wn('wn_1', 'central_tax_rate:1/2026'));
t('duplicate notification_key refused', () => wn('wn_2', 'central_tax_rate:1/2026'), 'UNIQUE');
t('unknown source refused', () => wn('wn_3', 'central_tax_rate:2/2026', { source: 'rss' }), true);
t('first triage of a keyed row without confirmation refused (v7)', () => run(`UPDATE watched_notifications SET affected_prefixes='["7113"]', effective_from='2026-11-01' WHERE id='wn_1'`), 'second admin');
t('pending first triage stored (v7)', () => run(`UPDATE watched_notifications SET pending_action='{"kind":"triage","affected_prefixes":["7113"],"by":"priya"}' WHERE id='wn_1'`));
t('confirmed first triage while detected', () => run(`UPDATE watched_notifications SET affected_prefixes='["7113"]', effective_from='2026-11-01', pending_action=NULL WHERE id='wn_1'`));
t('later addition of prefixes is single-admin', () => run(`UPDATE watched_notifications SET affected_prefixes='["7113","7117"]' WHERE id='wn_1'`));
t('notification_key change refused', () => run(`UPDATE watched_notifications SET notification_key='x:1/2026' WHERE id='wn_1'`), 'only affected prefixes');
t('resolve without second-admin confirmation refused (v5)', () => run(`UPDATE watched_notifications SET state='dismissed', resolved_at=?, resolved_by='priya' WHERE id='wn_1'`, now), 'second admin');
t('prefix removal without confirmation refused (v5)', () => run(`UPDATE watched_notifications SET affected_prefixes='[]' WHERE id='wn_1'`), 'second admin');
t('pending dismiss stored', () => run(`UPDATE watched_notifications SET pending_action='{"kind":"dismissed","by":"priya"}' WHERE id='wn_1'`));
t('resolve', () => run(`UPDATE watched_notifications SET state='dismissed', resolved_at=?, resolved_by='amit' WHERE id='wn_1'`, now));
t('closed row frozen', () => run(`UPDATE watched_notifications SET affected_prefixes='["7113","7117","71"]' WHERE id='wn_1'`), 'only affected prefixes');
t('keyed manual row: resolve needs confirmation (v7)', () => { wn('wn_5', 'central_tax_rate:5/2026', { source: 'manual', created_by: 'amit' }); run(`UPDATE watched_notifications SET state='dismissed', resolved_at=?, resolved_by='amit' WHERE id='wn_5'`, now); }, 'second admin');
t('unkeyed manual row: single-admin resolve', () => { wn('wn_6', null, { source: 'manual', created_by: 'amit', affected_prefixes: '["7113"]' }); run(`UPDATE watched_notifications SET state='dismissed', resolved_at=?, resolved_by='amit' WHERE id='wn_6'`, now); });
t('resolved_at required with state', () => wn('wn_4', 'central_tax_rate:3/2026', { state: 'published' }), true);
t('watched delete refused', () => run(`DELETE FROM watched_notifications WHERE id='wn_1'`), 'delete not allowed');
t('watcher run ok', () => run(`INSERT INTO watcher_runs(source,started_at,finished_at,status,items_seen,items_new,error,details_json) VALUES ('cbic',?,?,'ok',38,1,NULL,'{}')`, now, now));
t('failed run needs error', () => run(`INSERT INTO watcher_runs(source,started_at,finished_at,status,items_seen,items_new,error,details_json) VALUES ('cbic',?,?,'failed',0,0,NULL,'{}')`, now, now), true);
t('watcher_runs update refused', () => run(`UPDATE watcher_runs SET items_new=2`), 'append-only');
t('watcher_runs delete refused', () => run(`DELETE FROM watcher_runs`), 'append-only');

// ---- products (migration 4)
t('products_fetched_at index', () => ok('index', !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='products_fetched_at'`).get()));
t('product source limited', () => run(`INSERT INTO products(gtin,source,found,fetched_at,expires_at) VALUES ('04006381333931','amazon',1,?,?)`, now, now), true);

const fk = db.prepare('PRAGMA foreign_key_check').all();
console.log(`${pass} passed, ${fail} failed`);
console.log(`foreign_key_check rows: ${fk.length}`);
process.exit(fail || fk.length ? 1 : 0);
