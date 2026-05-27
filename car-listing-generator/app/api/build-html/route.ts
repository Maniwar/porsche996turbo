import { NextRequest, NextResponse } from 'next/server';
import nunjucks from 'nunjucks';
import path from 'path';

export async function POST(req: NextRequest) {
  const { carData, photoNames, conditionPhotoNames, carfaxName, stickerName, audioFileName, hasFrames, frameCount, hasVideo } = await req.json();

  const templateDir = path.join(process.cwd(), 'lib', 'template');
  const env = nunjucks.configure(templateDir, { autoescape: true });

  // Build the photos array for the lightbox
  const lightboxPhotos = [
    ...photoNames.map((name: string, i: number) => ({ src: name, cap: carData.gallery?.photos?.[i]?.alt || name, rot: false })),
    ...conditionPhotoNames.map((name: string, i: number) => ({ src: name, cap: `Condition — ${conditionPhotoNames[i]}`, rot: false })),
  ];

  const templateData = {
    car: {
      ...carData,
      identity: carData.identity || {},
      lightboxPhotos,
      photoNames,
      conditionPhotoNames,
      carfaxName: carfaxName || null,
      stickerName: stickerName || null,
      audioFileName: audioFileName || null,
      hasFrames,
      hasVideo: hasVideo || false,
      frameCount: frameCount || 0,
      conditionPhotoStartIndex: photoNames.length,
    },
  };

  const html = env.render('car-listing.njk', templateData);
  return NextResponse.json({ html });
}
