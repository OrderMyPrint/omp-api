/**
 * Catalogue reference data for the storefront UI.
 *
 * Prices are the researched market reference rates shown in the approved
 * Figma design (docs repo: docs/prd/product-catalogue-and-pricing.md §5).
 * They are display data only — the business must confirm them (D-08) and the
 * CA must confirm GST (D-28). In Phase 3 the API's pricing engine becomes the
 * single source of truth and this file is replaced by API calls.
 *
 * Options without a researched price are either included at no extra cost
 * (sizes, garment styles, colours) or marked `unavailable` with the reason,
 * so the site never shows an invented price.
 */

export type CategorySlug = "business-stationery" | "marketing-print" | "custom-transfers" | "corporate-merchandise";

export type Category = {
  slug: CategorySlug;
  name: string;
  summary: string;
  image: string;
  lead: string;
  about: string;
  bulkPrompt: { title: string; detail: string };
};

/** One quantity tier: unit price excluding GST. */
export type PriceTier = { quantity: number; unitPrice: number };

export type Choice = {
  id: string;
  label: string;
  detail?: string;
  /** Extra cost per unit, excluding GST. */
  perUnit?: number;
  /** Replaces the tier unit price (e.g. a different DTF sheet size). */
  unitPrice?: number;
  /** One-off charge per order, excluding GST. */
  perOrder?: number;
  /** Shown but not selectable; the text says why. */
  unavailable?: string;
  /** CSS colour for swatch steps. */
  swatch?: string;
};

type StepBase = {
  id: string;
  title: string;
  hint: string;
  note?: string;
  /** Shorter label for price breakdown and cart lines. */
  short?: string;
};

export type ChoiceStep = StepBase & { kind: "choice" | "swatch"; choices: Choice[]; defaultId: string };
export type MultiStep = StepBase & {
  kind: "multi";
  choices: Choice[];
  defaultIds: string[];
  /** Ask for the number of print colours per selected location. */
  coloursPerChoice?: { whenStep: string; equals: string; perColour: number; label: string };
};
export type ConfigStep = ChoiceStep | MultiStep;

export type QuantityMode =
  | { kind: "tiers"; hint: string }
  | {
      kind: "sizes";
      sizes: string[];
      surchargeSizes: string[];
      surcharge: number;
      quoteFrom: number;
      hint: string;
      /** Example breakdown shown on first load (from the Figma design). */
      defaults: Record<string, number>;
    };

export type Use = "Branding & identity" | "Events & promotions" | "Packaging & labelling" | "Team & uniforms";
export type Material = "Paper & card" | "Vinyl / film" | "Fabric";

export type Product = {
  slug: string;
  name: string;
  category: CategorySlug;
  summary: string;
  lead: string;
  image: string;
  /** Display string used on product cards, e.g. "₹399" or "₹349/pc". */
  fromPrice: string;
  /** Numeric starting price used by the price filter. */
  startingPrice: number;
  turnaround: string;
  unitNoun: { one: string; many: string };
  gstRate: number;
  tiers: PriceTier[];
  quantity: QuantityMode;
  steps: ConfigStep[];
  specs: [string, string][];
  artwork: { slots: string[]; printArea: string };
  description: string;
  uses: Use[];
  materials: Material[];
  /** Main option shown in the homepage quick price estimator. */
  estimatorOption: { label: string; choices: Choice[] };
};

