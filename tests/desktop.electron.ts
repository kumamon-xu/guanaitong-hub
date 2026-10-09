import assert from 'node:assert/strict';
import { app, dialog, safeStorage,shell } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync,writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { HubStore } from '../electron/store';
import { SessionVault } from '../electron/session-vault';
import { openStorage } from '../electron/storage-migration';
import { AddressVault } from '../electron/addresses';
import { version } from '../package.json';
import { DEFAULT_PRODUCT_QUERY,DEFAULT_ORDER_QUERY,type SyncTask } from '../src/shared/operations';
import { BackupService } from '../electron/backup-service';
import { DEFAULT_UPDATE_FEED,RELEASE_REPOSITORY } from '../src/shared/release-config';
import { DATABASE_VERSION } from '../electron/database-migrations';

const root = process.env.HUB_DESKTOP_TEST_ROOT!;
const phase = process.env.HUB_DESKTOP_TEST_PHASE!;
const appEntry = process.env.HUB_DESKTOP_TEST_ENTRY!;
assert.ok(root && appEntry && ['write', 'read'].includes(phase));
const appData = join(root, 'appdata');
if(process.env.HUB_DESKTOP_TEST_SCREENSHOTS)app.disableHardwareAcceleration();
mkdirSync(appData, { recursive: true });
// The production entry uses appData to locate its vault; keep real user data untouched.
app.setPath('appData', appData);
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
const updateBytes=Buffer.from('synthetic package; never execute'),updateHash=createHash('sha256').update(updateBytes).digest('hex');
const [major,minor,patch]=version.split('.').map(Number),updateVersion=`${major}.${minor}.${patch+1}`;
const updateBase=`https://github.com/${RELEASE_REPOSITORY}/releases/download/v${updateVersion}/`;
const updateName=`guanaitong-hub-${updateVersion}-${process.arch}.${process.platform==='win32'?'exe':'zip'}`;
const updateManifest={format:'guanaitong-release',schemaVersion:1,version:updateVersion,notes:'合成更新说明',publishedAt:'2026-10-08T00:00:00.000Z',databaseVersion:DATABASE_VERSION,downloads:{[process.platform+'-'+process.arch]:{url:updateBase+updateName,sha256:updateHash,size:updateBytes.length}}};
const originalFetch=globalThis.fetch;
const updateRequests:string[]=[];
globalThis.fetch=(async(input,options)=>{
  const url=String(input);
  if(url===DEFAULT_UPDATE_FEED){
    updateRequests.push(url);let reads=0;
    return new Response(new ReadableStream<Uint8Array>({pull(controller){if(reads++===0)controller.enqueue(new TextEncoder().encode('{"tag_name":'));else controller.error(new Error('Synthetic API body interruption'));}}));
  }
  if(url===`https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/release.json`){updateRequests.push(url);return new Response('',{status:302,headers:{Location:updateBase+'release.json'}});}
  if(url===updateBase+'release.json'){updateRequests.push(url);return Response.json(updateManifest);}
  if(url===updateBase+'SHA256SUMS.txt'){updateRequests.push(url);return new Response(updateHash+'  '+updateName+'\n');}
  if(url===updateBase+updateName){updateRequests.push(url);return new Response(updateBytes);}
  return originalFetch(input,options);
}) as typeof fetch;

