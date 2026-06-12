'use client';
import { useState, useEffect } from 'react';
import ApiKeySetup from '@/components/ApiKeySetup';
import CarIntakeForm from '@/components/CarIntakeForm';
import GenerationProgress from '@/components/GenerationProgress';
import ExportPanel from '@/components/ExportPanel';

export type Step = 'keys' | 'intake' | 'generate' | 'export';

export type ApiKeys = {
  anthropic: string;
  falai: string;
  suno: string;
};

export type CarFormData = {
  year: string;
  make: string;
  model: string;
  platform: string;
  vin: string;
  colorName: string;
  colorCode: string;
  colorOption: string;
  interior: string;
  price: string;
  mileage: string;
  location: string;
  email: string;
  transmission: string;
  transmissionUnit: string;
  accentColor: string;
  youtubeId: string;
  specialNotes: string;
  photos: File[];
  heroPhotoIndex: number;
  conditionPhotos: File[];
  carfaxPhoto: File | null;
  stickerPhoto: File | null;
  audioFile: File | null;
  serviceRecords: ServiceVisit[];
  cosmeticNotes: string;
};

export type ServiceVisit = {
  date: string;
  mileage: string;
  title: string;
  cost: string;
  shop: string;
  items: string;
};

export type GenerationResult = {
  htmlContent: string;
  photos: { name: string; dataUrl: string }[];
  frames: { name: string; dataUrl: string }[];
  videoDataUrl?: string;
  audioDataUrl?: string;
  audioFileName?: string;
};

const STORAGE_KEY = 'clg_api_keys';

export default function Home() {
  const [step, setStep] = useState<Step>('keys');
  const [keys, setKeys] = useState<ApiKeys>({ anthropic: '', falai: '', suno: '' });
  const [formData, setFormData] = useState<CarFormData | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setKeys(JSON.parse(saved));
    } catch {}
  }, []);

  function saveKeys(k: ApiKeys) {
    setKeys(k);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(k));
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-[#1e1e1e] px-8 py-4 flex items-center justify-between">
        <div>
          <div className="text-xs text-[#c9a875] uppercase tracking-[0.2em] mb-0.5">AI-Powered</div>
          <div className="text-white font-semibold text-lg tracking-tight">Car Listing Generator</div>
        </div>
        <div className="flex gap-2">
          {(['keys', 'intake', 'generate', 'export'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold
                ${step === s ? 'bg-[#c9a875] text-black' :
                  (['keys','intake','generate','export'].indexOf(step) > i) ? 'bg-[#2a2a2a] text-[#c9a875]' : 'bg-[#1a1a1a] text-[#444]'}`}>
                {i + 1}
              </div>
              {i < 3 && <div className="w-8 h-px bg-[#222]" />}
            </div>
          ))}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10">
        {step === 'keys' && (
          <ApiKeySetup
            keys={keys}
            onSave={(k) => { saveKeys(k); setStep('intake'); }}
          />
        )}
        {step === 'intake' && (
          <CarIntakeForm
            onBack={() => setStep('keys')}
            onSubmit={(data) => { setFormData(data); setStep('generate'); }}
          />
        )}
        {step === 'generate' && formData && (
          <GenerationProgress
            keys={keys}
            formData={formData}
            onBack={() => setStep('intake')}
            onDone={(r) => { setResult(r); setStep('export'); }}
          />
        )}
        {step === 'export' && result && (
          <ExportPanel
            result={result}
            onRestart={() => { setResult(null); setFormData(null); setStep('intake'); }}
          />
        )}
      </main>
    </div>
  );
}