export const categories: Category[] = [
  {
    slug: "business-stationery",
    name: "Business Stationery",
    summary: "Visiting cards · Letter pads · Envelopes",
    image: "/images/category-stationery.png",
    lead: "Cards, letter pads and envelopes that make every introduction count. Choose your stock, finish and quantity — see the price instantly.",
    about:
      "Business stationery printing online: visiting cards, letter pads and envelopes designed to match, printed on premium paper and delivered across India. Choose your paper weight and finish, upload your design and get a GST invoice with every business order.",
    bulkPrompt: {
      title: "Need a full stationery kit for your company?",
      detail: "Combine cards, letter pads and envelopes in one bulk quotation.",
    },
  },
  {
    slug: "marketing-print",
    name: "Marketing Print",
    summary: "Brochures · Stickers",
    image: "/images/category-marketing.png",
    lead: "Brochures and stickers that carry your brand to events, shop counters and parcels. Pick the paper or material — the price updates as you go.",
    about:
      "Marketing print online: folded brochures on coated stocks and custom stickers in paper, vinyl or transparent film. Configure the size, material and finish, upload your artwork and our pre-press team checks every file before printing.",
    bulkPrompt: {
      title: "Planning a launch or an event?",
      detail: "Get brochures, stickers and more priced together in one quotation.",
    },
  },
  {
    slug: "custom-transfers",
    name: "Custom Transfers",
    summary: "DTF stickers & gang sheets",
    image: "/images/category-transfers.png",
    lead: "Direct-to-film heat transfers for garments, bags and merchandise — order by gang sheet and press them yourself.",
    about:
      "DTF transfers printed on film, ready to heat-press onto cotton, polyester and blends. Order gang sheets in standard sizes, choose standard, glitter or glow film, and upload your own arranged sheet or let us arrange it for you.",
    bulkPrompt: {
      title: "Pressing transfers in volume?",
      detail: "Ask for a quotation on repeat or large gang-sheet orders.",
    },
  },
  {
    slug: "corporate-merchandise",
    name: "Corporate Merchandise",
    summary: "Corporate T-shirt printing",
    image: "/images/category-merchandise.png",
    lead: "Printed T-shirts for teams, events and uniforms — enter quantities by size and choose where to print.",
    about:
      "Corporate T-shirt printing with size-wise quantities, screen or DTF printing and multiple print locations. Bigger orders cost less per T-shirt, and orders of 300 pieces or more are priced by our sales team as a bulk quotation.",
    bulkPrompt: {
      title: "Ordering for your whole team?",
      detail: "Orders of 300 pieces or more, or with mixed products, are priced as a bulk quotation.",
    },
  },
];

const sharedArtworkFormats = "PDF, PNG, JPEG, SVG, CDR";

