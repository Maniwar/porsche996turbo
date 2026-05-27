'use client';
import { useState } from 'react';
import { Eye, EyeOff, Key } from 'lucide-react';
import type { ApiKeys } from '@/app/page';

export default function ApiKeySetup({ keys, onSave }: { keys: ApiKeys; onSave: (k: ApiKeys) => void }) {
  const [vals, setVals] = useState(keys);
  const [show, setShow] = useState({ anthropic: false, falai: false, suno: false });

  const set = (k: keyof ApiKeys, v: string) => setVals(prev => ({ ...prev, [k]: v }));
  const toggle = (k: keyof ApiKeys) => setShow(prev => ({ ...prev, [k]: !prev[k] }));

  const canProceed = vals.anthropic.trim().length > 10 && vals.falai.trim().length > 10;

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-8">
        <div className="text-xs text-[#c9a875] uppercase tracking-widest mb-2">Step 1</div>
        <h1 className="text-2xl font-bold text-white mb-2">API Keys</h1>
        <p className="text-sm text-[#666]">Keys are saved to your browser only — never stored on any server.</p>
      </div>

      <div className="space-y-5">
        {([
          { key: 'anthropic', label: 'Anthropic API Key', hint: 'claude.ai/settings → API Keys', placeholder: 'sk-ant-...' },
          { key: 'falai',     label: 'Fal.ai API Key',    hint: 'fal.ai/dashboard → Keys', placeholder: 'fal-...' },
          { key: 'suno',      label: 'Suno API Key (optional)', hint: 'Upload audio manually if you skip this', placeholder: 'Leave blank to upload audio manually' },
        ] as { key: keyof ApiKeys; label: string; hint: string; placeholder: string }[]).map(({ key, label, hint, placeholder }) => (
          <div key={key} className="card">
            <div className="flex items-center gap-2 mb-3">
              <Key size={14} className="text-[#c9a875]" />
              <span className="text-sm font-medium text-white">{label}</span>
            </div>
            <p className="text-xs text-[#555] mb-3">{hint}</p>
            <div className="relative">
              <input
                type={show[key] ? 'text' : 'password'}
                className="input pr-10"
                placeholder={placeholder}
                value={vals[key]}
                onChange={e => set(key, e.target.value)}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => toggle(key)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#555] hover:text-white transition-colors"
              >
                {show[key] ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 flex justify-end">
        <button className="btn-gold" disabled={!canProceed} onClick={() => onSave(vals)}>
          Continue to Car Info →
        </button>
      </div>
    </div>
  );
}
