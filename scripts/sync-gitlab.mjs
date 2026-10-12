// Copies the current code (HEAD) to the public-sector GitLab (remote "aigov") as one commit.
// The GitHub history is not pushed there: its older commits contain the publishable key, which that GitLab's secret scan
// rejects. Each sync adds one commit on top of the previous sync, so the GitLab history stays linear and readable.
// Usage: npm run sync:gitlab   (needs: git remote add aigov https://gitlab.aigov.go.kr/<user>/serotonin-board.git)
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const remote = process.env.GITLAB_REMOTE || 'aigov';

if (git('status', '--porcelain')) throw new Error('Commit or stash your changes first; only committed code is synced.');
git('fetch', remote);
let parent = '';
try {
  parent = git('rev-parse', '--verify', '--quiet', remote + '/main');
} catch {
  parent = ''; // first sync: the GitLab project is empty
}
const tree = git('rev-parse', 'HEAD^{tree}');
if (parent && git('rev-parse', parent + '^{tree}') === tree) {
  console.log('GitLab already has this code.');
  process.exit(0);
}
const head = git('log', '-1', '--format=%h %s');
const version = JSON.parse(git('show', 'HEAD:package.json')).version;
const message = (parent ? 'Sync v' + version + ' from GitHub ' : 'Serotonin board v' + version + ' (from GitHub ') + head.split(' ')[0] + (parent ? '' : ')') + '\n\n' + head + '\n';
const commit = execFileSync('git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { input: message, encoding: 'utf8' }).trim();
execFileSync('git', ['push', remote, commit + ':refs/heads/main'], { stdio: 'inherit' });
console.log('Synced ' + head + ' to ' + remote + ' as ' + commit.slice(0, 8));
