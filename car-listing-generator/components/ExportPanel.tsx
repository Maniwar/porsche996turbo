'use client';
import { useState } from 'react';
import { Download, RefreshCw, ExternalLink } from 'lucide-react';
import type { GenerationResult } from '@/app/page';

export default function ExportPanel({ result, onRestart }: {
  result: GenerationResult;
  onRestart: () => void;
}) {
  const [downloading, setDownloading] = useState(false);

  async function downloadZip() {
    setDownloading(true);
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      zip.file('index.html', result.htmlContent);

      for (const photo of result.photos) {
        const base64 = photo.dataUrl.split(',')[1];
        zip.file(photo.name, base64, { base64: true });
      }

      for (const frame of result.frames) {
        const base64 = frame.dataUrl.split(',')[1];
        zip.file(frame.name, base64, { base64: true });
      }

      if (result.videoDataUrl) {
        const base64 = result.videoDataUrl.split(',')[1];
        zip.file('hero-video.mp4', base64, { base64: true });
      }

      if (result.audioDataUrl && result.audioFileName) {
        const base64 = result.audioDataUrl.split(',')[1];
        zip.file(result.audioFileName, base64, { base64: true });
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'car-listing.zip';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  const previewUrl = URL.createObjectURL(
    new Blob([result.htmlContent], { type: 'text/html' })
  );

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="text-xs text-[#c9a875] uppercase tracking-widest mb-2">Step 4</div>
          <h1 className="text-2xl font-bold text-white mb-1">Your Listing is Ready</h1>
          <p className="text-sm text-[#666]">Download the ZIP and deploy to GitHub Pages, Netlify, or any static host.</p>
        </div>
        <button onClick={onRestart} className="btn-ghost flex items-center gap-2">
          <RefreshCw size={14} /> New Listing
        </button>
      </div>

      <div className="card mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white">Preview</h3>
          <a href={previewUrl} target="_blank" rel="noreferrer" className="text-xs text-[#c9a875] flex items-center gap-1 hover:underline">
            Open in tab <ExternalLink size={10} />
          </a>
        </div>
        <iframe
          src={previewUrl}
          className="w-full rounded-lg border border-[#222]"
          style={{ height: '520px' }}
          title="Listing Preview"
        />
      </div>

      <div className="card mb-6">
        <h3 className="section-heading">What's in the ZIP</h3>
        <div className="grid grid-cols-2 gap-3 text-xs text-[#666]">
          <div className="flex items-center gap-2"><span className="text-[#c9a875]">index.html</span> — complete self-contained listing page</div>
          {result.videoDataUrl
            ? <div className="flex items-center gap-2"><span className="text-[#c9a875]">hero-video.mp4</span> — cinematic hero animation</div>
            : result.frames.length > 0
              ? <div className="flex items-center gap-2"><span className="text-[#c9a875]">frames/</span> — {result.frames.length} hero animation frames</div>
              : <div className="flex items-center gap-2"><span className="text-[#444]">no animation</span> — static hero photo used</div>
          }
          <div className="flex items-center gap-2"><span className="text-[#c9a875]">{result.photos.length} photos</span> — all gallery + condition images</div>
          {result.audioFileName && <div className="flex items-center gap-2"><span className="text-[#c9a875]">{result.audioFileName}</span> — ambient audio</div>}
        </div>
      </div>

      <div className="flex gap-3">
        <button onClick={downloadZip} disabled={downloading} className="btn-gold flex items-center gap-2">
          <Download size={15} />
          {downloading ? 'Zipping...' : 'Download ZIP'}
        </button>
      </div>

      <div className="mt-6 card bg-[#0f0f0f]">
        <h3 className="text-xs font-semibold text-[#555] uppercase tracking-wide mb-3">Deploy to GitHub Pages</h3>
        <ol className="text-xs text-[#555] space-y-1.5 list-decimal list-inside">
          <li>Create a new GitHub repository (public)</li>
          <li>Unzip the download and push all files to <code className="text-[#888]">main</code> branch</li>
          <li>Go to Settings → Pages → Source: <code className="text-[#888]">main / root</code></li>
          <li>Your listing is live at <code className="text-[#888]">yourusername.github.io/repo-name</code></li>
        </ol>
      </div>
    </div>
  );
}
