# Secret Rotation Checklist

## P0-01 Remediation Steps

### Immediate Actions (Within 24 Hours)

#### 1. Supabase Credentials
- [ ] Go to https://supabase.com/dashboard
- [ ] Navigate to Settings > API
- [ ] Regenerate SUPABASE_SERVICE_ROLE_KEY (Project Settings > API > Service Role Key > Refresh)
- [ ] Copy new key and set as Supabase edge function secret

#### 2. Google OAuth
- [ ] Go to https://console.cloud.google.com/apis/credentials
- [ ] Select your OAuth 2.0 Client ID
- [ ] Generate new client secret (or create new credentials)
- [ ] Update Google Cloud Console with new secret

#### 3. Gemini API Key
- [ ] Go to https://aistudio.google.com/app
- [ ] Navigate to API Keys
- [ ] Delete the exposed key
- [ ] Create new API key

#### 4. Groq API Key
- [ ] Go to https://console.groq.com/keys
- [ ] Delete the exposed key
- [ ] Create new API key

#### 5. Cerebras API Key
- [ ] Go to https://cloud.cerebras.ai/api-keys
- [ ] Delete the exposed key
- [ ] Create new API key

#### 6. NVIDIA API Key
- [ ] Go to https://build.nvidia.com/
- [ ] Navigate to API Keys
- [ ] Delete the exposed key
- [ ] Create new API key

#### 7. APIFreeLLM Key (if used)
- [ ] Contact APIFreeLLM provider
- [ ] Request key rotation
- [ ] Get new API key

---

### Edge Function Secrets Update

After rotating credentials, update Supabase edge function secrets:

```bash
# Supabase CLI required
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-new-key
supabase secrets set SUPABASE_URL=https://your-project.supabase.co
supabase secrets set GOOGLE_CLIENT_ID=your-new-client-id
supabase secrets set GOOGLE_CLIENT_SECRET=your-new-secret
supabase secrets set GEMINI_API_KEY=your-new-key
supabase secrets set GROQ_API_KEY=your-new-key
supabase secrets set CEREBRAS_API_KEY=your-new-key
supabase secrets set NVIDIA_API_KEY=your-new-key
supabase secrets set APIFREELLM_API_KEY=your-new-key
```

---

### Verification Steps

- [ ] Remove old .env from git history (requires git rewrite)
- [ ] Confirm .env not in git: `git log --all --oneline -- .env | head -5`
- [ ] Test all auth flows work
- [ ] Test LLM calls work
- [ ] Test calendar sync works
- [ ] Test email sync works

---

### Git History Cleanup (Optional but Recommended)

```bash
# CAUTION: Rewrites git history
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch .env' \
  --tag-filter-fe blank -- --all
```

Or use BFG Repo-Cleaner:
```bash
bfg --delete-files .env
git reflog expire --expire=now --all && git gc --prune=now --aggressive
```

---

### Timeline

| Day | Action |
|-----|--------|
| Day 0 | Rotate all credentials |
| Day 0 | Deploy new edge function secrets |
| Day 0 | Update .env on local machines |
| Day 1 | Verify all integrations work |
| Day 7 | Confirm no unauthorized access |
| Day 30 | Review access logs for anomalies |