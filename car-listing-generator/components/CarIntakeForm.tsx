'use client';
import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, X, Plus, Star } from 'lucide-react';
import type { CarFormData, ServiceVisit } from '@/app/page';

const EMPTY_VISIT: ServiceVisit = { date: '', mileage: '', title: '', cost: '', shop: '', items: '' };

const DEFAULT: CarFormData = {
  year: '', make: '', model: '', platform: '', vin: '',
  colorName: '', colorCode: '', colorOption: '', interior: 'Black Full Leather',
  price: '', mileage: '', location: '', email: '',
  transmission: '', transmissionUnit: '', accentColor: '#bf3a1c',
  youtubeId: '', specialNotes: '',
  photos: [], heroPhotoIndex: 0, conditionPhotos: [],
  carfaxPhoto: null, stickerPhoto: null, audioFile: null,
  serviceRecords: [{ ...EMPTY_VISIT }],
  cosmeticNotes: '',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function PhotoDropzone({ label, multiple, onFiles, files, onRemove, heroIndex, onSetHero }:
  { label: string; multiple: boolean; onFiles: (f: File[]) => void; files: File[];
    onRemove: (i: number) => void; heroIndex?: number; onSetHero?: (i: number) => void }) {
  const onDrop = useCallback((accepted: File[]) => onFiles(accepted), [onFiles]);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: { 'image/*': [] }, multiple });

  return (
    <div>
      <label className="label">{label}</label>
      <div {...getRootProps()} className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
        ${isDragActive ? 'border-[#c9a875] bg-[#c9a87510]' : 'border-[#2a2a2a] hover:border-[#3a3a3a]'}`}>
        <input {...getInputProps()} />
        <Upload size={20} className="mx-auto mb-2 text-[#555]" />
        <p className="text-xs text-[#555]">{isDragActive ? 'Drop here' : 'Drag & drop or click to select'}</p>
      </div>
      {files.length > 0 && (
        <div className="mt-3 grid grid-cols-4 gap-2">
          {files.map((f, i) => (
            <div key={i} className="relative group rounded-lg overflow-hidden bg-[#111] border border-[#222]">
              <img src={URL.createObjectURL(f)} alt="" className="w-full h-20 object-cover" />
              {onSetHero && (
                <button onClick={() => onSetHero(i)}
                  className={`absolute top-1 left-1 p-0.5 rounded transition-colors ${heroIndex === i ? 'text-[#c9a875]' : 'text-white/40 hover:text-[#c9a875]'}`}
                  title="Set as hero (used for animation)">
                  <Star size={12} fill={heroIndex === i ? 'currentColor' : 'none'} />
                </button>
              )}
              <button onClick={() => onRemove(i)}
                className="absolute top-1 right-1 bg-black/60 rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-white">
                <X size={10} />
              </button>
              <div className="px-1.5 py-1 text-[9px] text-[#555] truncate">{f.name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CarIntakeForm({ onBack, onSubmit }: {
  onBack: () => void;
  onSubmit: (data: CarFormData) => void;
}) {
  const [data, setData] = useState<CarFormData>(DEFAULT);
  const [tab, setTab] = useState<'info' | 'photos' | 'service'>('info');

  const set = (k: keyof CarFormData, v: unknown) => setData(prev => ({ ...prev, [k]: v }));

  function addVisit() { set('serviceRecords', [...data.serviceRecords, { ...EMPTY_VISIT }]); }
  function removeVisit(i: number) { set('serviceRecords', data.serviceRecords.filter((_, idx) => idx !== i)); }
  function setVisit(i: number, k: keyof ServiceVisit, v: string) {
    const updated = data.serviceRecords.map((r, idx) => idx === i ? { ...r, [k]: v } : r);
    set('serviceRecords', updated);
  }

  const canSubmit = data.year && data.make && data.model && data.vin && data.price && data.email && data.photos.length > 0;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <div className="text-xs text-[#c9a875] uppercase tracking-widest mb-2">Step 2</div>
        <h1 className="text-2xl font-bold text-white mb-1">Car Information</h1>
        <p className="text-sm text-[#666]">Claude will use this to write all the listing copy and specs.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-[#111] p-1 rounded-lg w-fit">
        {(['info', 'photos', 'service'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-md text-sm font-medium transition-colors
              ${tab === t ? 'bg-[#1e1e1e] text-white' : 'text-[#555] hover:text-white'}`}>
            {t === 'info' ? 'Car Info' : t === 'photos' ? 'Photos' : 'Service Records'}
          </button>
        ))}
      </div>

      {tab === 'info' && (
        <div className="space-y-5">
          <div className="card">
            <h3 className="section-heading">Identity</h3>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Year"><input className="input" value={data.year} onChange={e => set('year', e.target.value)} placeholder="2003" /></Field>
              <Field label="Make"><input className="input" value={data.make} onChange={e => set('make', e.target.value)} placeholder="Porsche" /></Field>
              <Field label="Model"><input className="input" value={data.model} onChange={e => set('model', e.target.value)} placeholder="911 Turbo" /></Field>
              <Field label="Platform / Gen"><input className="input" value={data.platform} onChange={e => set('platform', e.target.value)} placeholder="996" /></Field>
              <Field label="VIN"><input className="input col-span-2" value={data.vin} onChange={e => set('vin', e.target.value)} placeholder="WP0AB29983S687118" /></Field>
            </div>
          </div>

          <div className="card">
            <h3 className="section-heading">Listing</h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Asking Price"><input className="input" value={data.price} onChange={e => set('price', e.target.value)} placeholder="$59,900" /></Field>
              <Field label="Mileage"><input className="input" value={data.mileage} onChange={e => set('mileage', e.target.value)} placeholder="94,702" /></Field>
              <Field label="Location"><input className="input" value={data.location} onChange={e => set('location', e.target.value)} placeholder="McKinney, TX" /></Field>
              <Field label="Contact Email"><input className="input" value={data.email} onChange={e => set('email', e.target.value)} placeholder="you@email.com" /></Field>
            </div>
          </div>

          <div className="card">
            <h3 className="section-heading">Paint &amp; Interior</h3>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Color Name"><input className="input" value={data.colorName} onChange={e => set('colorName', e.target.value)} placeholder="Zanzibar Red" /></Field>
              <Field label="Paint Code"><input className="input" value={data.colorCode} onChange={e => set('colorCode', e.target.value)} placeholder="L1A8" /></Field>
              <Field label="Option Code"><input className="input" value={data.colorOption} onChange={e => set('colorOption', e.target.value)} placeholder="00501" /></Field>
              <Field label="Interior">
                <input className="input" value={data.interior} onChange={e => set('interior', e.target.value)} placeholder="Black Full Leather" />
              </Field>
              <Field label="Page Accent Color">
                <div className="flex gap-2 items-center">
                  <input type="color" value={data.accentColor} onChange={e => set('accentColor', e.target.value)}
                    className="w-10 h-10 rounded cursor-pointer bg-transparent border border-[#2a2a2a]" />
                  <input className="input flex-1" value={data.accentColor} onChange={e => set('accentColor', e.target.value)} />
                </div>
              </Field>
            </div>
          </div>

          <div className="card">
            <h3 className="section-heading">Powertrain</h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Transmission Type"><input className="input" value={data.transmission} onChange={e => set('transmission', e.target.value)} placeholder="5-speed Tiptronic S" /></Field>
              <Field label="Transmission Unit"><input className="input" value={data.transmissionUnit} onChange={e => set('transmissionUnit', e.target.value)} placeholder="Mercedes-Benz 722.6 (W5A580)" /></Field>
            </div>
          </div>

          <div className="card">
            <h3 className="section-heading">Optional</h3>
            <div className="grid grid-cols-1 gap-4">
              <Field label="YouTube Video ID (cold start / exhaust)">
                <input className="input" value={data.youtubeId} onChange={e => set('youtubeId', e.target.value)} placeholder="FuedB67vqxo" />
              </Field>
              <Field label="Special Notes for Claude">
                <textarea className="input min-h-[80px] resize-y" value={data.specialNotes} onChange={e => set('specialNotes', e.target.value)}
                  placeholder="Rarity details, recent upgrades, anything Claude should know about this specific car..." />
              </Field>
            </div>
          </div>
        </div>
      )}

      {tab === 'photos' && (
        <div className="space-y-5">
          <div className="card">
            <h3 className="section-heading">Gallery Photos</h3>
            <p className="text-xs text-[#555] mb-4">Star (★) the hero photo — Fal.ai will use it to generate the animated frames.</p>
            <PhotoDropzone
              label="Exterior, Interior, Detail Photos"
              multiple={true}
              files={data.photos}
              heroIndex={data.heroPhotoIndex}
              onSetHero={i => set('heroPhotoIndex', i)}
              onFiles={files => set('photos', [...data.photos, ...files])}
              onRemove={i => set('photos', data.photos.filter((_, idx) => idx !== i))}
            />
          </div>

          <div className="card">
            <h3 className="section-heading">Cosmetic Condition Photos</h3>
            <p className="text-xs text-[#555] mb-4">Wear, trim issues, scratches. These go in the Full Disclosure section.</p>
            <PhotoDropzone
              label="Condition / Disclosure Photos"
              multiple={true}
              files={data.conditionPhotos}
              onFiles={files => set('conditionPhotos', [...data.conditionPhotos, ...files])}
              onRemove={i => set('conditionPhotos', data.conditionPhotos.filter((_, idx) => idx !== i))}
            />
            <div className="mt-4">
              <Field label="Written Condition Notes">
                <textarea className="input min-h-[80px] resize-y" value={data.cosmeticNotes}
                  onChange={e => set('cosmeticNotes', e.target.value)}
                  placeholder="Soft-touch plastic degradation on switch panels, scratch marks on driver door panel..." />
              </Field>
            </div>
          </div>

          <div className="card">
            <h3 className="section-heading">Documents</h3>
            <div className="grid grid-cols-2 gap-4">
              <PhotoDropzone label="CARFAX Screenshot" multiple={false}
                files={data.carfaxPhoto ? [data.carfaxPhoto] : []}
                onFiles={files => set('carfaxPhoto', files[0] || null)}
                onRemove={() => set('carfaxPhoto', null)} />
              <PhotoDropzone label="Option Sticker / Build Sheet" multiple={false}
                files={data.stickerPhoto ? [data.stickerPhoto] : []}
                onFiles={files => set('stickerPhoto', files[0] || null)}
                onRemove={() => set('stickerPhoto', null)} />
            </div>
          </div>

          <div className="card">
            <h3 className="section-heading">Audio File</h3>
            <p className="text-xs text-[#555] mb-3">Upload a Suno-generated MP3, or leave blank to skip the ambient audio player.</p>
            <PhotoDropzone label="Audio (.mp3)" multiple={false}
              files={data.audioFile ? [data.audioFile] : []}
              onFiles={files => set('audioFile', files[0] || null)}
              onRemove={() => set('audioFile', null)} />
          </div>
        </div>
      )}

      {tab === 'service' && (
        <div className="space-y-4">
          <div className="card">
            <p className="text-xs text-[#555] mb-4">Enter each service visit. Claude will use this to write the service history section and compute totals.</p>
            {data.serviceRecords.map((v, i) => (
              <div key={i} className="border border-[#222] rounded-lg p-4 mb-4 relative">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-xs font-medium text-[#c9a875] uppercase tracking-wide">Visit {i + 1}</span>
                  {data.serviceRecords.length > 1 && (
                    <button onClick={() => removeVisit(i)} className="text-[#444] hover:text-red-400 transition-colors"><X size={14} /></button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Date"><input className="input" value={v.date} onChange={e => setVisit(i, 'date', e.target.value)} placeholder="March 2025" /></Field>
                  <Field label="Mileage at Service"><input className="input" value={v.mileage} onChange={e => setVisit(i, 'mileage', e.target.value)} placeholder="89,600" /></Field>
                  <Field label="Service Title"><input className="input" value={v.title} onChange={e => setVisit(i, 'title', e.target.value)} placeholder="Major Service — Suspension Refresh" /></Field>
                  <Field label="Total Cost"><input className="input" value={v.cost} onChange={e => setVisit(i, 'cost', e.target.value)} placeholder="$13,698" /></Field>
                  <Field label="Shop / Dealer"><input className="input" value={v.shop} onChange={e => setVisit(i, 'shop', e.target.value)} placeholder="RAC Performance" /></Field>
                  <Field label="Line Items (one per line)">
                    <textarea className="input min-h-[80px] resize-y" value={v.items}
                      onChange={e => setVisit(i, 'items', e.target.value)}
                      placeholder={"Full Suspension Overhaul\nB4 Rear Struts (New)\nATF Service\nOil Change"} />
                  </Field>
                </div>
              </div>
            ))}
            <button onClick={addVisit} className="btn-ghost w-full flex items-center justify-center gap-2 mt-2">
              <Plus size={14} /> Add Service Visit
            </button>
          </div>
        </div>
      )}

      <div className="mt-8 flex justify-between">
        <button className="btn-ghost" onClick={onBack}>← Back</button>
        <button className="btn-gold" disabled={!canSubmit} onClick={() => onSubmit(data)}>
          Generate Listing →
        </button>
      </div>
      {!canSubmit && (
        <p className="text-xs text-[#444] text-right mt-2">
          Required: year, make, model, VIN, price, email, and at least one photo
        </p>
      )}
    </div>
  );
}
