const fs = require('fs');
const path = require('path');

const OUR = 'worker/src/drivers';
const OL = '/workspace/openlist-src/drivers';
const skip = new Set(['base.ts','cloud-base.ts','factory.ts','index.ts','stubs.ts','multipart.ts','signing.ts','xunlei-base.ts']);
const drivers = fs.readdirSync(OUR).filter(f => f.endsWith('.ts') && !skip.has(f)).map(f=>f.replace(/\.ts$/,''));

function camelToSnake(s){ return s.replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/([A-Z])([A-Z][a-z])/g,'$1_$2').toLowerCase(); }
function snakeToCamel(s){ return s.replace(/_([a-z0-9])/g,(_,c)=>c.toUpperCase()); }
function humanize(s){ return s.replace(/_/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase()); }

// 1) 解析 OpenList meta.go 的字段标签
function parseMeta(dir){
  const meta = {};
  if(!fs.existsSync(dir)) return meta;
  for(const f of fs.readdirSync(dir)){
    if(!f.endsWith('.go')) continue;
    const src = fs.readFileSync(path.join(dir,f),'utf8');
    const tagRe = /`([^`]*json:"[^`]*)`/g; let m;
    while((m = tagRe.exec(src))){
      const tag = m[1];
      const jm = tag.match(/json:"([^"]+)"/); if(!jm) continue;
      const key = jm[1];
      const typeM = tag.match(/type:"([^"]+)"/);
      const reqM = tag.match(/required:"([^"]+)"/);
      const defM = tag.match(/default:"([^"]+)"/);
      const helpM = tag.match(/help:"([^"]*)"/);
      const nameM = tag.match(/name:"([^"]*)"/);
      const optM = tag.match(/options:"([^"]*)"/);
      meta[key] = {
        label: (nameM?nameM[1]:humanize(key)),
        type: (typeM?typeM[1]:''),
        required: reqM? reqM[1]==='true':false,
        default: defM?defM[1]:undefined,
        help: helpM?helpM[1]:'',
        options: optM? optM[1].split(',').map(o=>({label:o,value:o})):undefined,
      };
    }
  }
  return meta;
}
const baseMeta = {
  root_folder_path:{label:'根目录路径',type:'text',help:'挂载到网盘内的根路径，默认 /'},
  root_folder_id:{label:'根目录ID',type:'text',help:'根目录 ID（部分驱动用 ID 定位）'},
};

// 2) 提取我们驱动实际读取的 cfg 键
function extractKeys(file){
  const src = fs.readFileSync(file,'utf8');
  const keys = new Set();
  let m;
  const add = (k)=>{ if(k && k!=='_mountId' && !/^(get|set|has|toString|valueOf)$/.test(k)) keys.add(k); };
  const re1 = /cfg\[['"]([\w-]+)['"]\]/g; while((m=re1.exec(src))) add(m[1]);
  const re2 = /cfgStr\(['"]([\w-]+)['"]\)/g; while((m=re2.exec(src))) add(m[1]);
  const re3 = /this\.cfg\.(\w+)/g; while((m=re3.exec(src))) add(m[1]);
  const re4 = /\(this\.cfg as [^)]*\)\[['"]([\w-]+)['"]\]/g; while((m=re4.exec(src))) add(m[1]);
  // 点访问：cfg.x（init 参数直接读取，如 s3/webdav 原版驱动）
  const re6 = /[^.\w]cfg\.(\w+)/g; while((m=re6.exec(src))) add(m[1]);
  return [...keys];
}

// 3) 组装 schema
const SCHEMAS = {};
for(const id of drivers){
  const ourFile = path.join(OUR, id+'.ts');
  const olDir = path.join(OL, id);
  const meta = Object.assign({}, baseMeta, parseMeta(olDir));
  const keys = extractKeys(ourFile);
  const fields = keys.map(k=>{
    const sk = camelToSnake(k);
    const mm = meta[k] || meta[sk] || meta[snakeToCamel(k)] || null;
    let type='text', label=humanize(k), required=false, def=undefined, help='', options=undefined;
    if(mm){
      label = mm.label||humanize(k);
      type = mm.type||'';
      required = !!mm.required; def = mm.default; help = mm.help||''; options = mm.options;
      if(!['password','text','textarea','number','bool','select'].includes(type)){
        type = (/password|secret|token|cookie|pwd|key/i.test(k))?'password':'text';
      }
    } else {
      type = (/password|secret|token|cookie|pwd|key/i.test(k))?'password':'text';
    }
    const f = { key:k, label, type };
    if(required) f.required=true;
    if(def!==undefined) f.default=def;
    if(help) f.help=help;
    if(options) f.options=options;
    return f;
  });
  SCHEMAS[id] = { id, name: humanize(id), fields };
}

const json = JSON.stringify(SCHEMAS, null, 2);
const out = [
  '// 自动生成：驱动配置 schema。key 取自本仓库 driver 实际读取的 cfg 键（保证表单发出的键驱动能读到），',
  '// 标签/类型/必填/帮助对齐 OpenList meta.go。运行 gen_schemas.js 可重新生成。',
  'export type FieldType = "text" | "password" | "textarea" | "number" | "bool" | "select";',
  'export interface FieldSchema {',
  '  key: string;',
  '  label: string;',
  '  type: FieldType;',
  '  required?: boolean;',
  '  default?: string | number | boolean;',
  '  help?: string;',
  '  options?: { label: string; value: string }[];',
  '}',
  'export interface DriverSchema {',
  '  id: string;',
  '  name: string;',
  '  fields: FieldSchema[];',
  '}',
  'const SCHEMAS: Record<string, DriverSchema> = ' + json + ';',
  'export function getDriverSchema(id: string): DriverSchema | undefined { return SCHEMAS[id]; }',
  'export function listDriverSchemas(): DriverSchema[] { return Object.values(SCHEMAS); }',
  'export default SCHEMAS;',
  ''
].join('\n');
fs.writeFileSync(path.join(OUR,'schemas.ts'), out);
console.log('generated schemas for', drivers.length, 'drivers');
for(const t of ['s3','webdav','baidu_netdisk','dropbox','aliyun','quark']){
  const s = SCHEMAS[t];
  if(!s){ console.log(t,'MISSING'); continue; }
  console.log('\n['+t+']', s.name, '| fields:', s.fields.length);
  s.fields.slice(0,8).forEach(f=>console.log('   ', f.key, '('+f.type+(f.required?',req':'')+')', '-', f.label));
}
