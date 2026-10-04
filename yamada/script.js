/*
 * 山田川 河川監視 v4
 *
 * ・茨城県公式APIは Cloudflare Worker 経由で取得
 * ・水位グラフは直近12時間
 * ・増減は「最新値」と「1時間前の値」の差
 * ・竜神ダムを最上流側（下高倉の上）に追加
 */

const WORKER_API_BASE_URL = "https://yamada-api.kansuu805030.workers.dev";

const stations = [
  {
    id:"ryujinDam", name:"竜神ダム", type:"ダム情報", status:"green", statusText:"観測中",
    dataType:"DAM",
    dataUrl:"https://kasen-pref-ibaraki.jp/Sta/GetDamStaData?obsTime=&obsStaId=476",
    damLevels:{
      minimum:136.00,
      floodSeasonLimit:146.50,
      normalFull:152.50,
      emergencyStart:156.80,
      floodFull:159.00
    },
    flowLevels:{
      maxRelease:20.000,
      flood:14.500
    },
    damLink:"#"
  },
  {
    id:"shimotakakura", name:"下高倉", type:"河川カメラ", status:"green", statusText:"カメラ",
    camera:{
      recent:{kind:"ibaraki",id:"534",offset:10},
      old:{kind:"ibaraki",id:"534",offset:40},
      normal:"https://kasen-pref-ibaraki.jp/Layers/Camera/NomalTime/534.jpg"
    }
  },
  {
    id:"amanoya", name:"天下野", type:"水位観測点", status:"green", statusText:"観測中",
    dataType:"A",
    dataUrl:"https://kasen-pref-ibaraki.jp/Sta/GetWaterLevelStaData?obsTime=&obsStaId=334",
    levels:{B:1.40,C:1.90,D:2.20},
    waterLink:"http://www.kasen.pref.ibaraki.jp/pc/graph/gra_river_277_1.html"
  },
  {
    id:"kuniyasu", name:"国安", type:"危機管理型水位計", status:"yellow", statusText:"観測中",
    dataType:"B",
    dataUrl:"https://kasen-pref-ibaraki.jp/Sta/GetKikikanriStaData?obsTime=&obsStaId=367",
    levels:{X:-3.56,E:0},
    waterLink:"http://www.kasen.pref.ibaraki.jp/pc/kikikanri/graph.html?no=98&code=08212"
  },
  {
    id:"wada", name:"和田", type:"水位観測点・河川カメラ", status:"orange", statusText:"観測中",
    dataType:"A",
    dataUrl:"https://kasen-pref-ibaraki.jp/Sta/GetWaterLevelStaData?obsTime=&obsStaId=335",
    levels:{B:2.60,C:3.10,D:3.60},
    waterLink:"#",
    camera:{
      recent:{kind:"ibaraki",id:"535",offset:10},
      old:{kind:"ibaraki",id:"535",offset:40},
      normal:"https://kasen-pref-ibaraki.jp/Layers/Camera/NomalTime/535.jpg"
    }
  },
  {
    id:"tokoi", name:"常井橋", type:"水位観測点・河川カメラ", status:"red", statusText:"観測中",
    dataType:"A",
    dataUrl:"https://kasen-pref-ibaraki.jp/Sta/GetWaterLevelStaData?obsTime=&obsStaId=333",
    levels:{A:2.00,B:3.00,C:3.50,D:3.80,E:4.30},
    waterLink:"#",
    camera:{
      recent:{kind:"river",id:"cctv_080004_31C03035",offset:20},
      old:{kind:"river",id:"cctv_080004_31C03035",offset:50},
      normal:"https://cam.river.go.jp/cam/normal/cctv_080004_31C03035.jpg"
    }
  }
];

