import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {verifyBundleSource} from '../tools/coverage-report.mjs';import {extractUiStringsAst} from '../tools/extract-ui-ast.mjs';
import {buildPricingFeed} from '../tools/sync-pricing-feed.mjs';import {CdpHudBridge} from '../dist/hud/hud-bridge.js';
test('F16: trusted snapshot detects deletion, relabeling, counts, duplicates and covered-text substitution',async()=>{
 const original=JSON.parse(await readFile(new URL('../ui-strings/2.24.0.json',import.meta.url)));
 const good=await verifyBundleSource(original,{noVendor:true});assert.equal(good.verified,true);assert.equal(good.byteVerified,false);assert.equal(good.actualSha256,undefined);
 for(const mutate of [v=>v.strings.pop(),v=>v.strings[0].kinds=['template'],v=>v.strings[0].count++,v=>v.strings.push(v.strings[0]),v=>v.strings[0].text='Cancel']){
  const altered=structuredClone(original);mutate(altered);assert.equal((await verifyBundleSource(altered,{noVendor:true})).verified,false);
 }
});
test('F16: AST extractor recognizes actual UI syntax, excludes comments and leaves user execution untouched',()=>{
 const source='// label:"A fake comment"\nconst x={label:"Save changes",description:`Delete ${count} items`};React.createElement("button",{},"Open panel");React.createElement();';
 const rows=extractUiStringsAst(source);assert.ok(rows.some(r=>r.text==='Save changes'));assert.ok(rows.some(r=>r.text==='Open panel'));assert.ok(rows.some(r=>r.kinds.includes('template')));assert.ok(!rows.some(r=>r.text.includes('fake comment')));
});
test('F06: the public feed is generated from the shipped catalog and identical validity intervals',async()=>{
 const catalog=JSON.parse(await readFile(new URL('../assets/model-catalog.json',import.meta.url)));const feed=JSON.parse(await readFile(new URL('../assets/pricing-feed.json',import.meta.url)));assert.deepEqual(buildPricingFeed(catalog),feed);
});
test('F11: old attach and detach events cannot replace or remove a newer physical slot',async()=>{
 const bridge=new CdpHudBridge({pollIntervalMs:0,engine:{getConversationMetrics:async options=>({...options}),clearCache(){}}});
 const event=(conversationId,sessionRevision,type='SESSION_ATTACHED')=>bridge.handleRawBindingPayload('target',JSON.stringify({type,conversationId,sessionRevision,paneSlotId:'slot'}));
 event('new',10);event('old',9);assert.equal(bridge.getActivePanes()[0].conversationId,'new');event('old',9,'SESSION_DETACHED');assert.equal(bridge.getActivePanes().length,1);event('new',10,'SESSION_DETACHED');assert.equal(bridge.getActivePanes().length,0);bridge.dispose();
});
test('P0-Batch1: 单账号下钻时请求明细保持严格时间倒序且 HUD 增量追加与上下文压缩结果精确一致',async t=>{
 const {mkdtemp,mkdir,rm,utimes}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');
 const {UsageStatsManager}=await import('../dist/usage.js');
 const {ProtobufWriter:W}=await import('../dist/protobuf.js');
 const {ConversationMetricsEngine}=await import('../dist/hud.js');
 const dir=await mkdtemp(join(tmpdir(),'gb-p0-batch1-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));

 // 1) 验证按具体账号筛选 getUsageSummary 后，getUsageEvents 依然严格按时间戳倒序返回
 const convDir=join(dir,'antigravity','conversations');
 await mkdir(convDir,{recursive:true});
 const nowSec=Math.floor(Date.now()/1000);
 const makeUsageGen=(model,input,tsSec)=>W.encodeLengthDelimited(1,Buffer.concat([
  W.encodeString(19,model),
  W.encodeLengthDelimited(4,Buffer.concat([W.encodeVarintField(2,input),W.encodeVarintField(3,10)])),
  W.encodeLengthDelimited(9,W.encodeLengthDelimited(4,W.encodeVarintField(1,tsSec))),
 ]));
 const dbOlder=join(convDir,'older.db'),dbNewer=join(convDir,'newer.db');
 for(const [p,ts,inp] of [[dbOlder,nowSec-300,100],[dbNewer,nowSec-60,200]]){
  const db=new DatabaseSync(p);
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
  db.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(makeUsageGen('gemini-3.8-flash',inp,ts));
  db.close();
 }
 // 故意让较旧事件的数据库拥有更新的文件 mtime，模拟扫描发现顺序与真实事件时间相反
 const futureDate=new Date(Date.now()+5000);
 await utimes(dbOlder,futureDate,futureDate);

 const usageMgr=new UsageStatsManager({geminiDir:dir,stateDir:dir});
 usageMgr.setKnownAccounts([{id:'acc-1',email:'one@example.com',name:'One'}]);
 // 将观察起点设为事件之前，使两条事件均归属到 acc-1
 usageMgr.setCurrentAccountContext({id:'acc-1',email:'one@example.com'});
 (usageMgr).accountContextObservedAtSec=nowSec-600;

 const filteredSummary=await usageMgr.getUsageSummary(true,'acc-1');
 const page=await usageMgr.getUsageEvents('today','',0,20,filteredSummary.snapshot_id,false,false,'acc-1');
 assert.equal(page.rows.length,2);
 assert.ok(page.rows[0].timestamp_seconds>page.rows[1].timestamp_seconds,'单账号筛选快照下的请求明细必须按时间戳倒序排列');

 // 2) 验证 HUD SQLite 增量前缀复用、gen_metadata 增量推进及压缩状态变更自动回退全扫
 const hudDbPath=join(convDir,'hud-inc.db');
 const hudDb=new DatabaseSync(hudDbPath);
 hudDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
 const stepBlob=(s,e,inp,out)=>Buffer.concat([
  W.encodeLengthDelimited(1,W.encodeVarintField(1,s)),
  W.encodeLengthDelimited(7,W.encodeVarintField(1,e)),
  W.encodeLengthDelimited(9,Buffer.concat([W.encodeVarintField(2,inp),W.encodeVarintField(3,out)])),
  W.encodeString(12,'exec-1'),
 ]);
 const genBlob=(stepIdx,inp,out,ttftSec,streamSec)=>Buffer.concat([
  W.encodeLengthDelimited(1,Buffer.concat([
   W.encodeLengthDelimited(4,Buffer.concat([W.encodeVarintField(2,inp),W.encodeVarintField(3,out)])),
   W.encodeLengthDelimited(11,W.encodeVarintField(1,ttftSec)),
   W.encodeLengthDelimited(12,W.encodeVarintField(1,streamSec)),
   W.encodeString(19,'gemini-3.8-flash'),
  ])),
  W.encodeVarintField(2,stepIdx),
  W.encodeString(4,'exec-1'),
 ]);
 for(let i=0;i<6;i++){
  hudDb.prepare('INSERT INTO steps VALUES(?,15,3,?)').run(i,stepBlob(100+i*10,105+i*10,100,50));
  hudDb.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(i,genBlob(i,100,50,1,3));
 }
 const hudEngine=new ConversationMetricsEngine({conversationsDir:convDir});
 const mInitial=await hudEngine.getConversationMetrics({conversationId:'hud-inc'});
 assert.equal(mInitial.tokens.totalTokens,6*150);
 assert.equal(mInitial.session.modelDurationSeconds,6*4);

 // 追加第 6、7 步（命中增量前缀复用路径）
 for(let i=6;i<8;i++){
  hudDb.prepare('INSERT INTO steps VALUES(?,15,3,?)').run(i,stepBlob(100+i*10,105+i*10,200,80));
  hudDb.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(i,genBlob(i,200,80,1,4));
 }
 const mAppended=await hudEngine.getConversationMetrics({conversationId:'hud-inc'});
 assert.equal(mAppended.tokens.totalTokens,6*150+2*280);
 assert.equal(mAppended.session.modelDurationSeconds,6*4+2*5);

 // 模拟前缀步骤发生上下文压缩归档 (status: 3 -> 5) 并插入 CHECKPOINT 步 (step_type=23)
 hudDb.prepare('UPDATE steps SET status=5 WHERE idx<4').run();
 hudDb.prepare('INSERT INTO steps VALUES(8,23,3,NULL)').run();
 const mCompacted=await hudEngine.getConversationMetrics({conversationId:'hud-inc'});
 assert.equal(mCompacted.session.compactionCount,1);
 assert.equal(mCompacted.tokens.totalTokens,6*150+2*280);
 hudDb.close();
});
test('P1-Batch2: 归档容量裁剪、只读 StateDb、四档套餐权重与基础词典完整性验证',async t=>{
 const {mkdtemp,rm,readdir}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');
 const {AccountsManager}=await import('../dist/accounts.js');
 const {readAntigravityStateDb}=await import('../dist/account-probe.js');
 const {UsageLedger}=await import('../dist/usage-ledger.js');
 const {stripModelProviderPrefix}=await import('../dist/model-identity.js');
 const {formatTurnDurationCompact}=await import('../dist/metric-format.js');
 const dir=await mkdtemp(join(tmpdir(),'gb-p1-batch2-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));

 // 1) accounts-removed 最多保留最近 10 份快照
 const mgr=new AccountsManager(dir);
 for(let i=0;i<13;i++){
  const acc=await mgr.upsertAccount({email:`u${i}@example.invalid`,refreshToken:`rt-${i}`});
  await mgr.deleteAccount(acc.id);
 }
 const removedFiles=(await readdir(join(dir,'accounts-removed'))).filter(f=>f.endsWith('.json'));
 assert.ok(removedFiles.length<=10,`accounts-removed 应裁剪至 <=10 份，实际 ${removedFiles.length}`);

 // 2) 四档套餐等级权重：ULTRA > PRO > 待确认 > FREE（真实 PRO 严格优先于等级未确认账号）
 const makeQuota=(rem,tier)=>({...mgr.fuseQuota(
  {models:{'gemini-3.8-flash':{quotaInfo:{remainingFraction:rem}}}},
  {groups:[{displayName:'Gemini Models',buckets:[{window:'5h',remainingFraction:rem}]}]}
 ),subscription_tier:tier});
 const accPro=await mgr.upsertAccount({email:'pro@example.invalid',refreshToken:'rt-pro',accessToken:'at-pro',expiresIn:3600});
 const accUnknown=await mgr.upsertAccount({email:'unk@example.invalid',refreshToken:'rt-unk',accessToken:'at-unk',expiresIn:3600});
 const accCur=await mgr.upsertAccount({email:'cur@example.invalid',refreshToken:'rt-cur',accessToken:'at-cur',expiresIn:3600});
 accPro.quota=makeQuota(0.8,'PRO');
 accUnknown.quota=makeQuota(0.95,'');
 accCur.quota=makeQuota(0.05,'PRO');
 await mgr.saveAccount(accPro);await mgr.saveAccount(accUnknown);await mgr.saveAccount(accCur);
 const rec=await mgr.selectBestAccount(
  {enabled:true,strategy:'priority',reserve_percentage:20,candidate_min_percentage:30,monitored_model:'gemini',candidate_account_ids:[accUnknown.id,accPro.id]},
  {currentId:accCur.id,currentEmail:accCur.email,currentQuota:accCur.quota}
 );
 assert.equal(rec.bestCandidate?.id,accPro.id,'真实 PRO 账号优先级必须高于等级未确认账号');

 // 3) ledger-reviews 未应用的预览自动裁剪上限 (<=5)，且池化 UsageLedger Worker 连续请求稳定
 const ledger=new UsageLedger(dir);
 const nowTs=Math.floor(Date.now()/1000);
 await ledger.save([
  {event_key:'ev-1',source_id:'s1',model:'gemini-3.8-flash',input_tokens:100,output_tokens:50,cached_tokens:0,total_tokens:150,timestamp_seconds:nowTs},
  {event_key:'ev-placeholder',source_id:'s2',model:'MODEL_PLACEHOLDER_M669',input_tokens:1000000,output_tokens:0,cached_tokens:0,total_tokens:1000000,timestamp_seconds:nowTs},
 ]);
 let placeholderPreview;
 for(let i=0;i<7;i++){
  placeholderPreview=await ledger.revalue({action:'preview',prices:{'gemini-3.8-flash':{input:0.5,output:1.5,cached:0.05}},accounts:[]});
 }
 assert.equal(placeholderPreview.unverifiableCount,0,'MODEL_PLACEHOLDER_M669 应在 revalueLedger 中归一化至 gemini-3.8-flash');
 assert.ok(placeholderPreview.after>=0.5,'占位符事件重估金额应命中定价');
 const reviewReceipts=(await readdir(join(dir,'ledger-reviews'))).filter(f=>/^[0-9a-f-]{36}\.json$/i.test(f));
 assert.ok(reviewReceipts.length<=5,`ledger-reviews 未应用预览应裁剪至 <=5 份，实际 ${reviewReceipts.length}`);

 // 4) Worker 隔离只读 readAntigravityStateDb 与公共格式化工具核验
 const vscdbPath=join(dir,'state.vscdb');
 const vdb=new DatabaseSync(vscdbPath);
 vdb.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT);');
 vdb.prepare('INSERT INTO ItemTable VALUES(?,?)').run('antigravityAuthStatus','{"email":"test@example.com"}');
 vdb.close();
 const stateMap=await readAntigravityStateDb(vscdbPath,['antigravityAuthStatus']);
 assert.equal(stateMap.get('antigravityAuthStatus'),'{"email":"test@example.com"}');
 assert.equal(stripModelProviderPrefix('publishers/google/models/gemini-4-carbon:generateContent'),'gemini-4-carbon');
 assert.equal(formatTurnDurationCompact(125,'zh'),'本轮 2m');

 // 5) 基础词典修复核验
 const baseDict=JSON.parse(await readFile(new URL('../dict/base.json',import.meta.url),'utf8'));
 assert.equal(baseDict['Browser Subagent'],'浏览器子智能体');
 assert.equal(baseDict['The browser subagent can be invoked by typing /browser'],'您可以通过在对话框中输入 /browser 来调用浏览器子智能体');
});
test('P2-Batch3: Protobuf 超长损毁 varint 安全保护、JSX 运行时 AST 提取与全版本零 caseOnly 校验',async()=>{
 const {ProtobufReader}=await import('../dist/protobuf.js');
 const {generateDeviceProfile}=await import('../dist/accounts.js');
 const {reconcile}=await import('../tools/coverage-report.mjs');
 const {readdir}=await import('node:fs/promises');

 // 1) 超过 10 字节的恶意未终止 varint 返回 null 而不越界或精度溢出
 const malformedVarint=Buffer.alloc(14,0x81);
 assert.equal(ProtobufReader.readVarint(malformedVarint,0),null);
 // 标准 10 字节负一 (-1 int64: ff * 9 + 01) 安全解析为 -1
 const minusOne=Buffer.from([0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x01]);
 assert.deepEqual(ProtobufReader.readVarint(minusOne,0),[-1,10]);

 // 2) 加密随机数生成的设备指纹格式严格为 64 位小写 hex
 const devProfile=generateDeviceProfile();
 assert.match(devProfile.machine_id,/^[0-9a-f]{64}$/);
 assert.match(devProfile.mac_machine_id,/^[0-9a-f]{64}$/);

 // 3) includeJsxRuntime 可提取 React 18/19 jsx/jsxs 自动运行时、三元分支与数组子节点，默认模式保持原快照稳定
 const jsxSample='(0,r.jsx)("button",{children:saving?"Saving changes":"Save changes"});(0,r.jsxs)("h2",{children:["Account settings"]});';
 assert.equal(extractUiStringsAst(jsxSample).length,0,'默认 v1 模式不改变历史冻结快照边界');
 const jsxExtracted=extractUiStringsAst(jsxSample,{includeJsxRuntime:true}).map(r=>r.text);
 assert.ok(jsxExtracted.includes('Saving changes'));
 assert.ok(jsxExtracted.includes('Save changes'));
 assert.ok(jsxExtracted.includes('Account settings'));

 // 4) 全部 12 个受支持版本的 ui-strings 精确大小写命中（caseOnly === 0）
 const baseDict=JSON.parse(await readFile(new URL('../dict/base.json',import.meta.url),'utf8'));
 const entryMap=new Map(Object.entries(baseDict).map(([k,v])=>[k,{value:v,source:'dict/base.json'}]));
 for(const file of (await readdir(new URL('../ui-strings/',import.meta.url))).filter(f=>f.endsWith('.json'))){
  const snap=JSON.parse(await readFile(new URL(`../ui-strings/${file}`,import.meta.url),'utf8'));
  const rep=reconcile(snap,entryMap);
  assert.equal(rep.caseOnly.length,0,`${file} 不应存在大小写不一致的兜底词条`);
  assert.equal(rep.missing.length,0,`${file} 不应存在漏译词条`);
 }
});

test('Release-Audit-P0: 费率重估同步 JSON 锁、HUD 编排器模型消歧、移除账号凭据脱敏与 AST v2 对账',async t=>{
 const {mkdtemp,mkdir,rm,readdir}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');
 const {UsageStatsManager}=await import('../dist/usage.js');
 const {AccountsManager}=await import('../dist/accounts.js');
 const {ProtobufWriter:W}=await import('../dist/protobuf.js');
 const {buildConversationHudMetrics,parseLatestGenMetadataBlob,resolveModelCapacity}=await import('../dist/hud.js');
 const {reconcileExtraction}=await import('../tools/coverage-report.mjs');
 const dir=await mkdtemp(join(tmpdir(),'gb-release-p0-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));

 // 1) revalueHistory('apply' / 'restore') 同步更新 usage-rate-locks.json，杜绝被移除费率锁在重启后复活
 const convDir=join(dir,'antigravity','conversations');
 await mkdir(convDir,{recursive:true});
 const nowSec=Math.floor(Date.now()/1000)-30;
 const revDb=new DatabaseSync(join(convDir,'revalue-sync.db'));
 revDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
 const mkUsageGen=(model,cacheWrite=0)=>W.encodeLengthDelimited(1,Buffer.concat([
  W.encodeString(19,model),
  W.encodeLengthDelimited(4,Buffer.concat([W.encodeVarintField(2,1000000),W.encodeVarintField(3,0),...(cacheWrite?[W.encodeVarintField(4,cacheWrite)]:[])])),
  W.encodeLengthDelimited(9,W.encodeLengthDelimited(4,W.encodeVarintField(1,nowSec))),
 ]));
 revDb.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(mkUsageGen('model-keep'));
 revDb.prepare('INSERT INTO gen_metadata VALUES(1,?)').run(mkUsageGen('model-drop',1000000));
 revDb.close();

 const usageMgr=new UsageStatsManager({geminiDir:dir,stateDir:dir});
 await usageMgr.savePricingTable({
  'model-keep':{model:'model-keep',input:1,output:1,cached:0},
  'model-drop':{model:'model-drop',input:1,output:1,cached:0,cacheWrite:1},
 });
 assert.equal((await usageMgr.getUsageSummary(true)).all_time.estimated_usd,3);
 const beforeJson=await readFile(join(dir,'usage-rate-locks.json'),'utf8');
 assert.equal(Object.keys(JSON.parse(beforeJson).entries).length,2);

 // 更新价格表：model-keep 涨至 $5，model-drop 移除未核实的 cacheWrite 费率（重估后该事件转为未计价，删除原锁）
 await usageMgr.savePricingTable({
  'model-keep':{model:'model-keep',input:5,output:1,cached:0},
  'model-drop':{model:'model-drop',input:1,output:1,cached:0},
 });
 const preview1=await usageMgr.previewRevalueHistory();
 assert.equal(preview1.before,3);
 assert.equal(preview1.after,5);
 await usageMgr.revalueHistory(true,{previewId:preview1.previewId});
 const appliedJson=JSON.parse(await readFile(join(dir,'usage-rate-locks.json'),'utf8'));
 assert.equal(Object.keys(appliedJson.entries).length,1,'变成未计价的费率锁必须从磁盘 usage-rate-locks.json 同步移除');

 // 重启新实例后验证已删除的 model-drop 费率锁不会从磁盘 JSON 复活，且支持连续二次预览
 const restartedMgr=new UsageStatsManager({geminiDir:dir,stateDir:dir});
 assert.equal((await restartedMgr.getUsageSummary(true)).all_time.estimated_usd,5);
 const preview2=await restartedMgr.previewRevalueHistory();
 assert.equal(preview2.before,5);

 // 回退第一次重估后，磁盘 JSON 与总金额均精确恢复为原值 $3（2 条锁）
 await restartedMgr.restoreRevalueHistory(preview1.previewId,true);
 assert.equal((await new UsageStatsManager({geminiDir:dir,stateDir:dir}).getUsageSummary(true)).all_time.estimated_usd,3);
 assert.equal(Object.keys(JSON.parse(await readFile(join(dir,'usage-rate-locks.json'),'utf8')).entries).length,2);

 // 2) HUD Orchestrator (Carbon / Hydrogen / Argon) 容量解析与按步 API 计费消歧
 assert.equal(resolveModelCapacity('Orchestrator (Carbon)').modelId,'gemini-4-carbon');
 assert.equal(resolveModelCapacity('Orchestrator (Carbon)').isFallback,false);
 assert.equal(resolveModelCapacity('Orchestrator (Hydrogen)').modelId,'gemini-4-hydrogen');
 assert.equal(resolveModelCapacity('Orchestrator (Hydrogen)').isFallback,false);
 assert.equal(resolveModelCapacity('gemini-flash-worker-agy').modelId,'gemini-3.8-flash');

 const carbonEnumGen=parseLatestGenMetadataBlob(W.encodeLengthDelimited(1,Buffer.concat([
  W.encodeVarintField(3,1667),
  W.encodeString(19,'gemini-pro-orchestrator-g1-pro'),
 ])));
 assert.equal(carbonEnumGen.modelEnum,1667);

 const novTs=Math.floor(Date.parse('2026-11-14T12:00:00Z')/1000);
 const hudHydrogen=buildConversationHudMetrics({
  conversationId:'orch-hydrogen',
  steps:[{
   idx:0,stepType:15,status:3,hasUsage:true,startTimeSeconds:novTs,endTimeSeconds:novTs+2,
   rawInputTokens:1_000_000,outputTokens:0,cachedReadTokens:0,cacheWriteTokens:0,reasoningTokens:0,candidateTokens:0,
   generation:{responseModel:'gemini-pro-orchestrator-g1-pro',modelDisplayName:'Orchestrator (Hydrogen)'},
  }],
 });
 assert.equal(hudHydrogen.context.modelId,'gemini-4-hydrogen');
 assert.equal(hudHydrogen.context.modelDisplayName,'Orchestrator (Hydrogen)');
 assert.equal(hudHydrogen.context.capacitySource,'reference');
 assert.equal(hudHydrogen.tokens.estimatedCostUsd,1.5,'Orchestrator (Hydrogen) 应按 Hydrogen $1.5/1M 计费而非 Argon $2.0/1M');

 // 3) deleteAccount 写入 accounts-removed 快照时必须脱敏 OAuth 令牌
 const accMgr=new AccountsManager(dir);
 const victim=await accMgr.upsertAccount({email:'sec@example.invalid',refreshToken:'1//secret-rt',accessToken:'ya29.secret-at',idToken:'eyJ.secret-id'});
 await accMgr.deleteAccount(victim.id);
 const removedSnapFiles=(await readdir(join(dir,'accounts-removed'))).filter(f=>f.startsWith(victim.id));
 const removedSnap=JSON.parse(await readFile(join(dir,'accounts-removed',removedSnapFiles[0]),'utf8'));
 assert.equal(removedSnap.account.token.redacted,true);
 assert.equal(JSON.stringify(removedSnap).includes('secret-rt'),false);
 assert.equal(JSON.stringify(removedSnap).includes('secret-at'),false);
 assert.equal(JSON.stringify(removedSnap).includes('secret-id'),false);

 // 4) typescript-ast-v2 对账与 2.32.1 新增 JSX 词条核验
 const jsxSource='(0,r.jsx)("h2",{children:"Agent working"});';
 const v2Rows=extractUiStringsAst(jsxSource,{includeJsxRuntime:true});
 assert.equal(reconcileExtraction({extractor:'typescript-ast-v2',strings:v2Rows},jsxSource).ok,true);
 const snap2321=JSON.parse(await readFile(new URL('../ui-strings/2.32.1.json',import.meta.url),'utf8'));
 assert.equal(snap2321.extractor,'typescript-ast-v2');
 const dict=JSON.parse(await readFile(new URL('../dict/base.json',import.meta.url),'utf8'));
 assert.equal(dict['Agent working'],'智能体工作中');
 assert.equal(dict['Sort and filter conversations'],'排序和筛选对话');
 assert.equal(dict['Live chat'],'实时对话');
});

test('Release-Audit-P1: 大账本模型归一化搜索、starter 套餐映射、OAuth 未配置提示、日志脱敏与价格源白名单',async t=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');
 const {UsageStatsManager}=await import('../dist/usage.js');
 const {UsageLedger}=await import('../dist/usage-ledger.js');
 const {AccountsManager}=await import('../dist/accounts.js');
 const {buildAccountQuotaOverview}=await import('../dist/account-quota.js');
 const {normalizeSubscriptionTier}=await import('../dist/ipc-projections.js');
 const {DEFAULT_API_PRICES,priceStatus}=await import('../dist/pricing.js');
 const {assertAllowedPricingFeedUrl}=await import('../dist/usage-pricing.js');
 const {Tasks}=await import('../dist/tasks.js');
 const {CacheMaintenance}=await import('../dist/maintenance.js');
 const {ProtobufWriter:W}=await import('../dist/protobuf.js');
 const dir=await mkdtemp(join(tmpdir(),'gb-release-p1-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));

 // 1) 大账本 ledgerEventPage 支持按归一化模型名检索历史占位符并返回归一化名称
 const ledger=new UsageLedger(dir);
 const nowSec=Math.floor(Date.now()/1000)-20;
 await ledger.save([
  {event_key:'p1-m668',source_id:'s1',model:'MODEL_PLACEHOLDER_M668',input_tokens:100,output_tokens:20,cached_tokens:0,total_tokens:120,timestamp_seconds:nowSec},
  {event_key:'p1-worker',source_id:'s2',model:'gemini-flash-worker-agy',input_tokens:50,output_tokens:10,cached_tokens:0,total_tokens:60,timestamp_seconds:nowSec+1},
 ]);
 const agg=await ledger.aggregate({prices:DEFAULT_API_PRICES,accountId:'all',accounts:[],snapshotId:'snap-p1'});
 const argonPage=await ledger.events({snapshot:agg.ledger_snapshot,period:'all',query:'gemini-4-argon',offset:0,limit:10});
 assert.equal(argonPage.total,1);
 assert.equal(argonPage.rows[0].model,'gemini-4-argon');
 const flashPage=await ledger.events({snapshot:agg.ledger_snapshot,period:'all',query:'3.8-flash',offset:0,limit:10});
 assert.equal(flashPage.total,1);
 assert.equal(flashPage.rows[0].model,'gemini-3.8-flash');

 // 2) Carbon 模型配额在未显式标记 is_carbon 的旧快照上自动对齐 family === 'carbon'，且新套餐枚举精确归一化
 const carbonOverview=buildAccountQuotaOverview({quota:{models:[{name:'gemini-4-carbon',percentage:80,reset_time:''}],quota_groups:[],is_forbidden:false,subscription_tier:'PRO',last_updated:nowSec,model_forwarding_rules:{}}});
 assert.equal(carbonOverview.models[0].is_carbon,true);
 assert.equal(normalizeSubscriptionTier('starter'),'FREE');
 assert.equal(normalizeSubscriptionTier('Google One AI Plus'),'PLUS');
 assert.equal(normalizeSubscriptionTier('Workspace Team'),'TEAM');
 assert.equal(normalizeSubscriptionTier('Cloud Enterprise'),'ENTERPRISE');
 assert.equal(normalizeSubscriptionTier('unknown-plan'),'待确认');

 // 3) 小账本单账号快照在 getUsageEvents 中继承账号范围并拒绝越权混读；gemini-4-carbon-trial 优惠期边界受 priceStatus 识别
 const convDir=join(dir,'antigravity','conversations');
 await mkdir(convDir,{recursive:true});
 const uDb=new DatabaseSync(join(convDir,'p1-scope.db'));
 uDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
 uDb.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(W.encodeLengthDelimited(1,Buffer.concat([
  W.encodeString(19,'gemini-3.8-flash'),
  W.encodeLengthDelimited(4,Buffer.concat([W.encodeVarintField(2,100),W.encodeVarintField(3,20)])),
  W.encodeLengthDelimited(9,W.encodeLengthDelimited(4,W.encodeVarintField(1,nowSec))),
 ])));
 uDb.close();
 const uMgr=new UsageStatsManager({geminiDir:dir,stateDir:join(dir,'small-state')});
 uMgr.setKnownAccounts([{id:'acc-a',email:'a@example.invalid'},{id:'acc-b',email:'b@example.invalid'}]);
 uMgr.setCurrentAccountContext({id:'acc-a',email:'a@example.invalid'});
 uMgr.accountContextObservedAtSec=nowSec-100;
 const sumB=await uMgr.getUsageSummary(true,'acc-b');
 assert.equal((await uMgr.getUsageEvents('all','',0,10,sumB.snapshot_id)).total,0,'省略 accountId 时应继承单账号快照范围');
 await assert.rejects(uMgr.getUsageEvents('all','',0,10,sumB.snapshot_id,false,false,'acc-a'),/范围不匹配/);
 assert.equal(priceStatus(DEFAULT_API_PRICES['gemini-4-carbon-trial'],Date.parse('2027-01-01T00:00:00Z')),'expired');

 // 4) 未配置可选 Google OAuth 环境变量时给出明确提示而非误报凭据失效
 const prevCid=process.env.GRAVITYBOX_GOOGLE_CLIENT_ID,prevSec=process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
 delete process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;delete process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
 try{
  const accMgr=new AccountsManager(join(dir,'oauth-state'));
  await assert.rejects(accMgr.addAccountWithRefreshToken('1//valid-token'),/未配置 Google OAuth 凭据/);
 }finally{
  if(prevCid!==undefined)process.env.GRAVITYBOX_GOOGLE_CLIENT_ID=prevCid;
  if(prevSec!==undefined)process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET=prevSec;
 }

 // 5) Tasks 后台异常脱敏与远程价格源 URL 安全白名单校验
 const tasks=new Tasks(join(dir,'tasks-state'),()=>{});
 tasks.begin('test-redact','脱敏测试',async()=>{throw new Error('上游返回异常 token=ya29.superSecretAccessToken123456');});
 await tasks.stop();
 assert.equal(tasks.list()[0].message.includes('ya29.'),false,'后台任务错误消息必须脱敏');
 assert.match(assertAllowedPricingFeedUrl('https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json'),/^https:/);
 assert.equal(assertAllowedPricingFeedUrl('http://127.0.0.1:8080/feed.json'),'http://127.0.0.1:8080/feed.json');
 assert.throws(()=>assertAllowedPricingFeedUrl('file:///etc/passwd'),/仅允许 HTTPS/);
 assert.throws(()=>assertAllowedPricingFeedUrl('http://example.com/feed.json'),/仅允许 HTTPS/);

 // 6) Maintenance 受保护对话统计前置排除浏览器缓存目录，保留精确对话与 Cookies 体积
 const maintProfile=join(dir,'maint-profile'),maintTrash=join(dir,'maint-trash');
 const bpDefault=join(dir,'antigravity','browser_profile','Default');
 await mkdir(join(bpDefault,'Cache'),{recursive:true});
 await mkdir(maintProfile,{recursive:true});await mkdir(maintTrash,{recursive:true});
 await writeFile(join(bpDefault,'Cache','big.bin'),Buffer.alloc(4096,1));
 await writeFile(join(bpDefault,'Cookies'),'protected-cookie-bytes');
 const maint=new CacheMaintenance(maintProfile,maintTrash,async()=>false,{geminiDir:dir});
 const scan=await maint.scan();
 const convProtected=scan.protectedEntries.find(e=>e.id==='conversations');
 assert.ok(convProtected && convProtected.bytes>=22,'受保护对话与站点 Cookies 体积不得被浏览器缓存抵扣归零');
});

test('Release-1.1.1-Final-Audit: P0→P1→P2 全量审计修复项端到端回归核验',async t=>{
 const {mkdtemp,mkdir,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');
 const {UsageStatsManager,resolveDatabaseModelFullName}=await import('../dist/usage.js');
 const {AccountsManager}=await import('../dist/accounts.js');
 const {classifyFamily,normalizeLiveModels}=await import('../dist/quota.js');
 const {DEFAULT_API_PRICES,calculateEstimatedUsd,matchPricingKeys,resolvePricingForTimestamp}=await import('../dist/pricing.js');
 const {registerRemoteModelMetadata,FEED_MODEL_KEYS}=await import('../dist/model-catalog.js');
 const {ProtobufWriter:W}=await import('../dist/protobuf.js');
 const {ConversationMetricsEngine,buildConversationHudMetrics,resolveModelCapacity}=await import('../dist/hud.js');
 const dir=await mkdtemp(join(tmpdir(),'gb-final-audit-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));

 // 1) P1-1 & P1-3: 公开价格源覆盖 18 款活跃商业模型、远端动态别名/容量注册与长上下文阶梯计费
 assert.ok(FEED_MODEL_KEYS.length>=18,'公开价格源应覆盖全部主流活跃商业模型');
 assert.equal(resolvePricingForTimestamp(DEFAULT_API_PRICES['gemini-4-carbon-trial'],Math.floor(Date.parse('2026-11-30T23:59:59Z')/1000))?.input,2);
 assert.equal(resolvePricingForTimestamp(DEFAULT_API_PRICES['gemini-4-carbon-trial'],Math.floor(Date.parse('2026-12-01T00:00:00Z')/1000))?.input,4);
 const g31=DEFAULT_API_PRICES['gemini-3.1-pro'];
 assert.equal(calculateEstimatedUsd(200_000,0,0,g31),0.4);
 assert.equal(calculateEstimatedUsd(250_000,0,0,g31),1.0,'Gemini 3.1 Pro >200k 上下文应自动切换至 $4/1M 阶梯费率');

 registerRemoteModelMetadata({
  aliases:{'MODEL_PLACEHOLDER_M699':'gemini-4-xenon-test','__proto__':'evil'},
  models:{'gemini-4-xenon-test':{displayName:'Gemini 4 Xenon',capacityTokens:256_000},'bad-cap':{capacityTokens:99_999_999}},
 });
 assert.equal(matchPricingKeys('MODEL_PLACEHOLDER_M699',['gemini-4-xenon-test']),'gemini-4-xenon-test');
 assert.equal(resolveDatabaseModelFullName('MODEL_PLACEHOLDER_M699',null),'gemini-4-xenon-test');
 const xenonCap=resolveModelCapacity('MODEL_PLACEHOLDER_M699');
 assert.equal(xenonCap.modelId,'gemini-4-xenon-test');
 assert.equal(xenonCap.displayName,'Gemini 4 Xenon');
 assert.equal(xenonCap.capacityTokens,256_000);
 assert.equal(xenonCap.isFallback,false);
 assert.equal(resolveModelCapacity('bad-cap').isFallback,true,'越界容量必须被安全过滤');

 // 2) P1-2: 此前未落锁的未定价历史事件在获取新价格后由 autoHealUnpricedHistory 自动补齐并刷新快照
 const convDir=join(dir,'antigravity','conversations');
 await mkdir(convDir,{recursive:true});
 const nowSec=Math.floor(Date.now()/1000)-30;
 const healDb=new DatabaseSync(join(convDir,'heal-unlocked.db'));
 healDb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
 healDb.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(W.encodeLengthDelimited(1,Buffer.concat([
  W.encodeString(19,'future-official-model-v9'),
  W.encodeLengthDelimited(4,Buffer.concat([W.encodeVarintField(2,1_000_000),W.encodeVarintField(3,0)])),
  W.encodeLengthDelimited(9,W.encodeLengthDelimited(4,W.encodeVarintField(1,nowSec))),
 ])));
 healDb.close();
 const healState=join(dir,'heal-state');
 const healMgr=new UsageStatsManager({geminiDir:dir,stateDir:healState});
 const beforeHeal=await healMgr.getUsageSummary(true);
 assert.equal(beforeHeal.all_time.estimated_usd,0);
 assert.equal(beforeHeal.all_time.unpriced_models,1);
 await healMgr.savePricingTable({'future-official-model-v9':{model:'future-official-model-v9',input:3.5,output:14,cached:0.35}});
 const healedCount=await healMgr.autoHealUnpricedHistory();
 assert.equal(healedCount,1,'未落锁历史未定价事件在新价格到达后必须被自愈落锁');
 const afterHeal=await healMgr.getUsageSummary(false);
 assert.equal(afterHeal.all_time.estimated_usd,3.5);
 assert.equal(afterHeal.all_time.unpriced_models,0);

 // 3) P0-3 & P1-5: 六档套餐权重 (TEAM > PRO > PLUS > 待确认) 与推理模型归属及实时窗口字段透传
 assert.equal(classifyFamily({modelId:'o3-mini'}),'claude');
 assert.equal(classifyFamily({modelId:'o4-mini'}),'claude');
 const liveNormalized=normalizeLiveModels([{modelId:'claude-sonnet-5-5',maxTokens:200_000,maxOutputTokens:16_384,quotaInfo:{remainingFraction:0.8}}],nowSec);
 assert.equal(liveNormalized[0].max_tokens,200_000);
 assert.equal(liveNormalized[0].max_output_tokens,16_384);

 const tierMgr=new AccountsManager(join(dir,'tier-state'));
 const mkQ=(rem,tier)=>({...tierMgr.fuseQuota(
  {models:{'gemini-3.8-flash':{quotaInfo:{remainingFraction:rem}}}},
  {groups:[{displayName:'Gemini Models',buckets:[{window:'5h',remainingFraction:rem}]}]}
 ),subscription_tier:tier});
 const aTeam=await tierMgr.upsertAccount({email:'team@example.invalid',refreshToken:'rt-t',accessToken:'at-t',expiresIn:3600});
 const aPro=await tierMgr.upsertAccount({email:'pro@example.invalid',refreshToken:'rt-p',accessToken:'at-p',expiresIn:3600});
 const aPlus=await tierMgr.upsertAccount({email:'plus@example.invalid',refreshToken:'rt-pl',accessToken:'at-pl',expiresIn:3600});
 const aCur=await tierMgr.upsertAccount({email:'cur@example.invalid',refreshToken:'rt-c',accessToken:'at-c',expiresIn:3600});
 aTeam.quota=mkQ(0.7,'TEAM');aPro.quota=mkQ(0.9,'PRO');aPlus.quota=mkQ(0.95,'PLUS');aCur.quota=mkQ(0.05,'PRO');
 await tierMgr.saveAccount(aTeam);await tierMgr.saveAccount(aPro);await tierMgr.saveAccount(aPlus);await tierMgr.saveAccount(aCur);
 const bestTeam=await tierMgr.selectBestAccount(
  {enabled:true,strategy:'priority',reserve_percentage:20,candidate_min_percentage:30,monitored_model:'gemini',candidate_account_ids:[aPlus.id,aPro.id,aTeam.id]},
  {currentId:aCur.id,currentEmail:aCur.email,currentQuota:aCur.quota}
 );
 assert.equal(bestTeam.bestCandidate?.id,aTeam.id,'TEAM 套餐权重应高于 PRO 与 PLUS');

 // 4) P0-4, P0-5 & P1-4: 子智能体轨迹标记、轮初等待落盘状态与 2.5s 内并发多子代理即刻嗅探 + 计费继承
 const subMetrics=buildConversationHudMetrics({
  conversationId:'sub-traj',
  isSubagentTrajectory:true,
  steps:[{idx:0,stepType:15,status:3,hasUsage:true,startTimeSeconds:nowSec,endTimeSeconds:nowSec+2,rawInputTokens:1000,outputTokens:100}],
 });
 assert.equal(subMetrics.session.isSubagentTrajectory,true);
 assert.equal(subMetrics.session.turns,0);

 const turn2Boot=buildConversationHudMetrics({
  conversationId:'turn2-boot',
  isStreaming:true,
  steps:[
   {idx:0,stepType:14,status:3,startTimeSeconds:nowSec-20,endTimeSeconds:nowSec-20},
   {idx:1,stepType:15,status:3,hasUsage:true,startTimeSeconds:nowSec-19,endTimeSeconds:nowSec-15,rawInputTokens:1000,outputTokens:100},
   {idx:2,stepType:14,status:3,startTimeSeconds:nowSec-1,endTimeSeconds:nowSec-1},
  ],
 });
 assert.equal(turn2Boot.session.awaitingFirstTurnStep,true);

 const multiConvDir=join(dir,'multi-sub-convs');
 await mkdir(multiConvDir,{recursive:true});
 const parentId='11111111-1111-4111-8111-111111111111';
 const child1Id='22222222-2222-4222-8222-222222222222';
 const child2Id='33333333-3333-4333-8333-333333333333';
 const parentDb=new DatabaseSync(join(multiConvDir,`${parentId}.db`));
 parentDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE trajectory_meta(trajectory_id TEXT);');
 parentDb.prepare('INSERT INTO trajectory_meta VALUES(?)').run(parentId);
 parentDb.prepare('INSERT INTO steps VALUES(0,14,3,?)').run(W.encodeLengthDelimited(1,W.encodeVarintField(1,nowSec)));
 parentDb.prepare('INSERT INTO steps VALUES(1,127,1,?)').run(W.encodeLengthDelimited(1,W.encodeVarintField(1,nowSec+1)));
 parentDb.close();

 const makeChildDb=(cid)=>{
  const cdb=new DatabaseSync(join(multiConvDir,`${cid}.db`));
  cdb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE trajectory_meta(trajectory_id TEXT); CREATE TABLE trajectory_metadata_blob(id TEXT PRIMARY KEY,data BLOB);');
  cdb.prepare('INSERT INTO trajectory_meta VALUES(?)').run(cid);
  cdb.prepare('INSERT INTO trajectory_metadata_blob VALUES(?,?)').run('meta',W.encodeString(5,parentId));
  cdb.prepare('INSERT INTO steps VALUES(0,15,1,?)').run(Buffer.concat([
   W.encodeLengthDelimited(1,W.encodeVarintField(1,nowSec+1)),
   W.encodeLengthDelimited(9,Buffer.concat([W.encodeVarintField(2,1_000_000),W.encodeVarintField(3,0)])),
  ]));
  cdb.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(W.encodeLengthDelimited(1,W.encodeString(19,'gemini-3.8-pro')));
  cdb.close();
 };
 makeChildDb(child1Id);
 const engine=new ConversationMetricsEngine({conversationsDir:multiConvDir});
 const mSub1=await engine.getConversationMetrics({conversationId:parentId,isSubagentRunning:true});
 assert.equal(mSub1.session.subagentCount,1);
 assert.equal(mSub1.tokens.estimatedCostUsd,4.0,'子智能体未内嵌 step ModelInfo 时应从 child genMetadata 继承模型单价');

 // 2.5s 缓存窗口内立即创建第 2 个并发子代理 .db，目录 mtime 变化必须立即触发重扫而非盲等 2.5s
 makeChildDb(child2Id);
 const mSub2=await engine.getConversationMetrics({conversationId:parentId,isSubagentRunning:true});
 assert.equal(mSub2.session.subagentCount,2,'2.5s 窗口内新增第 2 个子代理库必须被即刻嗅探纳入');
 assert.equal(mSub2.tokens.estimatedCostUsd,8.0);
});
