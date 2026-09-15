// 给所有 .ps1 补 UTF-8 BOM，并逐个做解析自检。
// Windows PowerShell 5.1 只会通过 BOM 判断 UTF-8；缺 BOM 就按 GBK 解码，
// 中文注释被误解码后会吃掉引号，报出一堆假语法错误（实测）。
// 本仓库所有含中文的 .ps1 因此统一带 BOM —— 这是 check-encoding.mjs 的已知例外。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function ps1Files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...ps1Files(p));
    else if (e.name.endsWith('.ps1')) out.push(p);
  }
  return out;
}

const rawArg = process.argv[2] || '..';
const root = path.resolve(rawArg);

// 同时支持「传目录」和「传单个文件」。
// 之前只支持目录，launch.ps1 传了文件路径，导致
// ENOTDIR: not a directory, scandir ...deploy.ps1 直接崩掉（实测）。
let files;
let labelRoot;
if (fs.existsSync(root) && fs.statSync(root).isFile()) {
  files = root.endsWith('.ps1') ? [root] : [];
  labelRoot = path.dirname(root);
} else if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
  files = ps1Files(root);
  labelRoot = root;
} else {
  console.log(`  路径不存在：${root}`);
  process.exit(1);
}

if (!files.length) {
  console.log('  未找到 .ps1 文件');
  process.exit(0);
}

let fixed = 0;
let bad = 0;
for (const f of files) {
  const rel = path.relative(labelRoot, f);
  let buf = fs.readFileSync(f);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (!hasBom) {
    const text = buf.toString('utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(f, Buffer.concat([BOM, Buffer.from(text, 'utf8')]));
    console.log(`  [FIX] ${rel}  补回 BOM`);
    fixed++;
  }

  const abs = f.replace(/'/g, "''");
  const ps = `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${abs}',[ref]$null,[ref]$e)|Out-Null; if($e.Count){'ERR '+$e.Count}else{'OK'}`;
  let r = '';
  try {
    r = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  } catch (e) {
    r = 'EXEC_FAIL';
  }
  if (r === 'OK') {
    console.log(`  [OK ] ${rel}${hasBom ? '' : '  (已修复)'}`);
  } else {
    console.log(`  [X  ] ${rel}  解析失败：${r}`);
    bad++;
  }
}

console.log(`\n  共 ${files.length} 个 .ps1：补 BOM ${fixed} 个，解析失败 ${bad} 个`);
process.exit(bad === 0 ? 0 : 1);