app.on('browser-window-created', (_event, window) => {
  window.hide();
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load', async () => {
    try {
      assert.equal(safeStorage.isEncryptionAvailable(), true);
      assert.ok(window.webContents.getURL().startsWith('file:'));
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        ready = await window.webContents.executeJavaScript("Boolean(window.hub && document.querySelector('.app-shell'))");
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(ready, true, 'The desktop renderer and preload must load.');
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('.sidebar-version span').textContent"), `v${process.env.HUB_DESKTOP_EXPECTED_VERSION??version}`);
      const state = await window.webContents.executeJavaScript('window.hub.getState()');
      assert.equal(state.cards.length, 0);
      assert.equal(state.settings.autoLogin, false);
      assert.equal(await window.webContents.executeJavaScript("Boolean(document.querySelector('.demo-notice'))"), false);
      if (phase === 'write') {
        assert.equal(state.settings.maskNumbers, true);
        await window.webContents.executeJavaScript('window.hub.updateSettings({maskNumbers:false})');
        const address = await window.webContents.executeJavaScript(`window.hub.saveAddress({
          label:'桌面测试', recipient:'测试收件人', phone:'13800138000',
          province:'上海市', city:'上海市', district:'黄浦区', town:'',
          detail:'临时测试地址 100 号', postalCode:'',
          provinceId:'', cityId:'', districtId:'', townId:''
        })`);
        assert.equal(address.isDefault, true);
      } else {
        assert.equal(state.settings.maskNumbers, false);
        const addresses = await window.webContents.executeJavaScript('window.hub.getAddresses()');
        assert.equal(addresses.length, 1);
        assert.equal(addresses[0].recipient, '测试收件人');
      }
      const databasePath = join(app.getPath('userData'), 'vault', 'hub.sqlite');
      for (const path of [databasePath, databasePath + '-wal']) if (existsSync(path)) {
        const addressBytes = readFileSync(path);
        assert.equal(addressBytes.includes(Buffer.from('测试收件人')), false);
        assert.equal(addressBytes.includes(Buffer.from('13800138000')), false);
      }
      assert.equal(existsSync(join(app.getPath('userData'), 'vault', 'addresses.enc')), false);

      // Exercise the actual IPC backup path, including a canceled preview and confirmed restore.
      const backupPath = join(root, 'desktop-unified.gathub');
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: backupPath })) as typeof dialog.showSaveDialog;
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [backupPath] })) as typeof dialog.showOpenDialog;
      if (phase === 'write') {
        assert.equal(await window.webContents.executeJavaScript("window.hub.exportData('desktop-backup-password')"), true);
        assert.equal(JSON.parse(readFileSync(backupPath, 'utf8')).version, process.env.HUB_DESKTOP_TEST_LEGACY==='1'?3:4);
        const original = (await window.webContents.executeJavaScript('window.hub.getAddresses()'))[0];
        await window.webContents.executeJavaScript(`window.hub.saveAddress(${JSON.stringify({ ...original, recipient: '临时修改' })},${JSON.stringify(original.id)})`);
        dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
        assert.equal(await window.webContents.executeJavaScript("window.hub.importData('desktop-backup-password')"), null);
        assert.equal((await window.webContents.executeJavaScript('window.hub.getAddresses()'))[0].recipient, '临时修改');
        dialog.showMessageBox = (async (_owner: unknown, options: { detail?: string }) => {
          assert.ok(options.detail?.includes('收货地址 1 条'));
          return { response: 1, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
        await window.webContents.executeJavaScript("window.hub.importData('desktop-backup-password')");
        assert.equal((await window.webContents.executeJavaScript('window.hub.getAddresses()'))[0].recipient, '测试收件人');
      }

      // Exercise native OS encryption for credentials and cookies across two Electron processes.
      const options = {
        directory: join(root, 'native-vault'),
        encryptString: (value: string) => safeStorage.encryptString(value),
        decryptString: (value: Buffer) => safeStorage.decryptString(value),
      };
      if (phase === 'write') {
        const legacy = new HubStore(options);
        const legacySessions = new SessionVault(options);
        const card = legacy.addCards([{ number: '123456789012', password: 'windows-test-password', label: '临时测试卡' }]).cards[0];
        await legacySessions.save(card.id, async () => [{ name: 'fixture', value: 'windows-test-cookie', domain: '.guanaitong.com', path: '/', secure: true, httpOnly: true }]);
        new AddressVault(options).save({ label: '', recipient: '迁移测试收件人', phone: '13800138000', province: '上海市', city: '上海市', district: '黄浦区', town: '', detail: '迁移临时地址 1 号', postalCode: '', provinceId: '', cityId: '', districtId: '', townId: '' });
      }
      const database = openStorage(options);
      const store = new HubStore({ ...options, repository: database });
      const sessions = new SessionVault({ ...options, repository: database });
      if (phase === 'write') {
        assert.equal(new AddressVault({ ...options, repository: database }).list()[0].recipient, '迁移测试收件人');
        const id=store.getState().cards[0].id;
        store.applySnapshot(id,{card:{status:'active',balance:100,balanceUnit:'元',expiresAt:'2026-10-12'},products:Array.from({length:120},(_,i)=>({id:`native-product-${i}`,name:`合成商品 ${i}`,brand:'合成品牌',category:'食品',categories:['食品'],specification:'标准规格',image:'',favorite:false,mergeKey:'',offers:[{cardId:id,sourceId:`native-source-${i}`,price:10+i%3,priceUnit:'元',stock:5,url:'https://a.guanaitong.com/product',variant:'合成规格',syncedAt:'2026-10-08T04:00:00.000Z',categories:['食品']}]})),orders:[{id:'native-order',cardId:id,sourceId:'native-order-source',name:'合成订单',amount:30,status:'已完成',createdAt:'2026-10-08T04:00:00.000Z',tracking:'',url:''}]});
        if(process.env.HUB_DESKTOP_TEST_LEGACY!=='1'){
          store.favoriteProduct('native-product-0');
          store.applySnapshot(id,{products:store.getState().products.filter(product=>product.id!=='native-product-0')});
        }
        store.updateCard(id,{tags:['福利','测试']});
        const task:SyncTask={id:'native-task',batchId:'native-batch',cardId:id,status:'failed',phase:'products',page:2,completed:100,total:120,errorKind:'schema',endpoint:'product/list',message:'合成分页响应变化',startedAt:'2026-10-08T03:59:00.000Z',finishedAt:'2026-10-08T04:00:00.000Z'};
        database.saveSyncTask(task);
        await sessions.save(store.getState().cards[0].id, async () => [{
          name: 'fixture', value: 'windows-test-cookie', domain: '.guanaitong.com',
          path: '/', secure: true, httpOnly: true,
        }]);
      }
      const card = store.getState().cards[0];
      assert.equal(card.number, '123456789012');
      assert.equal(store.getPassword(card.id), 'windows-test-password');
      const disk = readFileSync(store.filePath, 'utf8');
      assert.equal(disk.includes('windows-test-password'), false);
      assert.equal(disk.includes('123456789012'), false);
      assert.equal(sessions.load(card.id)[0].value, 'windows-test-cookie');
      if(phase==='write'){
        const waitFor=async(expression:string)=>{for(let attempt=0;attempt<50;attempt++){if(await window.webContents.executeJavaScript(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`Desktop condition timed out: ${expression}`);};
        const rich=join(root,'rich-fixture.gathub');
        const addressVault=new AddressVault({...options,repository:database});
        const management=database.managementData();if(process.env.HUB_DESKTOP_TEST_LEGACY==='1')delete management.tradeAttempts;
        writeFileSync(rich,store.exportBackup('desktop-backup-password',addressVault.list(),management));
        dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[rich]})) as typeof dialog.showOpenDialog;
        await window.webContents.executeJavaScript("window.hub.importData('desktop-backup-password')");
        const view=await window.webContents.executeJavaScript('window.hub.getViewState()');
        assert.equal(view.summary.products,120);assert.equal(view.products.length,4);assert.equal(view.orders.length,0);
        const query=await window.webContents.executeJavaScript(`window.hub.queryProducts(${JSON.stringify({...DEFAULT_PRODUCT_QUERY,page:2})})`);
        assert.equal(query.items.length,24);assert.equal(query.total,120);
        await assert.rejects(window.webContents.executeJavaScript(`window.hub.updateCard(${JSON.stringify(card.id)},{number:'000000000000'})`),/字段/);
        await assert.rejects(window.webContents.executeJavaScript(`window.hub.queryProducts(${JSON.stringify({...DEFAULT_PRODUCT_QUERY,pageSize:1000})})`),/分页/);
        await window.webContents.executeJavaScript("document.querySelector('button[aria-label=\"商品总库\"]').click()");
        for(let attempt=0;attempt<30;attempt++){if(await window.webContents.executeJavaScript("document.querySelector('.catalog-results-head')?.textContent.includes('120') && document.querySelectorAll('.virtual-catalog .product-tile').length > 0"))break;await new Promise(resolve=>setTimeout(resolve,100));}
        assert.equal(await window.webContents.executeJavaScript("document.querySelector('.catalog-results-head').textContent.includes('120')"),true);
        assert.ok(await window.webContents.executeJavaScript("document.querySelectorAll('.virtual-catalog .product-tile').length < 30"));
        if(process.env.HUB_DESKTOP_TEST_LEGACY!=='1'){
          await window.webContents.executeJavaScript("document.querySelector('button[aria-label=\"取消收藏 合成商品 0\"]').click()");
          await waitFor("Boolean(document.querySelector('button[aria-label=\"收藏 合成商品 0\"]'))");
          assert.equal((await window.webContents.executeJavaScript(`window.hub.queryProducts(${JSON.stringify({...DEFAULT_PRODUCT_QUERY,favoritesOnly:true})})`)).total,0);
        }
        const screenshots=process.env.HUB_DESKTOP_TEST_SCREENSHOTS;
        const screenshot=async(name:string)=>{if(!screenshots)return;for(let attempt=0;attempt<5;attempt++){await new Promise(resolve=>setTimeout(resolve,200));try{writeFileSync(join(screenshots,name),(await window.webContents.capturePage(undefined,{stayHidden:true})).toPNG());return;}catch(error){if(attempt===4)throw error;}}};
        await screenshot('catalog.png');
        await window.webContents.executeJavaScript("[...document.querySelectorAll('.pagination button')].find(button=>button.textContent==='下一页').click()");
        await waitFor("document.querySelector('.virtual-catalog')?.textContent.includes('合成商品 24')");
        assert.equal(await window.webContents.executeJavaScript("document.querySelector('.pagination').textContent.includes('第 2 / 5 页')"),true);
        await window.webContents.executeJavaScript("document.querySelector('button[aria-label=\"订单记录\"]').click()");
        await waitFor("document.querySelectorAll('.order-record').length===1");
        assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.order-record').length"),1);
        const csv=join(root,'orders.csv');dialog.showSaveDialog=(async()=>({canceled:false,filePath:csv})) as typeof dialog.showSaveDialog;
        assert.equal(await window.webContents.executeJavaScript(`window.hub.exportOrders(${JSON.stringify(DEFAULT_ORDER_QUERY)})`),true);
        assert.equal(readFileSync(csv,'utf8').includes('123456789012'),false);
        // New UI behavior is checked on the current app; legacy upgrade runs only need to preserve their data.
        if(process.env.HUB_DESKTOP_TEST_LEGACY!=='1'){
          await window.webContents.executeJavaScript('window.hub.updateSettings({maskNumbers:false})');
          await window.webContents.executeJavaScript("document.querySelector('button[aria-label=\"收货地址\"]').click()");
          await waitFor("Boolean(document.querySelector('.address-publish'))");
          assert.equal(await window.webContents.executeJavaScript("document.querySelector('select[aria-label=\"选择地址来源卡片\"]').textContent.includes('123456789012')"),true);
          await window.webContents.executeJavaScript("document.querySelector('.address-publish').click()");
          await waitFor("Boolean(document.querySelector('.address-confirm-details'))");
          assert.equal(await window.webContents.executeJavaScript("document.querySelector('select[aria-label=\"添加地址的目标卡片\"]').textContent.includes('123456789012') && document.querySelector('.address-confirm-details small').textContent.includes('123456789012')"),true);
          await window.webContents.executeJavaScript('window.hub.updateSettings({maskNumbers:true})');
          await waitFor("!document.querySelector('.address-page').textContent.includes('123456789012')");
          for(const selector of ['select[aria-label="选择地址来源卡片"]','select[aria-label="添加地址的目标卡片"]','.address-confirm-details small']){
            const text=await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).textContent`);
            assert.equal(text.includes('123456789012'),false);assert.ok(text.includes('1234 •••• 9012'));
          }
          assert.equal(await window.webContents.executeJavaScript("document.querySelector('select[aria-label=\"添加地址的目标卡片\"]').value"),card.id);
          await window.webContents.executeJavaScript('window.hub.updateSettings({maskNumbers:false})');
          await waitFor("document.querySelector('.address-confirm-details small').textContent.includes('123456789012')");
          await window.webContents.executeJavaScript("document.querySelector('button[aria-label=\"关闭官网地址确认\"]').click()");
        }
        await window.webContents.executeJavaScript("document.querySelector('button[aria-label=\"我的卡片\"]').click()");
        await waitFor("document.querySelector('.sync-monitor')?.textContent.includes('读取商品')");
        assert.equal(await window.webContents.executeJavaScript("document.querySelector('.sync-monitor').textContent.includes('读取商品')"),true);
        assert.equal(await window.webContents.executeJavaScript("document.querySelector('select[aria-label=\"卡片标签筛选\"]').textContent.includes('福利')"),true);
        await screenshot('sync.png');
        await window.webContents.executeJavaScript("document.querySelector('button[aria-label=\"设置与备份\"]').click()");
        await waitFor("Boolean(document.querySelector('.release-panel'))");
        assert.equal(await window.webContents.executeJavaScript("Boolean(document.querySelector('.release-panel'))"),true);
        if(process.env.HUB_DESKTOP_TEST_LEGACY!=='1'){
          const update=await window.webContents.executeJavaScript('window.hub.checkUpdates()');
          assert.equal(update.source,'github');assert.equal(update.available,true);
          assert.deepEqual(updateRequests,[DEFAULT_UPDATE_FEED,`https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/release.json`,updateBase+'release.json',updateBase+'SHA256SUMS.txt']);
          const prepared=await window.webContents.executeJavaScript('window.hub.prepareUpdate()');
          assert.deepEqual(readFileSync(prepared.filePath),updateBytes);assert.ok(existsSync(prepared.backupPath));
          const opened:string[]=[];shell.openPath=async path=>{opened.push(path);return'synthetic-stop-before-launch';};
          await assert.rejects(window.webContents.executeJavaScript('window.hub.installUpdate()'),/未能启动/);
          assert.deepEqual(opened,[await realpath(prepared.filePath)]);
          assert.equal((await window.webContents.executeJavaScript('window.hub.getState()')).cards.length,1);
        }
        await screenshot('settings.png');
        // Restore the original empty main fixture; the second process checks that snapshot.
        dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[backupPath]})) as typeof dialog.showOpenDialog;
        await window.webContents.executeJavaScript("window.hub.importData('desktop-backup-password')");
        assert.equal((await window.webContents.executeJavaScript('window.hub.getState()')).cards.length,0);
      }
      const safetyCopy = database.backup('desktop-test');
      assert.equal(readFileSync(safetyCopy).includes(Buffer.from('windows-test-cookie')), false);
      await sessions.flush(); await database.flush(); database.close();
      if (phase === 'read') {
        const addresses = await window.webContents.executeJavaScript('window.hub.getAddresses()');
        await window.webContents.executeJavaScript(`window.hub.removeAddress(${JSON.stringify(addresses[0].id)})`);
        assert.deepEqual(await window.webContents.executeJavaScript('window.hub.getAddresses()'), []);
      }
      console.log(JSON.stringify({ case: 'desktop-native-storage', phase, ok: true, platform: process.platform, arch: process.arch, renderer: true, ipc: true, encrypted: true }));
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
});

require(appEntry);