const levelInfo = {
  A:{name:"水防団待機水位",color:"#16834b"},
  B:{name:"氾濫注意水位",color:"#d5a400"},
  C:{name:"避難判断水位",color:"#d64b2a"},
  D:{name:"氾濫危険水位",color:"#8b3fb0"},
  E:{name:"氾濫発生水位",color:"#222"},
  X:{name:"観測開始水位",color:"#65c7df"}
};

const charts = {};
const cache = new Map();

function floorMinute(date){
  const d = new Date(date);
  d.setSeconds(0,0);
  return d;
}

function floor10Minutes(date){
  const d = floorMinute(date);
  d.setMinutes(Math.floor(d.getMinutes()/10)*10);
  return d;
}

function shiftedTime(offsetMinutes){
  return floor10Minutes(new Date(Date.now() - offsetMinutes*60000));
}

function ymdCompact(d){
  return String(d.getFullYear()).padStart(4,"0") +
         String(d.getMonth()+1).padStart(2,"0") +
         String(d.getDate()).padStart(2,"0") +
         String(d.getHours()).padStart(2,"0") +
         String(d.getMinutes()).padStart(2,"0");
}

function cameraUrl(spec){
  const d = shiftedTime(spec.offset);
  const stamp = ymdCompact(d);

  if(spec.kind === "river"){
    return `https://cam.river.go.jp/cam/history/${stamp}/${spec.id}.jpg`;
  }

  return `https://kasen-pref-ibaraki.jp/Layers/Camera/${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${stamp}_${spec.id}.jpg`;
}

function cameraLabel(offset){
  return offset === 10 || offset === 20 ? "直近" : "約30分前";
}

function apiProxyUrl(targetUrl){
  if(!WORKER_API_BASE_URL || WORKER_API_BASE_URL.includes("YOUR-WORKER")){
    throw new Error("Cloudflare Worker URLが未設定です。");
  }
  return WORKER_API_BASE_URL.replace(/\/$/,"") + "/api?url=" + encodeURIComponent(targetUrl);
}

async function fetchJson(url){
  if(cache.has(url)) return cache.get(url);
  let response;
  try{
    response = await fetch(apiProxyUrl(url), {method:"GET", cache:"no-store"});
  }catch(error){
    throw new Error(`Workerへの接続に失敗：${error.message}`);
  }
  if(!response.ok){
    let detail = "";
    try{ detail = await response.text(); }catch(e){}
    throw new Error(`HTTP ${response.status}${detail ? " / " + detail.slice(0,180) : ""}`);
  }
  let data;
  try{
    data = await response.json();
  }catch(error){
    throw new Error("WorkerからJSON以外の応答が返りました。");
  }
  cache.set(url,data);
  return data;
}

function parseObservationTime(s){
  const m = String(s).match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if(!m) return null;
  return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5]);
}

function parseItemData(json){
  return (json?.tableData?.itemDataList || []).map(item => ({
    id:Number(item.dataItemId),
    name:item.dispName || item.obsItemName || "",
    unit:item.unit || "",
    data:(item.dataList || []).map(r => {
      const time=parseObservationTime(r.time);
      const value=Number(r.data);
      return time && Number.isFinite(value) ? {time,value,upDown:r.upDown || "None",lvl:r.lvl} : null;
    }).filter(Boolean)
  }));
}

function findItem(items, id, names=[]){
  // まず dataItemId を優先
  const byId = items.find(x => x.id === id && x.data?.length);
  if(byId) return byId;

  // 項目名の完全一致
  const byExactName = items.find(x =>
    x.data?.length && names.includes(String(x.name).trim())
  );
  if(byExactName) return byExactName;

  // 表記ゆれに対応
  const normalizedNames = names.map(name =>
    String(name).replace(/[\s　]/g, "")
  );

  const byPartialName = items.find(x => {
    if(!x.data?.length) return false;

    const itemName = String(x.name).replace(/[\s　]/g, "");

    return normalizedNames.some(name =>
      itemName.includes(name)
    );
  });

  if(byPartialName) return byPartialName;

  return null;
}

