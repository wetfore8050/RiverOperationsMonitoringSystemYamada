/*
 * 山田川 河川監視
 * 水位：公式APIから直近72時間程度を取得し、直近12時間をChart.jsで描画
 * A：dataをmとしてそのまま使用
 * B：dataは「氾濫発生までの水位(cm)」なので -data/100 m に変換
 */

const stations = [
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
    waterLink:"http://www.kasen.pref.ibaraki.jp/pc/graph/gra_river_277_1.html",
  },
  {
    id:"kuniyasu", name:"国安", type:"危機管理型水位計", status:"yellow", statusText:"観測中",
    dataType:"B",
    dataUrl:"https://kasen-pref-ibaraki.jp/Sta/GetKikikanriStaData?obsTime=&obsStaId=454",
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

function shiftedTime(offsetMinutes){
  const d = new Date(Date.now() - offsetMinutes*60000);
  return floorMinute(d);
}

function ymd(d){
  return String(d.getFullYear()).padStart(4,"0") + "/" +
         String(d.getMonth()+1).padStart(2,"0") + "/" +
         String(d.getDate()).padStart(2,"0");
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

function cameraLabel(offset, normal=false){
  if(normal) return "平常時";
  return offset === 10 || offset === 20 ? "直近" : "約30分前";
}

async function fetchJson(url){
  if(cache.has(url)) return cache.get(url);
  const response = await fetch(url, {cache:"no-store"});
  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  cache.set(url,data);
  return data;
}

function findDataList(json){
  const lists = json?.tableData?.itemDataList || [];
  const item = lists.find(x => Array.isArray(x.dataList));
  return item?.dataList || [];
}

function parseObservationTime(s){
  const m = String(s).match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if(!m) return null;
  return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5]);
}

function normalizeData(station, raw){
  const data = raw.map(r => {
    const t = parseObservationTime(r.time);
    const n = Number(r.data);
    if(!t || !Number.isFinite(n)) return null;

    // A：mのまま。B：氾濫発生までの距離(cm) → mへ変換し、符号反転。
    const value = station.dataType === "B" ? -n / 100 : n;
    return {time:t, value};
  }).filter(Boolean);

  const end = Date.now();
  const start = end - 12*60*60*1000;
  return data.filter(x => x.time.getTime() >= start && x.time.getTime() <= end);
}

async function loadWaterData(station){
  try{
    const json = await fetchJson(station.dataUrl);
    const raw = findDataList(json);
    const data = normalizeData(station, raw);
    return {data, rawTime:json?.tableData?.obsTime || ""};
  }catch(error){
    console.error(station.name,error);
    return {data:[],rawTime:"",error:error.message};
  }
}

function makeLevelAnnotations(levels){
  const result = {};
  for(const [key,value] of Object.entries(levels || {})){
    const info = levelInfo[key];
    if(!info) continue;
    result[`level_${key}`] = {
      type:"line",
      yMin:value, yMax:value,
      borderColor:info.color,
      borderWidth:2,
      borderDash:[6,4],
      label:{
        display:true,
        content:`${key}: ${info.name} ${value >= 0 ? value.toFixed(2) : value.toFixed(2)}m`,
        position:"start",
        color:info.color,
        backgroundColor:"rgba(255,255,255,.85)",
        font:{size:10,weight:"bold"}
      }
    };
  }
  return result;
}

function makeChart(station, data){
  const canvas = document.getElementById(`chart-${station.id}`);
  if(!canvas) return;

  if(charts[station.id]) charts[station.id].destroy();

  const datasets = [{
    label:"水位",
    data:data.map(x=>({x:x.time,y:x.value})),
    borderColor:"#1769aa",
    backgroundColor:"rgba(23,105,170,.08)",
    borderWidth:3,
    pointRadius:2,
    tension:.25,
    fill:true
  }];

  charts[station.id] = new Chart(canvas,{
    type:"line",
    data:{datasets},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      parsing:false,
      scales:{
        x:{
          type:"linear",
          ticks:{
            callback:v => {
              const d=new Date(v);
              return d.toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"});
            },
            maxTicksLimit:7
          },
          grid:{color:"#e7edf1"}
        },
        y:{
          title:{display:true,text:"水位 (m)"},
          grid:{color:"#e7edf1"}
        }
      },
      plugins:{
        legend:{display:false},
        annotation:{annotations:makeLevelAnnotations(station.levels)}
      }
    }
  });
}

function getCurrent(data){
  return data.length ? data[data.length-1].value : null;
}

