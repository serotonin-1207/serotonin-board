// Public Supabase settings for the builds. The project address lives in supabase/public-config.json; the publishable key is
// public too (every visitor's browser receives it), but it is kept out of the repository so secret scanners do not flag it.
// It comes from the SUPABASE_PUBLISHABLE_KEY environment variable (GitHub Actions repository variable) or, on a developer PC,
// from the git-ignored file supabase/public-config.local.json ({ "publishableKey": "sb_publishable_..." }).
import fs from 'node:fs/promises';

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

export async function publicConfig() {
  const shared = await readJson('supabase/public-config.json');
  const local = await readJson('supabase/public-config.local.json');
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || local.publishableKey || '';
  if (publishableKey && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))
    throw new Error('SUPABASE_PUBLISHABLE_KEY must be a publishable key (sb_publishable_...). Never use a secret or service_role key.');
  if (!publishableKey && process.env.CI) throw new Error('SUPABASE_PUBLISHABLE_KEY is not set (GitHub: Settings → Secrets and variables → Actions → Variables).');
  if (!publishableKey) console.warn('No publishable key: the board will ask for it in its connection settings.');
  return { ...shared, ...local, publishableKey };
}