function normalizeWaterData(station, raw){
  const data = raw.map(r => {
    const t = r.time instanceof Date ? r.time : parseObservationTime(r.time);
    const n = Number(r.value);

    if(!t || !Number.isFinite(n)) return null;

    // B方式は「氾濫発生までの距離(cm)」なので、
    // 反転してmに変換する
    const value = station.dataType === "B" ? -n / 100 : n;

    return {time:t, value};
  }).filter(Boolean)
    .sort((a,b)=>a.time-b.time);

  if(!data.length) return [];

  const end = data[data.length-1].time.getTime();

  return data.filter(
    x =>
      x.time.getTime() >= end - 12 * 60 * 60 * 1000 &&
      x.time.getTime() <= end
  );
}

function normalizeDamData(item){
  return (item?.data || []).slice().sort((a,b)=>a.time-b.time).filter(x=>Number.isFinite(x.value));
}

function findWaterItem(items) {
  // まず名前で探す
  let item = items.find(x => x.name.includes("水位"));
  if (item) return item;

  // 次に unit が m の item を探す
  item = items.find(x => x.unit === "m");
  if (item) return item;

  // 最後に itemDataId=10 を fallback として使う
  return items.find(x => x.id === 10) || null;
}


async function loadWaterData(station){
  try{
    const json = await fetchJson(station.dataUrl);
    const itemData = parseItemData(json);

    let rawItem = null;

    if(station.dataType === "B"){
      // 危機管理型水位計はA方式と項目構成が異なるため、
      // 「氾濫発生までの距離」などの名称から探す
      rawItem = itemData.find(x =>
        x.data?.length &&
        (
          String(x.name).includes("氾濫発生まで") ||
          String(x.name).includes("距離") ||
          String(x.name).includes("水位")
        )
      );

      // 名前で見つからない場合は、
      // 実データを持っている項目を候補として探す
      if(!rawItem){
        rawItem = itemData.find(x => x.data?.length);
      }
    }else{
      // 通常の水位観測所（A方式）
      rawItem = findItem(itemData,10,["水位"]);
    }

    const data = normalizeWaterData(
      station,
      rawItem?.data || []
    );

    console.log(
      `${station.name} API項目:`,
      itemData.map(x => ({
        id:x.id,
        name:x.name,
        unit:x.unit,
        count:x.data?.length || 0
      }))
    );

    if(!rawItem){
      console.warn(
        `${station.name}: 水位データ項目をAPIから特定できませんでした`,
        itemData
      );
    }else if(!data.length){
      console.warn(
        `${station.name}: データ項目は見つかりましたが、有効な時系列データがありません`,
        rawItem
      );
    }

    return {
      data,
      rawTime:json?.tableData?.obsTime || "",
      error:!rawItem
        ? "水位データ項目を取得できませんでした。"
        : ""
    };

  }catch(error){
    console.error(station.name,error);
    return {
      data:[],
      rawTime:"",
      error:error.message
    };
  }
}

async function loadDamData(station){
  try{
    const json=await fetchJson(station.dataUrl);
    const items=parseItemData(json);
    const storage=normalizeDamData(findItem(items,10,["貯水位"]));
    const inflow=normalizeDamData(findItem(items,50,["流入量"]));
    const release=normalizeDamData(findItem(items,70,["放流量"]));
    const latestCandidates=[storage,inflow,release].filter(x=>x.length).map(x=>x[x.length-1].time.getTime());
    const end=Math.max(...latestCandidates);
    const start=end-12*60*60*1000;
    const trim=a=>a.filter(x=>x.time.getTime()>=start && x.time.getTime()<=end);
    return {storage:trim(storage),inflow:trim(inflow),release:trim(release),rawTime:json?.tableData?.obsTime || ""};
  }catch(error){
    console.error(station.name,error);
    return {storage:[],inflow:[],release:[],rawTime:"",error:error.message};
  }
}

