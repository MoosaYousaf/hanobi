#!/usr/bin/env node
// A stand-in for the GitHub CLI. It logs each call and keeps one pull request in a state file.
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = fs.existsSync(process.env.FAKE_GH_STATE) ? JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8')) : {};
const stdin = args.includes('-') ? fs.readFileSync(0, 'utf8') : null;
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin, prompt: process.env.GH_PROMPT_DISABLED }) + '\n');
const other = { number: 7, title: 'Other work', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: true, reviewDecision: '', headRefName: 'other', baseRefName: 'main', author: { login: 'sam' }, updatedAt: '2026-10-01T00:00:00Z' };
const [a, b] = args;
if (a === 'repo' && b === 'view') process.stdout.write(JSON.stringify({ defaultBranchRef: { name: 'trunk' } }));
else if (a === 'pr' && b === 'view') {
  if (!state.pr) { process.stderr.write('no pull requests found for branch "feature"\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ ...state.pr, statusCheckRollup: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }, { __typename: 'StatusContext', state: 'SUCCESS' }] }));
} else if (a === 'pr' && b === 'list') process.stdout.write(JSON.stringify([...(state.pr ? [state.pr] : []), other]));
else if (a === 'pr' && b === 'create') {
  const title = args[args.indexOf('--title') + 1], base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'trunk';
  state.pr = { number: 12, title, url: 'https://github.com/o/r/pull/12', state: 'OPEN', isDraft: args.includes('--draft'), reviewDecision: 'REVIEW_REQUIRED', headRefName: args[args.indexOf('--head') + 1], baseRefName: base, author: { login: 'me' }, updatedAt: '2026-10-29T00:00:00Z' };
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
  process.stdout.write('Creating pull request for feature into trunk\n\nhttps://github.com/o/r/pull/12\n');
} else if (a === 'api' && b === '/copilot_internal/user') process.stdout.write(JSON.stringify({ access_type_sku: 'free_limited_copilot', quota_reset_date_utc: '2026-11-01T00:00:00.000Z', quota_snapshots: {
  chat: { entitlement: 200, remaining: 30, percent_remaining: 15, unlimited: false }, completions: { entitlement: 2000, remaining: 2000, percent_remaining: 100, unlimited: false },
  premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: false } } }));
else if (a === 'pr' && b === 'checkout') process.stdout.write('Switched\n');
else { process.stderr.write(`unknown command ${args.join(' ')}\n`); process.exit(2); }
