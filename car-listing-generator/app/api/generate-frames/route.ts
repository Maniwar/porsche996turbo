import { NextRequest, NextResponse } from 'next/server';
import { fal } from '@fal-ai/client';

export async function POST(req: NextRequest) {
  const { apiKey, heroB64, heroMime } = await req.json();

  fal.config({ credentials: apiKey });

  // Upload the hero image to fal storage
  const imageBlob = await fetch(`data:${heroMime};base64,${heroB64}`).then(r => r.blob());
  const imageUrl = await fal.storage.upload(imageBlob);

  // Use fal's image-to-video (Kling) to generate a Ken Burns zoom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (fal.subscribe as any)('fal-ai/kling-video/v2.1/standard/image-to-video', {
    input: {
      prompt: 'Slow cinematic Ken Burns zoom-in, luxury automotive photography, smooth dolly push, dramatic lighting, 4K quality. No camera shake.',
      image_url: imageUrl,
      duration: '5',
      aspect_ratio: '16:9',
    },
    pollInterval: 3000,
  }) as { data: { video: { url: string } } };

  const videoUrl = result.data.video.url;

  return NextResponse.json({ videoUrl, mode: 'video' });
}