function renderStation(station, index, result){
  const current = getCurrent(result.data);
  const prev = result.data.length > 1 ? result.data[result.data.length-2].value : null;
  const diff = current !== null && prev !== null ? current-prev : null;

  return `
  <article class="station-card" id="${station.id}">
    <div class="station-header">
      <div class="station-title">
        <h3>${index+1}. ${station.name}</h3>
        <div class="station-type">${station.type}${station.dataType ? ` / ${station.dataType}方式` : ""}</div>
      </div>
      <span class="status ${station.status}">${station.statusText}</span>
    </div>

    ${station.dataUrl ? `
    <div class="station-body">
      <div class="water-panel">
        <div class="water-label">${station.dataType==="B" ? "氾濫発生までの距離" : "現在水位"}</div>
        <div class="water-value">${current===null ? "--" : current.toFixed(2)}<span class="unit">m</span></div>
        <div class="change ${diff>0?"up":diff<0?"down":"flat"}">
          ${diff===null?"変化量 --":`${diff>0?"↑":diff<0?"↓":"→"} ${Math.abs(diff).toFixed(2)} m`}
        </div>
        <div class="water-label">基準水位：${Object.keys(station.levels||{}).length ? "グラフ内に表示" : "なし"}</div>
        ${result.rawTime ? `<div class="water-label">公式更新時刻：${result.rawTime}</div>` : ""}
        ${result.error ? `<div class="water-label">取得エラー：${result.error}</div>` : ""}
      </div>
      <div class="chart-wrap">
        <div class="chart-title">直近12時間の水位</div>
        <canvas id="chart-${station.id}"></canvas>
      </div>
    </div>
    <div class="links">
      ${station.waterLink && station.waterLink!=="#" ? `<a href="${station.waterLink}" target="_blank" rel="noopener">公式水位ページ ↗</a>` : ""}
      <span class="links-note">A：m / B：氾濫発生までの距離(cm)を反転・m換算</span>
    </div>
    ` : ""}

    ${station.camera ? `
    <div class="camera-section">
      <h4>📷 河川カメラ</h4>
      <div class="camera-grid">
        ${makeCamera(station.camera.recent, cameraLabel(station.camera.recent.offset))}
        ${makeCamera(station.camera.old, cameraLabel(station.camera.old.offset))}
        ${makeNormalCamera(station.camera.normal)}
      </div>
    </div>
    ` : ""}
  </article>`;
}

function makeCamera(spec,label){
  const url=cameraUrl(spec);
  return `
  <div class="camera-card">
    <img src="${url}" alt="${label}" loading="lazy"
      onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">
    <div class="camera-error" style="display:none">画像を取得できませんでした<br><small>${url}</small></div>
    <div class="camera-caption">${label}<div class="camera-time">${urlTimeText(spec.offset)}</div></div>
  </div>`;
}

function makeNormalCamera(url){
  return `
  <div class="camera-card">
    <img src="${url}" alt="平常時" loading="lazy"
      onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">
    <div class="camera-error" style="display:none">画像を取得できませんでした</div>
    <div class="camera-caption">平常時</div>
  </div>`;
}

function urlTimeText(offset){
  const d=shiftedTime(offset);
  d.setMinutes(Math.floor(d.getMinutes() / 10) * 10);
  return d.toLocaleString("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
}

function renderSummary(){
  document.getElementById("stationSummary").innerHTML=stations.map((s,i)=>`
    <button class="summary-item" onclick="document.getElementById('${s.id}').scrollIntoView({behavior:'smooth',block:'center'})">
      <span class="summary-number">${i+1}</span>
      <span class="summary-name">${s.name}</span>
      <span class="summary-status">${s.statusText}</span>
    </button>`).join("");
}

async function render(){
  renderSummary();
  const list=document.getElementById("stationList");
  list.innerHTML=stations.map((s,i)=>renderStation(s,i,{data:[],rawTime:""})).join("");

  let success=0;
  for(let i=0;i<stations.length;i++){
    const s=stations[i];
    if(!s.dataUrl) continue;

    const result=await loadWaterData(s);
    success++;
    document.getElementById(s.id).outerHTML=renderStation(s,i,result);

    if(result.data.length) makeChart(s,result.data);
  }

  document.getElementById("message").textContent =
    `水位データ：${success}地点を公式URLから取得しました。グラフは直近12時間です。`;
}

function updateTime(){
  document.getElementById("updatedAt").textContent=
    new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"});
}

document.getElementById("refreshBtn").addEventListener("click",()=>{
  cache.clear();
  render();
  updateTime();
});

render();
updateTime();
