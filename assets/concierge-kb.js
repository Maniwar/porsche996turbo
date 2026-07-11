/*
 * concierge-kb.js — client-side knowledge base for the 2003 Porsche 911 Turbo concierge.
 * Emitted by concierge-kit from templates/concierge-kb.js.tmpl: images from
 * generated images.json (empty when absent — the engine merges admin-added
 * images at runtime), starters from generated starters.json (or a generic
 * per-goal set), demo answers from generated demo.json (or a generic set),
 * greeting from generated greeting.txt.
 * Plain browser script, no modules, no dependencies.
 *
 * Sets window.PORSCHE_KB = {
 *   images:    { token: { src, alt } }            — image tokens usable as {{img:token}}
 *   suggested: { sectionId: [q1, q2, q3], default: [...] }
 *   demo:      [ { match: [lowercase keywords], answer: 'markdown string' }, ... ]
 *   greeting:  markdown string — the concierge's opening message
 * }
 */
(function () {
  'use strict';

  window.PORSCHE_KB = {
    images: {
    "samsung-frame-tv-image-1": {
      "src": "samsung-frame-tv-image%20%281%29.png",
      "alt": "Zanzibar Red at golden sunset — cinematic side profile"
    },
    "full-side-profile-spring-roses": {
      "src": "20260404_174336.jpg",
      "alt": "Full side profile — spring roses background"
    },
    "front-3-4-midday-sun": {
      "src": "20250713_152957.jpg",
      "alt": "Front 3/4 — midday sun"
    },
    "side-profile-garage-blue-dusk": {
      "src": "20250706_210207.jpg",
      "alt": "Side profile — garage, blue dusk"
    },
    "rear-3-4-clean": {
      "src": "20250621_163849(1).jpg",
      "alt": "Rear 3/4 — clean"
    },
    "rear-turbo-script": {
      "src": "20250822_100255.jpg",
      "alt": "Rear — Turbo script"
    },
    "side-profile-dusk": {
      "src": "20250706_210134.jpg",
      "alt": "Side profile — dusk"
    },
    "wheel-red-porsche-caliper": {
      "src": "20260322_131938.jpg",
      "alt": "Wheel — red Porsche caliper"
    },
    "fender-roses": {
      "src": "20260404_171344.jpg",
      "alt": "Fender + roses"
    },
    "interior-black-leather": {
      "src": "20260515_121608.jpg",
      "alt": "Interior — black leather"
    },
    "side-profile-home": {
      "src": "20260404_174259.jpg",
      "alt": "Side profile — home"
    },
    "interior-steering": {
      "src": "interior-steering.jpg",
      "alt": "996 Turbo cockpit — Porsche crest steering wheel"
    },
    "interior-gauges": {
      "src": "interior-gauges.jpg",
      "alt": "Gauge cluster — 94,702 miles documented"
    },
    "front-3-4-parking-lot": {
      "src": "20250621_173938(1).jpg",
      "alt": "Front 3/4 — parking lot"
    },
    "rear-3-4-parking-lot": {
      "src": "20250621_163849.jpg",
      "alt": "Rear 3/4 — parking lot"
    },
    "front-overhead-door-open": {
      "src": "20250621_173915(1).jpg",
      "alt": "Front overhead — door open"
    },
    "option-sticker": {
      "src": "option_sticker.jpg",
      "alt": "Factory option sticker"
    },
    "spring-roses-alt-angle": {
      "src": "20260404_171327.jpg",
      "alt": "Spring roses — alt angle"
    },
    "interior-door-open": {
      "src": "20260515_121543.jpg",
      "alt": "Interior — door open"
    },
    "interior-detail": {
      "src": "20260515_121615.jpg",
      "alt": "Interior detail"
    },
    "trim-door-panel": {
      "src": "trim-door-panel.jpg",
      "alt": "Driver door panel scratches"
    },
    "trim-mirror-control": {
      "src": "trim-mirror-control.jpg",
      "alt": "Mirror control trim cracking"
    },
    "trim-switch-left": {
      "src": "trim-switch-left.jpg",
      "alt": "Switch panel soft-coat"
    },
    "trim-switch-right": {
      "src": "trim-switch-right.jpg",
      "alt": "PSM panel soft-coat"
    },
    "trim-vent-dash": {
      "src": "trim-vent-dash.jpg",
      "alt": "Dash vent area soft-coat"
    },
    "trim-ignition-surround": {
      "src": "trim-ignition-surround.jpg",
      "alt": "Ignition surround wear"
    },
    "trim-console-overview": {
      "src": "trim-console-overview.jpg",
      "alt": "Center console overview"
    },
    "document-screenshot": {
      "src": "Screenshot_20260518_110111_Chrome.jpg",
      "alt": "CARFAX vehicle history report — excerpt"
    }
  },

    videos: {
    "cold-start": {
      "src": "https://www.youtube.com/shorts/FuedB67vqxo",
      "label": "Cold start",
      "description": "A short clip of the car's cold start — share when a shopper asks to see or hear it start up."
    }
  },

    suggested: {
    "every-angle-every-light": [
      "What makes this car different?",
      "How much does it cost?",
      "What is it made of?"
    ],
    "what-makes-it-special": [
      "Will it suit my room?",
      "What are the full specs?",
      "How is it made?"
    ],
    "sec-20-407-invested-all-documented": [
      "How do I care for it?",
      "What if it gets damaged?",
      "How do returns work?"
    ],
    "serious-buyers-get-serious-answers": [
      "How do I reserve one?",
      "How long does delivery take?",
      "Is it good as a gift?"
    ],
    "default": [
      "What are the full specs?",
      "How much does it cost?",
      "How do I order one?"
    ]
  },

    demo: [
    {
      "match": [
        "price",
        "cost",
        "how much",
        "expensive",
        "afford"
      ],
      "answer": "The price is listed on this page, and there are no surprises added at the end. In this demonstration I can walk you through everything published here; for anything beyond it, write mberenji@gmail.com and a maker will reply."
    },
    {
      "match": [
        "deliver",
        "delivery",
        "ship",
        "shipping",
        "arrive",
        "how long",
        "track",
        "tracking"
      ],
      "answer": "Each car is made in small numbered batches, so delivery is confirmed when you reserve. Order-specific questions — tracking, address changes — go to mberenji@gmail.com."
    },
    {
      "match": [
        "return",
        "returns",
        "refund",
        "guarantee",
        "warranty",
        "repair",
        "damage"
      ],
      "answer": "Returns, repairs, and the guarantee are handled directly by the workshop. Write mberenji@gmail.com and a maker will reply with the details."
    },
    {
      "match": [
        "reserve",
        "buy",
        "order",
        "purchase",
        "checkout",
        "get one"
      ],
      "answer": "Reserving takes a moment — the page explains how, and nothing ships in this demonstration. If you would rather write, mberenji@gmail.com reaches the makers directly."
    }
  ],

    greeting: "Good evening — I keep the desk for 2003 Porsche 911 Turbo. Ask me anything about the car; I'll answer straight from the record.\n\n{{reply:Tell me about the history}}\n{{reply:What's the price?}}\n{{reply:Just looking}}"
  };
})();