export const products: Product[] = [
  {
    slug: "visiting-cards",
    name: "Visiting Cards",
    category: "business-stationery",
    summary: "Premium stocks, matte or gloss, single or double-sided.",
    lead: "Make a lasting first impression. Choose size, stock, sides and finish — see your price update instantly.",
    image: "/images/product-visiting-cards.png",
    fromPrice: "₹399",
    startingPrice: 399,
    turnaround: "2–3",
    unitNoun: { one: "card", many: "cards" },
    gstRate: 0.18,
    tiers: [
      { quantity: 100, unitPrice: 3.99 },
      { quantity: 250, unitPrice: 2.6 },
      { quantity: 500, unitPrice: 1.8 },
      { quantity: 1000, unitPrice: 1.5 },
      { quantity: 2500, unitPrice: 1.3 },
    ],
    quantity: { kind: "tiers", hint: "Quantity tiers lower your unit price" },
    steps: [
      {
        kind: "choice",
        id: "size",
        title: "Choose size",
        short: "Size",
        hint: "Standard sizes for every wallet",
        defaultId: "standard",
        choices: [
          { id: "standard", label: "Standard", detail: "85 × 55 mm" },
          { id: "us", label: "US standard", detail: "3.5 × 2 in" },
          { id: "square", label: "Square", detail: "65 × 65 mm" },
        ],
      },
      {
        kind: "choice",
        id: "paper",
        title: "Choose paper stock",
        short: "Paper",
        hint: "Heavier stock feels more premium",
        defaultId: "premium-matte-350",
        choices: [
          { id: "classic-matte-300", label: "Classic Matte 300 GSM", detail: "Included" },
          { id: "premium-matte-350", label: "Premium Matte 350 GSM", perUnit: 0.24 },
          { id: "linen-300", label: "Textured Linen 300 GSM", perUnit: 0.44 },
          { id: "kraft-350", label: "Kraft 350 GSM", perUnit: 0.36 },
        ],
      },
      {
        kind: "choice",
        id: "sides",
        title: "Printing sides",
        short: "Printing",
        hint: "Print on one or both sides",
        defaultId: "double",
        choices: [
          { id: "single", label: "Single-sided", detail: "Front only" },
          { id: "double", label: "Double-sided", perUnit: 0.36 },
        ],
      },
      {
        kind: "choice",
        id: "finish",
        title: "Finish",
        hint: "Protect and elevate your cards",
        defaultId: "soft-touch",
        choices: [
          { id: "none", label: "No lamination", detail: "Natural feel" },
          { id: "matte", label: "Matte lamination", perUnit: 0.24 },
          { id: "soft-touch", label: "Soft-touch", perUnit: 0.4 },
        ],
      },
      {
        kind: "choice",
        id: "corners",
        title: "Corners",
        hint: "Square or rounded",
        note: "Optional · rounded corners give a premium feel",
        defaultId: "square",
        choices: [
          { id: "square", label: "Square corners", detail: "Standard" },
          { id: "rounded", label: "Rounded corners", perUnit: 0.2 },
        ],
      },
    ],
    specs: [
      ["Standard size", "85 × 55 mm"],
      ["Stocks", "300–350 GSM"],
      ["Printing", "CMYK, 1 or 2 sides"],
      ["Artwork", sharedArtworkFormats],
    ],
    artwork: { slots: ["Front", "Back"], printArea: "85 × 55 mm trim · 91 × 61 mm with 3 mm bleed" },
    description:
      "Visiting cards printed in full colour on 300–350 GSM stocks. Pick a classic matte, premium matte, textured linen or kraft stock, print one or both sides, and add matte or soft-touch lamination to protect the surface. Rounded corners are optional. Keep text at least 3 mm inside the trim for clean cut edges.",
    uses: ["Branding & identity"],
    materials: ["Paper & card"],
    estimatorOption: {
      label: "Printing",
      choices: [
        { id: "single", label: "Single-sided", perUnit: 0 },
        { id: "double", label: "Double-sided", perUnit: 0.36 },
      ],
    },
  },
  {
    slug: "letter-pads",
    name: "Letter Pads",
    category: "business-stationery",
    summary: "A4 / A5 pads in 50 or 100 sheets, glued top.",
    lead: "Branded letter pads for quotes, notes and everyday correspondence. Choose the size, paper and sheets per pad.",
    image: "/images/product-letter-pads.png",
    fromPrice: "₹1,650",
    startingPrice: 1650,
    turnaround: "3–4",
    unitNoun: { one: "pad", many: "pads" },
    gstRate: 0.18,
    tiers: [
      { quantity: 10, unitPrice: 165 },
      { quantity: 15, unitPrice: 150 },
      { quantity: 20, unitPrice: 140 },
      { quantity: 50, unitPrice: 118 },
      { quantity: 100, unitPrice: 99 },
    ],
    quantity: { kind: "tiers", hint: "Number of pads — more pads cost less each" },
    steps: [
      {
        kind: "choice",
        id: "size",
        title: "Sheet size",
        hint: "A4 for letters, A5 for notes",
        defaultId: "a4",
        choices: [
          { id: "a4", label: "A4", detail: "210 × 297 mm" },
          { id: "a5", label: "A5", detail: "148 × 210 mm" },
        ],
      },
      {
        kind: "choice",
        id: "paper",
        title: "Paper",
        hint: "Weight and texture",
        defaultId: "bond-90",
        choices: [
          { id: "bond-90", label: "Bond 90 GSM", detail: "Included" },
          { id: "premium-100", label: "Premium 100 GSM", perUnit: 10 },
          { id: "textured-120", label: "Textured 120 GSM", perUnit: 18 },
        ],
      },
      {
        kind: "choice",
        id: "sheets",
        title: "Sheets per pad",
        hint: "Glued along the top edge",
        defaultId: "50",
        choices: [
          { id: "50", label: "50 sheets", detail: "Included" },
          { id: "100", label: "100 sheets", perUnit: 60 },
        ],
      },
      {
        kind: "choice",
        id: "printing",
        title: "Printing",
        hint: "Full colour on one or both sides",
        defaultId: "front",
        choices: [
          { id: "front", label: "Colour, front only", detail: "Included" },
          { id: "both", label: "Colour, both sides", perUnit: 25 },
        ],
      },
    ],
    specs: [
      ["Sizes", "A4 · A5"],
      ["Papers", "90–120 GSM"],
      ["Sheets per pad", "50 or 100"],
      ["Artwork", sharedArtworkFormats],
    ],
    artwork: { slots: ["Front", "Back"], printArea: "A4 210 × 297 mm trim · 216 × 303 mm with 3 mm bleed" },
    description:
      "Letter pads printed in full colour and glued along the top edge. Choose A4 or A5, a bond, premium or textured paper, and 50 or 100 sheets per pad. Print the letterhead on the front only, or on both sides for terms and conditions.",
    uses: ["Branding & identity"],
    materials: ["Paper & card"],
    estimatorOption: {
      label: "Paper",
      choices: [
        { id: "bond-90", label: "Bond 90 GSM", perUnit: 0 },
        { id: "premium-100", label: "Premium 100 GSM", perUnit: 10 },
        { id: "textured-120", label: "Textured 120 GSM", perUnit: 18 },
      ],
    },
  },
  {
    slug: "envelopes",
    name: "Envelopes",
    category: "business-stationery",
    summary: "DL, C5 and C4 with optional window.",
    lead: "Printed envelopes that match your letterhead. Choose size, paper, closure and where to print.",
    image: "/images/product-envelopes.png",
    fromPrice: "₹600",
    startingPrice: 600,
    turnaround: "3–4",
    unitNoun: { one: "envelope", many: "envelopes" },
    gstRate: 0.18,
    tiers: [
      { quantity: 100, unitPrice: 6 },
      { quantity: 250, unitPrice: 4.2 },
      { quantity: 500, unitPrice: 3.1 },
      { quantity: 1000, unitPrice: 2.6 },
      { quantity: 2500, unitPrice: 2.2 },
    ],
    quantity: { kind: "tiers", hint: "Quantity tiers lower your unit price" },
    steps: [
      {
        kind: "choice",
        id: "size",
        title: "Size",
        hint: "Fits A4 folded, A5 or A4 flat",
        defaultId: "dl",
        choices: [
          { id: "dl", label: "DL", detail: "110 × 220 mm" },
          { id: "c5", label: "C5", detail: "162 × 229 mm" },
          { id: "c4", label: "C4", detail: "229 × 324 mm" },
        ],
      },
      {
        kind: "choice",
        id: "paper",
        title: "Paper",
        hint: "White or natural kraft",
        defaultId: "white-100",
        choices: [
          { id: "white-100", label: "White 100 GSM", detail: "Included" },
          { id: "white-120", label: "White 120 GSM", perUnit: 0.4 },
          { id: "kraft-120", label: "Kraft 120 GSM", perUnit: 0.6 },
        ],
      },
      {
        kind: "choice",
        id: "closure",
        title: "Closure",
        hint: "How the flap seals",
        defaultId: "gum",
        choices: [
          { id: "gum", label: "Gummed", detail: "Included" },
          { id: "peel", label: "Peel & seal", perUnit: 0.5 },
        ],
      },
      {
        kind: "choice",
        id: "printing",
        title: "Printing",
        hint: "Where your design goes",
        defaultId: "front",
        choices: [
          { id: "front", label: "Front only", detail: "Included" },
          { id: "front-flap", label: "Front + flap", perUnit: 0.8 },
        ],
      },
    ],
    specs: [
      ["Sizes", "DL · C5 · C4"],
      ["Papers", "100–120 GSM, white or kraft"],
      ["Closure", "Gummed or peel & seal"],
      ["Artwork", sharedArtworkFormats],
    ],
    artwork: { slots: ["Front", "Flap"], printArea: "DL 110 × 220 mm · keep 5 mm clear of the edges" },
    description:
      "Printed envelopes in DL, C5 and C4 sizes on white or kraft paper. Choose a gummed or peel-and-seal flap and print the front only or the front and flap. Leave the address area clear if your envelopes will be posted.",
    uses: ["Branding & identity"],
    materials: ["Paper & card"],
    estimatorOption: {
      label: "Paper",
      choices: [
        { id: "white-100", label: "White 100 GSM", perUnit: 0 },
        { id: "white-120", label: "White 120 GSM", perUnit: 0.4 },
        { id: "kraft-120", label: "Kraft 120 GSM", perUnit: 0.6 },
      ],
    },
  },
  {
    slug: "brochures",
    name: "Brochures",
    category: "marketing-print",
    summary: "Bi-fold, tri-fold and Z-fold on coated stocks.",
    lead: "Folded brochures for menus, product sheets and events. Pick the fold, paper and finish — the price updates as you go.",
    image: "/images/product-brochures.png",
    fromPrice: "₹4,500",
    startingPrice: 4500,
    turnaround: "3–5",
    unitNoun: { one: "brochure", many: "brochures" },
    gstRate: 0.18,
    tiers: [
      { quantity: 250, unitPrice: 18 },
      { quantity: 500, unitPrice: 12.5 },
      { quantity: 1000, unitPrice: 8.9 },
      { quantity: 2500, unitPrice: 6.4 },
      { quantity: 5000, unitPrice: 5.2 },
    ],
    quantity: { kind: "tiers", hint: "Quantity tiers lower your unit price" },
    steps: [
      {
        kind: "choice",
        id: "size",
        title: "Finished size",
        hint: "Size after folding",
        defaultId: "a4",
        choices: [
          { id: "a4", label: "A4", detail: "210 × 297 mm" },
          { id: "a5", label: "A5", detail: "148 × 210 mm" },
          { id: "dl", label: "DL", detail: "99 × 210 mm" },
        ],
      },
      {
        kind: "choice",
        id: "fold",
        title: "Fold",
        hint: "How the sheet opens",
        defaultId: "tri",
        choices: [
          { id: "half", label: "Bi-fold", detail: "Folded in half" },
          { id: "tri", label: "Tri-fold", detail: "Three panels" },
          { id: "z", label: "Z-fold", detail: "Opens like a zigzag" },
        ],
      },
      {
        kind: "choice",
        id: "paper",
        title: "Paper",
        hint: "Coated stocks keep colours bright",
        defaultId: "gloss-130",
        choices: [
          { id: "gloss-130", label: "130 GSM gloss", detail: "Included" },
          { id: "matte-170", label: "170 GSM matte", perUnit: 0.6 },
          { id: "silk-250", label: "250 GSM silk", perUnit: 1.4 },
        ],
      },
      {
        kind: "choice",
        id: "finish",
        title: "Finish",
        hint: "Lamination protects the cover",
        defaultId: "none",
        choices: [
          { id: "none", label: "No lamination", detail: "Natural feel" },
          { id: "gloss", label: "Gloss lamination", perUnit: 1 },
          { id: "matte", label: "Matte lamination", perUnit: 1.2 },
        ],
      },
    ],
    specs: [
      ["Sizes", "A4 · A5 · DL (folded)"],
      ["Folds", "Bi-fold · tri-fold · Z-fold"],
      ["Papers", "130–250 GSM coated"],
      ["Artwork", sharedArtworkFormats],
    ],
    artwork: { slots: ["Outside", "Inside"], printArea: "Flat sheet size with 3 mm bleed · use our fold template" },
    description:
      "Folded brochures printed in full colour on coated gloss, matte or silk stocks. Choose a bi-fold, tri-fold or Z-fold and add gloss or matte lamination for durability. Download the fold template so your panels line up with the creases.",
    uses: ["Events & promotions"],
    materials: ["Paper & card"],
    estimatorOption: {
      label: "Paper",
      choices: [
        { id: "gloss-130", label: "130 GSM gloss", perUnit: 0 },
        { id: "matte-170", label: "170 GSM matte", perUnit: 0.6 },
        { id: "silk-250", label: "250 GSM silk", perUnit: 1.4 },
      ],
    },
  },
  {
    slug: "stickers",
    name: "Stickers",
    category: "marketing-print",
    summary: "Any size and shape — paper, vinyl or transparent.",
    lead: "Custom stickers for packaging, giveaways and labels. Choose the shape, material and cut — prices shown for 50 × 50 mm.",
    image: "/images/product-stickers.png",
    fromPrice: "₹450",
    startingPrice: 450,
    turnaround: "3–4",
    unitNoun: { one: "sticker", many: "stickers" },
    gstRate: 0.18,
    tiers: [
      { quantity: 100, unitPrice: 4.5 },
      { quantity: 250, unitPrice: 2.6 },
      { quantity: 500, unitPrice: 1.9 },
      { quantity: 1000, unitPrice: 1.4 },
      { quantity: 5000, unitPrice: 0.95 },
    ],
    quantity: { kind: "tiers", hint: "Quantity tiers lower your unit price" },
    steps: [
      {
        kind: "choice",
        id: "shape",
        title: "Shape",
        hint: "50 × 50 mm reference size",
        defaultId: "circle",
        choices: [
          { id: "circle", label: "Circle" },
          { id: "square", label: "Square" },
          { id: "rounded", label: "Rounded square" },
        ],
      },
      {
        kind: "choice",
        id: "material",
        title: "Material",
        hint: "Indoor, outdoor or see-through",
        defaultId: "paper",
        choices: [
          { id: "paper", label: "Paper (matte)", detail: "Included" },
          { id: "vinyl", label: "Vinyl (waterproof)", perUnit: 0.3 },
          { id: "transparent", label: "Transparent film", perUnit: 0.4 },
        ],
      },
      {
        kind: "choice",
        id: "cut",
        title: "Cutting style",
        hint: "On a sheet or cut one by one",
        defaultId: "kiss",
        choices: [
          { id: "kiss", label: "Kiss-cut on sheet", detail: "Included" },
          { id: "die", label: "Die-cut singles", perUnit: 0.5 },
        ],
      },
    ],
    specs: [
      ["Reference size", "50 × 50 mm"],
      ["Materials", "Paper · vinyl · transparent"],
      ["Cutting", "Kiss-cut sheets or die-cut singles"],
      ["Artwork", sharedArtworkFormats],
    ],
    artwork: { slots: ["Sticker"], printArea: "50 × 50 mm · 2 mm bleed around the cut line" },
    description:
      "Custom stickers printed in full colour on matte paper, waterproof vinyl or transparent film. Choose a circle, square or rounded square and have them kiss-cut on sheets or die-cut as singles. Prices are shown for a 50 × 50 mm sticker; other sizes can be quoted.",
    uses: ["Packaging & labelling", "Events & promotions"],
    materials: ["Paper & card", "Vinyl / film"],
    estimatorOption: {
      label: "Material",
      choices: [
        { id: "paper", label: "Paper (matte)", perUnit: 0 },
        { id: "vinyl", label: "Vinyl (waterproof)", perUnit: 0.3 },
        { id: "transparent", label: "Transparent film", perUnit: 0.4 },
      ],
    },
  },
  {
    slug: "dtf-stickers",
    name: "DTF Stickers",
    category: "custom-transfers",
    summary: "Heat-transfer prints by size or by gang sheet.",
    lead: "Direct-to-film gang sheets you heat-press onto garments and bags. Choose the sheet size and film — or let us arrange your designs.",
    image: "/images/product-dtf-stickers.png",
    fromPrice: "₹249",
    startingPrice: 249,
    turnaround: "1–2",
    unitNoun: { one: "sheet", many: "sheets" },
    gstRate: 0.18,
    tiers: [
      { quantity: 1, unitPrice: 449 },
      { quantity: 2, unitPrice: 419 },
      { quantity: 3, unitPrice: 399 },
      { quantity: 5, unitPrice: 369 },
      { quantity: 10, unitPrice: 339 },
    ],
    quantity: { kind: "tiers", hint: "Tier prices apply to 22 × 48 in sheets" },
    steps: [
      {
        kind: "choice",
        id: "sheet",
        title: "Gang-sheet size",
        hint: "Fixed 22 in width",
        defaultId: "22x48",
        choices: [
          { id: "22x24", label: "22 × 24 in", unitPrice: 249 },
          { id: "22x48", label: "22 × 48 in", detail: "Tier pricing" },
          { id: "22x120", label: "22 × 120 in", unitPrice: 999 },
        ],
      },
      {
        kind: "choice",
        id: "film",
        title: "Film",
        hint: "Special effects cost a little more",
        defaultId: "standard",
        choices: [
          { id: "standard", label: "Standard", detail: "Included" },
          { id: "glitter", label: "Glitter", perUnit: 60 },
          { id: "glow", label: "Glow in the dark", perUnit: 80 },
        ],
      },
      {
        kind: "choice",
        id: "arrange",
        title: "Sheet arrangement",
        hint: "Send a ready sheet, or separate designs",
        defaultId: "own",
        choices: [
          { id: "own", label: "I'll upload an arranged sheet", detail: "Included" },
          { id: "arrange", label: "Arrange for me", perUnit: 99 },
        ],
      },
    ],
    specs: [
      ["Sheet width", "22 in"],
      ["Lengths", "24 · 48 · 120 in"],
      ["Films", "Standard · glitter · glow"],
      ["Artwork", "PNG with transparent background (preferred), PDF, SVG"],
    ],
    artwork: { slots: ["Gang sheet"], printArea: "22 in wide · transparent background · 300 dpi at size" },
    description:
      "DTF transfers printed on film, ready to heat-press onto cotton, polyester and blends. Upload a sheet you have already arranged, or upload separate designs and we arrange them for a small fee. Glitter and glow-in-the-dark films are available.",
    uses: ["Team & uniforms", "Events & promotions"],
    materials: ["Vinyl / film"],
    estimatorOption: {
      label: "Film",
      choices: [
        { id: "standard", label: "Standard", perUnit: 0 },
        { id: "glitter", label: "Glitter", perUnit: 60 },
        { id: "glow", label: "Glow in the dark", perUnit: 80 },
      ],
    },
  },
  {
    slug: "corporate-t-shirts",
    name: "Corporate T-Shirts",
    category: "corporate-merchandise",
    summary: "Size-wise quantities, multiple print locations.",
    lead: "Printed T-shirts for teams, events and uniforms. Enter quantities by size, choose the fabric and where to print.",
    image: "/images/product-corporate-t-shirts.png",
    fromPrice: "₹349/pc",
    startingPrice: 349,
    turnaround: "5–7",
    unitNoun: { one: "T-shirt", many: "T-shirts" },
    gstRate: 0.05,
    tiers: [
      { quantity: 25, unitPrice: 349 },
      { quantity: 50, unitPrice: 319 },
      { quantity: 80, unitPrice: 299 },
      { quantity: 150, unitPrice: 279 },
    ],
    quantity: {
      kind: "sizes",
      sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL"],
      surchargeSizes: ["2XL", "3XL"],
      surcharge: 30,
      quoteFrom: 300,
      hint: "Enter how many of each size",
      defaults: { S: 10, M: 25, L: 25, XL: 15, "2XL": 5 },
    },
    steps: [
      {
        kind: "choice",
        id: "garment",
        title: "Garment type",
        hint: "Style of T-shirt",
        defaultId: "round-neck",
        choices: [
          { id: "round-neck", label: "Round neck", detail: "Classic tee" },
          { id: "polo", label: "Polo", detail: "Collared", unavailable: "Priced on quotation" },
          { id: "oversized", label: "Oversized", detail: "Relaxed fit", unavailable: "Priced on quotation" },
        ],
      },
      {
        kind: "choice",
        id: "fabric",
        title: "Fabric & GSM",
        hint: "Feel and weight",
        defaultId: "cotton-180",
        choices: [
          { id: "cotton-180", label: "Cotton 180 GSM", detail: "Everyday wear" },
          { id: "poly-cotton-200", label: "Poly-cotton 200 GSM", perUnit: 30 },
          {
            id: "dri-fit-160",
            label: "Dri-fit 160 GSM",
            detail: "Sports & events",
            unavailable: "Priced on quotation",
          },
        ],
      },
      {
        kind: "swatch",
        id: "colour",
        title: "Colour",
        hint: "Garment colour",
        defaultId: "navy",
        choices: [
          { id: "navy", label: "Navy", swatch: "#102848" },
          { id: "white", label: "White", swatch: "#ffffff" },
          { id: "black", label: "Black", swatch: "#191b10" },
          { id: "magenta", label: "Magenta", swatch: "#d01478" },
          { id: "cyan", label: "Cyan", swatch: "#20a8d8" },
          { id: "yellow", label: "Yellow", swatch: "#f8e008" },
        ],
      },
      {
        kind: "choice",
        id: "method",
        title: "Printing method",
        hint: "Depends on fabric and quantity",
        defaultId: "screen",
        choices: [
          { id: "screen", label: "Screen print", detail: "Best for 50+ · ₹300 per screen" },
          { id: "dtf", label: "DTF print", detail: "Any quantity" },
          { id: "embroidery", label: "Embroidery", unavailable: "Polo only" },
          { id: "sublimation", label: "Sublimation", unavailable: "Poly only" },
        ],
      },
      {
        kind: "multi",
        id: "locations",
        title: "Print locations",
        hint: "Each location adds setup and print cost",
        defaultIds: ["front"],
        coloursPerChoice: { whenStep: "method", equals: "screen", perColour: 300, label: "Screens" },
        choices: [
          { id: "front", label: "Front", detail: "Max 30 × 40 cm · included" },
          { id: "back", label: "Back", detail: "Max 30 × 40 cm", perUnit: 40 },
          { id: "left-chest", label: "Left chest", detail: "Max 10 × 10 cm", unavailable: "Priced on quotation" },
          { id: "sleeve", label: "Sleeve", detail: "Max 8 × 8 cm", unavailable: "Priced on quotation" },
        ],
      },
    ],
    specs: [
      ["Sizes", "XS – 3XL"],
      ["Fabrics", "Cotton 180 · poly-cotton 200 GSM"],
      ["Printing", "Screen or DTF"],
      ["Artwork", sharedArtworkFormats],
    ],
    artwork: { slots: ["Front", "Back"], printArea: "Front and back up to 30 × 40 cm" },
    description:
      "Round-neck T-shirts in cotton or poly-cotton, printed by screen printing or DTF. Enter quantities by size — 2XL and above cost ₹30 more per piece. Screen printing adds a one-off ₹300 per screen (one screen per colour per location). Orders of 300 pieces or more are priced as a bulk quotation.",
    uses: ["Team & uniforms", "Events & promotions"],
    materials: ["Fabric"],
    estimatorOption: {
      label: "Fabric",
      choices: [
        { id: "cotton-180", label: "Cotton 180 GSM", perUnit: 0 },
        { id: "poly-cotton-200", label: "Poly-cotton 200 GSM", perUnit: 30 },
      ],
    },
  },
];

export const allUses: Use[] = [
  "Branding & identity",
  "Events & promotions",
  "Packaging & labelling",
  "Team & uniforms",
];
export const allMaterials: Material[] = ["Paper & card", "Vinyl / film", "Fabric"];

export function getProduct(slug: string): Product | undefined {
  return products.find((product) => product.slug === slug);
}

export function getCategory(slug: string): Category | undefined {
  return categories.find((category) => category.slug === slug);
}

/** Category name in the overline style used on product cards. */
export function categoryName(slug: CategorySlug): string {
  return getCategory(slug)?.name ?? "";
}

export function productsInCategory(slug: CategorySlug): Product[] {
  return products.filter((product) => product.category === slug);
}

/** Smallest orderable quantity (the first price tier). */
export function minimumQuantity(product: Product): number {
  return Math.min(...product.tiers.map((tier) => tier.quantity));
}

/** Products featured in the homepage "Popular now" carousel, in order. */
export const popularProductSlugs = [
  "visiting-cards",
  "stickers",
  "dtf-stickers",
  "corporate-t-shirts",
  "letter-pads",
  "envelopes",
  "brochures",
];