function latest(data){
  return data.length ? data[data.length-1] : null;
}

function oneHourPrevious(data){
  if(!data.length) return null;
  const current=data[data.length-1];
  const target=current.time.getTime()-60*60*1000;
  let best=null;
  let bestDiff=Infinity;
  for(const x of data){
    const diff=Math.abs(x.time.getTime()-target);
    if(diff<bestDiff){best=x;bestDiff=diff;}
  }
  // 10分間隔データを想定し、最大15分までを採用
  return best && bestDiff <= 15*60*1000 ? best : null;
}

function diff1h(data){
  const cur=latest(data);
  const prev=oneHourPrevious(data);
  return cur && prev ? cur.value-prev.value : null;
}

function arrowDiff(diff){
  if(diff===null || !Number.isFinite(diff)) return "1時間前比 --";
  return `${diff>0?"↑":diff<0?"↓":"→"} ${Math.abs(diff).toFixed(2)}`;
}

function makeLevelDatasets(station,data){
  if(!data.length) return [];
  const first=data[0].time.getTime();
  const last=data[data.length-1].time.getTime();
  return Object.entries(station.levels || {}).map(([key,value])=>{
    const info=levelInfo[key];
    return {
      label:`${key}: ${info.name} (${value.toFixed(2)}m)`,
      data:[{x:first,y:value},{x:last,y:value}],
      borderColor:info.color,borderWidth:2,borderDash:[6,4],pointRadius:0,fill:false,tension:0
    };
  });
}

