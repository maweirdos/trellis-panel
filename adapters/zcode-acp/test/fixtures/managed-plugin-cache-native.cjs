'use strict'
// Reviewed native scanner excerpt; fixture data and entrypoint are local.
const D0 = require('node:fs'), iS = require('node:path'), roi = require('node:crypto')
const Ioc = new Set(['.mcp.json', '.zcode-plugin', 'README.md', 'agents', 'commands', 'dist', 'docs', 'hooks', 'output-styles', 'package.json', 'scripts', 'skills', 'templates'])
function Moc(e,t){let n=[],o=new Set([...Ioc,...t.runtimeTopLevelPaths??[]]);for(let i of aoi(e,o)){let a=uoi(i.slice(e.length+1));if(!Woc(a,o))continue;let c=(0,D0.readFileSync)(i);n.push({mode:yFn(a,(0,D0.statSync)(i).mode),path:a,sha256:vFn(c),sourcePath:i})}return n.sort((i,a)=>i.path.localeCompare(a.path))}
function*aoi(e,t,n=0){for(let o of(0,D0.readdirSync)(e,{withFileTypes:!0})){if(qoc(o.name,n,t))continue;let i=(0,iS.join)(e,o.name);if(o.isDirectory()){yield*aoi(i,t,n+1);continue}o.isFile()&&(yield i)}}
function dFn(e,t,n){if(e.kind==="filesystem"&&n.sourcePath)return(0,D0.readFileSync)(n.sourcePath);let o=soi();if(!o?.isSea())throw new Error("SEA plugin asset is unavailable outside SEA runtime.");return Buffer.from(o.getRawAsset(`${ooi}${lce}/${t.definition.name}/${t.definition.version}/${n.path}`))}
function qoc(e,t,n){return e===".turbo"||e==="coverage"||e===".venv"||e==="__pycache__"?!0:e==="node_modules"&&!(t===0&&n.has(e))}
function Woc(e,t){let n=e.split("/");if(n.includes(".DS_Store")||n.some(i=>i.endsWith(".pyc")))return!1;let[o]=e.split("/");return o!==void 0&&t.has(o)}
function yFn(e,t){if(t!==void 0&&(t&73)!==0)return 493;let n=uoi(e);return/(?:^|\/)dist\/mcp\/server\.js$/i.test(n)||/^hooks\//u.test(n)&&!/\.(json|md|txt)$/iu.test(n)?493:420}
function uoi(e){return e.split(iS.sep).join('/')}
function vFn(e){return(0,roi.createHash)('sha256').update(e).digest('hex')}
function soi(){return undefined}
function bQe(){}
function hEt(){}
function Roc(){return {kind:'filesystem',plugins:[]}}
bQe();mSc();async function mSc(){if(process.env.MANAGED_FIXTURE_FAIL_MAIN)throw new Error('native-main-ran')}
module.exports = { Moc, dFn, aoi, Woc, yFn, uoi, Ioc,
  context: { filename: __filename, dirname: __dirname, argv: process.argv, cwd: process.cwd(),
    main: require.main === module, id: module.id, paths: module.paths, self: require(__filename) === module.exports } }
