import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export async function POST(req: NextRequest) {
  const { apiKey, car, photoB64s } = await req.json();

  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are writing copy for a premium private-party car listing. The style is a luxury automotive magazine — not a classifieds ad. Every sentence should be specific, verifiable, and confident. No filler, no hype words like "amazing" or "stunning". Write as if the reader is a knowledgeable enthusiast buyer.

You will receive car details and photos. Your job is to output a complete JSON data object that will be used to render the listing page. Write ALL narrative copy in full — not placeholders. The JSON must be valid and complete.`;

  const userContent: Anthropic.MessageParam['content'] = [
    {
      type: 'text',
      text: `Generate a complete car listing data object for this vehicle:

CAR DETAILS:
${JSON.stringify(car, null, 2)}

OUTPUT a JSON object with this structure (fill every field with real copy):
{
  "hero": {
    "pill": "short rarity/hook statement",
    "headline": "${car.year} ${car.make} ${car.model}",
    "subline": "${car.colorName} · ${car.transmission} · ${car.location}",
    "stats": [{"label": "Asking", "value": "${car.price}"}, {"label": "Mileage", "value": "${car.mileage}"}, {"label": "Engine", "value": "..."}, {"label": "Transmission", "value": "${car.transmission}"}, {"label": "Drivetrain", "value": "AWD or RWD"}]
  },
  "snapCells": [{"label": "Year", "value": "${car.year}", "gold": false}, ...],
  "colorStory": {
    "headline": "compelling headline about the color",
    "intro": "HTML string — 2-3 sentences using perceptual/light language about how this paint looks",
    "card1Title": "...", "card1Body": "...",
    "card2Title": "...", "card2Body": "..."
  },
  "highlightCards": [
    {"icon": "star|clock|shield|document|heart|bolt|wrench|gauge|wheel", "title": "...", "body": "..."}
  ],
  "transmissionCard": {
    "enabled": true,
    "title": "...", "titleAccent": "...",
    "teaser": "one sentence about the transmission",
    "body": "full paragraph technical argument for why this transmission is great",
    "specs": [{"value": "...", "label": "..."}, ...]
  },
  "rarityBlock": {
    "enabled": true,
    "headline": "The Rarity Argument",
    "paragraphs": ["paragraph 1", "paragraph 2"],
    "boldClaim": "the key rarity claim sentence",
    "finalClaim": "This car may genuinely not exist anywhere else.",
    "badgeNumber": "1", "badgeLabel": "Known US-Spec\\n${car.colorName}\\n${car.model}"
  },
  "specsIdentity": [{"key": "Year", "value": "${car.year}", "gold": false}, ...],
  "specsPowertrain": [{"key": "Engine", "value": "...", "gold": true}, ...],
  "specsEquipment": [{"key": "Seats", "value": "..."}, ...],
  "service": {
    "totalRaw": 0,
    "visitCount": ${car.serviceRecords?.length || 0},
    "shopName": "...", "shopSubName": "...", "shopLocation": "...",
    "headline": "$X Invested. All Documented.",
    "subheadline": "2-3 sentences about the service quality and shop",
    "visits": [
      {"date": "...", "mileage": "...", "title": "...", "cost": "$...", "costRaw": 0, "featured": true, "shop": "...", "invoiceRef": "...", "items": [{"label": "...", "key": true}]}
    ],
    "highlights": [{"icon": "clock|wrench|shield|bolt", "title": "...", "body": "..."}]
  },
  "kbMoment": {"quote": "Not just ${car.colorName}.<br><em>${car.colorName}.</em><br>...", "attr": "..."},
  "contact": {"headline": "Serious Buyers Get Serious Answers", "body": "...", "note": "..."},
  "cosmeticDisclosure": {"enabled": ${car.cosmeticNotes ? 'true' : 'false'}, "headline": "Interior Trim Condition", "disclosure": "${car.cosmeticNotes || ''}"},
  "meta": {"title": "${car.year} ${car.make} ${car.model} — ${car.colorName} · For Sale · ${car.location}", "description": "..."}
}

Service records from the seller:
${car.serviceText}

Special notes: ${car.specialNotes || 'None'}
Cosmetic notes: ${car.cosmeticNotes || 'None'}

Respond with ONLY the JSON object, no markdown fences.`,
    },
    ...photoB64s.slice(0, 5).map((b64: string) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: b64 },
    })),
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = (response.content[0] as { type: 'text'; text: string }).text.trim();
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}') + 1;
  const carData = JSON.parse(text.slice(jsonStart, jsonEnd));

  // Attach pass-through identity fields
  carData.identity = car;

  return NextResponse.json({ carData });
}