function makeWaterChart(station,data){
  const canvas=document.getElementById(`chart-${station.id}`);
  if(!canvas || !data.length) return;
  if(charts[station.id]) charts[station.id].destroy();

  const datasets=[{
    label:"水位",
    data:data.map(x=>({x:x.time.getTime(),y:x.value})),
    borderColor:"#1769aa",
    backgroundColor:"rgba(23,105,170,.08)",
    borderWidth:3,
    pointRadius:2,
    tension:.25,
    fill:"start",
    order:10
  },...makeLevelDatasets(station,data)];

  charts[station.id]=new Chart(canvas,{
    type:"line",data:{datasets},
    options:{
      responsive:true,maintainAspectRatio:false,parsing:false,
      scales:{
        x:{type:"linear",ticks:{callback:v=>new Date(v).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}),maxTicksLimit:7},grid:{color:"#e7edf1"}},
        y:{title:{display:true,text:"水位 (m)"},grid:{color:"#e7edf1"}}
      },
      plugins:{legend:{display:true,position:"bottom",labels:{filter:item=>item.datasetIndex>0}},tooltip:{callbacks:{title(items){return items.length?new Date(items[0].parsed.x).toLocaleString("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}):""}}}}
    }
  });
}

function damStorageRate(level){
  if(level===null || !Number.isFinite(level)) return null;
  const d=stations.find(s=>s.id==="ryujinDam").damLevels;
  return ((level-d.minimum)/(d.floodFull-d.minimum))*100;
}

function makeDamLevelDatasets(station,data){
  if(!data.length) return [];
  const first=data[0].time.getTime(), last=data[data.length-1].time.getTime();
  const levels=[
    ["最低水位",station.damLevels.minimum,"#65c7df"],
    ["洪水期制限水位",station.damLevels.floodSeasonLimit,"#d5a400"],
    ["常時満水位",station.damLevels.normalFull,"#16834b"],
    ["異常洪水時防災操作開始水位",station.damLevels.emergencyStart,"#d64b2a"],
    ["洪水時満水位",station.damLevels.floodFull,"#8b3fb0"]
  ];
  return levels.map(([name,value,color])=>({label:`${name} (${value.toFixed(2)}m)`,data:[{x:first,y:value},{x:last,y:value}],borderColor:color,borderWidth:2,borderDash:[6,4],pointRadius:0,fill:false,tension:0,yAxisID:"y"}));
}

function makeDamFlowDatasets(station,data){
  if(!data.length) return [];
  const first=data[0].time.getTime(), last=data[data.length-1].time.getTime();
  return [
    {label:`計画最大放流量 (${station.flowLevels.maxRelease.toFixed(3)}m³/s)`,data:[{x:first,y:station.flowLevels.maxRelease},{x:last,y:station.flowLevels.maxRelease}],borderColor:"#8b3fb0",borderWidth:2,borderDash:[6,4],pointRadius:0,fill:false,tension:0,yAxisID:"y2"},
    {label:`洪水量 (${station.flowLevels.flood.toFixed(3)}m³/s)`,data:[{x:first,y:station.flowLevels.flood},{x:last,y:station.flowLevels.flood}],borderColor:"#d64b2a",borderWidth:2,borderDash:[6,4],pointRadius:0,fill:false,tension:0,yAxisID:"y2"}
  ];
}

function makeDamChart(station,result){
  const canvas=document.getElementById(`chart-${station.id}`);
  if(!canvas || !result.storage.length) return;
  if(charts[station.id]) charts[station.id].destroy();

  const datasets=[
    {label:"貯水位",data:result.storage.map(x=>({x:x.time.getTime(),y:x.value})),borderColor:"#1769aa",backgroundColor:"rgba(23,105,170,.08)",borderWidth:3,pointRadius:2,tension:.25,fill:false,yAxisID:"y",order:10},
    {label:"流入量",data:result.inflow.map(x=>({x:x.time.getTime(),y:x.value})),borderColor:"#2e8b57",backgroundColor:"transparent",borderWidth:2.5,pointRadius:1.5,tension:.2,fill:false,yAxisID:"y2",order:11},
    {label:"放流量",data:result.release.map(x=>({x:x.time.getTime(),y:x.value})),borderColor:"#d17b00",backgroundColor:"transparent",borderWidth:2.5,pointRadius:1.5,tension:.2,fill:false,yAxisID:"y2",order:12},
    ...makeDamLevelDatasets(station,result.storage),
    ...makeDamFlowDatasets(station,result.inflow)
  ];

  charts[station.id]=new Chart(canvas,{
    type:"line",data:{datasets},
    options:{
      responsive:true,maintainAspectRatio:false,parsing:false,
      scales:{
        x:{type:"linear",ticks:{callback:v=>new Date(v).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}),maxTicksLimit:7},grid:{color:"#e7edf1"}},
        y:{position:"left",title:{display:true,text:"貯水位 (m)"},grid:{color:"#e7edf1"}},
        y2:{position:"right",title:{display:true,text:"流量 (m³/s)"},grid:{drawOnChartArea:false}}
      },
      plugins:{legend:{display:true,position:"bottom"},tooltip:{callbacks:{title(items){return items.length?new Date(items[0].parsed.x).toLocaleString("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}):""}}}}
    }
  });
}

function setDamChartMode(station,mode){
  const chart=charts[station.id];
  if(!chart) return;
  chart.data.datasets.forEach(ds=>{
    const isLevel=ds.yAxisID==="y";
    const isFlow=ds.yAxisID==="y2";
    ds.hidden=mode==="level" ? !isLevel : mode==="flow" ? !isFlow : false;
  });
  chart.update();
  document.querySelectorAll(`#${station.id} .dam-mode-btn`).forEach(btn=>btn.classList.toggle("active",btn.dataset.mode===mode));
}

function renderDam(station,result,index){
  const cur=latest(result.storage);
  const rate=damStorageRate(cur?.value ?? null);
  const storageDiff=diff1h(result.storage);
  const inflow=latest(result.inflow);
  const release=latest(result.release);
  const inflowDiff=diff1h(result.inflow);
  const releaseDiff=diff1h(result.release);

  return `
  <article class="station-card dam-card" id="${station.id}">
    <div class="station-header">
      <div class="station-title"><h3>${index+1}. ${station.name}</h3><div class="station-type">${station.type}</div></div>
      <span class="status ${station.status}">${station.statusText}</span>
    </div>
    <div class="dam-summary">
      <div class="dam-main-value">
        <div class="water-label">貯水率</div>
        <div class="water-value">${rate===null?"--":rate.toFixed(1)}<span class="unit">%</span></div>
        <div class="dam-sub-change ${storageDiff>0?"up":storageDiff<0?"down":"flat"}">${storageDiff===null?"貯水位 1時間前比 --":`貯水位 1時間前比 ${storageDiff>0?"↑":storageDiff<0?"↓":"→"} ${Math.abs(storageDiff).toFixed(2)}m`}</div>
      </div>
      <div class="dam-flow-values">
        <div class="dam-flow-item"><span>放流量</span><strong>${release?release.value.toFixed(3):"--"}<small> m³/s</small></strong><em class="${releaseDiff>0?"up":releaseDiff<0?"down":"flat"}">${arrowDiff(releaseDiff)} m³/s</em></div>
        <div class="dam-flow-item"><span>流入量</span><strong>${inflow?inflow.value.toFixed(3):"--"}<small> m³/s</small></strong><em class="${inflowDiff>0?"up":inflowDiff<0?"down":"flat"}">${arrowDiff(inflowDiff)} m³/s</em></div>
      </div>
    </div>
    <div class="dam-chart-section">
      <div class="chart-title-row"><div class="chart-title">直近12時間のダム情報</div><div class="dam-mode-buttons"><button class="dam-mode-btn active" data-mode="all" onclick="setDamChartMode(stations.find(s=>s.id==='${station.id}'),'all')">すべて</button><button class="dam-mode-btn" data-mode="level" onclick="setDamChartMode(stations.find(s=>s.id==='${station.id}'),'level')">貯水位・基準水位</button><button class="dam-mode-btn" data-mode="flow" onclick="setDamChartMode(stations.find(s=>s.id==='${station.id}'),'flow')">流入量・放流量・基準量</button></div></div>
      <div class="dam-chart-wrap"><canvas id="chart-${station.id}"></canvas></div>
      <details class="dam-reference"><summary>■ 基準量の説明</summary>
        <div class="dam-reference-grid">
          <div><h4>○貯水位基準水位</h4><ul><li>最低水位：136.00m</li><li>洪水期制限水位：146.50m</li><li>常時満水位：152.50m</li><li>異常洪水時防災操作開始水位：156.80m</li><li>洪水時満水位：159.00m</li></ul><p>洪水期制限水位：6月21日～10月10日の貯められる上限<br>常時満水位：10月11日～6月20日の貯められる上限<br>異常洪水時防災操作開始水位：いわゆる緊急放流準備開始水位<br>洪水時満水位：計画上の最高水位（これ以上貯められない）<br>貯水率：洪水時満水位に対する現在の貯水位の割合</p></div>
          <div><h4>○流量基準量</h4><ul><li>計画最大放流量：20.000m³/s</li><li>洪水量：14.500m³/s</li></ul><p>計画最大放流量：洪水調節時にダムから放流できる最大量<br>洪水量：洪水調節を開始する目安となる流入量</p></div>
        </div>
      </details>
    </div>
    ${result.rawTime?`<div class="links"><span class="links-note">公式更新時刻：${result.rawTime}</span></div>`:""}
  </article>`;
}

function renderWater(station,index,result){
  const current=latest(result.data);
  const diff=diff1h(result.data);
  return `
  <article class="station-card" id="${station.id}">
    <div class="station-header"><div class="station-title"><h3>${index+1}. ${station.name}</h3><div class="station-type">${station.type}${station.dataType?` / ${station.dataType}方式`:""}</div></div><span class="status ${station.status}">${station.statusText}</span></div>
    ${station.dataUrl?`<div class="station-body"><div class="water-panel"><div class="water-label">${station.dataType==="B"?"氾濫発生までの距離":"現在水位"}</div><div class="water-value">${current?current.value.toFixed(2):"--"}<span class="unit">m</span></div><div class="change ${diff>0?"up":diff<0?"down":"flat"}">${diff===null?"1時間前比 --":`${diff>0?"↑":diff<0?"↓":"→"} ${Math.abs(diff).toFixed(2)} m`}</div><div class="water-label">基準水位：${Object.keys(station.levels||{}).length?"グラフ内に表示":"なし"}</div>${result.rawTime?`<div class="water-label">公式更新時刻：${result.rawTime}</div>`:""}${result.error?`<div class="water-label error-text">取得エラー：${result.error}</div>`:""}</div><div class="chart-wrap"><div class="chart-title">直近12時間の水位</div><canvas id="chart-${station.id}"></canvas></div></div><div class="links">${station.waterLink&&station.waterLink!=="#"?`<a href="${station.waterLink}" target="_blank" rel="noopener">公式水位ページ ↗</a>`:""}<span class="links-note">A：m / B：氾濫発生までの距離(cm)を反転・m換算</span></div>`:""}
    ${station.camera?`<div class="camera-section"><h4>📷 河川カメラ</h4><div class="camera-grid">${makeCamera(station.camera.recent,cameraLabel(station.camera.recent.offset))}${makeCamera(station.camera.old,cameraLabel(station.camera.old.offset))}${makeNormalCamera(station.camera.normal)}</div></div>`:""}
  </article>`;
}

function makeCamera(spec,label){
  const url=cameraUrl(spec);
  return `<div class="camera-card"><img src="${url}" alt="${label}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><div class="camera-error" style="display:none">画像を取得できませんでした<br><small>${url}</small></div><div class="camera-caption">${label}<div class="camera-time">${urlTimeText(spec.offset)}</div></div></div>`;
}

function makeNormalCamera(url){
  return `<div class="camera-card"><img src="${url}" alt="平常時" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><div class="camera-error" style="display:none">画像を取得できませんでした</div><div class="camera-caption">平常時</div></div>`;
}

function urlTimeText(offset){
  const d=shiftedTime(offset);
  return d.toLocaleString("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
}

function renderSummary(){
  document.getElementById("stationSummary").innerHTML=stations.map((s,i)=>`<button class="summary-item" onclick="document.getElementById('${s.id}').scrollIntoView({behavior:'smooth',block:'center'})"><span class="summary-number">${i+1}</span><span class="summary-name">${s.name}</span><span class="summary-status">${s.statusText}</span></button>`).join("");
}

async function render(){
  renderSummary();
  const list=document.getElementById("stationList");
  list.innerHTML=stations.map((s,i)=>s.dataType==="DAM"?renderDam(s,{storage:[],inflow:[],release:[],rawTime:""},i):renderWater(s,i,{data:[],rawTime:""})).join("");

  let success=0;
  for(let i=0;i<stations.length;i++){
    const s=stations[i];
    if(!s.dataUrl) continue;
    const result=s.dataType==="DAM" ? await loadDamData(s) : await loadWaterData(s);
    success++;
    document.getElementById(s.id).outerHTML=s.dataType==="DAM"?renderDam(s,result,i):renderWater(s,i,result);
    if(s.dataType==="DAM"){
      if(result.storage.length) makeDamChart(s,result);
    }else if(result.data.length){
      makeWaterChart(s,result.data);
    }
  }

  document.getElementById("message").textContent=`公式データ：${success}地点を取得。グラフは直近12時間、増減は1時間前との差です。`;
}

function updateTime(){
  document.getElementById("updatedAt").textContent=new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"});
}

document.getElementById("refreshBtn").addEventListener("click",()=>{
  cache.clear();
  render();
  updateTime();
});

render();
updateTime();
