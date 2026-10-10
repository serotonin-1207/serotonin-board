// Creates a department access code and prints the SQL that registers it. The code is written to .work/dept-codes.txt
// (git-ignored) and never printed, so it does not end up in terminal history or chat.
//   node scripts/new-dept.mjs dept2 "2부서" [--office]
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const office = process.argv.includes('--office');
const [id, name] = args;
if (!id || !name || !/^[a-z0-9_-]{2,30}$/.test(id) || name.length > 40) {
  console.error('사용법: node scripts/new-dept.mjs <영문-id> "<부서 이름>" [--office]\n  예: node scripts/new-dept.mjs rescue "구조대"\n  --office: 순환 근무가 아닌 내근 부서(날짜가 자정에 바뀜)');
  process.exit(1);
}
const code = crypto.randomBytes(12).toString('base64url');
const hash = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
await fs.mkdir('.work', { recursive: true });
await fs.appendFile('.work/dept-codes.txt', `${new Date().toISOString()}  ${id}  ${name}${office ? ' (내근)' : ''}\n  접속 코드: ${code}\n`);
console.log(`-- ${name} (${id})${office ? ' · 내근' : ''}: 접속 코드는 .work/dept-codes.txt 에 저장했습니다.`);
console.log(`insert into public.serotonin_depts(id, name, rotating, code_hash)\nvalues ('${id}', '${name.replace(/'/g, "''")}', ${office ? 'false' : 'true'}, '${hash}');`);
