'use client';
import { useEffect, useState, useRef } from 'react';
import { CheckCircle, Circle, Loader, AlertCircle } from 'lucide-react';
import type { ApiKeys, CarFormData, GenerationResult } from '@/app/page';

type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

type GenStep = {
  id: string;
  label: string;
  detail: string;
  status: StepStatus;
  progress?: string;
};

const INITIAL_STEPS: GenStep[] = [
  { id: 'copy',   label: 'Writing listing copy',          detail: 'Claude analyzes photos + inputs → generates all text and structured data', status: 'pending' },
  { id: 'frames', label: 'Generating hero animation',      detail: 'Fal.ai creates 80 cinematic frames from the hero photo',                  status: 'pending' },
  { id: 'audio',  label: 'Processing audio',               detail: 'Attaching uploaded audio file',                                           status: 'pending' },
  { id: 'html',   label: 'Assembling listing HTML',        detail: 'Rendering final page from template + generated data',                      status: 'pending' },
];

function StepRow({ step }: { step: GenStep }) {
  return (
    <div className={`flex items-start gap-4 p-4 rounded-lg transition-colors
      ${step.status === 'running' ? 'bg-[#1a1a1a] border border-[#2a2a2a]' : ''}`}>
      <div className="mt-0.5 flex-shrink-0">
        {step.status === 'pending'  && <Circle size={18} className="text-[#333]" />}
        {step.status === 'running'  && <Loader  size={18} className="text-[#c9a875] animate-spin" />}
        {step.status === 'done'     && <CheckCircle size={18} className="text-emerald-500" />}
        {step.status === 'error'    && <AlertCircle size={18} className="text-red-500" />}
        {step.status === 'skipped'  && <Circle size={18} className="text-[#333]" />}
      </div>
      <div className="flex-1">
        <div className={`text-sm font-medium ${step.status === 'pending' || step.status === 'skipped' ? 'text-[#555]' : 'text-white'}`}>
          {step.label}
          {step.status === 'skipped' && <span className="ml-2 text-xs text-[#444]">skipped</span>}
        </div>
        <div className="text-xs text-[#444] mt-0.5">{step.progress || step.detail}</div>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function GenerationProgress({ keys, formData, onBack, onDone }: {
  keys: ApiKeys;
  formData: CarFormData;
  onBack: () => void;
  onDone: (result: GenerationResult) => void;
}) {
  const [steps, setSteps] = useState<GenStep[]>(INITIAL_STEPS);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const started = useRef(false);

  function updateStep(id: string, patch: Partial<GenStep>) {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }
  function addLog(msg: string) { setLog(prev => [...prev, msg]); }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
  }, []);

  async function run() {
    try {
      // ── Step 1: Generate copy via Claude ──
      updateStep('copy', { status: 'running', progress: 'Sending photos and car details to Claude...' });
      addLog('Preparing photos for Claude Vision...');

      const photoB64s = await Promise.all(
        formData.photos.slice(0, 10).map(f => fileToBase64(f))
      );

      const serviceText = formData.serviceRecords.map((v, i) =>
        `Visit ${i+1}: ${v.date}, ${v.mileage} miles, ${v.title}, ${v.cost} at ${v.shop}.\nItems: ${v.items}`
      ).join('\n\n');

      addLog('Calling Claude API...');
      const copyRes = await fetch('/api/generate-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: keys.anthropic,
          car: {
            year: formData.year, make: formData.make, model: formData.model,
            platform: formData.platform, vin: formData.vin,
            colorName: formData.colorName, colorCode: formData.colorCode, colorOption: formData.colorOption,
            interior: formData.interior, price: formData.price, mileage: formData.mileage,
            location: formData.location, email: formData.email,
            transmission: formData.transmission, transmissionUnit: formData.transmissionUnit,
            accentColor: formData.accentColor, youtubeId: formData.youtubeId,
            specialNotes: formData.specialNotes, cosmeticNotes: formData.cosmeticNotes,
            serviceText,
            photoCount: formData.photos.length,
            photoNames: formData.photos.map(f => f.name),
            conditionPhotoCount: formData.conditionPhotos.length,
          },
          photoB64s,
        }),
      });

      if (!copyRes.ok) throw new Error(`Copy generation failed: ${await copyRes.text()}`);
      const { carData } = await copyRes.json();
      addLog('Claude copy generation complete.');
      updateStep('copy', { status: 'done', progress: 'All listing copy generated.' });

      // ── Step 2: Generate frames via Fal.ai ──
      updateStep('frames', { status: 'running', progress: 'Sending hero photo to Fal.ai...' });
      addLog('Calling Fal.ai for hero animation...');

      const heroFile = formData.photos[formData.heroPhotoIndex] || formData.photos[0];
      let frames: { name: string; dataUrl: string }[] = [];
      let videoDataUrl: string | undefined;

      if (heroFile && keys.falai) {
        const heroB64 = await fileToBase64(heroFile);
        const framesRes = await fetch('/api/generate-frames', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: keys.falai, heroB64, heroMime: heroFile.type }),
        });
        if (framesRes.ok) {
          const { videoUrl } = await framesRes.json();
          updateStep('frames', { status: 'running', progress: 'Downloading hero video...' });
          const videoBlob = await fetch(videoUrl).then(r => r.blob());
          videoDataUrl = await fileToDataUrl(new File([videoBlob], 'hero-video.mp4', { type: 'video/mp4' }));
          addLog('Hero animation video downloaded.');
          updateStep('frames', { status: 'done', progress: 'Hero animation video ready.' });
        } else {
          addLog('Fal.ai generation failed — listing will use static hero image.');
          updateStep('frames', { status: 'skipped', progress: 'Frame generation failed — static fallback will be used.' });
        }
      } else {
        addLog('Fal.ai key not provided — skipping animation.');
        updateStep('frames', { status: 'skipped', progress: 'No Fal.ai key — animation skipped.' });
      }

      // ── Step 3: Audio ──
      let audioDataUrl: string | undefined;
      let audioFileName: string | undefined;
      if (formData.audioFile) {
        updateStep('audio', { status: 'running', progress: 'Reading uploaded audio file...' });
        audioDataUrl = await fileToDataUrl(formData.audioFile);
        audioFileName = formData.audioFile.name;
        updateStep('audio', { status: 'done', progress: `Audio attached: ${formData.audioFile.name}` });
        addLog('Audio file attached.');
      } else {
        updateStep('audio', { status: 'skipped', progress: 'No audio file — audio player will be hidden.' });
      }

      // Build photo data URLs for ZIP
      const allPhotos = await Promise.all(
        [...formData.photos, ...formData.conditionPhotos,
          ...(formData.carfaxPhoto ? [formData.carfaxPhoto] : []),
          ...(formData.stickerPhoto ? [formData.stickerPhoto] : [])
        ].map(async f => ({ name: f.name, dataUrl: await fileToDataUrl(f) }))
      );

      // ── Step 4: Build HTML ──
      updateStep('html', { status: 'running', progress: 'Rendering Nunjucks template...' });
      addLog('Assembling final HTML...');

      const htmlRes = await fetch('/api/build-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carData,
          photoNames: formData.photos.map(f => f.name),
          conditionPhotoNames: formData.conditionPhotos.map(f => f.name),
          carfaxName: formData.carfaxPhoto?.name,
          stickerName: formData.stickerPhoto?.name,
          audioFileName,
          hasFrames: frames.length > 0,
          hasVideo: !!videoDataUrl,
          frameCount: frames.length || 0,
        }),
      });

      if (!htmlRes.ok) throw new Error(`HTML build failed: ${await htmlRes.text()}`);
      const { html } = await htmlRes.json();
      updateStep('html', { status: 'done', progress: 'Listing page assembled.' });
      addLog('Done! Your listing is ready.');

      onDone({ htmlContent: html, photos: allPhotos, frames, videoDataUrl, audioDataUrl, audioFileName });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      addLog(`Error: ${msg}`);
    }
  }

  const allDone = steps.every(s => s.status === 'done' || s.status === 'skipped');

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-6">
        <div className="text-xs text-[#c9a875] uppercase tracking-widest mb-2">Step 3</div>
        <h1 className="text-2xl font-bold text-white mb-1">Generating Your Listing</h1>
        <p className="text-sm text-[#666]">This takes 1–3 minutes depending on Fal.ai frame generation.</p>
      </div>

      <div className="card space-y-1 mb-6">
        {steps.map(s => <StepRow key={s.id} step={s} />)}
      </div>

      {log.length > 0 && (
        <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-4 mb-6 font-mono text-xs text-[#555] space-y-0.5 max-h-32 overflow-y-auto">
          {log.map((l, i) => <div key={i}>&gt; {l}</div>)}
        </div>
      )}

      {error && (
        <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-4 mb-6 text-sm text-red-400">
          <strong>Error:</strong> {error}
        </div>
      )}

      <div className="flex justify-between">
        <button className="btn-ghost" onClick={onBack} disabled={!error && !allDone}>← Back</button>
        {allDone && <div className="text-sm text-emerald-400 font-medium">✓ Ready — proceeding to export...</div>}
      </div>
    </div>
  );
}
